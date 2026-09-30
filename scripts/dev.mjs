import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pythonInVenv = process.platform === 'win32'
  ? resolve(root, '.venv', 'Scripts', 'python.exe')
  : resolve(root, '.venv', 'bin', 'python');
const python = process.env.CODELAB_PYTHON || (existsSync(pythonInVenv) ? pythonInVenv : process.platform === 'win32' ? 'python' : 'python3');
const vite = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const services = [];
let shuttingDown = false;

function checkPythonDependencies() {
  const result = spawnSync(python, ['-c', 'import fastapi, httpx, uvicorn, docker'], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) return true;
  console.error('CodeLab Python dependencies are missing from the selected interpreter.');
  if (result.stderr) console.error(result.stderr.trim());
  const venvPython = process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';
  console.error(`Install them with: ${venvPython} -m pip install -r apps/api/requirements.txt -r services/java-runner/requirements.txt`);
  return false;
}

function launch(name, command, args, cwd, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv, PYTHONUNBUFFERED: '1' },
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const service = { name, child, error: null, exitCode: null };
  services.push(service);
  const forward = (stream, target) => {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line) target.write(`[${name}] ${line}\n`);
    });
    stream.on('end', () => { if (pending) target.write(`[${name}] ${pending}\n`); });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('error', (error) => { service.error = error; });
  child.on('exit', (code) => {
    service.exitCode = code ?? 1;
    if (!shuttingDown) {
      console.error(`[${name}] stopped unexpectedly with exit code ${service.exitCode}.`);
      void shutdown(service.exitCode || 1);
    }
  });
  return service;
}

const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitForJson(url, service, predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (service?.error) throw new Error(`${label} failed to start: ${service.error.message}`);
    if (service?.exitCode !== null && service?.exitCode !== undefined) {
      throw new Error(`${label} stopped with exit code ${service.exitCode}.`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const value = await response.json();
        if (predicate(value)) return value;
        lastError = `unexpected response from ${url}`;
      } else {
        lastError = `${url} returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await pause(300);
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function waitForVite(service, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service?.error) throw new Error(`Vite failed to start: ${service.error.message}`);
    if (service?.exitCode !== null && service?.exitCode !== undefined) {
      throw new Error(`Vite stopped with exit code ${service.exitCode}.`);
    }
    try {
      const response = await fetch('http://127.0.0.1:5173/@vite/client', { signal: AbortSignal.timeout(1000) });
      if (response.ok && (response.headers.get('content-type') ?? '').includes('javascript')) return;
    } catch { /* the development server is still starting */ }
    await pause(300);
  }
  throw new Error('Vite did not become ready at http://localhost:5173. Stop any process using port 5173 and try again.');
}

async function viteAlreadyRunning() {
  try {
    const response = await fetch('http://127.0.0.1:5173/@vite/client', { signal: AbortSignal.timeout(1000) });
    return response.ok && (response.headers.get('content-type') ?? '').includes('javascript');
  } catch {
    return false;
  }
}

async function killWindowsProcessTree(pid) {
  await new Promise((resolvePromise) => {
    const killer = spawn('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(resolvePromise, 3000);
    timer.unref();
    killer.once('error', resolvePromise);
    killer.once('exit', resolvePromise);
  });
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const running = services.filter(({ child }) => child.exitCode === null && child.signalCode === null);
  if (process.platform === 'win32') {
    const runner = running.find(({ name }) => name === 'java-runner');
    if (runner) await killWindowsProcessTree(runner.child.pid);
  }
  for (const { child } of running) child.kill();
  await Promise.race([
    Promise.all(running.map(({ child }) => new Promise((resolvePromise) => child.once('exit', resolvePromise)))),
    pause(4000),
  ]);
  for (const { child } of running) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  process.exitCode = exitCode;
}

process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

async function main() {
  if (!existsSync(vite)) throw new Error('Web dependencies are missing. Run npm install in the CodeLab folder first.');
  if (!checkPythonDependencies()) throw new Error('Install the CodeLab Python dependencies, then run npm run dev again.');

  console.log('Starting CodeLab with the JDK installed on this computer (local development mode).');
  const runner = launch(
    'java-runner', python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8100'],
    resolve(root, 'services', 'java-runner'), { JAVA_EXECUTION_MODE: 'local' },
  );
  await waitForJson('http://127.0.0.1:8100/health', runner, (value) => value.status === 'ok', 'Java runner');

  const api = launch(
    'api', python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'],
    resolve(root, 'apps', 'api'), { JAVA_RUNNER_URL: 'http://127.0.0.1:8100' },
  );
  await waitForJson('http://127.0.0.1:8000/health', api, (value) => value.status === 'ok', 'CodeLab API');

  let web = null;
  if (await viteAlreadyRunning()) {
    console.log('[web] Reusing the Vite server already running at http://localhost:5173.');
  } else {
    web = launch(
      'web', process.execPath, [vite, '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
      resolve(root, 'apps', 'web'), { API_INTERNAL_URL: 'http://127.0.0.1:8000' },
    );
    await waitForVite(web);
  }

  const runtime = await waitForJson(
    'http://127.0.0.1:5173/api/runtime', web,
    (value) => value.language === 'Java' && value.mode === 'local',
    'CodeLab API proxy',
  );
  console.log(`CodeLab is ready at http://localhost:5173 (${runtime.available ? `${runtime.vendor} ${runtime.version}` : runtime.message}).`);
  console.log('Press Ctrl+C to stop the API and Java runner.');
}

main().catch(async (error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.message.includes('port 5173')) {
    console.error('If CodeLab is already open, its existing Vite server will be reused; otherwise stop the other app first.');
  }
  await shutdown(1);
});
