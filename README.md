# dsh-develop-ui

DSH（DeepSeek Harness）一体化开发视图插件：**文件树 + 文件编辑/预览 + agent 对话** 同屏协作。

## 功能全景（MVP 已实现）

| 功能 | 说明 |
|------|------|
| 文件树面板 | 当前工作区自动检测（session cwd）、目录树（懒加载展开）、面包屑导航、刷新、隐藏目录过滤（.git/node_modules）、路径记忆 |
| 文件查看 | 文本/代码查看；**md 源码⇄渲染预览**（代码块高亮）；**代码文件源码⇄高亮**（shiki）；**图片预览** |
| 编辑保存 | textarea 编辑、● 未保存标记、Ctrl+S 落盘、**版本守卫**（冲突 409 提示 + 重新加载）、大文件拦截（>1MB） |
| 对话引用 | composer **@文件**（整文件引用）、**片段级引用**（选中文本发送给 agent） |
| 终端面板 | 底部多 tab 内嵌终端（`@xterm/xterm` + node-pty 真 shell：PowerShell / cmd / Git Bash），长轮询输出、高度拖拽记忆、右键复制/粘贴、按工作区隔离 |
| 命令白名单 | shell 命令审批**三键**（拒绝 / 允许一次 / 永远允许，永远允许可选粒度：命令名 / 子命令前缀 / 整行精确）；白名单命中自动放行不弹窗；⚙ 管理浮层增删查（localStorage 持久） |
| 扩展 | 侧栏 📁 开关、overlay 面板（可折叠）、错误/空/加载状态 |

## 形态

DSH **profile bundle 插件**（Cordis 双半，社区标准）：

- **host 半**（`src/host/` → `lib/index.js`）：文件系统（`ctx.fs` 版本守卫原子写）、md 渲染（markdown-it + 任务列表）、代码高亮（shiki）；经 **`ctx.webServer` HTTP 路由**（`/api/dsh-develop-ui/*`）暴露给浏览器半（含本机端口校验）
- **client 半**（`src/client/` → `lib/client.js`）：`__ModuleLoader__` lazy-CJS 格式 React UI；经 fetch 调 host 路由；三个槽位：sidebar.footer.action（📁）、shell.overlay（面板）、conversation.input.left（@文件）

## 安装（手动本地安装，DSH Desktop）

> 以下为经真机验证的完整流程（约 2 分钟），来源：`docs/开发记录/M0-真机安装验证.md`。

### 方式一：一键脚本（推荐）

```powershell
cd E:\trae-file\deepseek-harness-client
node scripts/install-plugin.mjs              # 装本地已构建的 tarball；没有则回落 npm 已发布版
```

脚本会依次完成：确定安装源 → `pnpm add` 到 profile → 注册 `dsh.profile.bundles`（自动备份 `package.json.bak`）
→ 校验产物（host/client/patch/node-pty）→ 打印重启与验证指引。

| 常用参数 | 作用 |
|---|---|
| `--from local` | 强制重新 `node build.mjs && tsc --emitDeclarationOnly` + `pnpm pack` 后装本地 tarball |
| `--from npm` | 装 npm 上的已发布版本（不构建） |
| `--version 0.1.5` | 指定 npm 版本（隐含 `--from npm`） |
| `--force` | 先 `pnpm remove` 再装，清掉旧版残留 |
| `--dry-run` | 只打印将执行的动作，不落盘 |
| `--uninstall` | 卸载：移除插件包 + `dependencies` + `bundles` 注册 |
| `--profile "D:\path\profiles\desktop"` | 指定其他 profile 目录 |
| `--registry https://registry.npmjs.org` | 指定 registry（默认沿用环境 `.npmrc`，本机为 npmmirror） |

**装完必须完全退出并重启 DSH Desktop**，bundle 才会加载（脚本不代为重启，避免杀掉当前会话）。

### 方式二：手动步骤（与脚本等价）

### 前置条件

- Node.js `^22.19.0 || >=24.0.0`（见 `package.json engines`）
- DSH Desktop 已安装并**至少启动过一次**（确保 `C:\Users\User\.dsh\profiles\desktop` 已生成）
- 插件源码目录：`E:\trae-file\deepseek-harness-client`

