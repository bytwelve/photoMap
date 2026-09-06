import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { delay } from './utils.mjs';
import { localAppData, resultRoot } from './config.mjs';
import { evaluate } from './cdp.mjs';

export async function debugPortIsClosed(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(true));
  });
}

export async function waitForDebugPortClosed(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await debugPortIsClosed(port)) return;
    await delay(100);
  }
  throw new Error(`Debugging port ${port} remained open after the exact app process exited.`);
}

export async function terminateProcessTree(pid) {
  await new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const errors = [];
    killer.stderr.on('data', (chunk) => errors.push(String(chunk)));
    killer.once('error', reject);
    killer.once('exit', (code) => {
      if (code === 0 || code === 128) resolve();
      else reject(new Error(`taskkill failed for exact process tree ${pid}: ${errors.join('').trim()}`));
    });
  });
}

export async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    once(child, 'exit').then(([code]) => code),
    delay(timeoutMs).then(() => null),
  ]);
}

export function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export function launchApplication(runtime, prefix, port) {
  const stdout = [];
  const stderr = [];
  const child = spawn(runtime.executablePath, [`--remote-debugging-port=${port}`], {
    cwd: runtime.applicationDirectory,
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  const launched = {
    runtime,
    prefix,
    port,
    child,
    stdout,
    stderr,
    closed: false,
    exitCode: null,
    spawnError: null,
  };
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  child.on('error', (error) => {
    launched.spawnError = error;
    stderr.push(`${error.stack ?? error.message}\n`);
  });
  runtime.activeLaunches.add(launched);
  return launched;
}

export async function closeApplication(client, launched) {
  if (launched.closed) return launched.exitCode;
  const { child, port, runtime } = launched;
  if (client) {
    try {
      await evaluate(client, `window.photoMap.windowAction('close')`, false);
    } catch {
      // Fall back to terminating only the exact child started by this script.
    }
    try {
      client.close();
    } catch {
      // Process cleanup below remains authoritative.
    }
  }
  if (child.pid === undefined && launched.spawnError !== null) {
    await waitForDebugPortClosed(port);
    launched.closed = true;
    runtime.activeLaunches.delete(launched);
    return null;
  }
  let exitCode = await waitForExit(child, 8_000);
  if (exitCode === null) {
    if (child.pid === undefined) throw new Error('Packaged app process has no PID for bounded cleanup.');
    child.kill();
    exitCode = await waitForExit(child, 3_000);
    if (exitCode === null && !processIsRunning(child.pid) && await debugPortIsClosed(port)) {
      exitCode = child.exitCode ?? -1;
    }
  }
  if (exitCode === null) {
    if (child.pid === undefined) throw new Error('Packaged app process has no PID for bounded cleanup.');
    let terminationError;
    try {
      await terminateProcessTree(child.pid);
    } catch (error) {
      terminationError = error;
    }
    exitCode = await waitForExit(child, 5_000);
    if (exitCode === null && !processIsRunning(child.pid) && await debugPortIsClosed(port)) {
      exitCode = child.exitCode ?? -1;
    }
    if (exitCode === null && terminationError !== undefined) {
      throw terminationError;
    }
  }
  if (exitCode === null) throw new Error('Exact packaged app process tree did not exit after cleanup.');
  await waitForDebugPortClosed(port);
  launched.closed = true;
  launched.exitCode = exitCode;
  runtime.activeLaunches.delete(launched);
  return exitCode;
}

export async function writeLaunchLogs(prefix, launched) {
  await Promise.all([
    writeFile(path.join(resultRoot, `${prefix}-stdout.log`), launched.stdout.join(''), 'utf8'),
    writeFile(path.join(resultRoot, `${prefix}-stderr.log`), launched.stderr.join(''), 'utf8'),
  ]);
}
