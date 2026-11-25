# 电商运营中台 · Dianshangxt

面向 **Amazon** 与 **TikTok Shop** 双平台的跨境电商运营管理系统。多店铺、多站点数据放在同一张运营报表里：订单、库存、广告、达人、利润一次看清。

> 技术栈：React 18 + TypeScript + Vite + TailwindCSS + Recharts + Supabase (PostgreSQL)

**🌐 线上地址：<https://caifu-001.github.io/Dianshangxt/>**

前端由 GitHub Pages 托管（push `main` 自动构建发布），数据存放在 Supabase 云端。
首次使用前，需要在该 Supabase 项目的 SQL Editor 执行一次 `supabase/schema.sql` 建表。

![运营概览](docs/preview-dashboard.png)

<details>
<summary>更多界面预览</summary>

![订单管理](docs/preview-orders.png)

![利润核算](docs/preview-profit.png)

</details>


---

## 功能模块

| 模块 | 能力 |
| --- | --- |
| 运营概览 | GMV / 订单 / 净利润 / ACOS 指标卡，销售与利润趋势、平台占比、热销 Top5、库存预警、店铺表现、待办提醒 |
| 店铺管理 | Amazon / TikTok Shop 多店铺多站点档案，近 30 天销售额、订单、净利率、SKU 数、广告占比、目标 ACOS |
| 商品管理 | SKU / ASIN 档案、成本售价、毛利率，搜索筛选、CSV 批量导入导出 |
| 订单管理 | 逐单录入与平台报表导入，佣金 / FBA / 物流 / 广告 / 退款逐项拆解，**利润由数据库生成列自动计算** |
| 库存管理 | 可用 / 在途 / 预留、安全库存、日均销量，自动测算可售天数、补货建议，一键生成补货任务 |
| 广告投放 | SP / SB / SD / GMV Max / Video 活动，ACOS、ROAS、CTR、CVR、CPC，超目标自动标红，一键暂停 |
| 达人合作 | TikTok 达人建联漏斗（待联系 → 已联系 → 寄样 → 合作中），佣金率、带货 GMV、视频产出、待跟进提醒 |
| 利润核算 | 从 GMV 到净利润的完整损益表，费用构成环图、关键比率，费用台账（头程 / 仓储 / 订阅 / 佣金 / 税费） |
| 任务看板 | 待处理 / 进行中 / 已完成三列看板，模块、优先级、负责人、截止日，逾期标红 |
| 系统设置 | 账号资料、数据源状态与各表行数、演示数据生成、一键导出 schema、清空业务数据 |

## 快速开始

```bash
npm install
npm run dev      # http://127.0.0.1:5173
```

## 首次使用：初始化数据库（必做）

1. 打开 <https://supabase.com/dashboard/project/rjdoimnicmibxfwcjchn/sql/new>（SQL Editor → New query）
2. 复制 `supabase/schema.sql` 的全部内容，粘贴并 **Run**
3. 回到应用登录 / 注册，系统会自动检测并进入工作台
4. （可选）在「数据源」或「系统设置」中点击 **生成演示数据**，立刻看到完整报表

脚本是幂等的，可以重复执行；包含建表、索引、行级权限（RLS）与注册自动建档触发器。

> 也可以在登录后的「数据源」页面直接点「复制脚本 / 打开 SQL 编辑器」，无需打开本地文件。

> **注册后登录不了？** Supabase 默认开启「邮箱验证」，注册后需点邮件里的确认链接。
> 内部工具若不想验证，可到 Supabase 控制台 → Authentication → Sign In / Providers → Email，
> 关闭 **Confirm email** 后重新注册即可（已有账号需要再确认一次邮箱）。

## 多币种与汇率

Amazon 各站点币种不同（USD / GBP / EUR / JPY…），系统统一以 **USD 为基准**折算后再汇总：

- 「系统设置 → 汇率与币种」可维护 `1 USD = ?` 的各币种汇率，保存到 `profiles.settings.fx`
- 运营概览、订单合计、广告 KPI、利润表均按该汇率折算
- 单店铺视图仍以该店铺本币展示明细，费用台账保留录入币种


## 环境变量

`.env.example` 中的配置已内置默认值，可覆盖：

```env
VITE_SUPABASE_URL=https://rjdoimnicmibxfwcjchn.supabase.co
VITE_SUPABASE_KEY=sb_publishable_vBOpo9IQaKPg4ACt_nLopg_oiJQAKhy
```

`publishable` / `anon` key 按设计是公开的，安全性由 RLS 保证：**每个账号只能读写自己的数据**。
切勿把 `service_role` 密钥放进前端。

## 数据模型

```
stores ──┬── products ── inventory
         ├── orders
         └── campaigns

creators (TikTok 达人)     tasks (运营任务)     expenses (费用台账)
profiles (账号档案，与 auth.users 一对一)
```

- 所有业务表带 `user_id`（默认 `auth.uid()`）与 RLS 策略
- `orders.gross_amount` / `orders.profit` 为 PostgreSQL 生成列，客户端无需维护
- `orders` 对 `(user_id, store_id, order_no)` 唯一，重复导入会被拒绝

## 导入模板

**订单报表**：订单号、日期、店铺、SKU、商品、数量、单价、佣金、履约费、物流、广告分摊、退款、国家、买家
（Amazon「订单报告」与 TikTok「订单导出」CSV 的常见列名已内置别名映射，可直接上传）

**商品**：店铺、SKU、ASIN、商品名称、类目、成本、售价

列名支持中英文与常见平台字段名，导入前可在弹窗中手动调整对应关系。

## 脚本

```bash
npm run dev        # 本地开发
npm run typecheck  # 类型检查
npm run build      # 生产构建（输出 dist/）
npm run preview    # 预览构建产物
```

## 部署

当前线上版本跑在 **GitHub Pages**：<https://caifu-001.github.io/Dianshangxt/>

- 推送 `main` 触发 `.github/workflows/deploy.yml`：`npm install` → 类型检查 → 构建 → 发布
- 构建产物的资源前缀由 `vite.config.ts` 的 `base` 控制，生产模式固定为 `/Dianshangxt/`
- 构建后自动把 `index.html` 复制成 `404.html`，用于兜住 SPA 子路由刷新（Pages 无服务端 rewrite）
- 仓库改名或绑定自定义域名时，在 `.env` 里设置 `VITE_BASE_PATH=/` 即可（此时 basename 也会自动变）

也可以部署到 Vercel / Netlify / Cloudflare Pages 等任意静态托管，
此时把 `VITE_BASE_PATH` 设为 `/`，并配置 history fallback（所有路径回退到 `index.html`）。

## 目录结构

```
├─ supabase/
│  └─ schema.sql            # 数据库初始化脚本（建表 + RLS + 触发器）
├─ src/
│  ├─ components/           # UI 组件、布局、图表、导入弹窗
│  ├─ context/              # 认证上下文
│  ├─ hooks/                # useAsync 等
│  ├─ lib/                  # supabase 客户端、数据访问、类型、常量、演示数据
│  └─ pages/                # 10 个业务页面
└─ index.html
```
