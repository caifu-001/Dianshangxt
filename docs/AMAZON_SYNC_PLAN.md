# Amazon 平台数据自动同步 — 技术方案

> 目标：用户在系统内用 OAuth 授权自己的 Amazon 卖家账号后，订单、商品、库存自动同步到现有表，贯通利润 / 绩效 / 采购闭环。
> 适用架构：GitHub Pages 静态前端 + Supabase（Auth / Postgres / PostgREST / Edge Functions）。
> 原则：**不推翻现有表结构、不把密钥放前端、不自动写费用字段**（避免污染利润生成列）。

---

## 1. 总体架构

```
┌────────────────────┐
│  浏览器（静态前端）  │
│  设置 → 平台连接    │
└─────────┬──────────┘
          │ ① 点「连接 Amazon」→ 302
          ▼
┌────────────────────┐       ② LWA 授权页（Amazon）
│ amazon-oauth-start │ ──────────────────────────────► 用户登录并同意
│  (Edge Function)   │ ◄────── ③ 回调 /oauth-callback?code&state
└─────────┬──────────┘
          │ ④ code 换 token（客户端密钥只在服务端）
          ▼
┌───────────────────────────────────────────────┐
│  platform_connections（加密存 refresh_token） │
└─────────┬─────────────────────────────────────┘
          │ ⑤ 定时触发（GitHub Actions cron / Supabase Cron）
          ▼
┌────────────────────────┐   SigV4 签名 + LWA token  │  Amazon SP-API
│  amazon-sync           │ ─────────────────────────► │  Orders / Catalog
│  (Edge Function, Deno) │ ◄───────────────────────── │  FBA Inventory
└─────────┬──────────────┘   增量游标 + 限流退避      │  Financial Events
          │ ⑥ 幂等写入（service_role）
          ▼
┌─────────────────────────────────┐
│  orders / products / inventory  │  ← 现有表，无需改结构
│  sync_runs（同步日志）           │
└─────────────────────────────────┘
```

关键点：**前端永远拿不到 client secret / refresh token / AWS 密钥**。所有敏感调用在 Edge Function 内完成。

---

## 2. 前置准备（账号与资质）

| 项目 | 说明 | 周期 |
|---|---|---|
| 专业卖家账号 | Amazon 要求 Professional 账号才能创建开发者资料。个人账号需先升级（$39.99/月） | 即时 |
| 开发者资料 | Seller Central → Apps and Services → Develop Apps → Create Developer Profile | — |
| **私有应用（Private seller）** | 只服务自己公司、自授权、无需公开审计 | **3–7 天** |
| 公共应用（Public seller） | 服务多家公司、需官网 HTTPS + 隐私政策 + 安全问卷（PwC/ISG） | 20–60 天 |
| AWS IAM 用户 | 建 IAM User，策略 `AmazonSellingPartnerAPI...`（execute-api:Invoke），拿 Access Key / Secret / Role ARN | 即时 |
| LWA 应用 | 在 Developer Central 创建 app client，拿 Client ID / Secret，配置 OAuth 重定向 URI | 即时 |

**第一阶段建议：私有应用（Private seller）**。因为本系统是多租户，但第一版只接你自己的店铺；先把闭环跑通，再评估是否申请公共应用开放给所有入驻公司。私有应用授权卖家上限 25 个，足够内部验证。

⚠️ 私有应用只能给自己公司用。若后续要让各入驻公司授权自己的店铺，必须转公共应用（走审计）。

---

## 3. 数据库设计

### 3.1 新增 `platform_connections`（店铺授权连接）

```sql
create table if not exists public.platform_connections (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  store_id          uuid not null references public.stores(id) on delete cascade,
  platform          text not null default 'amazon',
  seller_id         text,                    -- Amazon merchant seller id
  marketplace_ids   text[] not null default '{}',  -- 如 {ATVPDKIKX0DER}
  region            text not null default 'na',    -- na / eu / fe
  token_cipher      text,                    -- refresh token 密文（pgcrypto 加密）
  token_expires_at  timestamptz,
  scopes            text[] not null default '{}',
  status            text not null default 'active'
                    check (status in ('active','paused','error','revoked')),
  last_sync_at      timestamptz,             -- 增量游标：上次同步到哪
  last_error        text,
  connected_by      uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, store_id, platform)
);
alter table public.platform_connections enable row level security;
create policy platform_connections_select on public.platform_connections
  for select to authenticated
  using (public.has_permission('stores.view') and public.in_company(company_id));
-- 写操作只走 Edge Function（service_role），不给前端 insert/update policy
```

