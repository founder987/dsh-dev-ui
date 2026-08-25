# dsk-develop-ui

DSH（DeepSeek Harness）一体化开发视图插件：**文件树 + 文件编辑/预览 + agent 对话** 同屏协作。

## 功能全景（MVP 已实现）

| 功能 | 说明 |
|------|------|
| 文件树面板 | 当前工作区自动检测（session cwd）、目录树（懒加载展开）、面包屑导航、刷新、隐藏目录过滤（.git/node_modules）、路径记忆 |
| 文件查看 | 文本/代码查看；**md 源码⇄渲染预览**（代码块高亮）；**代码文件源码⇄高亮**（shiki）；**图片预览** |
| 编辑保存 | textarea 编辑、● 未保存标记、Ctrl+S 落盘、**版本守卫**（冲突 409 提示 + 重新加载）、大文件拦截（>1MB） |
| 对话引用 | composer **@文件**（整文件引用）、**片段级引用**（选中文本发送给 agent） |
| 扩展 | 侧栏 📁 开关、overlay 面板（可折叠）、错误/空/加载状态 |

## 形态

DSH **profile bundle 插件**（Cordis 双半，社区标准）：

- **host 半**（`src/host/` → `lib/index.js`）：文件系统（`ctx.fs` 版本守卫原子写）、md 渲染（markdown-it + 任务列表）、代码高亮（shiki）；经 **`ctx.webServer` HTTP 路由**（`/api/dsk-develop-ui/*`）暴露给浏览器半（含本机端口校验）
- **client 半**（`src/client/` → `lib/client.js`）：`__ModuleLoader__` lazy-CJS 格式 React UI；经 fetch 调 host 路由；三个槽位：sidebar.footer.action（📁）、shell.overlay（面板）、conversation.input.left（@文件）

## 安装（手动，DSH Desktop）

```powershell
# ① 打包
pnpm pack                                    # → dsk-develop-ui-0.1.0.tgz

# ② 安装到 desktop profile
cd C:\Users\User\.dsh\profiles\desktop
pnpm add "E:\...\dsk-develop-ui-0.1.0.tgz"

# ③ 编辑 C:\Users\User\.dsh\profiles\desktop\package.json：
#    dsh.profile.bundles 追加 "dsk-develop-ui"

# ④ 重启 DSH Desktop
```

## 开发命令

```bash
pnpm install        # 安装依赖
pnpm build          # esbuild 双入口 + tsc 类型声明（node build.mjs && tsc --emitDeclarationOnly）
pnpm typecheck      # 类型检查（tsc --noEmit）
# 单测（需先 pnpm build 产出 lib/*.js）：
node tests/unit/markdown.test.mjs
node tests/unit/fs-service.test.mjs
node tests/unit/highlight.test.mjs
node tests/integration/client-bundle-format.test.mjs   # client bundle 冒烟
node tests/repro/double-load.test.mjs                  # host 加载回归
```

> 环境备注（Windows + DSH Desktop）：PATH 中 pnpm 为 DSH 内置包装器，`pnpm run` 会嵌套 spawn 被拦截——用 `node build.mjs` 直跑；esbuild 在文件沙箱内 spawn 被拦截，构建需完整权限或真实终端（详见 `docs/开发记录/初始化记录.md`）。

## 文档

- `specs/` — 产品概述（MVP 验收）、技术栈、开发规范、开发路线图、项目结构、交互设计
- `docs/开发记录/` — 初始化、M0 验证、迭代报告、验收核对

## 依赖版本对齐

与 DSH 2.0.1（`dsh-plugin-desktop`）运行时对齐：react 18.3、shiki 4.4、`@deepseek-ai/*` 0.1.0-rc.7。
