# MVP 迭代 4 完成报告：图片预览

> 日期：2025-08-21 ｜ 提交：`831a7dc` ｜ 状态：✅ 完成并已安装

## 本轮交付

### T-401：host 图片读取路由
- `GET /api/dsk-develop-ui/fs/read-image?path=` → `{ dataUrl, mime }`
- `ctx.fs.readBytes`（Uint8Array → Buffer → base64 dataUrl），**5MB 上限**（`MAX_IMAGE_BYTES`，超限 FS_TOO_LARGE→413）
- 扩展名 → MIME 推断（png/jpg/gif/svg/webp/bmp/ico），非图片拒绝

### T-402：client 图片预览
- 图片扩展名识别 → 点击图片文件走 `read-image` 预览（**不读文本**）
- 内容区 `viewMode: 'image'` 渲染 `<img>`（objectFit contain）
- 图片视图隐藏保存/片段按钮（无可编辑内容）

## 测试结果

- ✅ 全量：markdown 12 + fs-service 4 + highlight 12 断言 + SMOKE + repro
- ✅ typecheck 0 错误、构建通过、已安装（client 33.8KB）

## MVP/P1 功能全景（累计 12 项）

| 功能 | 状态 |
|---|---|
| 文件树（当前工作区/目录树/面包屑/刷新）| ✅ |
| 查看 / 编辑保存（dirty+Ctrl+S+版本守卫）| ✅ |
| md 源码/预览 + 代码块高亮 | ✅ |
| 代码文件源码/高亮 | ✅ |
| @文件 整文件引用 / 片段级引用 | ✅ |
| **图片预览（P1）** | ✅ |
| 隐藏过滤 / 路径记忆 / 自动检测 | ✅ |

## 遗留

| 项 | 说明 |
|----|------|
| details 列集成 | single 槽被工具详情占据，替换风险高 |
| 引用升级结构化 chip | 需 session-scope ctx 设计 |

## 下一步

- 重启 DSH 验证：点击图片文件（.png/.svg 等）→ 面板内显示预览
- 产品概述 P0/P1 基本全覆盖；后续可做引用 chip 升级或收尾文档（验收对照）