- **加密**：用 `pgcrypto` 的 `pgp_sym_encrypt` / `pgp_sym_decrypt`，密钥放 Supabase Vault 或 Edge Function secret，绝不进代码库。
- **隔离**：查询必须带 `company_id = 当前公司`，普通成员看不到 token 字段（在前端层做字段裁剪，或建视图隐藏 `token_cipher`）。

### 3.2 新增 `sync_runs`（同步日志）

```sql
create table if not exists public.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  connection_id uuid references public.platform_connections(id) on delete cascade,
  job_type      text not null,   -- orders / products / inventory / financial
  status        text not null check (status in ('running','ok','partial','failed')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  rows_new      integer not null default 0,
  rows_updated  integer not null default 0,
  cursor_from   timestamptz,
  cursor_to     timestamptz,
  error         text,
  detail        jsonb not null default '{}'::jsonb
);
create index if not exists idx_sync_runs_conn on public.sync_runs(connection_id, started_at desc);
alter table public.sync_runs enable row level security;
create policy sync_runs_select on public.sync_runs
  for select to authenticated
  using (public.has_permission('stores.view') and public.in_company(company_id));
```

同步结果同时写一条 `system_logs`（category=`business`，action=`sync_completed`），复用现有日志中心。

### 3.3 现有表：无需改结构

| 表 | 现有唯一键 | 幂等策略 |
|---|---|---|
| `orders` | `(user_id, store_id, order_no)` | `order_no` 直接存 Amazon `AmazonOrderId`，重复同步触发 `on conflict` 更新 |
| `products` | `(user_id, store_id, sku)` | `sku` 存 Amazon `SellerSKU`，`asin` 字段已存在 |
| `inventory` | `(user_id, store_id, sku, warehouse)` | `warehouse` 用 `FBA-<站点>`，如 `FBA-US` |

> 注意：`user_id` 对同步数据统一填该店铺所属公司的负责人 / 连接创建人（`connected_by`），保持与现有 RLS 兼容。写入用 service_role 绕过 RLS，但 Edge Function 内部必须校验 `company_id` 一致。

---

## 4. OAuth 授权流程（Login with Amazon）

1. **发起**：前端点「连接 Amazon」→ 调 `amazon-oauth-start?store_id=xxx`
2. **生成 state**：Edge Function 生成随机 `state`（防 CSRF），把 `company_id / store_id / state` 短期存入 `oauth_states` 表（5 分钟过期），拼 LWA 授权 URL：
   ```
   https://www.amazon.com/ap/oa
     ?client_id=<LWA Client ID>
     &scope=readorders readcatalog readinventory readfinancials
     &response_type=code
     &redirect_uri=https://<project>.supabase.co/functions/v1/amazon-oauth-callback
     &state=<state>
   ```
3. **回调**：Amazon 跳回 `amazon-oauth-callback?code=...&state=...`，校验 state 一致且未过期
4. **换 token**：服务端用 `code + client_id + client_secret + redirect_uri` 请求 `https://api.amazon.com/auth/o2/token`，拿 `refresh_token`
5. **落库**：加密后写入 `platform_connections`，标记 `status=active`，写系统日志
6. **首次同步**：异步触发一次全量/近 90 天同步

刷新令牌长期有效（除非用户取消授权）；访问令牌 1 小时过期，每次调用前用 refresh token 换新。

---

## 5. Edge Function 结构

```
supabase/functions/
├── _shared/
│   ├── amazon.ts       # LWA token 刷新 + AWS SigV4 签名 + 请求封装 + 限流重试
│   ├── db.ts           # service_role 客户端，统一 company_id 校验
│   ├── crypto.ts       # token 加解密
│   └── cors.ts
├── amazon-oauth-start/index.ts     # 生成 state，302 跳转
├── amazon-oauth-callback/index.ts  # code 换 token，落库
├── amazon-sync/index.ts            # 主同步入口（定时 + 手动）
└── amazon-disconnect/index.ts      # 解除授权，删除 token
```

### 5.1 `amazon.ts` — 签名与调用要点

- **双认证**：每个 SP-API 请求都要 `x-amz-access-token`（LWA access token）+ AWS SigV4 签名（`Authorization` header）。
- **端点**：
  - 北美 `https://sellingpartnerapi-na.amazon.com`
  - 欧洲 `https://sellingpartnerapi-eu.amazon.com`
  - 远东 `https://sellingpartnerapi-fe.amazon.com`
- **限流**：各接口 QPS 不同（如 `getOrders` 通常 ~2/s，`getOrderItems` ~2/s），按响应头 `x-amzn-ratelimit-limit` 动态调整；429/503 走指数退避（1s→2s→4s→8s，最多 5 次）。
- **分页**：用 `NextToken` 翻页，单批处理 100 条。
- **错误**：记录 `x-amzn-RequestId`，便于向 Amazon 工单排查。

