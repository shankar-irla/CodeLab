from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import shutil
import shlex
import signal
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path, PurePosixPath
from typing import Protocol

import docker
from docker.errors import APIError, DockerException, NotFound
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="CodeLab Java Runner", version="0.1.0")
local_logger = logging.getLogger("codelab.local-runtime")
JAVA_IMAGE = os.getenv("JAVA_IMAGE", "codelab-java:25")
JAVA_EXECUTION_MODE = os.getenv("JAVA_EXECUTION_MODE", "docker").strip().lower()
DEFAULT_TIMEOUT = float(os.getenv("EXECUTION_TIMEOUT_SECONDS", "5"))
MEMORY_LIMIT = os.getenv("EXECUTION_MEMORY_LIMIT", "256m")
CPU_LIMIT = float(os.getenv("EXECUTION_CPU_LIMIT", "1.0"))
MAX_SOURCE_BYTES = 512_000
MAX_OUTPUT_BYTES = 64_000
MAIN_CLASS_PATTERN = re.compile(r"^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$")
active_containers: dict[str, str] = {}
active_processes: dict[str, asyncio.subprocess.Process] = {}
cancelled_jobs: set[str] = set()


class RunRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=80)
    files: dict[str, str] = Field(min_length=1, max_length=80)
    stdin: str = Field(default="", max_length=64_000)
    main_class: str = Field(default="Main", max_length=240)
    timeout_seconds: float = Field(default=DEFAULT_TIMEOUT, gt=0, le=30)


class LanguageRuntime(Protocol):
    def get_version(self) -> dict[str, str]: ...
    def validate_project(self, request: RunRequest) -> dict[str, str]: ...
    async def compile_and_run(self, request: RunRequest) -> dict[str, object]: ...
    async def stop(self, job_id: str) -> dict[str, str]: ...
    def parse_diagnostics(self, output: str) -> list[dict[str, object]]: ...


def _safe_files(files: dict[str, str]) -> tuple[dict[str, str], int]:
    result: dict[str, str] = {}
    total = 0
    for name, content in files.items():
        normalized = name.replace("\\", "/")
        parts = normalized.split("/")
        if (
            normalized.startswith("/")
            or ":" in normalized
            or any(part in ("", ".", "..") for part in parts)
            or any(part.endswith((" ", ".")) for part in parts)
            or not normalized.endswith(".java")
            or "\x00" in normalized
        ):
            raise HTTPException(status_code=422, detail=f"Invalid Java file path: {name}")
        encoded = content.encode("utf-8")
        total += len(encoded)
        result[normalized] = content
    if total > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail="Java source files exceed the 500 KB limit.")
    if not result:
        raise HTTPException(status_code=422, detail="Add at least one .java file before running.")
    return result, total


def _archive(files: dict[str, str], stdin: str) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, content in files.items():
            payload = content.encode("utf-8")
            item = tarfile.TarInfo(name=name)
            item.size = len(payload)
            item.mode = 0o444
            archive.addfile(item, io.BytesIO(payload))
        payload = stdin.encode("utf-8")
        item = tarfile.TarInfo(name=".codelab-input")
        item.size = len(payload)
        item.mode = 0o444
        archive.addfile(item, io.BytesIO(payload))
    return buffer.getvalue()


def _parse_diagnostics(output: str) -> list[dict[str, object]]:
    lines = output.splitlines()
    diagnostics: list[dict[str, object]] = []
    pattern = re.compile(r"^(?:/workspace/)?(.+?\.java):(\d+):\s+(error|warning):\s+(.*)$")
    for index, line in enumerate(lines):
        match = pattern.match(line.strip())
        if not match:
            continue
        file, line_number, severity, message = match.groups()
        file = file.replace("\\", "/")
        column = None
        for next_line in lines[index + 1 : index + 3]:
            caret = next_line.find("^")
            if caret >= 0:
                column = caret + 1
                break
        upper = message.lower()
        code = "JAVA_COMPILER_ERROR"
        if "cannot find symbol" in upper:
            code = "CANNOT_FIND_SYMBOL"
        elif "incompatible types" in upper:
            code = "INCOMPATIBLE_TYPES"
        elif "expected" in upper:
            code = "SYNTAX_ERROR"
        diagnostics.append({
            "file": file,
            "line": int(line_number),
            "column": column,
            "severity": severity,
            "code": code,
            "message": message,
        })
    return diagnostics


