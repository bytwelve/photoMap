import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { ApiResult, WindowAction } from '../../shared/contracts';
import { PHOTO_MAP_CHANNELS } from '../../shared/contracts';
import { PhotoMapError, toPublicError } from '../../shared/errors';
import {
  parseCreateTypeRequest,
  parseRenamePhotoRequest,
  parseResolveScanLocationsRequest,
  parseSaveExportRequest,
  parseTrashPhotosRequest,
  parseUpdateCaptureTimeRequest,
  parseUpdateLocationsRequest,
  parseUpdateNoteRequest,
  parseUpdateTypesRequest
} from '../../shared/schemas';
import { parseAppSettings } from '../../shared/settings';
import type { PhotoMapController } from '../app-controller';

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  const mainFrame = window.webContents.mainFrame;
  if (
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== mainFrame ||
    event.senderFrame.url !== window.webContents.getURL()
  ) {
    throw new PhotoMapError('UNAUTHORIZED_IPC', '已拒绝未授权的页面请求。', {
      scope: 'global'
    });
  }
}

async function resultOf<T>(action: () => T | Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

function parseWindowAction(value: unknown): WindowAction {
  if (value === 'minimize' || value === 'toggleMaximize' || value === 'close') {
    return value;
  }
  throw new PhotoMapError('INVALID_REQUEST', '窗口操作无效。');
}

export function registerPhotoMapHandlers(controller: PhotoMapController, window: BrowserWindow): void {
  ipcMain.handle(PHOTO_MAP_CHANNELS.getLibrary, (event) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.getLibrary();
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.chooseLibrary, (event) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.chooseLibrary();
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.refreshLibrary, (event) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.refreshLibrary();
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.cancelScan, (event) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.cancelScan();
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.resolveScanLocations, (event, value: unknown) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.resolveScanLocations(parseResolveScanLocationsRequest(value));
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.updateLocations, (event, value: unknown) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.updateLocations(parseUpdateLocationsRequest(value));
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.updateTypes, (event, value: unknown) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.updateTypes(parseUpdateTypesRequest(value));
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.updateNote, (event, value: unknown) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.updateNote(parseUpdateNoteRequest(value));
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.updateCaptureTime, (event, value: unknown) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.updateCaptureTime(parseUpdateCaptureTimeRequest(value));
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.renamePhoto, (event, value: unknown) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.renamePhoto(parseRenamePhotoRequest(value));
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.createType, (event, value: unknown) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.createType(parseCreateTypeRequest(value));
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.trashPhotos, (event, value: unknown) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      const request = parseTrashPhotosRequest(value);
      return controller.trashPhotos(request.photoIds);
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.saveExport, (event, value: unknown) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.saveExport(parseSaveExportRequest(value));
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.getAppInfo, (event) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.getAppInfo();
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.importMapData, (event) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.importMapData();
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.openMapDownload, (event) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.openMapDownload();
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.getSettings, (event) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.getSettings();
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.updateSettings, (event, value: unknown) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.updateSettings(parseAppSettings(value));
    })
  );
  ipcMain.handle(PHOTO_MAP_CHANNELS.windowAction, (event, value: unknown) =>
    resultOf(() => {
      assertTrustedSender(event, window);
      return controller.windowAction(parseWindowAction(value));
    })
  );
}

export function removePhotoMapHandlers(): void {
  for (const channel of Object.values(PHOTO_MAP_CHANNELS)) {
    if (channel !== PHOTO_MAP_CHANNELS.scanProgress) {
      ipcMain.removeHandler(channel);
    }
  }
}
