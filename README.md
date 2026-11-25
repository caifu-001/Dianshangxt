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

> **已经建过表？** 角色权限体系是后加的，需要**重新完整执行一次**这个脚本。
> 脚本是幂等的：只补列、重建策略与触发器，不会清空已有数据。

3. 回到应用登录 / 注册，系统会自动检测并进入工作台
4. （可选）在「数据源」或「系统设置」中点击 **生成演示数据**，立刻看到完整报表

脚本是幂等的，可以重复执行；包含建表、索引、行级权限（RLS）与注册自动建档触发器。

> 也可以在登录后的「数据源」页面直接点「复制脚本 / 打开 SQL 编辑器」，无需打开本地文件。

> **注册后登录不了？** Supabase 默认开启「邮箱验证」，注册后需点邮件里的确认链接。
> 内部工具若不想验证，可到 Supabase 控制台 → Authentication → Sign In / Providers → Email，
> 关闭 **Confirm email** 后重新注册即可（已有账号需要再确认一次邮箱）。

## 角色与权限

三级角色，团队成员**共享同一套业务数据**，权限决定能做什么：

| 能力 | 超级管理员 | 普通管理员 | 普通人员 |
| --- | :--: | :--: | :--: |
| 查看 / 新增 / 编辑业务数据 | ✅ | ✅ | ✅ |
| 删除业务数据（订单 / 商品 / 店铺等） | ✅ | ✅ | ❌ |
| 进入「账号管理」 | ✅ | ✅ | ❌ |
| 调整普通人员的角色与状态 | ✅ | ✅ | ❌ |
| 调整管理员 / 超级管理员的角色 | ✅ | ❌ | ❌ |
| 移除账号档案 | ✅ | ❌ | ❌ |
| 修改汇率 / 清空数据 / 生成演示数据 | ✅ | ✅ | ❌ |
| 修改自己的资料与密码 | ✅ | ✅ | ✅ |

**初始化顺序**：数据库里**第一个注册的账号自动成为超级管理员**，之后注册的都是普通人员，
再由超管在「账号管理」页调整。所以第一次使用时请用你自己的邮箱先注册。

**权限在三层同时生效**：① 侧边栏菜单按角色隐藏；② 页面级路由守卫（普通人员访问 `/accounts` 会被重定向）；
③ 数据库 RLS 策略 + 触发器。即使绕过界面直接调接口，Postgres 也会拒绝。

**防锁死设计**：超级管理员不能降低自己的角色、不能移除自己；脚本末尾的 `ensure_super_admin()`
会在系统没有超管时，把最早注册的账号自动提升上来。

**删除的安全性**：`deleteRow()` 会回读被删除的行数，RLS 拒绝时会明确提示
「没有删除权限」，不会出现界面显示成功但其实没删的情况。

> 当前是**单团队共享**模型。如果需要多公司 / 多团队数据隔离，需要引入 `org_id` 并改写 RLS 策略，
> 这是另一套设计，需要的话告诉我。

## 账号安全

代码里已经内置的防护：

| 机制 | 说明 |
| --- | --- |
| 图形验证码 | Canvas 绘制 4 位字符（排除 0/O/1/I/L），点击换一张，校验失败自动刷新，登录/注册/发码前都需通过 |
| 密码强度 | 至少 8 位，且包含「小写 / 大写 / 数字 / 符号」中的两类，注册与改密时实时提示 |
| 失败锁定 | 同一邮箱连续输错 5 次，锁定 15 分钟并显示倒计时 |
| 邮箱验证码登录 | 一次性 6 位码，60 秒重发冷却，10 分钟有效，无需记密码 |
| 改密验证 | 修改密码前必须重新输入当前密码，避免会话被盗后直接接管账号 |
| 数据隔离 | 9 张业务表全部启用 RLS，`user_id = auth.uid()`，账号之间互相不可见 |

### 邮箱验证码要真正可用，需在 Supabase 做三步

**1. 配置自有 SMTP（必须）**
`Authentication` → `Emails` → `SMTP Settings`。
Supabase 内置邮件服务**每小时仅 2 封，且只能发给项目成员**，验证码基本发不出去。
推荐 Resend（免费 100 封/天）、SendGrid 或企业邮箱 SMTP。

**2. 让邮件显示 6 位数字（可选）**
`Authentication` → `Emails` → `Magic Link`，把正文里的 `{{ .ConfirmationURL }}` 换成 `{{ .Token }}`。
不换也能用 —— 邮件里是一条登录链接，用户点它同样能完成登录。

**3. 加 Redirect URL 白名单**
`Authentication` → `URL Configuration` → `Redirect URLs`，加入：

```
https://caifu-001.github.io/Dianshangxt/
http://127.0.0.1:5173/
```

> **失败锁定的边界**：前端锁定基于 `localStorage`，清缓存即可绕过，它拦的是"同一浏览器随手试密码"这类最廉价的手段。
> 服务端真正的防线是 Supabase Auth 自带的 rate limit。生产环境建议同时在
> `Authentication` → `Providers` → `Email` 里开启「Confirm email」并要求强密码。

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
