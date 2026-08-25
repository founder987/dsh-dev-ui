# MVP 迭代完成报告：@文件 引用 + 路径记忆

> 日期：2025-08-21 ｜ 提交：`022eab8` ｜ 状态：✅ 完成并已安装

## 本轮交付

### T-103：conversation @文件 引用（产品概述 P0）
- **`conversation.input.left` 槽**（list，additive）注册 **@文件 按钮**（`src/client/conversation/FileRefButton.tsx`）
- 点击按钮 → 打开文件树面板（**引用模式**）→ 选文件 → 点"**引用此文件**"→ 经 `inputActions.setDraft` 把 `文件：name（path）` 注入 composer 草稿（agent 可感知）
- 跨槽通信：模块级 store（`setInsertRefFn`/`callInsertRef`/`pendingRef`）桥接 input.left 与 overlay 两个槽的组件

### T-101（MVP 替代方案）：路径记忆
- 工作区路径 localStorage 记忆（`dsk-develop-ui.rootPath`），重开面板自动填充——替代自动检测的 MVP 方案
- **workspace-root 自动检测**：列为遗留（需进一步查证 session cwd / workspaceRegistry 的会话关系 API）

## 测试结果

- ✅ smoke：**3 个槽位**注册（sidebar.footer.action / shell.overlay / conversation.input.left）
- ✅ 全量：markdown 12 + fs-service 4 + highlight 12 断言 + repro OK
- ✅ typecheck 0 错误、构建通过、已替换安装（client 25.9KB）

## 遗留问题

| 项 | 说明 | 建议 |
|----|------|------|
| workspace-root 自动检测 | 需查 session cwd / workspaceRegistry 会话关系 API | 下一轮 |
| details 列集成 | details 槽 single 被工具详情占据，替换风险高 | 专门验证 |
| 引用为文本注入 | 非结构化 chip（`insertReference` 需 session-scope ctx/服务） | 后续升级 |

## 下一步

- 重启 DSH 验证 @文件 流程（composer 出现 @文件 按钮 → 选文件 → 引用注入）
- 继续迭代：workspace-root 自动检测 / details 列 / 片段级引用