### 5.2 `amazon-sync/index.ts` — 同步主流程

```
for each active connection:
  token = refreshAccessToken(connection)
  cursor = connection.last_sync_at ?? now - 90 days

  # 订单
  orders = GET /orders/v0/orders?CreatedAfter=cursor&MarketplaceIds=...
  for each order:
     items = GET /orders/v0/orders/{AmazonOrderId}/orderItems
     upsert orders（order_no = AmazonOrderId）
  cursor_orders = max(LastUpdateDate)

  # 商品（ASIN → SellerSKU）
  catalog = GET /catalog/v0/items/{asin} 或 searchCatalogItems
  upsert products（sku = SellerSKU, asin = ASIN）

  # FBA 库存
  summaries = GET /fba/inventory/v1/summaries?details=true
  upsert inventory（warehouse = FBA-{marketplace}）

  update connection.last_sync_at = cursor_to
  insert sync_runs + system_logs
```

**首次同步**：`last_sync_at` 为空时默认拉最近 90 天，避免一次性拉全量触发限流；历史数据可在设置页手动「补同步」。

---

## 6. 字段映射

### 6.1 订单 `orders`

| 现有字段 | SP-API 来源 | 说明 |
|---|---|---|
| `order_no` | `AmazonOrderId` | 幂等键 |
| `order_date` | `PurchaseDate` | 转 date |
| `sku` | `OrderItem.SellerSKU` | 一单多品时按行拆单 |
| `title` | `OrderItem.Title` | |
| `quantity` | `OrderItem.QuantityOrdered` | |
| `unit_price` | `OrderItem.ItemPrice.Amount` | 原币，与店铺 currency 一致 |
| `status` | `OrderStatus` | `Pending→pending`、`Shipped→shipped`、`Delivered→delivered`、`Cancelled→cancelled`、`Refunded→refunded` |
| `country` | `ShippingAddress.CountryCode` | 只取国家码，不存详细地址 |
| `customer_name` | — | **留空**（PII，第一阶段不取） |
| `platform_fee` | — | **留空**（见 6.4） |
| `fba_fee / shipping_fee / ad_cost` | — | 留空或沿用现有手填值 |
| `product_id` | 按 `sku` 关联 `products` | 关联失败不阻断入库 |

> 一单多 SKU：按订单行拆成多条 `orders` 记录，共享同一 `order_no` 会撞唯一键。解决：用 `order_no = AmazonOrderId + '-' + 行序号`，并在 `note` 存原始 `AmazonOrderId`；或在第一阶段只取主商品行。建议**按行拆单 + 序号后缀**。

### 6.2 商品 `products`

| 现有字段 | SP-API 来源 |
|---|---|
| `sku` | `SellerSKU` / `sku` |
| `asin` | `ASIN` |
| `title` | `itemName` / `Title` |
| `image_url` | `images[].link` |
| `category` | `productCategory` / `browseNode` |
| `sale_price` | `price.Amount`（若有） |
| `currency` | 店铺币种 |
| `cost_price` | **不动**（采购成本来自系统内采购单，不从平台取） |

### 6.3 库存 `inventory`

| 现有字段 | SP-API 来源 |
|---|---|
| `sku` | `sellerSku` |
| `warehouse` | `FBA-<MarketplaceCode>` |
| `available_qty` | `availableQuantity` |
| `inbound_qty` | `inboundQuantity` |
| `reserved_qty` | `reservedQuantity` |
| `updated_at` | 同步时间 |

- 同步是**覆盖式**（平台是权威库存源），不写 `stock_movements`，避免与手工出入库冲突。

### 6.4 费用与利润（重要）

`orders.profit` 是数据库生成列：`销售额 - cost_amount - platform_fee - fba_fee - shipping_fee - ad_cost - refund_amount - other_fee`。

- 第一阶段**只同步销售额与数量**，费用字段保持为空/0，利润显示为「未扣费毛估」。
- 第二阶段接 `Financial Events API`（`GET /finances/v0/financialEvents?OrderId=...`）取佣金、FBA 费、退款，按订单回填 `platform_fee / fba_fee / refund_amount`。
- 广告费来自 `Ads API` 报表，单独归集到 `campaigns`，再按规则分摊。
- **绝不未经确认就写费用字段**，否则利润数据会错且难以追溯。

---

## 7. 调度策略

