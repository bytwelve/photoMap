# 素材清单与使用说明

本文件列出项目图像和地图数据的来源、处理链与许可边界。项目源代码及维护者有权授权的素材贡献采用 [MIT 许可证](LICENSE)；第三方数据保留各自适用的条款。

## 运行时地图图片

[地图目录](resources/map) 包含以下四张 PNG。[地图绘制代码](src/renderer/map-scene/scene.ts) 引用这些图层，[打包配置](forge.config.ts) 将整个目录作为运行资源带入安装包。

| 文件 | 用途、像素尺寸与文件大小 | SHA-256 |
| --- | --- | --- |
| `terrain-expanded-uniform-r16.png` | 地形背景；1536 × 1468；2,734,576 bytes | `aa76fa763b2a9c2375580efec94b975f9b385e0bf03f1ec5c9646110d80f7fbc` |
| `terrain-coast-repair-uniform-r16.png` | 海岸修补图层；1536 × 1468；658,112 bytes | `190f83fa67bda13ed5a0b7b601fabd615547d54a0cf270e8e92de89e409039bc` |
| `province-lines-uniform-r16.png` | 省界图层；2000 × 1710；132,481 bytes | `8ca854be5a9ed74987b2d30f65f278ed40ebaaf6d56cfefcf5c93b90f57b455f` |
| `national-outline-uniform-r16.png` | 全国轮廓图层；2000 × 1710；48,736 bytes | `3d77d12a965b25ad574797afca61a3319bb5c355f5ede536e09c49619ba8f9b1` |

文件哈希的固定值见[资源校验测试](tests/unit/release-map-data-packaging.test.ts)。

### 已核实的图层组合方式

- 地形背景与海岸修补图具有相同的源图尺寸。`drawBaseMap` 先绘制地形，再将修补图覆盖到同一个目标矩形。
- 省界与全国轮廓是独立的透明背景线条图。`drawBoundaries` 在省级视图中叠加省界图片，在市级视图或省界图片不可用时使用导入的 GeoJSON 路径描边，随后叠加全国轮廓图片。
- [坐标配置](src/renderer/map-scene/projection.ts) 定义 2000 × 1710 的地图绘制坐标。两张地形图片使用扩展的 `TERRAIN_BOUNDS`，两张线条图片绘制到地图画布。绘制尺寸与源 PNG 像素尺寸是不同概念。
- 四张图都是项目现有的预制资源，由应用从本地加载；现有生成行政区目录的脚本不会生成这些 PNG。

## 邮箱图片

[`vintage-green-mailbox.png`](src/renderer/assets/vintage-green-mailbox.png) 是绿色复古邮箱的透明背景装饰图，源图尺寸为 **941 × 1672**，文件大小为 **937,379 bytes**，SHA-256 为 `3aa2a3941a34c108f689a671289641417008b291e6f173c3021b6fa0aeadf072`。

[明信片样式](src/renderer/styles/postcard.css) 在投递区域与完成界面引用同一张图，通过 CSS 调整位置、缩放并添加投影；投递区域使用的宽高比与源图一致。它通过 [Webpack 图片资源规则](webpack.renderer.ts) 进入应用，不由运行时生成。

## 运行时图片的来源与许可

2026-09-08，维护者声明这五张图片由其通过 AI 生成，并授权按 MIT 分发。2026-09-10 核对历史脚本、生成清单与实际文件后，确认地图 PNG 还包含以下数据处理步骤；维护者声明不能代替这部分第三方来源记录。

| 当前图片 | 已核实的直接输入与处理 |
| --- | --- |
| `terrain-expanded-uniform-r16.png` | 从 `terrain-expanded-r14.png` 重采样为连续纬度投影；历史记录描述外围 AI 扩展并保留原主体像素 |
| `terrain-coast-repair-uniform-r16.png` | 从 `terrain-coast-repair-r15.png` 重采样；r15 使用 Natural Earth 海陆与海岸数据修补背景，以省份 GeoJSON 生成中国区域排除掩膜 |
| `province-lines-uniform-r16.png` | 从 `province-lines-r13.png` 重采样；未找到 r13 原始线图的生成脚本 |
| `national-outline-uniform-r16.png` | 从 `national-outline-r12.png` 重采样；未找到 r12 原始线图的生成脚本 |
| `vintage-green-mailbox.png` | AI 生成，依据为维护者声明；未提供原始生成记录 |

