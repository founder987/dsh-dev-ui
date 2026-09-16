# DSH Desktop 2.0.10 启动失败修复（client 半外部模块面漂移 + 布局槽契约升级）

> 日期：2026-09-16 ｜ 版本：0.1.5 → 0.1.6 ｜ 症状：DSH Desktop 升级到 2.0.10 后**无法启动**

## 1. 现象与证据

用户导出的诊断包 `diagnostics-1789545553921-…`：

```
dsh-plugin-desktop: renderer boot failed (plugins: @deepseek-ai/dsh-client-ui-sidebar,
  …-sidebar-right, …-documentpreview, …-files, …-conversation, …-chat, …-workflow-run,
  …-workspace, …-goal, …-trajectory, …-directory-picker-browse, …-deliverables):
  The client Loader did not provide an error message.
RendererStartupFailure: Renderer boot failed for 12 plugin(s)
```

- `lifecycle-events/summary.json`：`host-boot` 45.5s（异常长）、`renderer-startup` 1.26s **failed**；`failureReason: renderer-failed`。
- 失败条目集合（12 个）**恰好是 `layout` 服务的依赖闭包**：ui-sidebar / ui-sidebar-right / ui-workspace
  直接 `inject: ['layout', …]`；ui-conversation 依赖 uiWorkspace；chat/goal/trajectory/workflow-run/
  deliverables 依赖 uiConversation / sidebarRight；sidebar-files / documentpreview 依赖 sidebarRightTabs。
- `health-snapshots/` 显示 09:52 的两次「healthy-startup」快照里 profile `bundles` **不含**
  `dsh-develop-ui`（当时已卸载）→ 装上本插件即失败、卸下即正常，指向本插件。
- DSH Desktop 的渲染健康门（`dsh-plugin-desktop` client）判定逻辑是
  `loader.entries().filter(e => e.fiber?.state !== 2)`（非 active 即计入）——12 个条目 pending
  说明它们的注入服务里有一个永远不出现：官方 `ui-layout` 被本插件 patch 禁用后，
  **本插件就是 `layout` 的唯一提供者**。

## 2. 根因（两个叠加问题）

### 2.1 client 半 require 了已不存在的包 → 整个 client 半从不激活（主因）

在隔离 DSH_HOME 里复跑同版本宿主 + 无头 Chrome（CDP 抓控制台）得到原始报错：

```
Error: failed to import loader entry 834a7764 (dsh-develop-ui):
client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table
— not a platform seed word, not a materialized module, and no registered package factory
```

- dsh 0.1.5-rc.2 里 **`@deepseek-ai/dsh-client-runtime` 已不存在**（0.1.0-rc.7 时代的包），
  `defineStore` 迁到平台 seed 包 **`@deepseek-ai/dsh-client-store`**。
- `src/client/shell/DevFrame.tsx` 仍 `import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'`，
  esbuild 把它编成 `require("@deepseek-ai/dsh-client-runtime/client")`；宿主模块表既非 seed、
  也非 `__DSH_BOOT__` 图内包 → **factory 物化同步抛错** → 插件条目 import 失败 → `apply` 从未执行
  → `layout` 服务不存在 → §1 的 12 个官方条目全部 pending → 桌面渲染进程启动失败。
- 条目 import 失败时 loader 不给 fiber（`entry.fiber === undefined`），桌面报告里的列表只列出了
  pending 的官方条目，本插件名不在其中——这也是最初排查容易跑偏的地方。

### 2.2 root 槽子声明仍是 0.1.0-rc.7 契约（修复 2.1 后暴露）

0.1.5-rc.2 官方 AppFrame（`@deepseek-ai/dsh-client-ui-layout`）契约：

| 项 | 0.1.5-rc.2（新） | 本插件旧值（rc.7） |
|---|---|---|
| root 子槽 | `sidebar`(single/root)、`main`(**keyed**/root)、`rightbar`(single/root)、`shell.overlay`(list/root) | sidebar、conversation、details、shell.overlay |
| `ctx.layout` 面 | `selectPanel` / `beginNavigation` / `dispose` / `toggleSidebar` / `openRightbar` / `closeRightbar` | `toggleSidebar` / `openDetails` / `closeDetails` |
| panelInfo | `ctx.slots.provideRoot({ hooks: { panelInfo } })` | 无（靠注册的 `inject` 钩子接线 actions） |
| store 动作 | `selectPanel` / `retainMainPanels` / `setSidebar` / `toggleSidebar` / `setViewportWidth` / `setRightbar` / `openRightbar` / `closeRightbar` | setSidebar/setDetails/openDetails/closeDetails/setNarrow… |

旧声明导致：官方 ui-conversation 注册的 `main`（keyed，key=`conversation`）与 ui-sidebar-right 注册的
`rightbar` 无槽可落，官方详情/右侧栏无法渲染；框架渲染 `details`（strict session 槽）时抛
`SlotAssemblyError: strict session slot 'details' rendered without a scope binding`。

## 3. 修复内容

- `src/client/shell/DevFrame.tsx`
  - `defineStore` 改自 **`@deepseek-ai/dsh-client-store`**（平台 seed）。
  - store 状态改为官方同形：`panelInfo.activePanelId` + `layoutInfo`（sidebar/viewportWidth/
    narrowExpanded/rightbar/rightbarShown/rightbarTrack/rightbarFullscreen/rightbarInstant），
    动作集对齐官方 stores.ts（外加本插件 tree/editor/chat 三个列宽动作）。
  - 新增 `solveRightbarNormal`（官方 columns.ts 的 rightbar 规则：`available = viewport − sidebar − 400`，
    钳制 `[300, viewport*0.7]`）；右侧栏列改为官方语义：**轨道宽 0 时 occupant 自锚右缘悬浮**，
    渲染 `renderSlot('rightbar', { width, viewportWidth, canShow })`。
  - 会话列渲染官方 **`main`**（keyed）：`renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })`。