| 方式 | 说明 | 推荐 |
|---|---|---|
| GitHub Actions cron | 已有部署基建，每 30–60 分钟 `curl` 调 `amazon-sync` Edge Function（带 service key） | ✅ 第一阶段 |
| Supabase Cron (pg_cron + pg_net) | 数据库内置定时，减少外部依赖 | 第二阶段 |
| 前端手动按钮 | 设置页「立即同步」，调 Edge Function | 必备（补同步/排错） |

- 每个连接独立记录 `last_sync_at`，失败不影响其他连接。
- 单连接同步加锁（数据库 advisory lock），防止定时与手动并发重复跑。

---

## 8. 前端改造

- **设置页 → 平台连接卡片**：列出各店铺的 Amazon 连接状态、最后同步时间、同步按钮、解除授权。
- **连接向导**：选店铺 → 跳 LWA 授权 → 回调后提示成功并触发首次同步。
- **同步状态**：在「运营驾驶舱 / 系统日志」展示同步成功率、失败原因（复用 `sync_runs` 与 `system_logs`）。
- **普通成员只读**：连接/解除按钮仅 `system.manage` 或店铺负责人可见。

权限码沿用现有：`stores.view` / `stores.edit`，新增 `sync.manage`（可选，默认授予 admin）。

---

## 9. 合规与安全

- **不存 PII**：买家姓名、电话、地址、邮箱一律不落库；国家码可保留。
- **密钥管理**：LWA Client Secret、AWS Access Key、加密密钥放 Supabase Edge Function Secrets / Vault，不进 git。
- **Token 加密**：`refresh_token` 用 pgcrypto 对称加密存储，解密只在 Edge Function 内存中进行。
- **权限最小化**：SP-API scope 只申请 `readorders / readcatalog / readinventory / readfinancials`，不申请写权限（第一阶段纯只读）。
- **隐私政策**：公共应用阶段必须有 HTTPS 官网 + 隐私政策 + 数据删除机制；第一阶段私有应用可豁免。
- **审计**：每次同步写 `sync_runs` + `system_logs`，包含请求 ID、行数、耗时。

---

## 10. 成本

| 项 | 费用 |
|---|---|
| SP-API 调用 | 免费（受限流约束） |
| Supabase Edge Functions | 免费额度内（50 万次/月）足够 |
| GitHub Actions cron | 免费额度内 |
| Amazon 专业卖家账号 | $39.99/月（卖家本身需承担） |
| AWS IAM | 免费 |

---

## 11. 实施阶段与验收

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0 准备** | 专业卖家账号、开发者资料、私有应用、AWS IAM、LWA app | 拿到 Client ID/Secret、AWS Key、Role ARN |
| **P1 授权** | `platform_connections` 表 + oauth-start/callback 两个函数 | 点连接能完成授权，token 加密落库，前端显示已连接 |
| **P2 订单同步** | amazon-sync 订单分支 + 字段映射 + 幂等 | 近 90 天订单同步进 `orders`，重复跑不产生重复单 |
| **P3 商品/库存** | catalog 与 FBA inventory 分支 | `products` / `inventory` 与后台一致 |
| **P4 调度与可观测** | cron + 手动同步 + sync_runs + 日志 | 定时自动跑，失败有日志和告警 |
| **P5 财务（可选）** | Financial Events 回填费用 | 佣金/FBA/退款回填正确，利润可追溯 |
| **P6 公共应用（可选）** | 官网、隐私政策、安全问卷、审计 | 各入驻公司可独立授权自己的店铺 |

---

## 12. 主要风险

| 风险 | 应对 |
|---|---|
| 私有应用不能服务多家公司 | 第一阶段只接自有店铺；多公司需走公共应用审计 |
| PII 审核严格 | 第一阶段不取任何 PII |
| 一单多 SKU 唯一键冲突 | 按行拆单 + 序号后缀 |
| 费用字段写错污染利润 | 费用留空，第二阶段用 Financial Events 精确回填 |
| Amazon 限流 / schema 变更 | 限流退避 + 请求 ID 日志 + 定期查看 SP-API Release Notes |
| Token 泄露 | 加密存储 + 服务端专用 + 不进前端与 git |
| 同步覆盖手工库存 | 只覆盖 FBA 仓，国内仓不动；不写 stock_movements |

---

## 13. 待确认事项

1. 是否已有 **Amazon 专业卖家账号**？若无，需先注册（$39.99/月）。
2. 第一阶段只接**你自己的店铺**，还是要开放给所有入驻公司？（决定私有 / 公共应用路线）
3. 主要站点/区域：北美（na）、欧洲（eu）还是日本（fe）？决定 API 端点。
4. 是否需要广告数据（`campaigns`）也自动同步？这要额外接 Ads API。
5. 一单多 SKU：按行拆单是否可接受？
