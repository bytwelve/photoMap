import { randomUUID } from 'node:crypto';
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import { PHOTO_MAP_CHANNELS } from '../../shared/contracts';

/** Keep the window alive until its debounced preferences have reached the main process. */
export function flushRendererSettings(window: BrowserWindow, timeoutMs = 3000): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const contents = window.webContents;
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      ipcMain.removeListener(PHOTO_MAP_CHANNELS.settingsFlushed, onFlushed);
      contents.removeListener('render-process-gone', onUnavailable);
      contents.removeListener('destroyed', onUnavailable);
      if (error) reject(error);
      else resolve();
    };
    const onUnavailable = (): void => finish(new Error('The renderer closed before saving preferences.'));
    const onFlushed = (event: IpcMainEvent, responseId: unknown, succeeded: unknown): void => {
      if (event.sender !== contents || event.senderFrame !== contents.mainFrame
        || event.senderFrame?.url !== contents.getURL() || responseId !== requestId) return;
      finish(succeeded === true ? undefined : new Error('The renderer could not save preferences.'));
    };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for renderer preferences.')), timeoutMs);
    ipcMain.on(PHOTO_MAP_CHANNELS.settingsFlushed, onFlushed);
    contents.once('render-process-gone', onUnavailable);
    contents.once('destroyed', onUnavailable);
    try {
      contents.send(PHOTO_MAP_CHANNELS.flushSettings, requestId);
    } catch {
      onUnavailable();
    }
  });
}
