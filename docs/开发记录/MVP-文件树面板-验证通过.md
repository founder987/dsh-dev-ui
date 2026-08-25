# MVP 文件树面板：真机验证通过

> 日期：2025-08-21 ｜ 状态：✅ 验证通过

## 验证结论

dsk-develop-ui 插件在 DSH Desktop 2.0.1 中完整运行：

- ✅ host 半：`ctx.webServer` 注册 `/api/dsk-develop-ui/*` 路由（fs list/read/write + md render），插件行 `inject: ['webServer', 'fs']`
- ✅ client 半：`exports.inject = ['slots']` + `exports.apply`（sidebar.footer.action 按钮 + shell.overlay 面板），经 `ctx.slots.inject/register` 注册
- ✅ 启动零错误（日志无 failed to load / inject 报错）

## 排障记录（2026-08-21 连续修复链）

| # | 报错 | 根因 | 修复 |
|---|------|------|------|
| 1 | `service "fsOps" has been registered` | cordis `Service` 构造自动 `ctx.provide` + apply 显式 provide = 双重注册 | apply 只 `new`，不显式 provide（`tests/repro/double-load.test.mjs` 本地复现） |
| 2 | `cannot get property "webServer" without inject` | cordis 服务访问必须行级 `inject` 声明 | cordis.patch.yml 行加 `inject: ['webServer', 'fs']` |
| 3 | `cannot get property "slots" without inject`（client 半） | bundle 静态包 client 半需 `exports.inject` 声明 | client/index.ts 导出 `export const inject = ['slots']` |

## 关键架构事实（已验证）

- profile bundle 包 = 一个"层"，层的行 = 包内 `cordis.patch.yml` 内容 → **必须 insert 自己**（官方 dsh-web-app 同款）
- host 半 HTTP 路由：`ctx.webServer.register({ kind: 'exact', path, handler })` + 本机端口校验（参照 market）
- client 半 slots：`ctx.slots.inject(name, () => ctx.slots.register({ name, id }, Component))`，list 槽 additive
- 工作区路径：MVP 面板手动输入（后续接 session cwd 自动检测）

## 下一步

- 功能级验证：📁 按钮、目录树加载、md 预览、编辑保存（Ctrl+S + dirty）
- 后续迭代：details 列集成文件内容、conversation @文件 引用、代码高亮、工作区路径自动检测
