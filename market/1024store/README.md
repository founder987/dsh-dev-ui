# DSH 1024Store 上架提交（路径 B）

本目录收录提交到官方市场 [DSH 1024Store](https://deepseek1024.com)（目录仓库
[imsai-sh/awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)）所需的条目文件。

1024Store 不会自动从 npm 收录插件，必须向目录仓库提 PR 添加条目；合并后由其
catalog-sync 工作流自动同步到 deepseek1024.com，无需人工干预。

## 提交步骤

1. Fork `imsai-sh/awesome-deepseek-harness-plugins`。
2. 把 `founder987--dsh-dev-ui.json` 复制到 fork 的 `catalog/plugins/` 下
   （文件名即条目 id 的规范化形式：`owner/repository` → `owner--repository.json`）。
3. 提 PR——**只含这一个新文件**，不要改动 README、workflow、scripts 等任何其他路径
   （门禁会拒绝目录外的改动）。
4. 静态校验通过后自动合并、自动同步到网站；之后 DSH Desktop 插件市场选中
   1024Store 来源即可搜到（搜 `dsh-dev-ui` 可命中 id）。

## 提交前自检（PR 门禁会逐项校验）

- [x] `package.json` 声明非空 `dsh.bundle.patch`（`./cordis.patch.yml`），且该文件已提交到仓库
- [x] GitHub 仓库已加 `dsh-plugin` topic（供 tokenless 指标发现）
- [x] npm 已发布 `dsh-develop-ui`（决定"可安装"标签；未发布会显示为仅浏览，不影响收录）
- [ ] PR 中 `added` 日期为实际提交日期（如跨天请顺手更新）
- [ ] 描述保持客观、具体，无夸大用语与行动号召

## 收录后验证

```powershell
# 服务端应返回 1 条
curl "https://deepseek1024.com/api/v1/plugins?q=dsh-dev-ui"
```

桌面端若一时搜不到：市场页点**刷新**（绕过 5 分钟本地索引缓存）后重试。