- `src/client/index.ts`
  - `DevLayoutController` 重写为官方 0.1.5-rc.2 LayoutController 等价面（含 `selectPanel` 的
    main 面板存在性校验与 `beginNavigation` 取消信号）。
  - root 注册改为官方同款接线：本插件创建 store 实例 → `slots.provideRoot({ hooks: { panelInfo } })`
    → `reflect.provide('layout')` → `slots.register(root, { children, store })` →
    `slots.subscribe('main', retainMainPanels)`；不再依赖注册的 `inject` 钩子拿 actions。
- `package.json`：`dsh.client.inject` 去掉 `@deepseek-ai/dsh-client-runtime`（已不存在）与
  `@deepseek-ai/dsh-client-ui-layout`（本插件接替其角色，不能反过来依赖它），补
  `@deepseek-ai/dsh-client-store`；peerDeps/devDeps 同步（devDeps 装 `0.1.5-rc.2` 供 `tsc` 取类型）。
- 回归防线：`tests/integration/client-bundle-format.test.mjs` 新增
  - `[5.1]/[5.2]/[5.3]`：root 子槽 = sidebar/main(keyed)/rightbar/shell.overlay、panelInfo 钩子、
    `ctx.layout` 接口齐备；
  - `[15]`：`lib/client.js` 的全部 `require` 必须命中平台 seed 或 `dsh.client.inject` 图内包
    （正是本次事故的机器可检断言）。

## 4. 验证方法（可复现）

隔离环境（不动真机 profile 与用户进程）：

```powershell
# ① 复制 profile 到隔离 DSH_HOME（.dsh-module-fallback 是 dsh 自管目录，需删掉让它自愈）
robocopy C:\Users\User\.dsh\profiles\desktop <隔离>\.dsh-test\profiles\desktop /E
Remove-Item <隔离>\.dsh-test\profiles\desktop\.dsh-module-fallback -Recurse -Force

# ② 用 DSH Desktop 自带 CLI 以隔离 DSH_HOME 起 web 宿主
$env:ELECTRON_RUN_AS_NODE=1; $env:DSH_HOME=<隔离>\.dsh-test
& 'D:\apps\DSH Desktop\DSH Desktop.exe' --expose-internals `
  'D:\apps\DSH Desktop\resources\app\lib\desktop-cli.js' --profile desktop --port 3099 --no-open

# ③ 无头 Chrome + CDP 探针（脚本：scripts/probe-client-boot.mjs）抓渲染进程控制台与 DOM
node scripts/probe-client-boot.mjs "http://127.0.0.1:3099/?token=<打印的 token>" 15000
```

修复前：`require("@deepseek-ai/dsh-client-runtime/client") missed the module table`，页面空白。
修复后：`[dsh-develop-ui] client half loaded (layout provider)`，无异常，探针
`devFrame: true`，页面渲染出官方工作区/对话 UI（说明 web shell 的 `assertEntriesActive`
——与桌面渲染健康门同源——已无 pending 条目）。

其余回归：`node tests/unit/*.mjs`、`node tests/integration/*.mjs` 全绿；
`tests/repro/double-load.test.mjs` 失败为**既有问题**（该测试的行未声明 `inject: ['webServer','fs']`，
已在 HEAD 上复现同样报错，与本次改动无关）。

## 5. 落地

- 已用项目自带安装脚本把 0.1.6 装入真机 profile（`node scripts/install-plugin.mjs`，未重启桌面）：
  `C:\Users\User\.dsh\profiles\desktop` 中版本 = 0.1.6，client 半 require 面已为
  `react / react-dom / react/jsx-runtime / @deepseek-ai/dsh-client-store / @deepseek-ai/dsh-client-ui-primitives`。
- **完全退出并重启 DSH Desktop 后生效**；期望：渲染健康门不再报 `renderer boot failed`。
- 顺手修了安装脚本的一处误报：node-pty 校验原先只看 `build/Release/pty.node`，而
  node-pty 的 `loadNativeModule` 会回退到 `prebuilds/<platform>-<arch>`，且 win32 加载的是
  `conpty` / `conpty_console_list`（非 `pty`）——现在按运行时真实查找路径逐名检查。

## 6. 遗留（下一步）

- `workspaces` 服务在 0.1.5-rc.2 已无 `openPath`（`@deepseek-ai/dsh-api-workspace-controller` 只剩
  create/rename/delete/reorder/…），因此 **C12「聊天内打开文件」拦截失效**（现状：打一条
  `workspaces service unavailable, openPath interceptor skipped` 警告后跳过）。需按新 API
  （ui-workspace / sidebar-right 的 openTab 通道）重做该功能。
- 若干 client 文件仍 `import type … from '@deepseek-ai/dsh-client-runtime/client'`（类型仅编译期，
  不影响运行时，本地 rc.7 副本可满足 `tsc`），应在下次迭代把这些类型迁到 0.1.5 之后的包。
- `tests/repro/double-load.test.mjs` 需补行内 `inject` 声明才能重新跑通（既有问题）。
