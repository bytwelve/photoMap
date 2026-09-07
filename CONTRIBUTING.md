# 参与贡献

**简体中文** · [English](CONTRIBUTING.en.md)

感谢你关注「用照片拼地图」。这是一个隐私优先的 Windows 离线桌面应用，任何贡献都应保持这一前提：**不引入网络请求、遥测或云依赖，扫描与批注不写入源媒体目录，重命名与回收站操作必须由用户明确触发。**

## 开发环境

环境版本、安装依赖与运行方式见[开发指南](docs/DEVELOPMENT.md#环境)。

## 提交前检查

所有改动至少运行：

```powershell
npm run check
```

它会执行严格类型检查、ESLint（含四层边界规则）、knip 无用代码检查、全部 Vitest 测试、完整许可证输入检查及文档链接检查。涉及以下范围的改动，还应在精确工具链下运行完整门禁 `pwsh -NoProfile -File .\scripts\verify-local.ps1 -Gate all`：

- Windows 打包、Squirrel 安装器、便携模式
- 文件系统操作（重命名、回收站、扫描、路径策略）
- 自定义协议（`photomap-media:` / `photomap-asset:`）
- 数据位置、设置存储、SQLite schema
- 隐私边界（EXIF / GPS 处理、诊断日志内容）

## 代码约定

- TypeScript 严格模式；主进程、preload、renderer、shared 四层边界见 [开发指南](./docs/DEVELOPMENT.md)。
- renderer 与主进程的所有通信必须经过 `src/shared/contracts.ts` 中的类型化契约与 `src/shared/schemas.ts` 校验。
- 新功能需附带测试：纯逻辑放 `tests/unit/`，涉及 SQLite / 文件系统的放 `tests/integration/`。
- 不要在诊断日志、错误信息或测试快照中写入完整路径、标签内容、原始 EXIF 或经纬度。
- 提交信息使用 `feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `test:` 前缀，中英文均可。

## 提交 Pull Request

1. Fork 并从仓库默认分支创建工作分支。新仓库约定使用 `main`；CI 同时兼容沿用 `master` 的副本。
2. 保持 PR 聚焦单一目的；重构与功能分开提交。
3. 在 PR 描述中说明：改了什么、为什么、如何验证、是否影响隐私 / 文件安全边界。
4. 通过 CI 的代码检查、依赖审计和打包启动验收后等待维护者审阅。

## 报告问题

- 缺陷与功能建议请使用 Issue 模板。
- **安全问题请勿公开提交**，按 [`SECURITY.md`](./SECURITY.md) 私密报告。
- 提交 Issue 时不要附带真实私人照片、包含位置信息的截图或完整本机路径。

## 文档与素材

- 改动文件位置、命令或标题时，同步更新 README、使用指南和文档链接，运行 `npm run docs:check` 检查本地链接与章节锚点；README 的概念图与实际截图应继续明确区分。
- 更新截图使用仓库合成照片，方法见[开发指南](./docs/DEVELOPMENT.md#文档与截图)。新增素材应在 [ASSETS.md](./ASSETS.md) 登记来源、许可和必要的生成记录；缺失记录应如实注明。
- 地图版本变更需核实来源条款、更新 manifest 与行政区目录，并运行完整地图回归。不能仅放宽哈希校验，也不要将自行下载的 GeoJSON 提交到仓库。
- 中文文档为准。修改有 `.en.md` 对应版本的中文文档时，尽量在同一个 PR 内同步翻译；确实无法同步时在描述中说明，留待后续处理——译文陈旧比公开缺失更糟。

## 许可

提交贡献即表示你同意以本项目的 [MIT 许可证](./LICENSE) 授权你的贡献。