[地图素材来源记录](docs/assets/map-provenance.json) 保存这条输入链、历史证据哈希与当前输出哈希。四张地图 PNG 与历史 r16 输出的 SHA-256 均一致；本次只核对文件和生成代码，没有重新执行历史图像生成流程。具体 AI 工具、模型、原始提示词及最初参考输入尚未取得，不补写未知信息。

### Natural Earth

海岸修补使用 `natural-earth-vector` v5.1.2 的完整 land、coastline 和 ocean 数据，来源为 [Natural Earth 上游仓库](https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2/geojson)。2026-09-10 核对的[官方使用条款](https://www.naturalearthdata.com/about/terms-of-use/)将其全部版本的栅格与矢量数据置于 public domain，允许修改、电子分发及商业使用，不要求另行许可或署名。项目仍保留来源与版本，便于复核。

Natural Earth 的条款不覆盖另行输入的天地图省份排除掩膜。该省份文件与应用地图版本清单的哈希相同，其适用条款的未决状态见下文。

### 分发授权与边界

维护者有权授予的图片贡献按 [MIT 许可证](LICENSE) 提供，版权声明为 `Copyright (c) 2026 PhotoMap contributors`。第三方输入不会因此自动变为 MIT；尚未核实的参考输入或上游数据权利不能由本声明补授。

分发维护者素材时保留项目版权声明与完整 MIT 许可，建议同时附上本素材说明。构建流程将它们放入 `resources/licenses/`，项目许可证名为 `LICENSE-PhotoMap.txt`。当前记录已确认 Natural Earth 的使用条件；海岸修补掩膜所用天地图几何的分发依据仍待补齐，行政区目录的性质见[上游依据与核验状态](#上游依据与核验状态)。

## GeoJSON 与行政区目录

[地图版本清单](src/shared/map-data-manifest.json) 记录天地图下载入口，以及应用接受的两份 GeoJSON 的文件大小和 SHA-256。

原始 GeoJSON 不随仓库及安装包分发，由用户自行取得和导入，具体操作与版本限制见[使用指南](docs/USAGE.md#地图数据)。

[行政区目录](src/shared/administrative-regions.data.json) 包含来源入口、输入文件哈希和地区代码、名称等字段。[生成脚本](scripts/generate-administrative-regions.cjs) 从校验后的 GeoJSON 提取目录信息，输出行政区 JSON。

### 上游依据与核验状态

行政区目录与海岸修补掩膜都由天地图 GeoJSON 派生，但派生出的内容性质不同，分别记录。

**行政区目录：不含几何的事实数据。** [行政区目录](src/shared/administrative-regions.data.json) 共 409 条记录（34 条省级、375 条市级），每条只有 `level`、`code`、`name`、`parentProvinceCode` 四个字段，不含任何坐标或几何，整个文件约 54 KB。其内容是行政区划代码、法定名称与隶属关系。《中华人民共和国著作权法》第五条规定本法不适用于具有行政性质的文件及单纯事实消息，通用数表同样不构成作品。同一批事实由民政部全国行政区划信息查询平台和国家地名信息库公开发布，可脱离天地图独立核对。天地图 GeoJSON 在这里只是提取这些事实时使用的输入，`provenance` 字段记录它是为了可复现，不是目录本身的授权依据。目录随源码和安装包分发。

**海岸修补掩膜：几何成果留在已分发的栅格里。** `terrain-coast-repair-uniform-r16.png` 使用天地图省份**几何**计算中国区域排除掩膜。几何是上游投入所在，其成果体现在这张随包分发的图片中，与上面的事实数据不同。这项派生使用的适用条款尚未取得，是真实待办。

截至 2026-09-10，也尚未验证当前官方下载入口及这两份精确 GeoJSON 的可获得性。第三方转载、其他地区天地图条款或“免费下载”不能替代本数据来源的授权依据。原始 GeoJSON 不随仓库和安装包分发。

因此公开分发前的待办收敛为两项：取得覆盖海岸修补掩膜用途的天地图条款或授权；从官方入口重新取得两份 GeoJSON 并核对哈希，确认新用户能拼出地图。本地既有文件通过测试不能替代其中任何一项。具体完成条件见[发布检查清单](docs/RELEASE_CHECKLIST.md#地图公开前置条件)。本节记录本项目的判断依据与待办，不构成法律意见。

## 地图合规与审图号

本项目在本机绘制中国地图并支持导出图片，因此涉及地图管理相关规定，此处记录事实与未决事项。

《地图管理条例》对向社会公开的地图规定了送审与标注审图号的要求，互联网地图服务另有资质要求。**本项目未申请审图号**，也不提供在线地图服务：应用离线运行，边界几何由用户自行取得并导入，绘制与导出都在用户本机完成，项目不托管、不下发地图数据。

需要注意两点。其一，[`resources/map/`](resources/map) 中的省界与全国轮廓图层随安装包分发，属于随软件提供的地图图形，不因用户自备 GeoJSON 而免除。其二，README 与文档中的界面截图包含地图画面。这些情形是否落入需要送审的范围，尚未取得主管部门意见。

将本项目用于公开发布地图产品、提供在线地图服务或商业分发前，应先向自然资源主管部门咨询并完成相应审核。个人本地使用与公开分发地图产品是不同情形，本节不替代其判断，也不构成法律意见。

## 合成照片与概念图

- [测试照片说明](tests/fixtures/photos/README.md) 记载七张旅行摄影风格素材由内置图像生成工具生成，并按项目 MIT 许可提供；[照片清单](tests/fixtures/photos/manifest.json) 记录其文件信息。它们不是实际旅行或私人照片记录，不进入应用安装包。其中六张于 2026-09-11 由 PNG 转为 JPEG 质量 92（渐进式、无 EXIF），像素尺寸不变，使公开验收覆盖用户实际最常见的 JPEG 解码路径，并把仓库中的测试素材从约 17 MB 降到约 5 MB；`beijing-great-wall.png` 保留 PNG。清单中的 `sourceSha256` 仍指向各自的原始图像，转码前后的来源链未变。
- [README 首图](docs/images/travel-map-growth.png) 由维护者于 2026-09-10 提供，用于展示「添加旅行照片 → 填入对应地区 → 不断丰富照片地图」的概念流程，不是软件截图或实际导出。图片尺寸为 **1774 × 887**，文件大小为 **2,227,395 bytes**，SHA-256 为 `11cf70bfe1a2867362f90ada27a9da9a7035f25754941bcd5257dec8bf077d8d`。本次按原文件替换，未裁切或重新压缩。原始制作方式、参考输入与独立许可信息未随图片提供，不沿用被替换旧图的生成与许可记录。

## 界面截图

[README](README.md) 中的实际界面截图使用项目合成照片和演示批注，不包含私人照片。

[导出分享图成品](docs/images/share-card.png) 来自应用「导出分享图」的实际导出画布，使用默认边框与标题字号，并通过编辑器收紧底部留白。为展示多照片拼接效果，每个省级区块配置七张不同的公开合成照片，共 238 张演示照片，拼图密度设为 7；地点标注仅供演示，不代表真实拍摄地点或旅行记录；南海岛礁保留应用底图。[生成脚本](tests/e2e/capture-share-docs.mjs) 在隔离图库中准备素材、打开导出编辑器并保存其完整分辨率 PNG，不对成图另行补画或合成。运行前需按[开发指南](docs/DEVELOPMENT.md)准备地图环境变量，使用项目固定 Node 版本执行 `node tests/e2e/capture-share-docs.mjs`。

现有截图在合成照片转为 JPEG 之前生成，画面内容一致，重新运行截图脚本会因转码产生极小的像素差异。

截图中的运行时图片和测试照片适用本页对应的来源与许可说明。截图或导出图不会改变其中地图几何及第三方组件各自的许可，也不会消除上文尚未完成的来源核验。

第三方软件依赖及完整许可证的收集方式见[第三方声明](THIRD_PARTY_NOTICES.md)。
