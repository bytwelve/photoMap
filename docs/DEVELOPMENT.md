# 开发指南

用户操作见 [使用指南](USAGE.md)，发布门禁见 [发布检查清单](RELEASE_CHECKLIST.md)。

## 环境

Windows 10 / 11 x64，Node.js `>=24.15.0 <25`，npm `>=11.0.0 <12`，PowerShell 7.2+。本地构建兼容范围来自 `package.json` 的 `engines`，`npm run make` 按此范围检查，不要求精确匹配小版本或补丁版本。

CI 与正式发布仍使用 `.node-version` 中的 Node.js `24.19.0` 和 `package.json` 的 `packageManager` 中的 npm `11.12.1`。`verify-local.ps1` 与正式发布组装脚本保留精确版本检查，用于生成和核对发布验收记录；普通用户从源码生成安装包或便携版无需执行这些发布脚本。

在包含 `package.json` 的项目目录中打开 PowerShell，安装依赖：

```powershell
npm ci
```

`npm ci` 按 `package-lock.json` 中锁定的版本安装依赖，会先清理已有的 `node_modules`。通常在首次准备项目或依赖变更后执行，无需每次启动或打包前重复安装。

依赖安装及首次下载 Electron 运行环境需要网络；Electron 会按其包内校验和校验二进制。应用中的照片扫描、整理和导出在本机离线完成。

## 运行与打包

安装依赖后，按用途选择以下一种命令，**不需要依次执行**：

| 用途 | 命令 | 结果 |
| --- | --- | --- |
| 生成便携版 | `npm run package` | 程序位于 `out/PhotoMap-portable-win32-x64/PhotoMap.exe` |
| 生成 Windows 安装包 | `npm run make` | 安装器位于 `out/make/squirrel.windows/x64/PhotoMap-Setup.exe`，同时生成便携版和构建元数据，无需预先运行 `package` |
| 开发与调试 | `npm start` | 编译并打开软件，持续运行开发服务，不生成可分发的应用包 |

安装包尚未进行 Authenticode 签名。

