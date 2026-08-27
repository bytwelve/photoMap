const path = require('node:path');
const { createWindowsInstaller } = require('electron-winstaller');

const appRoot = path.resolve(__dirname, '..');
createWindowsInstaller({
  name: 'PhotoMap',
  title: 'PhotoMap',
  authors: 'PhotoMap contributors',
  description: '完全离线的 Windows 照片地图桌面应用',
  appDirectory: path.join(appRoot, 'out', 'PhotoMap-win32-x64'),
  outputDirectory: path.join(appRoot, 'out', 'make', 'squirrel.windows', 'x64'),
  exe: 'PhotoMap.exe',
  setupExe: 'PhotoMap-Setup.exe',
  noMsi: true,
  noDelta: true,
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
