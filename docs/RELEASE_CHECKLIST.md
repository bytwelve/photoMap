# 发布流程与验收

源码公开与发布 Windows 二进制是两个交付步骤。只有下面的验证实际完成，才把对应状态记为通过。

变更历史见 [CHANGELOG.md](../CHANGELOG.md)。每次验证结果保存在对应 `test-results/` 目录；不把旧提交、旧产物或不同工具链的结果当作新版本通过证据。

## 源码首次公开

1. 检查 `git status`、拟提交差异和将推送的分支、标签历史。只保留源码、测试与必要素材；`.gitignore` 不会移除已跟踪文件或历史记录。Git 管理范围见[开发指南](DEVELOPMENT.md#应交给-git-的文件)。
2. 从干净检出运行 `npm ci`、`npm run check`、`npm audit --audit-level=moderate`，再运行下文的目录包与公开 E2E 验收。保存与当前提交对应的结果。
3. 检查 README 的图片、文档跳转与启动说明。确认项目名称、许可证、已验证的平台和功能限制与实际一致。
4. 完成下文的[地图公开前置条件](#地图公开前置条件)，将适用条款与获取结果记录在 [ASSETS.md](../ASSETS.md#上游依据与核验状态)。
5. 确定实际 GitHub 仓库地址，用于 `package.json` 的 `repository`、`homepage`、`bugs` 元数据；安装包发布后再补 README 的真实下载入口。

### 地图公开前置条件

这两项独立验证，当前均未完成：

- **分发依据**：取得适用于现有天地图输入及海岸修补掩膜用途的官方条款或授权，记录 URL / 文件、适用版本、允许的分发方式与署名要求。Natural Earth 已核实的 public domain 条款不代替天地图输入的依据。不含几何的行政区目录按事实数据处理，依据见 [ASSETS.md](../ASSETS.md#上游依据与核验状态)。
- **获取与兼容性**：从官方页面取得省、市文件，记录实际选项、下载日期、文件大小与 SHA-256；在干净应用中导入并完成照片墙与导出。若官方文件变化，先审核版本并验证地图行为，不能只放宽哈希校验。

本地已有地图通过回归，仅证明本地文件兼容；修改来源说明不代表这两项通过。未完成时保持待核实状态，不将当前包含相关派生素材的源码或二进制标记为已具备公开发布条件。

### 在 GitHub 上创建仓库

在 GitHub 创建空仓库，选择计划的公开范围，不额外初始化 README、许可证或 `.gitignore`。新仓库约定默认分支为 `main`，CI 同时兼容沿用 `master` 的副本。下列命令以 `main` 为例，仅供维护者在确认目标地址和待公开内容后执行；先将占位地址替换为实际仓库地址。操作依据见 [GitHub 导入已有仓库说明](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)。

先在项目目录检查 `git rev-parse --show-toplevel` 与 `git branch --show-current`。若该副本没有自己的 `.git`（例如源码 ZIP），在确认使用当前源码开始新历史后执行 `git init -b main`。已有历史时保留它；若当前分支为 `master` 且没有 `main`，可执行 `git branch -m main`。不要重新初始化已有仓库、覆盖已存在的 `main` 或借用上级目录的仓库。

```powershell
git status
git remote -v
# 仅在尚未配置 origin 时添加；已有 origin 时先核对其地址
git remote add origin 'https://github.com/OWNER/REPOSITORY.git'
git remote -v
git push -u origin main
```

推送前应先提交已审阅的改动。首次推送只包含准备公开的分支；历史标签逐一确认后按需推送，不默认执行 `--all` 或 `--tags`。发生远端历史不一致时先核对原因，不使用强制推送覆盖。

早期版本节点的性质见 [变更记录](../CHANGELOG.md)。版本标签不代替对应构建和人工验收证据。

### 仓库上线后

- 在 Actions 中确认当前提交的检查、打包与公开 E2E 全部通过，并打开 GitHub 渲染的 README 实际点击链接、查看图片。
- 在仓库设置中启用 Private vulnerability reporting，并检查 Security 页面可用的报告入口；`SECURITY.md` 不会自动启用它。步骤见 [GitHub 私密漏洞报告设置](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。
- 在维护者个人资料或行为准则中提供可用的私密联系方式，并确认能收到报告。按团队需要设置 `main` 的分支保护及 CI 必须通过规则。
- 源码公开不代表已发布经过安装、卸载和断网验收的二进制。提供下载前继续完成下面的发布步骤。

## 正式二进制发布前

1. 确定发布版本和 Authenticode 策略，完成上述仓库与文档检查。
2. 更新 CHANGELOG 与包版本，提交准备发布的全部变更，使用精确工具链构建。
3. 运行完整构建门禁、实际产物检查和完整地图 E2E。
4. 在 Windows 上检查安装、启动、退出、卸载；在主机断网后检查扫描、地图、批注与导出。
5. 记录本次安装器及 app.asar 的 SHA-256、检查人、时间、步骤与结果。
6. 用验收文件组装版本目录，检查发布说明、签名状态、SHA-256，再准备 GitHub 资产。
7. 推送对应提交和本次版本标签，确认 CI，再通过 GitHub Release 上传已经验收的安装器、便携包和校验文件。发布说明列出版本变更、支持平台、地图获取要求和实际签名状态；随后更新 README 下载入口。不要在源码仓库提交 `out/` 或 `releases/`。

## 自动门禁

本地完整构建使用以下命令。GitHub 还提供手动工作流 **Windows installer validation**（Actions → 选择工作流 → Run workflow），会审计依赖、运行完整门禁、检查便携产物并执行公开 E2E，留存测试安装器与证据。它不会发布 GitHub Release，也不代表人工安装、卸载或整机断网验收已通过。

```powershell
pwsh -NoProfile -File ./scripts/verify-local.ps1 -Gate all
npm run package:verify -- out/PhotoMap-portable-win32-x64
npm run e2e:packaged
$env:PHOTOMAP_E2E_MAP_DATA_FIXTURES = '<自行取得的地图目录>'
npm run e2e:map
```

完整构建生成 Squirrel 安装器、nupkg、RELEASES、便携目录及 `out/release-build.json`。Squirrel 暂存路径必须为 ASCII；需要时向 `make-windows.ps1` 传入可写的 ASCII `-StageBase`。

`verify-local.ps1` 按 `scripts/build/input-manifest.json` 记录产品构建输入的身份；组装脚本检查构建输入、门禁记录、版本、包内容及哈希一致。任何影响构建输入的修改后都要重新生成证据。README 和文档图片不属于产品构建输入，修改它们仍应检查展示与链接，但不要求重建未改变的产品。

组装参数 `-FastGateResultRoot` 可接收本次 `-Gate all` 或 `-Gate fast` 的结果目录；完整门禁已经包含源码检查，无需再重复执行 fast。

门禁以实际 `summary.json` 和对应日志记录执行结果；不能根据文件名或未执行的检查项推断通过。

## 人工验收文件

将实际检查结果写入仓库忽略的本地文件，结构如下。示例中的 `notRun` 不代表通过；占位字段必须由真实记录替换。

```json
{
  "schemaVersion": 1,
  "applicationVersion": "0.3.0",
  "reviewedBy": "<实际检查人>",
  "reviewedAtUtc": "<实际 UTC 时间>",
  "statement": "<验收范围与结论>",
  "installerSha256": "<本次 PhotoMap-Setup.exe 的 SHA-256>",
  "applicationPayloadSha256": "<本次 resources/app.asar 的 SHA-256>",
  "installerSmokeTest": { "status": "notRun", "notes": "尚未执行" },
  "offlineSmokeTest": { "status": "notRun", "notes": "尚未执行" }
}
```

使用 `Get-FileHash -Algorithm SHA256` 取得实际哈希。测试状态只接受 `passed`、`failed`、`notRun`，必须附说明。记录绑定精确版本、安装器与应用载荷，不可复用旧包的确认。

```powershell
pwsh -NoProfile -File ./scripts/release/assemble-release.ps1 `
  -FastGateResultRoot '<门禁结果目录>' `
  -E2EResultRoot '<完整地图 E2E 结果目录>' `
  -ExpectedVersion '0.3.0' `
  -ReleaseAcceptancePath '.local/release-acceptance.json'
```

不提供验收文件时可组装候选目录，但状态是 `pending`；检查存在缺口时是 `reviewed-with-gaps`。仅当显式提交的安装器和断网检查均通过，才记录 `accepted`。`prepare-github-release.ps1` 会拒绝缺少这些证据的候选目录。

公开 E2E 的 renderer 离线模拟不能替代整机断网验收。签名状态另行记录，不由人工确认自动变成已签名。当前未配置 Authenticode，发布说明应如实标明。

## 准备 GitHub 上传文件

先完成上面的本地组装，使 `releases/v1.0.0/` 中的验收状态为 `accepted`，并确认本次版本标签已存在、指向经过验收的发布提交。以下以 `v1.0.0` 为例，实际发布时替换为本次版本；已有标签应先核对，不覆盖其指向。输出目录必须尚不存在。

```powershell
pwsh -NoProfile -File ./scripts/release/prepare-github-release.ps1 `
  -TagName 'v1.0.0' `
  -OutputRoot '.local/github-upload-v1.0.0'
```

脚本读取对应版本目录，复核标签、版本、源码身份、人工验收与产物哈希，在指定目录生成安装器、便携 ZIP、发布 manifest、SHA-256 清单和 `RELEASE-NOTES.md`；返回的 `assets` 是应上传的四个附件路径。它只准备本地文件，不推送标签，也不创建 GitHub Release。

`OutputRoot` 就是最终输出目录，脚本不会再在其下附加版本号。上述示例直接生成：

```text
.local/github-upload-v1.0.0/
  PhotoMap-v1.0.0-Setup-win32-x64.exe
  PhotoMap-v1.0.0-portable-win32-x64.zip
  PhotoMap-v1.0.0-release-manifest.json
  PhotoMap-v1.0.0-SHA256SUMS.txt
  RELEASE-NOTES.md
```

完成仓库与文档检查后，推送本次提交和版本标签，在 GitHub 创建该标签的 Release，将 `RELEASE-NOTES.md` 作为发布说明并上传四个附件。发布后实际检查下载链接与文件校验和，再把该 Release 的实际地址加入 README。
