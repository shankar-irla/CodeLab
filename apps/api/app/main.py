from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI(title="CodeLab API", version="0.1.0")
ALLOWED_ORIGINS = [
    origin.strip().rstrip("/")
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]
if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        max_age=600,
    )
MAX_CONCURRENT_RUNS = max(1, int(os.getenv("MAX_CONCURRENT_RUNS", "4")))
MAX_TRACKED_JOBS = max(32, MAX_CONCURRENT_RUNS * 16)
run_slots = asyncio.Semaphore(MAX_CONCURRENT_RUNS)
jobs: dict[str, dict[str, Any]] = {}
background_tasks: set[asyncio.Task[None]] = set()
FILE_NAME_PATTERN = re.compile(r"^[^\x00]+\.java$")
MAX_SOURCE_BYTES = 512_000


def runner_url() -> str:
    """Resolve the runner binding during request handling, with a local-dev fallback."""
    bound_url = os.getenv("JAVA_RUNNER_URL")
    if bound_url:
        return bound_url.rstrip("/")
    if os.getenv("VERCEL"):
        raise HTTPException(status_code=503, detail="The Java runner service binding is not available.")
    return "http://localhost:8100"


def runner_auth_headers(request: Request) -> dict[str, str] | None:
    """Forward Vercel's signed OIDC token to the internal Sandbox runner."""
    if not os.getenv("VERCEL"):
        return None
    token = request.headers.get("x-vercel-oidc-token")
    return {"x-vercel-oidc-token": token} if token else None


class RunRequest(BaseModel):
    files: dict[str, str] = Field(min_length=1, max_length=80)
    stdin: str = Field(default="", max_length=64_000)
    main_class: str = Field(default="Main", max_length=240)
    timeout_seconds: float = Field(default=5, gt=0, le=30)


def _validate_request(payload: RunRequest) -> None:
    total_size = 0
    for name, content in payload.files.items():
        normalized = name.replace("\\", "/")
        if (
            normalized.startswith("/")
            or ":" in normalized
            or not FILE_NAME_PATTERN.fullmatch(normalized)
            or any(part in ("", ".", "..") for part in normalized.split("/"))
            or any(part.endswith((" ", ".")) for part in normalized.split("/"))
        ):
            raise HTTPException(status_code=422, detail=f"Invalid Java file path: {name}")
        total_size += len(content.encode("utf-8"))
    if total_size > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail="Java source files exceed the 500 KB limit.")


async def _run_job(job_id: str, payload: RunRequest) -> None:
    jobs[job_id]["status"] = "RUNNING"
    jobs[job_id]["started_at"] = time.time()
    try:
        async with run_slots:
            async with httpx.AsyncClient(timeout=payload.timeout_seconds + 15) as client:
                response = await client.post(
                    f"{runner_url()}/run",
                    json={
                        "job_id": job_id,
                        "files": payload.files,
                        "stdin": payload.stdin,
                        "main_class": payload.main_class,
                        "timeout_seconds": payload.timeout_seconds,
                    },
                )
            if response.is_error:
                try:
                    detail = response.json().get("detail", "Java runner returned an error.")
                except ValueError:
                    detail = "Java runner returned an error."
                jobs[job_id].update(status="ERROR", error=detail)
            else:
                result = response.json()
                jobs[job_id].update(status=result.get("status", "ERROR"), result=result)
    except httpx.TimeoutException:
        try:
            async with httpx.AsyncClient(timeout=4) as client:
                await client.post(f"{runner_url()}/stop/{job_id}")
        except httpx.HTTPError:
            pass
        jobs[job_id].update(status="ERROR", error="The Java runner did not respond in time.")
    except httpx.HTTPError:
        jobs[job_id].update(status="ERROR", error="The Java runner is unavailable. Start the CodeLab services and try again.")
    except asyncio.CancelledError:
        jobs[job_id].update(status="STOPPED", error="Execution stopped.")
        raise
    except Exception:
        jobs[job_id].update(status="ERROR", error="The Java runner could not complete this execution.")
    finally:
        jobs[job_id]["finished_at"] = time.time()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/runtime")
async def runtime(request: Request) -> dict[str, Any]:
    try:
        timeout = 20 if os.getenv("VERCEL") else 4
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(f"{runner_url()}/runtime", headers=runner_auth_headers(request))
        if response.is_error:
            try:
                message = response.json().get("detail", "Java runner is unavailable")
            except (ValueError, AttributeError):
                message = "Java runner is unavailable"
            return {"available": False, "language": "Java", "message": message}
        return {"available": True, "language": "Java", **response.json()}
    except httpx.HTTPError:
        return {"available": False, "language": "Java", "message": "Sandbox is unavailable"}


@app.post("/api/run")
async def create_run(payload: RunRequest, request: Request) -> Any:
    _validate_request(payload)
    if os.getenv("VERCEL"):
        job_id = str(uuid4())
        try:
            async with httpx.AsyncClient(timeout=payload.timeout_seconds + 30) as client:
                response = await client.post(
                    f"{runner_url()}/run",
                    headers=runner_auth_headers(request),
                    json={
                        "job_id": job_id,
                        "files": payload.files,
                        "stdin": payload.stdin,
                        "main_class": payload.main_class,
                        "timeout_seconds": payload.timeout_seconds,
                    },
                )
        except httpx.TimeoutException as exc:
            raise HTTPException(status_code=504, detail="The Java sandbox did not finish in time.") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=503, detail="The Java runner is unavailable.") from exc
        if response.is_error:
            try:
                detail = response.json().get("detail", "The Java runner could not start this execution.")
            except (ValueError, AttributeError):
                detail = "The Java runner could not start this execution."
            raise HTTPException(status_code=response.status_code, detail=detail)
        return JSONResponse(
            status_code=200,
            content={"id": job_id, "status": "COMPLETED", "result": response.json()},
        )

    active = sum(job.get("status") in {"QUEUED", "RUNNING"} for job in jobs.values())
    if active >= MAX_TRACKED_JOBS:
        raise HTTPException(status_code=429, detail="The local run queue is full. Wait for a run to finish and try again.")
    while len(jobs) >= MAX_TRACKED_JOBS:
        finished = next((key for key, value in jobs.items() if value.get("status") not in {"QUEUED", "RUNNING"}), None)
        if finished is None:
            break
        jobs.pop(finished, None)
    job_id = str(uuid4())
    jobs[job_id] = {"id": job_id, "status": "QUEUED", "created_at": time.time()}
    task = asyncio.create_task(_run_job(job_id, payload))
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)
    return {"id": job_id, "status": "QUEUED"}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Run not found. Start a new run and try again.")
    return job


@app.post("/api/jobs/{job_id}/stop")
async def stop_job(job_id: str) -> dict[str, str]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Run not found.")
    if job.get("status") in {"QUEUED", "RUNNING"}:
        try:
            async with httpx.AsyncClient(timeout=4) as client:
                await client.post(f"{runner_url()}/stop/{job_id}")
        except httpx.HTTPError:
            pass
    return {"status": "stop_requested"}