### ① 构建

```powershell
cd E:\trae-file\deepseek-harness-client
node build.mjs && tsc --emitDeclarationOnly   # 产出 lib/index.js（host）、lib/client.js（client）、lib/types
```

> 环境备注（Windows + DSH Desktop）：PATH 中 `pnpm` 是 DSH 内置包装器，`pnpm run` 嵌套
> spawn 会被拦截——构建用 `node build.mjs` 直跑；esbuild 在文件沙箱内 spawn 被拦截，
> **构建需在真实终端 / 完整权限下执行**（详见 `docs/开发记录/初始化记录.md`）。

### ② 打包

```powershell
pnpm pack                                     # → dsh-develop-ui-<version>.tgz（随 package.json 版本，当前 0.1.5）
```

打包前可用 `tar -tzf dsh-develop-ui-<version>.tgz` 自检，期望内容含
`package/lib/index.js`、`package/lib/client.js`、`package/cordis.patch.yml`、`package/package.json`、`package/lib/types/*`、`README.md`。

### ③ 安装到 desktop profile

```powershell
cd C:\Users\User\.dsh\profiles\desktop
pnpm add "E:\trae-file\deepseek-harness-client\dsh-develop-ui-<version>.tgz"
```

> profile 为 `nodeLinker: hoisted` + `autoInstallPeers: false`：插件 peerDeps
> （react、`@deepseek-ai/*`）已由 DSH 运行时提供，无需重复安装；dependencies
> （markdown-it、shiki、`@xterm/xterm`、monaco-editor、node-pty）由 `pnpm add` 自动装入。

### ④ 注册 bundle

编辑 `C:\Users\User\.dsh\profiles\desktop\package.json`，把插件名追加进
`dsh.profile.bundles`：

```json
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-develop-ui"]
  }
}
```

### ⑤ 重启并验证

```powershell
# 完全退出 DSH Desktop 后重新启动（重启会中断当前会话——请先保存/确认）

# a) host 半：查看当日日志
Get-Content "C:\Users\User\AppData\Roaming\DSH Desktop\logs\dsh-$(Get-Date -Format 'yyyy-MM-dd').log" -Tail 50
#    期望无：bundle 加载失败 / MissingClientBundleError

# b) client bundle 可达（端口取 DSH Web GUI 实际监听端口）
Invoke-WebRequest -Uri "http://127.0.0.1:<端口>/plugins/dsh-develop-ui/client.js" -UseBasicParsing | Select-Object StatusCode
#    期望：200，且响应体含 window.__ModuleLoader__.load({ id: "dsh-develop-ui"

# c) client 半：GUI 打开开发者工具（Ctrl+Shift+I）控制台
#    期望出现：[dsh-develop-ui] client half loaded（如无，浏览器硬刷新 Ctrl+Shift+R）
```

### ⑥ 开发迭代循环（改代码 → 重装）

```powershell
# 一键：重建 + 打包 + 覆盖安装 + 校验
cd E:\trae-file\deepseek-harness-client
node scripts/install-plugin.mjs --from local

# 等价手动步骤：
# node build.mjs && tsc --emitDeclarationOnly → pnpm pack
# cd C:\Users\User\.dsh\profiles\desktop
# pnpm remove dsh-develop-ui
# pnpm add "E:\trae-file\deepseek-harness-client\dsh-develop-ui-<version>.tgz"
# 重启 DSH Desktop
```

### 升级 / 卸载 / 回滚

```powershell
cd E:\trae-file\deepseek-harness-client

# 升级：重建打包并覆盖安装（自动先 remove 旧版）
node scripts/install-plugin.mjs --from local --force

# 卸载 / 回滚：移除插件包 + dependencies + bundles 注册
node scripts/install-plugin.mjs --uninstall
# 重启 DSH Desktop 即恢复官方布局
```

> 手动等价：`cd C:\Users\User\.dsh\profiles\desktop` → `pnpm remove dsh-develop-ui`
> → 编辑 `package.json` 从 `dsh.profile.bundles` 移除 `"dsh-develop-ui"`。

