# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.3.0 - 2026-09-02

### 新增

- 支持普通照片、普通视频、Apple Live Photo 与 Android Motion Photo 的识别与展示
- 明信片模式支持编辑拍摄时间、在原文件夹内重命名文件、投递最后一张明信片
- 侧栏按文件夹筛选

### 变更

- 使用 ExifReader 强化 EXIF / GPS 解析
- 移除与 `typecheck` 重复的 `lint` 脚本
- 优化批量批注与明信片媒体交互

### 修复

- 未标记地点筛选的计数与交互

## 0.2.0 - 2026-08-30

### 新增

- 批注模式与区域快捷入口
- 照片加载与 EXIF 识别
- 批注地图数据与 GPS 标签处理解耦

### 变更

- 升级明信片交互
- 优化筛选与分类排序

## 0.1.0 - 2026-08-27

- 初始化项目：Electron + React + TypeScript，照片墙、SQLite 索引与 Windows 打包
