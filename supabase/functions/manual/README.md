# Edge Functions 网页控制台手动部署（复制粘贴版）

本目录的 4 个 `index.ts` 是**自包含单文件**版本：已把 `../_shared` 的所有公共模块内联进去，可以直接复制粘贴到 Supabase 网页控制台，不需要 CLI、不需要额外文件。

> 仓库里 `amazon-*/index.ts` + `_shared/` 是给 Supabase CLI 用的模块化版本；本目录是同一份代码的合并版，功能完全一致，二选一即可。

## 第一步：填 Secrets（4 个函数共用）

Supabase 控制台 → 左侧 **Project Settings → Edge Functions → Secrets**（或 Functions → Secrets），逐个 Add new secret：

> ⚠️ **`SUPABASE_` 开头的不要手动创建**——Supabase 会自动注入 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`，手动添加会报 `Name must not start with the SUPABASE_ prefix`。代码里直接读这三个环境变量即可，无需任何操作。GitHub Actions 那边的同名 secret 是仓库变量，不在这个页面填，两者互不影响。

| Secret 名 | 值 | 说明 |
|---|---|---|
| `AMAZON_LWA_CLIENT_ID` | 待申请 | Login with Amazon 应用 Client ID |
| `AMAZON_LWA_CLIENT_SECRET` | 待申请 | Client Secret |
| `AMAZON_REDIRECT_URI` | 部署 callback 后回填 | 形如 `https://<project>.supabase.co/functions/v1/amazon-oauth-callback` |
| `AWS_ACCESS_KEY_ID` | 待申请 | IAM 用户 Access Key |
| `AWS_SECRET_ACCESS_KEY` | 待申请 | IAM Secret |
| `AWS_ROLE_ARN` | 待申请 | SP-API 角色 ARN |
| `TOKEN_ENCRYPTION_KEY` | 命令行生成 | `openssl rand -base64 32` 的输出，32 字节 base64 |
| `SYNC_CRON_SECRET` | 自定义强随机串 | GitHub Actions 定时同步的口令，和 workflow secret 保持一致 |
| `FRONTEND_URL` | `https://kuahaishidai.dpdns.org` | OAuth 回调后跳回的前端地址 |
| `AMAZON_SCOPES` | 可留空 | 留空用默认 `readorders readcatalog readinventory readfinancials` |

> 现在没有 Amazon 凭证也可以先把函数和 Secrets 建好：函数会在调用时返回「尚未配置凭证」，前端会给出明确提示，不影响其它功能。

## 第二步：创建 4 个函数并粘贴代码

Supabase 控制台 → 左侧 **Edge Functions → Create a new function**，按下面顺序逐个创建。

函数名**必须完全一致**（前端和定时任务按名字调用）：

| 函数名 | 复制哪个文件 | 行数 |
|---|---|---|
| `amazon-oauth-start` | `amazon-oauth-start/index.ts` | ~729 |
| `amazon-oauth-callback` | `amazon-oauth-callback/index.ts` | ~757 |
| `amazon-sync` | `amazon-sync/index.ts` | ~886 |
| `amazon-disconnect` | `amazon-disconnect/index.ts` | ~718 |

操作：点 Create a new function → 填函数名 → 把对应 `index.ts` 的**全部内容**粘贴进编辑器 → Deploy。

创建 `amazon-sync` 后，回到第一步把 `AMAZON_REDIRECT_URI` 回填为 callback 函数的实际 URL。

## 第三步：验证

浏览器控制台执行（把 `<anon-key>` 换成项目 publishable key）：

```js
fetch('https://rjdoimnicmibxfwcjchn.supabase.co/functions/v1/amazon-sync', {
  method: 'POST',
  headers: { Authorization: 'Bearer <anon-key>', 'Content-Type': 'application/json' },
  body: '{}',
}).then(async r => console.log(r.status, await r.text()))
```

- `404 NOT_FOUND` → 函数没部署成功，检查函数名
- `503 NOT_CONFIGURED` → **函数已部署成功**，只是凭证还没填（预期状态）
- `200/401` → 函数已运行

前端刷新设置页，「平台账号连接」卡片会自动探测部署状态：未部署显示红条，凭证未配置显示黄条，都就绪才允许点「连接店铺」。

## 常见问题

- **粘贴后 Deploy 报错**：确认没有把 Markdown 代码块的 ```` ``` ```` 一起复制进去。
- **`npm:@supabase/supabase-js@2.45.4` 下载慢**：Supabase 首次部署会缓存依赖，第二次起很快。
- **改了代码要更新**：网页控制台重新粘贴 → Deploy；CLI 版则 `supabase functions deploy <name>`。
- **想用 CLI 一次部署全部**：`supabase login` → `supabase link --project-ref rjdoimnicmibxfwcjchn` → `supabase functions deploy --no-verify-jwt` 前先确认 JWT 校验需求；CLI 部署请用仓库根目录的模块化版本（`amazon-*/index.ts` + `_shared/`），**不要用本目录的合并版**。
