import { app, BrowserWindow, session } from 'electron';

function configureOfflineSession(rendererEntry: string): void {
  const applicationSession = session.defaultSession;
  applicationSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  applicationSession.setPermissionCheckHandler(() => false);

  let developmentOrigin: URL | null = null;
  if (!app.isPackaged) {
    try {
      const entry = new URL(rendererEntry);
      if (entry.hostname === 'localhost' || entry.hostname === '127.0.0.1') {
        developmentOrigin = entry;
      }
    } catch {
      developmentOrigin = null;
    }
  }

  applicationSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      let allowed = false;
      if (developmentOrigin !== null) {
        try {
          const requested = new URL(details.url);
          const requestedHttpProtocol = requested.protocol === 'http:' || requested.protocol === 'https:';
          const developmentHttpProtocol =
            developmentOrigin.protocol === 'http:' || developmentOrigin.protocol === 'https:';
          allowed =
            requested.hostname === developmentOrigin.hostname &&
            requested.port === developmentOrigin.port &&
            (requested.protocol === developmentOrigin.protocol ||
              (requested.protocol === 'ws:' && developmentHttpProtocol) ||
              (requested.protocol === 'wss:' && developmentOrigin.protocol === 'https:') ||
              (requestedHttpProtocol && requested.protocol === developmentOrigin.protocol));
        } catch {
          allowed = false;
        }
      }
      callback({ cancel: !allowed });
    }
  );
}

export function createMainWindow(rendererEntry: string, preloadEntry: string): BrowserWindow {
  configureOfflineSession(rendererEntry);
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1180,
    minHeight: 720,
    frame: false,
    show: false,
    backgroundColor: '#f4efe6',
    webPreferences: {
      preload: preloadEntry,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
  window.once('ready-to-show', () => window.show());
  return window;
}