def _local_java_environment(temporary_directory: Path) -> dict[str, str]:
    # Do not pass API credentials or unrelated application secrets into user code.
    allowed = {
        "PATH", "JAVA_HOME", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
        "TMPDIR", "LANG", "LC_ALL", "TZ",
    }
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    for key in ("TEMP", "TMP", "TMPDIR"):
        environment[key] = str(temporary_directory)
    for key in ("CLASSPATH", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"):
        environment.pop(key, None)
    return environment


async def _read_limited(stream: asyncio.StreamReader, output: bytearray) -> None:
    while chunk := await stream.read(8192):
        output.extend(chunk)
        overflow = len(output) - MAX_OUTPUT_BYTES
        if overflow > 0:
            del output[:overflow]


async def _finish_readers(*tasks: asyncio.Task[None]) -> None:
    _, pending = await asyncio.wait(set(tasks), timeout=1)
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


async def _terminate_local_process(
    process: asyncio.subprocess.Process,
    wait_task: asyncio.Task[int] | None = None,
) -> None:
    if process.returncode is not None:
        return
    local_logger.warning("Terminating local Java process pid=%s", process.pid)
    if wait_task is None:
        wait_task = asyncio.create_task(process.wait())
    if os.name == "nt":
        process.kill()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, OSError):
            process.kill()
    done, _ = await asyncio.wait({wait_task}, timeout=3)
    if not done:
        local_logger.error("Process.kill did not stop pid=%s; waiting after retry", process.pid)
        process.kill()
        await wait_task
    local_logger.warning("Local Java process pid=%s stopped with code=%s", process.pid, process.returncode)


def _combined_output(stdout: bytes, stderr: bytes) -> str:
    return (stdout + stderr)[-MAX_OUTPUT_BYTES:].decode("utf-8", errors="replace").strip("\r\n")


def _docker_client():
    return docker.from_env(timeout=5)


def _runtime_version() -> dict[str, str]:
    client = _docker_client()
    try:
        output = client.containers.run(
            JAVA_IMAGE,
            ["java", "-version"],
            stdout=True,
            stderr=True,
            remove=True,
            network_disabled=True,
            mem_limit="96m",
            nano_cpus=500_000_000,
            pids_limit=16,
            read_only=True,
            user="10001:10001",
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
        )
    finally:
        client.close()
    text = output.decode("utf-8", errors="replace")
    match = re.search(r'version "([^"]+)"', text)
    return {"version": match.group(1) if match else "Unknown", "vendor": "OpenJDK"}