> 启用/禁用/卸载也可直接用 DSH 市场或设置 UI 操作，无需改任何配置文件：禁用官方
> `ui-layout` 的 loader patch 已内置在包内 `cordis.patch.yml`（bundle 层），插件被
> 禁用或卸载时该层整层跳过，官方布局自动恢复。

### 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| `client bundle not found` | `lib/client.js` 缺失：重跑构建后重新 `pnpm pack` |
| 端口 404 | GUI 端口动态分配：`netstat -ano \| Select-String LISTENING` 取实际端口（本机曾见 54179/49606/54262/58493） |
| GUI 无 client 日志 | 浏览器需硬刷新（Ctrl+Shift+R）；或 `dsh.client.inject` 依赖图未满足 |
| 启动报 `service "X" has been registered` | apply 里显式 `ctx.provide` 同名服务导致双重注册冲突：只 `new XxxService(ctx)`，不显式 provide（见 `tests/repro/double-load.test.mjs`） |
| 构建/测试命令被沙箱拦截 | esbuild spawn 在文件沙箱内被拦截：需完整权限或真实终端执行 |
| 安装后终端面板不可用 | node-pty 原生模块没编译（`ERR_PNPM_IGNORED_BUILDS`）：在 profile 执行 `pnpm approve-builds` 勾选 node-pty，或在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds: { node-pty: true }` → 重跑安装脚本 |
| `ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS`（卸载时） | 上次安装是半成品（有目录无 `dependencies` 声明）：安装脚本已内置自愈与兜底清理，直接重跑脚本即可 |
| 装完看不到效果 | bundle 只在 DSH Desktop 启动时加载：必须**完全退出并重启**，不是刷新页面 |

## 发布到 npm

前置：`package.json` 已固定 `publishConfig`（`registry: registry.npmjs.org`、`access: public`），首次发布需有 npm 账号。

```powershell
# ① 升版本（npm 不允许覆盖已发布版本）
npm.cmd version patch        # 0.1.2 → 0.1.3；或手动改 package.json 的 version

# ② 全量构建（esbuild 双入口 + 类型声明）
node build.mjs && tsc --emitDeclarationOnly

# ③ 发布前自检：确认 tarball 内容完整（package/lib、cordis.patch.yml、README）
pnpm pack
tar -tzf dsh-develop-ui-<version>.tgz

# ④ 登录（已登录可跳过；Windows 执行策略禁用 npm.ps1，一律用 npm.cmd）
npm.cmd login
npm.cmd whoami               # 验证登录态

# ⑤ 发布
npm.cmd publish

# ⑥ 验证
npm.cmd view dsh-develop-ui version
```

发布后两件事：

1. **同步市场目录**：把 `market/v1/plugins` 的 `latestVersion` 改为新版本号并重新部署（路径 A 自建目录）；1024Store（路径 B）会自动检测 npm 新发布，无需操作。
2. **不要改动已发布版本的内容**：发现 bug 一律发新版本，不要试图覆盖（npm 本身也不允许）。

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
# 安装/卸载插件到 DSH Desktop profile（详见「安装」章节）：
node scripts/install-plugin.mjs --dry-run              # 预览将执行的动作
node scripts/install-plugin.mjs --from local           # 重建打包并覆盖安装
node scripts/install-plugin.mjs --uninstall            # 卸载
```

> 环境备注（Windows + DSH Desktop）：PATH 中 pnpm 为 DSH 内置包装器，`pnpm run` 会嵌套 spawn 被拦截——用 `node build.mjs` 直跑；esbuild 在文件沙箱内 spawn 被拦截，构建需完整权限或真实终端（详见 `docs/开发记录/初始化记录.md`）。

## 文档

- `specs/` — 产品概述（MVP 验收）、技术栈、开发规范、开发路线图、项目结构、交互设计
- `docs/开发记录/` — 初始化、M0 验证、迭代报告、验收核对

## 依赖版本对齐

与 DSH 2.0.1（`dsh-plugin-desktop`）运行时对齐：react 18.3、shiki 4.4、`@deepseek-ai/*` 0.1.0-rc.7。
