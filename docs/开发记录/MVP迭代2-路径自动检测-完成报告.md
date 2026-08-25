# MVP 迭代 2 完成报告：路径自动检测 + 面板导航

> 日期：2025-08-21 ｜ 提交：`014e3d0` ｜ 状态：✅ 完成并已安装

## 本轮交付

### T-201：工作区路径自动检测（产品概述 P0"文件列表"体验闭环）
- **发现**：`shell.overlay` 槽 standardProps 含 `useWorkspaces`；client workspaces 服务（`ctx.workspaces.list`）的 `items[].path` + `recentWorkspaceId` 提供最近工作区路径
- **实现**：面板初始路径 = localStorage 记忆 ?? **最近工作区路径自动检测**；workspaces 异步就绪后 useEffect 回填
- 无需 host 路由（client 侧服务直达），比原方案更简单

### T-202：面板导航增强
- **刷新按钮**（⟳）：重新加载当前目录
- **面包屑导航**：当前路径分段可点击，点击任意上级目录跳转（`breadcrumbParts` 纯函数）

## 测试结果

- ✅ smoke（3 槽）、markdown 12 + fs-service 4 + highlight 12 断言
- ✅ typecheck 0 错误、构建通过、已安装（client 28.7KB）

## 遗留（更新）

| 项 | 说明 |
|----|------|
| details 列集成 | single 槽被工具详情占据，替换风险高（需专门验证）|
| 引用升级 chip | `insertReference` 需 session-scope ctx；input.left 槽无 inject 契约，需 apply 层全局引用入口设计 |
| md 代码块高亮 | 需 shiki 同步/异步与 markdown-it 集成（复杂度上升）|

## MVP 功能全景（当前）

✅ 文件树面板（路径输入/自动检测/目录树/面包屑/刷新）✅ 文件查看/编辑保存（dirty+Ctrl+S+版本守卫）✅ md 源码/预览 ✅ 代码高亮 ✅ 隐藏目录过滤 ✅ @文件 引用 ✅ 路径记忆

## 下一步

- 重启 DSH 验证：打开面板自动带出最近工作区路径；面包屑/刷新可用
- 候选迭代：md 代码块高亮 / details 列专门验证 / 片段级引用（P1）