async def _execute(request: RunRequest, files: dict[str, str]) -> dict[str, object]:
    started = time.monotonic()
    client = _docker_client()
    container = None
    timed_out = False
    try:
        script = (
            "unset CLASSPATH JAVA_TOOL_OPTIONS JDK_JAVA_OPTIONS _JAVA_OPTIONS; "
            "mkdir -p /tmp/codelab-classes; "
            "if ! find /workspace -type f -name '*.java' -print0 | "
            "xargs -0 javac -encoding UTF-8 -d /tmp/codelab-classes; then "
            "printf '\\n__CODELAB_STAGE__:compile\\n'; exit 42; fi; "
            "cd /tmp/codelab-classes && exec java -Xmx128m -XX:MaxMetaspaceSize=64m "
            f"{shlex.quote(request.main_class)} < /workspace/.codelab-input"
        )
        container = await asyncio.to_thread(
            client.containers.create,
            image=JAVA_IMAGE,
            command=["/bin/sh", "-lc", script],
            working_dir="/workspace",
            user="10001:10001",
            stdin_open=False,
            tty=True,
            network_disabled=True,
            read_only=True,
            tmpfs={
                "/workspace": "rw,noexec,nosuid,nodev,size=16m",
                "/tmp": "rw,nosuid,nodev,size=128m",
            },
            mem_limit=MEMORY_LIMIT,
            nano_cpus=int(CPU_LIMIT * 1_000_000_000),
            pids_limit=64,
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
            labels={"codelab.job": request.job_id},
            log_config=docker.types.LogConfig(
                type="json-file", config={"max-size": "1m", "max-file": "1"}
            ),
        )
        await asyncio.to_thread(container.put_archive, "/workspace", _archive(files, request.stdin))
        await asyncio.to_thread(container.start)
        active_containers[request.job_id] = container.id

        deadline = time.monotonic() + request.timeout_seconds
        while True:
            await asyncio.to_thread(container.reload)
            if container.status == "exited":
                break
            if request.job_id in cancelled_jobs:
                await asyncio.to_thread(container.kill)
                await asyncio.to_thread(container.wait, timeout=3)
                break
            if time.monotonic() >= deadline:
                timed_out = True
                await asyncio.to_thread(container.kill)
                await asyncio.to_thread(container.wait, timeout=3)
                break
            await asyncio.sleep(0.1)

        await asyncio.to_thread(container.reload)
        state = container.attrs.get("State", {})
        raw_output = await asyncio.to_thread(container.logs, stdout=True, stderr=True)
        output = raw_output.decode("utf-8", errors="replace")
        compile_error = "__CODELAB_STAGE__:compile" in output
        output = output.replace("\n__CODELAB_STAGE__:compile\n", "\n").strip("\n")
        output = output[-MAX_OUTPUT_BYTES:]
        exit_code = state.get("ExitCode")
        oom_killed = bool(state.get("OOMKilled")) or "java.lang.OutOfMemoryError" in output
        stopped = request.job_id in cancelled_jobs

        if timed_out:
            status = "TIME_LIMIT_EXCEEDED"
        elif oom_killed:
            status = "MEMORY_LIMIT_EXCEEDED"
        elif stopped:
            status = "STOPPED"
        elif compile_error:
            status = "COMPILE_ERROR"
        elif exit_code == 0:
            status = "SUCCESS"
        else:
            status = "RUNTIME_ERROR"

        memory_mb = None
        try:
            stats = await asyncio.to_thread(container.stats, stream=False)
            usage = stats.get("memory_stats", {}).get("usage")
            if usage is not None:
                memory_mb = round(usage / (1024 * 1024), 1)
        except (APIError, DockerException):
            pass
        return {
            "status": status,
            "output": output,
            "exit_code": exit_code,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "memory_mb": memory_mb,
            "diagnostics": java_runtime.parse_diagnostics(output) if compile_error else [],
        }
    except HTTPException:
        raise
    except (DockerException, APIError) as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Java sandbox is unavailable. Start Docker and build {JAVA_IMAGE}.",
        ) from exc
    finally:
        active_containers.pop(request.job_id, None)
        cancelled_jobs.discard(request.job_id)
        if container is not None:
            try:
                await asyncio.to_thread(container.remove, force=True)
            except (NotFound, APIError, DockerException):
                pass
        client.close()


class JavaRuntime:
    def get_version(self) -> dict[str, str]:
        return _runtime_version()

    def validate_project(self, request: RunRequest) -> dict[str, str]:
        files, _ = _safe_files(request.files)
        if not MAIN_CLASS_PATTERN.fullmatch(request.main_class):
            raise HTTPException(status_code=422, detail="Main class must be a Java class name, such as Main.")
        return files

    async def compile_and_run(self, request: RunRequest) -> dict[str, object]:
        files = self.validate_project(request)
        return await _execute(request, files)

    async def stop(self, job_id: str) -> dict[str, str]:
        cancelled_jobs.add(job_id)
        container_id = active_containers.get(job_id)
        if container_id:
            client = _docker_client()
            try:
                await asyncio.to_thread(client.containers.get(container_id).kill)
            except (NotFound, APIError):
                pass
            finally:
                client.close()
        return {"status": "stop_requested"}

    def parse_diagnostics(self, output: str) -> list[dict[str, object]]:
        return _parse_diagnostics(output)


