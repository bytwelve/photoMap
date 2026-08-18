import { app, dialog, ipcMain, net, protocol } from 'electron';
import started from 'electron-squirrel-startup';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { configureAppPaths,initializeAppDirectories } from './bootstrap/app-paths';
import { createMainWindow } from './bootstrap/create-window';
import { DEFAULT_APP_SETTINGS,PHOTO_MAP_CHANNELS } from '../shared/contracts';
import type { AppSettings,WindowAction } from '../shared/contracts';
import { parseAppSettings } from '../shared/settings';
import { PhotoMapError } from '../shared/errors';
import { PhotoLibrary } from './library';
import { parseUpdateLocationsRequest,parseUpdateTypesRequest,parseCreateTypeRequest,parseTrashPhotosRequest } from '../shared/schemas';

if (started) app.quit();
app.setName('PhotoMap');
const paths = configureAppPaths();
protocol.registerSchemesAsPrivileged([{scheme:'photomap-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}},{scheme:'photomap-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
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
  const library = new PhotoLibrary(paths,progress=>{if(!window.isDestroyed())window.webContents.send(PHOTO_MAP_CHANNELS.scanProgress,progress);});
  protocol.handle('photomap-media',async(request)=>{
    const url=new URL(request.url);if(url.hostname!=='photo')return new Response(null,{status:404});
    const filePath=library.mediaPath(decodeURIComponent(url.pathname.slice(1)),url.searchParams.get('size')==='thumb',url.searchParams.get('content')==='motion');
    if(!filePath)return new Response(null,{status:404});
    try {await stat(filePath);return net.fetch(pathToFileURL(filePath).href,{headers:request.headers});}catch{return new Response(null,{status:404});}
  });
  window.once('closed',()=>library.close());
  protocol.handle('photomap-asset',async(request)=>{
    const url=new URL(request.url),name=path.basename(url.pathname);
    if(url.hostname!=='data'||!['china-provinces.geojson','china-city-view.geojson'].includes(name))return new Response(null,{status:404});
    try{return net.fetch(pathToFileURL(path.join(paths.assetRoot,'data',name)).href);}catch{return new Response(null,{status:404});}
  });

  handle(PHOTO_MAP_CHANNELS.getAppInfo,async()=>({name:app.getName(),version:app.getVersion(),platform:process.platform,isPackaged:app.isPackaged,mapData:{ready:true,items:[],completed:0,total:0}}));
  handle(PHOTO_MAP_CHANNELS.getSettings,()=>settings);
  handle(PHOTO_MAP_CHANNELS.updateSettings,async(value)=>{settings=parseAppSettings(value);await writeFile(paths.settingsPath,JSON.stringify(settings),'utf8');return settings;});
  handle(PHOTO_MAP_CHANNELS.windowAction,(value)=>{const action=value as WindowAction;if(action==='minimize')window.minimize();else if(action==='toggleMaximize'){if(window.isMaximized())window.unmaximize();else window.maximize();}else if(action==='close')window.close();return {maximized:window.isMaximized()};});
  handle(PHOTO_MAP_CHANNELS.getLibrary,()=>library.snapshot());
  handle(PHOTO_MAP_CHANNELS.chooseLibrary,async()=>{const result=await dialog.showOpenDialog(window,{properties:['openDirectory'],title:'选择照片文件夹'});if(result.canceled||!result.filePaths[0])return {cancelled:true,library:library.snapshot()};return {cancelled:false,library:await library.activate(result.filePaths[0])};});
  handle(PHOTO_MAP_CHANNELS.refreshLibrary,()=>library.scan());
  handle(PHOTO_MAP_CHANNELS.cancelScan,()=>library.cancel());
  handle(PHOTO_MAP_CHANNELS.updateLocations,value=>library.updateLocations(parseUpdateLocationsRequest(value)));
  handle(PHOTO_MAP_CHANNELS.updateTypes,value=>library.updateTypes(parseUpdateTypesRequest(value)));
  handle(PHOTO_MAP_CHANNELS.createType,value=>library.createType(parseCreateTypeRequest(value).name));
  handle(PHOTO_MAP_CHANNELS.trashPhotos,value=>library.trash(parseTrashPhotosRequest(value).photoIds));

  await window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
});
app.on('window-all-closed',()=>app.quit());
