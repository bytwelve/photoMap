import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PHOTO_MAP_CHANNELS, type PhotoMapApi } from '../../src/shared/contracts';

const mocks = vi.hoisted(() => ({
  ipc: undefined as unknown as EventEmitter & { invoke: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> },
  expose: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  get ipcRenderer() { return mocks.ipc; },
}));

async function preload(): Promise<PhotoMapApi> {
  vi.resetModules();
  mocks.expose.mockClear();
  mocks.ipc = Object.assign(new EventEmitter(), { invoke: vi.fn(), send: vi.fn() });
  await import('../../src/preload/index');
  return mocks.expose.mock.calls[0]![1] as PhotoMapApi;
}

describe('preload settings flush bridge', () => {
  it('acknowledges only after the renderer save promise completes', async () => {
    const api = await preload();
    let resolve!: () => void;
    const pending = new Promise<void>((complete) => { resolve = complete; });
    api.subscribeSettingsFlush(() => pending);
    mocks.ipc.emit(PHOTO_MAP_CHANNELS.flushSettings, {}, 'close-1');
    await Promise.resolve();
    expect(mocks.ipc.send).not.toHaveBeenCalled();
    resolve();
    await vi.waitFor(() => expect(mocks.ipc.send).toHaveBeenCalledWith(PHOTO_MAP_CHANNELS.settingsFlushed, 'close-1', true));
  });

  it('acknowledges errors and an unmounted renderer without leaving the main process waiting', async () => {
    const api = await preload();
    const unsubscribe = api.subscribeSettingsFlush(async () => { throw new Error('save failed'); });
    mocks.ipc.emit(PHOTO_MAP_CHANNELS.flushSettings, {}, 'close-error');
    await vi.waitFor(() => expect(mocks.ipc.send).toHaveBeenCalledWith(PHOTO_MAP_CHANNELS.settingsFlushed, 'close-error', false));
    unsubscribe();
    mocks.ipc.emit(PHOTO_MAP_CHANNELS.flushSettings, {}, 'close-unmounted');
    await vi.waitFor(() => expect(mocks.ipc.send).toHaveBeenCalledWith(PHOTO_MAP_CHANNELS.settingsFlushed, 'close-unmounted', true));
  });
});
