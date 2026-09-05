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

