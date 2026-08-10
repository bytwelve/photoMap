import { app, ipcMain } from 'electron';
import started from 'electron-squirrel-startup';
import { readFile, writeFile } from 'node:fs/promises';
import { configureAppPaths,initializeAppDirectories } from './bootstrap/app-paths';
import { createMainWindow } from './bootstrap/create-window';
import { DEFAULT_APP_SETTINGS,PHOTO_MAP_CHANNELS } from '../shared/contracts';
import type { AppSettings,WindowAction } from '../shared/contracts';
import { parseAppSettings } from '../shared/settings';
import { PhotoMapError } from '../shared/errors';


if (started) app.quit();
app.setName('PhotoMap');
const paths = configureAppPaths();

app.whenReady().then(async()=>{
  await initializeAppDirectories(paths);
  const window = createMainWindow(MAIN_WINDOW_WEBPACK_ENTRY,MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY);
  let settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
  try {settings=parseAppSettings(JSON.parse(await readFile(paths.settingsPath,'utf8')));} catch { /* Use defaults for first run. */ }
  const handle = (channel:string,operation:(value:unknown)=>unknown) => ipcMain.handle(channel,async(event,value:unknown)=>{
    try {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new PhotoMapError('UNAUTHORIZED_IPC','请求来源无效。');
      return {ok:true,value:await operation(value)};
    } catch(error) {return {ok:false,error:{code:error instanceof PhotoMapError ? error.code : 'UNKNOWN_ERROR',userMessage:error instanceof Error ? error.message : '操作失败。',scope:'task',retryability:'retry'}};}
  });
  
  handle(PHOTO_MAP_CHANNELS.getAppInfo,async()=>({name:app.getName(),version:app.getVersion(),platform:process.platform,isPackaged:app.isPackaged,mapData:{ready:true,items:[],completed:0,total:0}}));
  handle(PHOTO_MAP_CHANNELS.getSettings,()=>settings);
  handle(PHOTO_MAP_CHANNELS.updateSettings,async(value)=>{settings=parseAppSettings(value);await writeFile(paths.settingsPath,JSON.stringify(settings),'utf8');return settings;});
  handle(PHOTO_MAP_CHANNELS.windowAction,(value)=>{const action=value as WindowAction;if(action==='minimize')window.minimize();else if(action==='toggleMaximize'){if(window.isMaximized())window.unmaximize();else window.maximize();}else if(action==='close')window.close();return {maximized:window.isMaximized()};});
  
  await window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
});
app.on('window-all-closed',()=>app.quit());
