import path from 'node:path';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { delay } from './utils.mjs';
import { resultRoot } from './config.mjs';

export async function freePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address === 'string' || address === null) {
    server.close();
    throw new Error('Unable to allocate a local debugging port.');
  }
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

export async function waitForTarget(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(Math.min(1_000, remainingMs)),
      });
      if (response.ok) {
        const targets = await response.json();
        // Electron exposes a pending URL before the document has committed. Wait
        // for its HTML title as well, so Runtime does not initialize about:blank.
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl
          && /^(?:file:|https?:)/.test(target.url ?? '') && Boolean(target.title?.trim()));
        if (page) return page;
      }
    } catch {
      // The endpoint may not be open yet, or may have stopped responding.
    }
    const retryDelayMs = Math.min(20, deadline - Date.now());
    if (retryDelayMs > 0) await delay(retryDelayMs);
  }
  throw new Error('Timed out waiting for the packaged renderer debugging endpoint.');
}

export class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.events = [];
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) {
        this.events.push(message);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else request.resolve(message.result);
    });
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open.')), { once: true });
    });
  }

  async send(method, params = {}, timeoutMs = 30_000) {
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

export function rendererErrorEvents(client) {
  return client.events.filter((event) => (
    event.method === 'Runtime.exceptionThrown'
    || (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error')
    || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error')
  ));
}

export async function evaluate(client, expression, awaitPromise = true) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result?.value;
}

export async function waitForValue(client, expression, predicate, timeoutMs = 30_000, pollIntervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluate(client, expression);
    if (predicate(lastValue)) return lastValue;
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for renderer state. Last value: ${JSON.stringify(lastValue)}`);
}

export async function screenshot(client, fileName) {
  // An inactive desktop window may stop producing compositor frames on Windows.
  await client.send('Page.bringToFront');
  const response = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  }, 90_000);
  const outputPath = path.join(resultRoot, fileName);
  await writeFile(outputPath, Buffer.from(response.data, 'base64'));
  return outputPath;
}
