# 第三方软件声明

PhotoMap 的项目源代码采用 [MIT 许可证](LICENSE)。第三方组件保留各自的版权和许可证；下表依据当前 [package-lock.json](package-lock.json) 及已安装组件的许可文件整理，不替代完整许可文本。图像与地图数据的文件清单及使用说明另见 [ASSETS.md](ASSETS.md)。

## JavaScript 运行时依赖

| 组件 | 锁定版本 | 许可证 |
| --- | --- | --- |
| `@phosphor-icons/react` | 2.1.10 | MIT |
| `@xmldom/xmldom` | 0.9.12 | MIT |
| `electron-squirrel-startup` | 1.0.1 | Apache-2.0 |
| `debug`（`electron-squirrel-startup` 的嵌套依赖） | 2.6.9 | MIT |
| `ms`（`electron-squirrel-startup` 的嵌套依赖） | 2.0.0 | MIT |
| `exifreader` | 4.44.0 | MPL-2.0 |
| `react` | 19.2.7 | MIT |
| `react-dom` | 19.2.7 | MIT |
| `scheduler` | 0.27.0 | MIT |

[许可证收集脚本](scripts/build/collect-licenses.cjs) 从锁文件中枚举非开发依赖，核对已安装版本，并收集各组件顶层的 LICENSE、LICENCE、COPYING 或 NOTICE 文件。组件名称、版本、来源归档地址及完整许可文本写入生成的 `THIRD_PARTY_LICENSES.txt`。

ExifReader 的锁定来源归档地址保存在 `package-lock.json` 的 `node_modules/exifreader` 条目中；收集脚本将其同时写入许可证文本和清单。该组件的 MPL-2.0 许可应与其源代码一并核对，项目 MIT 声明不替代它。本项目直接使用 npm 锁定归档中的组件，不维护 ExifReader 修改版。

## Electron 与 Chromium

项目锁定 Electron 43.4.1。当前已安装 Electron 分发目录提供 `LICENSE` 和 `LICENSES.chromium.html`，其中后者包含 Chromium 及所含第三方组件的声明。二进制分发需要保留这两份文件，不能只附项目 MIT 许可证或上面的 JavaScript 依赖表。

[产物检查脚本](scripts/build/verify-package.cjs) 将应用可执行文件旁的这两份文件与当前 Electron 分发目录逐字节比较。[Squirrel 配置](scripts/build/squirrel-config.json) 显式增加 Chromium 许可证文件，[安装器构建脚本](scripts/create-squirrel.cjs) 对解包后的应用再次执行产物检查。

