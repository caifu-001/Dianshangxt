# Amazon 数据同步 Edge Functions

前端静态站没有服务端，所有敏感操作（OAuth 换 token、SP-API 签名、幂等写库）都在这里。
**当前凭证未配置**：所有函数会返回 `NOT_CONFIGURED` 和缺失项清单，前端据此提示「尚未配置，请管理员在 Supabase 填入凭证」，不会误同步、不会崩溃。

## 目录

| 函数 | 作用 |
|---|---|
| `amazon-oauth-start` | 校验管理员身份 → 生成一次性 state → 跳 LWA 授权页 |
| `amazon-oauth-callback` | code 换 token → AES-GCM 加密 → 落库 → 回跳前端 |
| `amazon-sync` | 定时/手动触发，拉订单/商品/FBA 库存并幂等写现有表 |
| `amazon-disconnect` | 清 token、标记 revoked；保留历史业务数据 |
| `_shared/` | 配置、加解密、Amazon 签名、写库、CORS 公共模块 |

## 部署

```bash
# 安装 Supabase CLI 后，在项目根目录
supabase login
supabase link --project-ref rjdoimnicmibxfwcjchn
supabase functions deploy amazon-oauth-start
supabase functions deploy amazon-oauth-callback
supabase functions deploy amazon-sync
supabase functions deploy amazon-disconnect
```

> 部署前先在 Supabase SQL Editor 执行 `supabase/platform_sync_schema.sql`。

## 需要的 Secrets（Supabase → Project Settings → Edge Functions → Secrets）

**现在可以什么都不填**——系统处于「未配置」状态但其它功能不受影响。拿到 Amazon 公共应用资质后按下表填入：

| Secret | 说明 | 来源 |
|---|---|---|
| `AMAZON_LWA_CLIENT_ID` | LWA 应用 Client ID | Developer Central 创建 app client |
| `AMAZON_LWA_CLIENT_SECRET` | LWA Client Secret | 同上（只显示一次） |
| `AMAZON_REDIRECT_URI` | OAuth 回调地址 | 部署后 callback 函数 URL，如 `https://<ref>.supabase.co/functions/v1/amazon-oauth-callback` |
| `AMAZON_SCOPES` | 权限范围（空格分隔） | 默认 `readorders readcatalog readinventory readfinancials`，按实际审批调整 |
| `AWS_ACCESS_KEY_ID` | IAM 用户 Access Key | AWS IAM |
| `AWS_SECRET_ACCESS_KEY` | IAM Secret | 同上 |
| `AWS_SESSION_TOKEN` | 临时会话令牌 | 用 IAM User 长期凭证时可留空 |
| `AWS_ROLE_ARN` | SP-API 访问角色 ARN | 开发者资料里配的 IAM Role |
| `TOKEN_ENCRYPTION_KEY` | token 加密密钥（32 字节 base64） | 本地生成，见下 |
| `SYNC_CRON_SECRET` | 定时任务校验密钥 | 自己设一个长随机串，同时填到 GitHub Actions secrets |
| `FRONTEND_URL` | 回调后前端落地页 | 默认 `https://kuahaishidai.dpdns.org` |

生成加密密钥：

```bash
openssl rand -base64 32
```

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` 由 Supabase 自动注入，无需手动配置。

## 回调白名单

在 Developer Central 的 LWA 应用里把 `AMAZON_REDIRECT_URI` 加入允许的 redirect URI（必须完全一致，含尾斜杠差异都不行）。

## 安全说明

- refresh token 用 AES-GCM 加密后存库，密钥只在 Edge Function secret 里，数据库和代码库都没有明文。
- 前端只能读本公司连接状态（`list_platform_connections` RPC + RLS），无法读 token。
- 连接/解除只允许公司管理员（或超管），普通成员只读。
- OAuth state 一次性、5 分钟过期，回调即删，防 CSRF 与重放。
- 同步用数据库 CAS 锁（`sync_lock_until`）防止定时与手动并发重复跑。

## 安全边界（第一阶段）

- 只同步订单、商品、FBA 库存，**不落库买家 PII**（姓名/电话/地址/邮箱），只保留国家码。
- 费用字段（佣金/FBA/退款）暂留 0，避免污染 `orders.profit` 生成列；后续接 Financial Events 再精确回填。
- 只申请只读 scope，不申请任何写权限。