便携版应保留完整目录，不能只复制 `.exe`。日常使用建议先将整个 `PhotoMap-portable-win32-x64` 文件夹复制到 `out/` 之外的可写位置，再运行其中的 `PhotoMap.exe`；运行已打包的软件不需要 npm 命令。分享软件与保留个人数据的方法见[便携版分享与备份](USAGE.md#便携版分享与备份)。

开发模式会持续占用当前终端，可另开终端执行其他命令；停止开发服务时，在原终端按 `Ctrl+C`。

`package:portable` 将 Forge 目录转换为便携目录，后续产物验证使用便携路径。正式 Squirrel 安装器统一使用 `npm run make`，配置来源为 `scripts/build/squirrel-config.json`。自定义兼容层直接调用锁定的 `electron-winstaller`，不注册 Forge Maker；升级安装器依赖时需要重新验证该适配。

### 再次打包

如果曾直接运行 `out/PhotoMap-portable-win32-x64/` 中的应用，该目录会生成 `PhotoMapData`。为保护已有记录，`npm run package` 和 `npm run make` 会拒绝覆盖含此数据目录的旧便携包。

请先退出应用，将完整的旧 `out/PhotoMap-portable-win32-x64` 文件夹移动到 `out/` 之外的独立可写位置，保留其中的数据与应用文件，再重新执行打包命令。不要删除数据来解除保护。

### Electron 下载排障

首次启动或打包可能下载 Electron。若应用窗口已经打开，终端残留的 `Downloading Electron binary...` 旧日志无需处理；若始终未打开窗口，再检查连接和错误日志。`npm start` 是持续运行的开发服务，使用 `Ctrl+C` 停止。

## 目录与边界

```text
src/
  main/
    index.ts                  # 主进程启动入口
    app-controller.ts         # 组合服务与应用操作
    operation-coordinator.ts  # 扫描生命周期、互斥与关闭等待
    bootstrap/                # 数据目录、窗口与会话边界
    ipc/                      # 注册经过校验的通信处理器
    infrastructure/
      diagnostics/            # 脱敏诊断
      filesystem/             # 路径策略与媒体枚举
      media-protocol/         # 本地媒体与地图资源协议
      settings/               # 设置持久化
      sqlite/
        catalog-repository.ts # 目录读写与业务事务
        catalog-migrations.ts # 迁移、备份与完整性检查
        catalog-schema.ts     # 表结构与必需列/索引
        row-mapping.ts        # 数据库行转换
    services/                 # 扫描、媒体、地图等应用服务
      library-scan/reconcile-plan.ts # 扫描对账计划，事务留在 repository
  preload/                    # 受控桥接
  renderer/
    App.tsx                   # 组合界面
    hooks/                    # 扫描、照片操作、地图状态、设置与反馈
      usePhotoActions.ts      # 照片编辑、重命名与删除操作
      useMapData.ts           # 地图状态加载与导入
    components/
      Shell.tsx               # 窗口与主界面壳层
      LeftSidebar.tsx         # 数据源与筛选侧栏
      FolderFilter.tsx        # 文件夹筛选
      MediaKindFilter.tsx     # 媒体类型筛选
    map-data-state.ts         # 地图可用性状态判断
    features/
      photo-wall/
      postcard/               # PostcardView、编辑、播放、动画与完成页
      batch/
      export/
    map-scene/                # 地图布局、渲染与照片裁切
    styles/                   # 基础、功能、响应式样式
    main.tsx                  # 唯一 renderer 入口
  shared/
    contracts.ts              # 主进程 / renderer 通信契约
    schemas.ts                # 运行时输入校验
    map-data-manifest.json    # 地图版本、字节数、SHA-256 的权威来源
    administrative-regions.data.json
resources/map/                # 构建必需的地图视觉图层
scripts/
  build/                      # 构建输入清单、许可证与实际产物检查
  build-inputs.ps1             # 清单驱动的指纹计算输入与暂存复制
  e2e-packaged.cjs             # npm 命令入口，选择公开或完整验收
  release/                    # 本地版本组装、GitHub 资产准备和验收辅助
  *.ps1 / *.cjs               # Windows 构建入口
tests/
  unit/                       # 纯逻辑与契约
  integration/                # SQLite、文件系统等
  e2e/
    lib/                      # CDP、启动、隔离目录、素材与证据
    scenarios/                # 扫描、明信片、批量、地图、导出、重启
    public-smoke.mjs           # 无地图的公开功能验收
    map-regression.mjs         # 需要外部地图的完整回归
    capture-docs.mjs           # 使用合成素材生成实际截图
  fixtures/photos/            # 七张合成旅行照片
docs/
  USAGE.md                    # 用户操作、兼容性与数据边界
  DEVELOPMENT.md              # 开发、目录与验证
  RELEASE_CHECKLIST.md        # 源码公开与二进制发布
  images/                     # 实际截图与概念图；来源集中见 ASSETS.md
.github/                      # CI、依赖更新、Issue 与 PR 模板
```

界面通过 preload 的类型化接口调用服务；文件系统与 SQLite 操作、EXIF / GPS 解析在主进程中完成。解析出的经纬度不写入应用数据，也不作为界面字段传递；媒体预览可通过受控协议读取原图，原图仍保留原有元数据。重构时保持这些操作与数据边界。样式入口 `styles.css` 的导入顺序是层叠契约；调整顺序也需要验证界面。

上述分层中可由工具判定的部分写入了 `eslint.config.mjs`，由 `npm run lint` 检查而非仅靠评审：renderer 不得导入 `electron`、`node:*` 或主进程 / preload 实现；`src/shared` 同时被两个进程加载，不得依赖 Electron、Node 内建模块或任何进程层；主进程与 preload 不得反向引用 renderer。违反时报错并给出应改用的替代路径。`src/**` 另外禁用 `console`，诊断统一走 `src/main/infrastructure/diagnostics`。

地图服务、行政区目录生成器和 E2E 共用同一份地图 manifest。不要为了测试修改生产哈希；上游文件变化需要单独审核并同步重新生成目录。

关闭应用先提交界面中尚未触发延迟保存的设置，再等待主进程已受理的设置和导出写入；等待期间窗口停止接受输入。新增异步写入操作应接入同一退出协调器。

设置使用 schema 2；读取 schema 1 时迁移已有偏好，下次正常保存写入新格式。数据库迁移及迁移备份用于保留已有用户数据。

产品构建输入由 `scripts/build/input-manifest.json` 统一列出，源码指纹与 ASCII 暂存目录使用同一清单。修改 README 或文档截图不会使已有产品构建指纹失效；修改源代码、运行资源、依赖或随包许可证等构建输入需要重新构建和验证。新增顶层构建配置或输入目录时同步更新该清单。没有 `.git` 的源码 ZIP 也可执行本地构建门禁。

## 行政区目录再生成

使用已核实且符合 manifest 的省、市文件校验或重建运行时行政区目录：

```powershell
npm run generate:regions -- --check <province.geojson> <city.geojson>
npm run generate:regions -- --write <province.geojson> <city.geojson>
```

修改上游数据版本前先核实来源条款、地区编码和地图行为，再更新 manifest 与目录并运行完整地图回归。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 严格类型、ESLint、无用代码、Vitest、许可证输入与文档链接检查；CI 与本地门禁使用同一入口 |
| `npm run lint` | ESLint 检查，含下文的分层边界规则；`npm run lint:fix` 自动修复可修复项 |
| `npm run unused:check` | knip 检查无法到达的文件、导出与依赖 |
| `npm run docs:check` | 检查源码 Markdown 的内联/引用式链接、图片、章节锚点及可核对的 Git 版本引用 |
| `npm run test:watch` | 测试监听 |
| `npm run licenses:check` | 核对锁定版本与完整许可证输入 |
| `npm run package:verify -- out/PhotoMap-portable-win32-x64` | 校验实际产物的许可证、ASAR 与排除文件 |
| `npm run e2e:packaged` | 公开功能与重启验收 |
| `npm run e2e:map` | 完整地图、布局和导出回归 |
| `npm audit --audit-level=moderate` | 检查全部依赖的已知漏洞 |
| `npm run generate:regions -- --check <province> <city>` | 校验已提交行政区目录的可重现性 |

## 已知的 React Hooks 待办

`npm run lint` 当前有 38 条 `react-hooks` 警告，分布为 `exhaustive-deps` 20 条、`set-state-in-effect` 14 条、`refs` 4 条。它们是真实提示，不是配置噪声：依赖数组不完整、在 effect 中直接 setState、以及把 ref 传入可能在渲染期读取它的函数。

这些代码目前通过打包后的 E2E 验收，逐条修改会改变渲染时序与副作用次数，容易引入无限重渲染或状态回滚。因此保留为警告并单独推进：每次只处理一个组件，先补该行为的测试，再运行 `npm run e2e:packaged`（涉及地图与导出时运行 `npm run e2e:map`），确认交互与截图无回归后提交。不要为消除警告批量补依赖数组或整体套用自动修复。

新增 renderer 代码应从一开始就满足这三条规则；`npm run lint` 的错误项为零，警告数只应下降。

## 公开端到端验收

```powershell
npm run package
npm run package:verify -- out/PhotoMap-portable-win32-x64
npm run e2e:packaged
```

测试复制产物到带所有权标记的临时目录，复制合成照片到隔离目录，启动真正的 Electron EXE。它验证缺地图引导、真实扫描、图像解码、备注、重命名、标签、地点、批量界面及重启恢复，随后检查数据隔离并清理进程与临时包。日志、截图及结构化结果保存在 `test-results/packaged-e2e-*/`。

公开验收包含 renderer 离线模拟与外部 HTTP 请求检查；这不等同于安装器验收或整台主机断网测试。

完整地图回归另行配置：

```powershell
$env:PHOTOMAP_E2E_MAP_DATA_FIXTURES = '<自行取得的地图文件目录>'
npm run e2e:map
```

照片默认来自仓库，不必设置 `PHOTOMAP_E2E_PHOTO_FIXTURES`。如需替换，目录必须有相同的七个测试文件名（六个 `.jpg` 与一个 `.png`，扩展名也要一致）；不要使用私人照片。两个地图文件必须符合 manifest，并使用规范文件名。它们只复制到隔离的测试数据目录。

## 文档与截图

更新 README 截图时，先完成打包并设置同样的地图目录，再运行 `node tests/e2e/capture-docs.mjs`。它使用合成素材与固定演示批注，检查程序版本与 `package.json` 一致，再输出四张 1600 × 1000 的实际应用截图到 `docs/images/`。提交前检查截图中没有用户路径或私人信息。

分享图成品由 `node tests/e2e/capture-share-docs.mjs` 生成，使用相同的地图环境变量；演示数据与构图参数见 [ASSETS.md](../ASSETS.md)。

文档 PNG 可进行无损压缩，压缩后核对尺寸与逐像素内容一致。运行时图片和测试素材有固定哈希约束，不随文档压缩一起替换；改变它们需同步对应 manifest 与验证。

## 应交给 Git 的文件

保留源码、测试、`package-lock.json`、配置、说明文档、产品图层、合成测试照片和 README 截图。`package.json` 中的 `private: true` 防止误发 npm 包，不影响 GitHub 开源。行政区 JSON 是运行时必需且可复现生成的轻量资源，与未分发的 GeoJSON 本体不同。

忽略清单以根目录 `.gitignore` 为准，此处不再复述以免两处不一致；注意 `.gitignore` 不会移除已跟踪的文件或历史记录。需要人工判断的是规则覆盖不到的情况：不要提交凭据、个人照片、自行下载的 GeoJSON、便携版运行数据或构建产物，即使它们出现在未被忽略的路径下。

候选设计图、提示词、浏览器快照和过程记录保存在 `.local/design-exploration/` 等已忽略目录，只把最终采用的素材与来源说明放入 `docs/images/`。

源码仓库中的合成照片用于公开复现，体积约 5 MB；它们不会进入运行时包。

清理本地缓存和构建目录前，应先确认没有运行中的构建或应用，并保留尚需复核的验收记录及数据恢复备份。

## 依赖维护

生产依赖和开发依赖都要审计。当前 overrides 用于 Forge 依赖链中的压缩包处理、临时文件、开发服务器和查询解析器；升级时同时运行从头安装、开发启动、完整打包和 E2E，不能只看审计数字。

`npm ci` 的弃用提示与漏洞报告是不同信息；不要通过忽略审计或强制不兼容升级来消除提示。迁移 Forge 主版本需要独立验证。

`.github/dependabot.yml` 每月提交依赖更新建议，并按验证成本分组：`runtime` 进入安装包，`electron-toolchain` 会使打包与安装器证据失效，`dev-tooling` 只影响门禁。分组只是提示优先级，合并前仍需完成上述从头安装、开发启动、完整打包与 E2E 验证。
