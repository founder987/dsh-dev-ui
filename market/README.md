# DSH 插件市场 · 标准目录来源（路径 A）

本目录是 dsk-develop-ui 的**标准目录来源**（DSH Community Market catalog source v1）。

## 文件说明

| 文件 | 作用 | 托管要求 |
|---|---|---|
| `catalog-source.json` | 来源 manifest，用户添加来源时填它的 URL | 任意 HTTPS 静态托管，响应需为 JSON（`.json` 扩展名天然满足） |
| `v1/plugins` | provider page，即 `GET /v1/plugins` 的响应体 | 无扩展名路径，且 **Content-Type 必须是 `application/json`**（见下） |
| `_headers` | Cloudflare Pages 自定义响应头（把 `v1/plugins` 强制为 JSON） | 仅用 Cloudflare Pages 时需要 |

## 必须修改的占位符

1. `catalog-source.json` 中 `transport.endpoint` 的 `https://YOUR-HOST/v1/plugins`
   —— 替换成你的真实域名，**必须与 manifest 自身 URL 同源（同一 HTTPS origin、443 端口）**。
2. `v1/plugins` 中 `latestVersion` 必须与 npm 上实际发布的精确版本一致（每次发新版后同步更新）。

## 托管步骤（任选其一）

### 方式一：Cloudflare Pages（推荐，免费、可自定义 Content-Type）

1. 把 `market/` 目录内容推到 Git 仓库，接入 Cloudflare Pages；
2. `_headers` 已保证 `/v1/plugins` 返回 `application/json`；
3. 得到 `https://<project>.pages.dev/...` 后，把 endpoint 改为实际地址。

### 方式二：Netlify

在站点根加 `netlify.toml`：

```toml
[[headers]]
  for = "/v1/plugins"
  [headers.values]
    Content-Type = "application/json"
```

### 方式三：Vercel

`vercel.json`：

```json
{
  "headers": [
    { "source": "/v1/plugins", "headers": [{ "key": "Content-Type", "value": "application/json" }] }
  ]
}
```

> 不要用 GitHub Pages / Gitee Pages 直接托管 `v1/plugins`：它们无法为无扩展名文件设置
> `Content-Type: application/json`，Host 会以"目录 response 非 JSON"拒绝。

## 消费者如何添加

1. DSH Desktop → 设置 → 插件 → **插件市场** → **来源**；
2. **添加来源**，填 `catalog-source.json` 的 URL（manifest URL）；
3. 选中该来源 → **发现 / 可安装** 中即可看到并安装 dsk-develop-ui。

## 发布前自检（npm 包侧，Host 安装时权威复核）

- [ ] `package.json` 含 `repository` 字段，且与目录条目 `repository.url` 归一化后一致（均已指向 Gitee 仓库）；
- [ ] 版本为精确稳定 `X.Y.Z`（无 range/tag/prerelease）；
- [ ] 无 `preinstall`/`install`/`postinstall`/`prepare` 脚本；
- [ ] `dsh.bundle.patch` 指向包内存在的 cordis patch 文件；
- [ ] 依赖不包含旧版 `cordis`；`@deepseek-ai/cordis` 满足 4.0.1、`@deepseek-ai/dsh*` 满足 0.1.0-rc.7；`engines.node` 接受 24.18.1；
- [ ] npm 上未标记 deprecated。

发布命令（Windows PowerShell 下 npm.ps1 被执行策略禁用，请用 `npm.cmd`）：

```powershell
node build.mjs && tsc --emitDeclarationOnly
npm.cmd login
npm.cmd publish
```
