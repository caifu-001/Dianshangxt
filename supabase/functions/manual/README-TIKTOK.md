# TikTok Shop 数据同步 · 网页控制台手动部署（复制粘贴版）

本目录的 `tiktok-*/index.ts` 4 个文件是**自包含单文件**版本：已把 `../_shared` 的公共模块全部内联进去，可直接复制粘贴到 Supabase 网页控制台，不需要 CLI、不需要额外文件。

> Amazon 部署见同目录 `README.md`。两套函数共用同一批 Supabase 自动变量与 `TOKEN_ENCRYPTION_KEY`、`SYNC_CRON_SECRET`、`FRONTEND_URL`，TikTok 只需额外填自己的 6 个 Secret。

## 第一步：填 Secrets（Supabase 控制台 → Project Settings → Edge Functions → Secrets）

> ⚠️ **`SUPABASE_` 开头的不要手动创建**——平台自动注入 `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`，手动添加会报 `Name must not start with the SUPABASE_ prefix`。

TikTok 独有的 Secret（申请到应用后填写）：

| Secret 名 | 值 | 说明 |
|---|---|---|
| `TIKTOK_APP_KEY` | 待申请 | TikTok Shop 开放平台应用 App Key |
| `TIKTOK_APP_SECRET` | 待申请 | App Secret（用于 HMAC-SHA256 签名） |
| `TIKTOK_SERVICE_ID` | 待申请 | 应用 Service ID |
| `TIKTOK_REDIRECT_URI` | 部署 callback 后回填 | 形如 `https://<project>.supabase.co/functions/v1/tiktok-oauth-callback` |
| `TIKTOK_SCOPES` | 可留空 | 授权 scope，按申请时开通的填；留空不强制 |
| `TIKTOK_MARKET` | `global` 或 `us` | 美国站填 `us`（走 services.us 域名），其余填 `global` |

与 Amazon 共用的 Secret（已填过就不用重复填）：

| Secret 名 | 值 | 说明 |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | 命令行生成 | `openssl rand -base64 32`，32 字节 base64。⚠️ 必须和 Amazon 用同一个，否则两套 token 互不兼容 |
| `SYNC_CRON_SECRET` | 自定义强随机串 | 定时任务口令 |
| `FRONTEND_URL` | `https://kuahaishidai.dpdns.org` | OAuth 回调后跳回的前端地址 |

> 现在没有 TikTok 凭证也可以先把函数和 Secret 建好：函数会返回「尚未配置凭证」，前端显示黄条提示，不影响 Amazon 和其它功能。

## 第二步：创建 4 个函数并粘贴代码

Supabase 控制台 → **Edge Functions → Create a new function**，函数名**必须完全一致**（前端按名字调用）：

| 函数名 | 复制哪个文件 | 行数 |
|---|---|---|
| `tiktok-oauth-start` | `tiktok-oauth-start/index.ts` | ~761 |
| `tiktok-oauth-callback` | `tiktok-oauth-callback/index.ts` | ~797 |
| `tiktok-sync` | `tiktok-sync/index.ts` | ~928 |
| `tiktok-disconnect` | `tiktok-disconnect/index.ts` | ~757 |

操作：点 Create a new function → 填函数名 → 把对应 `index.ts` 的**全部内容**粘贴进编辑器 → Deploy。

创建 `tiktok-oauth-callback` 后，回到第一步把 `TIKTOK_REDIRECT_URI` 回填为它的实际 URL：`https://rjdoimnicmibxfwcjchn.supabase.co/functions/v1/tiktok-oauth-callback`。

## 第三步：放开 region 约束（数据库增量脚本）

TikTok 授权用 `us` / `global` 市场标识，原 Amazon 的 `platform_connections.region` 只允许 `na/eu/fe`。需在 Supabase **SQL Editor** 执行 `supabase/tiktok_sync_schema.sql`（幂等，可重复执行）。

## 第四步：验证

浏览器控制台执行（把 `<anon-key>` 换成项目 publishable key）：

```js
fetch('https://rjdoimnicmibxfwcjchn.supabase.co/functions/v1/tiktok-sync', {
  method: 'POST',
  headers: { Authorization: 'Bearer <anon-key>', 'Content-Type': 'application/json' },
  body: '{}',
}).then(async r => console.log(r.status, await r.text()))
```

- `404 NOT_FOUND` → 函数没部署成功，检查函数名
- `503 NOT_CONFIGURED` → **函数已部署成功**，只是凭证还没填（预期状态）
- `200/401` → 函数已运行

前端「数据接入中心」切换到 TikTok 标签会自动探测：未部署显示红条，凭证未配置显示黄条，都就绪才允许点「连接店铺」。

## 定时同步

如需 TikTok 也定时同步，在 `.github/workflows/amazon-sync.yml` 的 curl 循环里追加 `tiktok-sync`（两平台共用同一个 cron secret）。手动同步在「数据接入中心」按平台分别触发。

## 常见问题

- **`TIKTOK_MARKET` 选错**：美国站卖家必须填 `us`，授权走 `services.us.tiktokshop.com`；其它站点填 `global`。
- **token 7 天过期**：同步函数会自动刷新，无需人工干预。
- **开发者邮箱**：注册开放平台用的邮箱不能和卖家账号绑定，否则只能走自用路线，开不了 Public App。
- **改了代码要更新**：网页控制台重新粘贴 → Deploy；CLI 版用仓库根目录模块化版本（`tiktok-*/index.ts` + `_shared/`），不要用本目录合并版。
- **同步时报「记录已存在 / duplicate key / 唯一键重复」**：旧版同步函数的 `upsert(onConflict)` 带了 `user_id`，但订单/商品/库存的唯一键是团队级的 `(store_id, ...)`，导致 upsert 命中不了唯一约束而退化成插入冲突。本目录代码已修正为 `store_id,...`，**请把 4 个函数重新粘贴并 Deploy 一次**即可，无需改数据库。