class LocalJavaRuntime:
    """Development runner that compiles with the JDK installed on this computer."""

    @staticmethod
    def _tool(name: str) -> str:
        suffix = ".exe" if os.name == "nt" else ""
        java_home = os.getenv("JAVA_HOME")
        if java_home:
            candidate = Path(java_home) / "bin" / f"{name}{suffix}"
            if candidate.is_file():
                return str(candidate)
        found = shutil.which(name)
        if found:
            return found
        raise HTTPException(
            status_code=503,
            detail=f"Could not find {name}. Install a JDK and make sure JAVA_HOME or PATH includes it.",
        )

    def get_version(self) -> dict[str, str]:
        java = self._tool("java")
        self._tool("javac")
        try:
            result = subprocess.run(
                [java, "-version"], capture_output=True, text=True, timeout=5, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(status_code=503, detail="The installed Java runtime did not respond.") from exc
        version_text = result.stderr + result.stdout
        match = re.search(r'version "([^\"]+)"', version_text)
        if result.returncode != 0 or not match:
            raise HTTPException(status_code=503, detail="Could not read the installed Java version.")
        lower = version_text.lower()
        vendor = "OpenJDK" if "openjdk" in lower else "Oracle JDK" if "java(tm)" in lower else "Java"
        return {"version": match.group(1), "vendor": vendor}

    def validate_project(self, request: RunRequest) -> dict[str, str]:
        files, _ = _safe_files(request.files)
        if not MAIN_CLASS_PATTERN.fullmatch(request.main_class):
            raise HTTPException(status_code=422, detail="Main class must be a Java class name, such as Main.")
        return files

    async def _run_process(
        self,
        job_id: str,
        arguments: list[str],
        cwd: Path,
        stdin: bytes,
        timeout: float,
    ) -> tuple[bytes, bytes, int | None, bool]:
        process_options: dict[str, object] = {}
        if os.name == "nt":
            process_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            process_options["start_new_session"] = True
        try:
            process = await asyncio.create_subprocess_exec(
                *arguments,
                cwd=str(cwd),
                env=_local_java_environment(cwd),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                **process_options,
            )
        except OSError as exc:
            raise HTTPException(status_code=503, detail=f"Could not start the local Java tool: {exc}") from exc

        active_processes[job_id] = process
        stdout_buffer = bytearray()
        stderr_buffer = bytearray()
        stdout_task = asyncio.create_task(_read_limited(process.stdout, stdout_buffer))
        stderr_task = asyncio.create_task(_read_limited(process.stderr, stderr_buffer))
        wait_task = asyncio.create_task(process.wait())
        timed_out = False
        try:
            if process.stdin is not None:
                if stdin:
                    process.stdin.write(stdin)
                    try:
                        await process.stdin.drain()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                process.stdin.close()
            done, _ = await asyncio.wait({wait_task}, timeout=max(0.01, timeout))
            if not done:
                timed_out = True
                local_logger.warning("Java job %s hit its time limit; terminating pid=%s", job_id, process.pid)
                await _terminate_local_process(process, wait_task)
                local_logger.warning("Java job %s cleanup finished; returncode=%s", job_id, process.returncode)
            await _finish_readers(stdout_task, stderr_task)
            return bytes(stdout_buffer), bytes(stderr_buffer), process.returncode, timed_out
        except asyncio.CancelledError:
            await _terminate_local_process(process, wait_task)
            for task in (stdout_task, stderr_task):
                task.cancel()
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
            raise
        finally:
            if active_processes.get(job_id) is process:
                active_processes.pop(job_id, None)

    @staticmethod
    def _result(status: str, output: str, exit_code: int | None, started: float, diagnostics: bool = False) -> dict[str, object]:
        return {
            "status": status,
            "output": output,
            "exit_code": exit_code,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "memory_mb": None,
            "diagnostics": _parse_diagnostics(output) if diagnostics else [],
        }

    async def compile_and_run(self, request: RunRequest) -> dict[str, object]:
        files = self.validate_project(request)
        started = time.monotonic()
        deadline = started + request.timeout_seconds
        java = self._tool("java")
        javac = self._tool("javac")
        try:
            with tempfile.TemporaryDirectory(prefix="codelab-java-", ignore_cleanup_errors=True) as temporary_directory:
                workspace = Path(temporary_directory)
                classes = workspace / ".codelab-classes"
                classes.mkdir()
                source_paths: list[str] = []
                for name, source in files.items():
                    relative = PurePosixPath(name)
                    destination = workspace.joinpath(*relative.parts)
                    if not destination.resolve().is_relative_to(workspace.resolve()):
                        raise HTTPException(status_code=422, detail=f"Invalid Java file path: {name}")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_text(source, encoding="utf-8")
                    source_paths.append(relative.as_posix())

                if request.job_id in cancelled_jobs:
                    return self._result("STOPPED", "Execution stopped.", None, started)

                stdout, stderr, exit_code, timed_out = await self._run_process(
                    request.job_id,
                    [javac, "-encoding", "UTF-8", "-proc:none", "-d", str(classes), *source_paths],
                    workspace,
                    b"",
                    deadline - time.monotonic(),
                )
                compile_output = _combined_output(stdout, stderr)
                if request.job_id in cancelled_jobs:
                    return self._result("STOPPED", compile_output or "Execution stopped.", exit_code, started)
                if timed_out:
                    return self._result("TIME_LIMIT_EXCEEDED", compile_output or "Java compilation exceeded the time limit.", exit_code, started)
                if exit_code != 0:
                    return self._result("COMPILE_ERROR", compile_output, exit_code, started, diagnostics=True)

                if request.job_id in cancelled_jobs:
                    return self._result("STOPPED", "Execution stopped.", None, started)
                runtime_args = [
                    java, f"-Djava.io.tmpdir={workspace}", "-XX:-UsePerfData", "-Xms16m", "-Xmx128m", "-Xss512k", "-XX:MaxMetaspaceSize=64m",
                    "-XX:ActiveProcessorCount=1", "-cp", str(classes), request.main_class,
                ]
                stdout, stderr, exit_code, timed_out = await self._run_process(
                    request.job_id,
                    runtime_args,
                    workspace,
                    request.stdin.encode("utf-8"),
                    deadline - time.monotonic(),
                )
                output = _combined_output(stdout, stderr)
                if request.job_id in cancelled_jobs:
                    return self._result("STOPPED", output or "Execution stopped.", exit_code, started)
                if timed_out:
                    return self._result("TIME_LIMIT_EXCEEDED", output or "Java program exceeded the time limit.", exit_code, started)
                return self._result("SUCCESS" if exit_code == 0 else "RUNTIME_ERROR", output, exit_code, started)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Could not prepare the Java project: {exc}") from exc
        finally:
            cancelled_jobs.discard(request.job_id)

    async def stop(self, job_id: str) -> dict[str, str]:
        cancelled_jobs.add(job_id)
        process = active_processes.get(job_id)
        local_logger.warning("Stop requested for Java job %s; active pid=%s", job_id, process.pid if process else None)
        if process is not None:
            await _terminate_local_process(process)
        return {"status": "stop_requested"}

    def parse_diagnostics(self, output: str) -> list[dict[str, object]]:
        return _parse_diagnostics(output)


if JAVA_EXECUTION_MODE not in {"docker", "local"}:
    raise RuntimeError("JAVA_EXECUTION_MODE must be either 'docker' or 'local'.")

java_runtime: LanguageRuntime = LocalJavaRuntime() if JAVA_EXECUTION_MODE == "local" else JavaRuntime()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/runtime")
async def runtime() -> dict[str, object]:
    try:
        info = await asyncio.to_thread(java_runtime.get_version)
        return {**info, "mode": JAVA_EXECUTION_MODE, "sandboxed": JAVA_EXECUTION_MODE == "docker"}
    except HTTPException:
        raise
    except (DockerException, APIError) as exc:
        raise HTTPException(status_code=503, detail="Java Docker image is not available yet.") from exc


@app.post("/run")
async def run(request: RunRequest) -> dict[str, object]:
    return await java_runtime.compile_and_run(request)


@app.post("/stop/{job_id}")
async def stop(job_id: str) -> dict[str, str]:
    return await java_runtime.stop(job_id)
