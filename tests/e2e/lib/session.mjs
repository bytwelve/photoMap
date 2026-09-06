import { freePort, waitForTarget, CdpClient, evaluate } from './cdp.mjs';
import { launchApplication, closeApplication, writeLaunchLogs } from './processes.mjs';
import { UI_OBSERVER_SOURCE } from './config.mjs';

export async function openSession(runtime, prefix, observeUi = false) {
  const port = await freePort();
  const launched = launchApplication(runtime, prefix, port);
  let client;
  try {
    const target = await waitForTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.send('Page.enable');
    if (observeUi) {
      await client.send('Page.addScriptToEvaluateOnNewDocument', { source: UI_OBSERVER_SOURCE });
    }
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    if (observeUi) await evaluate(client, UI_OBSERVER_SOURCE);
    return { prefix, port, launched, client, closed: false };
  } catch (error) {
    try {
      await closeApplication(client, launched);
    } finally {
      await writeLaunchLogs(prefix, launched);
    }
    throw error;
  }
}

export async function shutdownSession(session) {
  if (!session || session.closed) return;
  try {
    await closeApplication(session.client, session.launched);
    session.closed = true;
  } finally {
    await writeLaunchLogs(session.prefix, session.launched);
  }
}
