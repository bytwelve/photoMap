import type { ForgeConfig } from '@electron-forge/shared-types';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { mainConfig } from './webpack.main';
import { rendererConfig } from './webpack.renderer';


const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'PhotoMap',
    name: 'PhotoMap'
  },
  rebuildConfig: {},
  makers: [],
  plugins: [
    new WebpackPlugin({
      mainConfig,
      devContentSecurityPolicy: [
        "default-src 'self'",
        "script-src 'self' 'unsafe-eval' 'unsafe-inline' data:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: photomap-media: photomap-asset:",
        "media-src 'self' blob: photomap-media:",
        "connect-src 'self' ws: wss: photomap-asset: photomap-media:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-src 'none'",
      ].join('; '),
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/renderer/index.html',
            js: './src/renderer/main.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload/index.ts'
            }
          }
        ]
      }
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ]
};

export default config;
