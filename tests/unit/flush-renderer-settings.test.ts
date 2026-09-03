import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHOTO_MAP_CHANNELS } from '../../src/shared/contracts';

const electron = vi.hoisted(() => ({ ipcMain: undefined as unknown as EventEmitter }));
vi.mock('electron', () => ({ get ipcMain() { return electron.ipcMain; } }));
import { flushRendererSettings } from '../../src/main/bootstrap/flush-renderer-settings';

function renderer() {
  electron.ipcMain = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    mainFrame: { url: 'file:///app/index.html' },
    getURL: () => 'file:///app/index.html',
    send: vi.fn(),
  });
  const window = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { window, contents, event };
}

afterEach(() => vi.useRealTimers());

describe('renderer shutdown handshake', () => {
  it('waits for the current main frame and request token, then removes its listeners', async () => {
    const { window, contents, event } = renderer();
    let finished = false;
    const flushing = flushRendererSettings(window as never).then(() => { finished = true; });
    const requestId = contents.send.mock.calls[0]![1];
    expect(contents.send).toHaveBeenCalledWith(PHOTO_MAP_CHANNELS.flushSettings, requestId);
    electron.ipcMain.emit(PHOTO_MAP_CHANNELS.settingsFlushed, event, 'stale-token', true);
    electron.ipcMain.emit(PHOTO_MAP_CHANNELS.settingsFlushed, { ...event, sender: {} }, requestId, true);
    electron.ipcMain.emit(PHOTO_MAP_CHANNELS.settingsFlushed, { ...event, senderFrame: {} }, requestId, true);
    await Promise.resolve();
    expect(finished).toBe(false);
    electron.ipcMain.emit(PHOTO_MAP_CHANNELS.settingsFlushed, event, requestId, true);
    await flushing;
    expect(finished).toBe(true);
    expect(electron.ipcMain.listenerCount(PHOTO_MAP_CHANNELS.settingsFlushed)).toBe(0);
    expect(contents.listenerCount('destroyed')).toBe(0);
  });

  it('times out a nonresponsive renderer without blocking application shutdown forever', async () => {
    vi.useFakeTimers();
    const { window, contents } = renderer();
    const flushing = flushRendererSettings(window as never);
    const failed = expect(flushing).rejects.toThrow('Timed out');
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    expect(electron.ipcMain.listenerCount(PHOTO_MAP_CHANNELS.settingsFlushed)).toBe(0);
    expect(contents.listenerCount('render-process-gone')).toBe(0);
  });

  it.each(['failed-save', 'renderer-crash', 'send-failure'])('settles %s and releases the waiting resources', async (failure) => {
    const { window, contents, event } = renderer();
    if (failure === 'send-failure') contents.send.mockImplementation(() => { throw new Error('destroyed'); });
    const flushing = flushRendererSettings(window as never);
    const failed = expect(flushing).rejects.toThrow();
    if (failure === 'failed-save') {
      electron.ipcMain.emit(PHOTO_MAP_CHANNELS.settingsFlushed, event, contents.send.mock.calls[0]![1], false);
    } else if (failure === 'renderer-crash') contents.emit('render-process-gone');
    await failed;
    expect(electron.ipcMain.listenerCount(PHOTO_MAP_CHANNELS.settingsFlushed)).toBe(0);
  });
});
