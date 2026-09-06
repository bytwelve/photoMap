import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

const cdpModuleUrl = new URL('../e2e/lib/cdp.mjs', import.meta.url).href;
const { waitForTarget } = await import(cdpModuleUrl) as {
  waitForTarget: (port: number, timeoutMs?: number) => Promise<unknown>;
};
const servers: Server[] = [];

async function serve(listener: RequestListener): Promise<number> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Local test server has no TCP address.');
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  }));
});

describe('packaged renderer endpoint polling', () => {
  it('honors the total deadline when HTTP accepts connections but never responds', async () => {
    let requests = 0;
    const port = await serve(() => { requests += 1; });
    const startedAt = performance.now();

    await expect(waitForTarget(port, 200)).rejects.toThrow(
      'Timed out waiting for the packaged renderer debugging endpoint.',
    );

    expect(requests).toBeGreaterThan(0);
    expect(performance.now() - startedAt).toBeLessThan(1_500);
  });

  it('continues polling after a stalled request and returns the ready page', async () => {
    let requests = 0;
    const target = {
      type: 'page',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/ready',
      url: 'file:///test/index.html',
      title: 'PhotoMap test renderer',
    };
    const port = await serve((_request, response) => {
      requests += 1;
      if (requests === 1) return;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify([
        { ...target, url: 'about:blank', title: '' },
        target,
      ]));
    });

    await expect(waitForTarget(port, 2_500)).resolves.toEqual(target);
    expect(requests).toBe(2);
  });
});
