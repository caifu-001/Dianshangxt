-- =============================================================
--  跨境电商运营中台 · 数据库初始化脚本
--  适用：Supabase (PostgreSQL 15+)
--  使用方法：Supabase 控制台 → SQL Editor → 粘贴全部内容 → Run
--  脚本可重复执行（幂等）
-- =============================================================

create extension if not exists pgcrypto;

-- -------------------------------------------------------------
-- 1. 用户档案（含角色与账号状态）
-- -------------------------------------------------------------
create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  email            text,
  full_name        text,
  company          text,
  role             text not null default 'member',   -- super_admin / admin / member
  status           text not null default 'active',   -- active / disabled
  last_sign_in_at  timestamptz,
  note             text,                             -- 管理员备注
  settings         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

-- 兼容旧版本已建好的 profiles 表：缺列则补齐
alter table public.profiles add column if not exists status          text not null default 'active';
alter table public.profiles add column if not exists last_sign_in_at timestamptz;
alter table public.profiles add column if not exists note            text;
alter table public.profiles alter column role set default 'member';

-- 历史数据里的 'owner' 收敛到新角色体系
update public.profiles set role = 'member' where role not in ('super_admin', 'admin', 'member');

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add  constraint profiles_role_check
  check (role in ('super_admin', 'admin', 'member'));

alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add  constraint profiles_status_check
  check (status in ('active', 'disabled'));

create index if not exists idx_profiles_role   on public.profiles(role);
create index if not exists idx_profiles_status on public.profiles(status);

-- -------------------------------------------------------------
-- 1b. 多租户：公司（租户）
--   · 平台超级管理员不属于任何公司，通过 active_company_id 切换当前管理视角
--   · 普通账号必须归属一家公司；公司内最高角色为 admin（普通管理员）
--   · 默认公司承载升级前已有数据，保证老库重跑脚本后数据不丢
-- -------------------------------------------------------------
create table if not exists public.companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text,
  status     text not null default 'active' check (status in ('active','disabled')),
  note       text,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_companies_code
  on public.companies(lower(code)) where code is not null;

insert into public.companies (id, name, code, status)
values ('00000000-0000-0000-0000-000000000001', '默认公司', 'DEFAULT', 'active')
on conflict (id) do nothing;

alter table public.profiles add column if not exists company_id        uuid references public.companies(id) on delete set null;
alter table public.profiles add column if not exists active_company_id uuid references public.companies(id) on delete set null;
create index if not exists idx_profiles_company on public.profiles(company_id);

-- 旧数据归入默认公司（超管下面单独摘出）
update public.profiles set company_id = '00000000-0000-0000-0000-000000000001'::uuid
 where company_id is null;

-- 平台唯一超级管理员：不属于任何公司；其余超管降级为公司普通管理员
update public.profiles
   set role = 'super_admin',
       company_id = null,
       active_company_id = coalesce(active_company_id, '00000000-0000-0000-0000-000000000001'::uuid)
 where lower(coalesce(email, '')) = 'yinsuccess168@163.com';
update public.profiles
   set role = 'admin'
 where role = 'super_admin'
   and lower(coalesce(email, '')) <> 'yinsuccess168@163.com';

-- 新用户注册后自动建档
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_count int;
  assigned_role  text;
begin
  -- 多租户：只有平台超管邮箱能拿到 super_admin；其余账号一律普通人员，
  -- 且默认落进默认公司，由所属公司的管理员在账号管理页调整。
  assigned_role := case
    when lower(coalesce(new.email, '')) = 'yinsuccess168@163.com' then 'super_admin'
    else 'member'
  end;

  insert into public.profiles (id, email, full_name, role, status, company_id, active_company_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    assigned_role,
    'active',
    case when assigned_role = 'super_admin' then null else '00000000-0000-0000-0000-000000000001'::uuid end,
    case when assigned_role = 'super_admin' then '00000000-0000-0000-0000-000000000001'::uuid else null end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 防止有人把系统锁死：保证至少存在一个超级管理员
create or replace function public.ensure_super_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 多租户后超管固定为指定邮箱；该邮箱未注册时不动现有超管，避免把系统锁死，
  -- 但绝不再随机把「最早注册的账号」提升成超管。
  if exists (select 1 from public.profiles where lower(coalesce(email, '')) = 'yinsuccess168@163.com') then
    update public.profiles
       set role = 'super_admin',
           company_id = null,
           active_company_id = coalesce(active_company_id, '00000000-0000-0000-0000-000000000001'::uuid)
     where lower(coalesce(email, '')) = 'yinsuccess168@163.com';

    update public.profiles
       set role = 'admin'
     where role = 'super_admin'
       and lower(coalesce(email, '')) <> 'yinsuccess168@163.com';
  end if;
end;
$$;

-- -------------------------------------------------------------
-- 2. 店铺
-- -------------------------------------------------------------
create table if not exists public.stores (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name          text not null,
  platform      text not null check (platform in ('amazon', 'tiktok')),
  marketplace   text not null default 'US',        -- US / UK / DE / FR / JP / CA / MX / SA / AE ...
  currency      text not null default 'USD',
  seller_id     text,
  status        text not null default 'active' check (status in ('active', 'paused', 'closed')),
  target_acos   numeric(6,2) not null default 30,  -- 目标 ACOS %
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_stores_user on public.stores(user_id);

-- -------------------------------------------------------------
-- 3. 商品
-- -------------------------------------------------------------
create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_id      uuid not null references public.stores(id) on delete cascade,
  sku           text not null,
  asin          text,
  title         text not null,
  image_url     text,
  category      text,
  cost_price    numeric(12,2) not null default 0,   -- 采购成本（含头程分摊）
  sale_price    numeric(12,2) not null default 0,   -- 售价
  currency      text not null default 'USD',
  status        text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  tags          text[] not null default '{}',
  note          text,
  created_at    timestamptz not null default now(),
  unique (user_id, store_id, sku)
);
create index if not exists idx_products_user   on public.products(user_id);
create index if not exists idx_products_store  on public.products(store_id);
create index if not exists idx_products_asin   on public.products(asin);

-- -------------------------------------------------------------
-- 4. 订单（利润字段由数据库自动计算，前端无需维护）
-- -------------------------------------------------------------
create table if not exists public.orders (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  product_id      uuid references public.products(id) on delete set null,
  order_no        text not null,
  order_date      date not null default current_date,
  channel         text not null default 'amazon' check (channel in ('amazon', 'tiktok', 'other')),
  sku             text,
  title           text,
  customer_name   text,
  country         text,
  quantity        integer not null default 1,
  unit_price      numeric(12,2) not null default 0,
  cost_amount     numeric(12,2) not null default 0,  -- 采购成本合计
  platform_fee    numeric(12,2) not null default 0,  -- 平台佣金
  fba_fee         numeric(12,2) not null default 0,  -- FBA / 履约费
  shipping_fee    numeric(12,2) not null default 0,  -- 头程 / 物流
  ad_cost         numeric(12,2) not null default 0,  -- 分摊广告费
  refund_amount   numeric(12,2) not null default 0,  -- 退款
  other_fee       numeric(12,2) not null default 0,  -- 其他费用
  status          text not null default 'pending'
                  check (status in ('pending', 'shipped', 'delivered', 'refunded', 'cancelled')),
  note            text,
  gross_amount    numeric(14,2) generated always as (quantity * unit_price) stored,
  profit          numeric(14,2) generated always as (
                    quantity * unit_price
                    - cost_amount - platform_fee - fba_fee
                    - shipping_fee - ad_cost - refund_amount - other_fee
                  ) stored,
  created_at      timestamptz not null default now()
);
create index if not exists idx_orders_user  on public.orders(user_id);
create index if not exists idx_orders_store on public.orders(store_id);
create index if not exists idx_orders_date  on public.orders(order_date desc);
create unique index if not exists uq_orders_no on public.orders(user_id, store_id, order_no);

-- -------------------------------------------------------------
-- 5. 库存
-- -------------------------------------------------------------
create table if not exists public.inventory (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  product_id      uuid references public.products(id) on delete cascade,
  sku             text not null,
  title           text,
  warehouse       text not null default 'FBA-US',
  available_qty   integer not null default 0,
  inbound_qty     integer not null default 0,
  reserved_qty    integer not null default 0,
  safety_stock    integer not null default 0,
  avg_daily_sales numeric(10,2) not null default 0,
  updated_at      timestamptz not null default now(),
  unique (user_id, store_id, sku, warehouse)
);
create index if not exists idx_inventory_user on public.inventory(user_id);

-- -------------------------------------------------------------
-- 6. 广告活动
-- -------------------------------------------------------------
create table if not exists public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_id      uuid not null references public.stores(id) on delete cascade,
  name          text not null,
  platform      text not null default 'amazon' check (platform in ('amazon', 'tiktok')),
  ad_type       text not null default 'SP',   -- SP / SB / SD / GMV_MAX / LIVE / VIDEO
  status        text not null default 'active' check (status in ('active', 'paused', 'ended')),
  daily_budget  numeric(12,2) not null default 0,
  spend         numeric(12,2) not null default 0,
  impressions   integer not null default 0,
  clicks        integer not null default 0,
  orders_count  integer not null default 0,
  sales         numeric(14,2) not null default 0,
  start_date    date not null default current_date,
  end_date      date,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_campaigns_user  on public.campaigns(user_id);
create index if not exists idx_campaigns_store on public.campaigns(store_id);

-- -------------------------------------------------------------
-- 7. TikTok 达人 / 内容合作
-- -------------------------------------------------------------
create table if not exists public.creators (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_id        uuid references public.stores(id) on delete set null,
  handle          text not null,
  name            text,
  avatar_url      text,
  region          text default 'US',
  category        text,
  followers       integer not null default 0,
  email           text,
  commission_rate numeric(6,2) not null default 0,  -- 佣金比例 %
  status          text not null default 'pending'
                  check (status in ('pending', 'contacted', 'sampling', 'cooperating', 'paused')),
  gmv             numeric(14,2) not null default 0,
  video_count     integer not null default 0,
  last_contact    date,
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_creators_user on public.creators(user_id);

-- -------------------------------------------------------------
-- 8. 运营任务
-- -------------------------------------------------------------
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_id     uuid references public.stores(id) on delete set null,
  title        text not null,
  description  text,
  module       text not null default 'other'
               check (module in ('listing', 'ads', 'inventory', 'content', 'customer', 'finance', 'other')),
  priority     text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status       text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  due_date     date,
  assignee     text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_tasks_user on public.tasks(user_id);
create index if not exists idx_tasks_status on public.tasks(status);

-- -------------------------------------------------------------
-- 9. 费用台账（头程、仓储、软件订阅……）
-- -------------------------------------------------------------
create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_id     uuid references public.stores(id) on delete cascade,
  category     text not null default 'shipping',
  amount       numeric(12,2) not null default 0,
  currency     text not null default 'CNY',
  expense_date date not null default current_date,
  remark       text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_expenses_user on public.expenses(user_id);
create index if not exists idx_expenses_date on public.expenses(expense_date desc);

-- -------------------------------------------------------------
-- 10. 组织架构：部门 / 岗位 / 自定义角色
--     departments 支持无限层级（parent_id 自引用），岗位挂在部门下，
--     roles.permissions 存权限码，决定该角色能看到哪些模块、能否删除。
-- -------------------------------------------------------------
create table if not exists public.departments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  parent_id   uuid references public.departments(id) on delete set null,
  leader_id   uuid references public.profiles(id) on delete set null,
  description text,
  code        text,                               -- 部门编码：IT / HR / OPS / FIN ...
  scope       text[] not null default '{}',       -- 部门级权限码：模块可见范围 + 人事职能
  inherit_parent boolean not null default true,   -- 是否继承上级部门的可见范围
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists idx_departments_parent on public.departments(parent_id);

-- 兼容旧库：部门权限是新概念，缺列则补齐
alter table public.departments add column if not exists code           text;
alter table public.departments add column if not exists scope          text[] not null default '{}';
alter table public.departments add column if not exists inherit_parent boolean not null default true;
create unique index if not exists uq_departments_code
  on public.departments (lower(code)) where code is not null;

create table if not exists public.positions (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  department_id uuid references public.departments(id) on delete set null,
  level         text not null default 'P1',   -- 职级：P1-P8 / M1-M4 等，用户可自定义
  description   text,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists idx_positions_dept on public.positions(department_id);

create table if not exists public.roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  permissions text[] not null default '{}',   -- 权限码，见 lib/permissions.ts
  is_system   boolean not null default false, -- 内置角色：不可删除，可改权限
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists uq_roles_name on public.roles (name);

-- 成员与组织的关系（删岗位/部门时置空，不影响账号本身）
alter table public.profiles add column if not exists department_id uuid references public.departments(id) on delete set null;
alter table public.profiles add column if not exists position_id   uuid references public.positions(id)   on delete set null;
alter table public.profiles add column if not exists role_id       uuid references public.roles(id)       on delete set null;

create index if not exists idx_profiles_department on public.profiles(department_id);
create index if not exists idx_profiles_position   on public.profiles(position_id);
create index if not exists idx_profiles_role_id    on public.profiles(role_id);

-- 员工档案联系方式：工号 / 电话 / 微信（登录邮箱在 profiles.email，不随这里改动）
alter table public.profiles add column if not exists employee_no text;
alter table public.profiles add column if not exists phone       text;
alter table public.profiles add column if not exists wechat      text;
create unique index if not exists uq_profiles_employee_no
  on public.profiles(lower(employee_no))
 where employee_no is not null and btrim(employee_no) <> '';

-- -------------------------------------------------------------
-- 10.1 人员生命周期（入职 / 在职 / 离职）
--      status 管「账号能不能登录」，employment_status 管「人还在这家公司吗」，
--      两者解耦：休假停用账号时人事状态仍是 active，不会误记成离职。
-- -------------------------------------------------------------
alter table public.profiles add column if not exists employment_status text not null default 'active';
alter table public.profiles add column if not exists hire_date    date;          -- 入职日期
alter table public.profiles add column if not exists left_at      timestamptz;   -- 离职生效时间
alter table public.profiles add column if not exists left_reason  text;          -- 离职原因
alter table public.profiles add column if not exists handover_to  uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists provisioned_by uuid references auth.users(id) on delete set null;
alter table public.profiles add column if not exists provisioned_at timestamptz; -- 由管理员创建账号的时间

alter table public.profiles drop constraint if exists profiles_employment_check;
alter table public.profiles add  constraint profiles_employment_check
  check (employment_status in ('pending', 'active', 'left'));

create index if not exists idx_profiles_employment on public.profiles(employment_status);

-- -------------------------------------------------------------
-- 11. 竞品分析：跟踪竞品的价格 / 评分 / BSR
--     competitors 存最近一次采集值（列表页直接读，避免每次汇总）
--     competitor_snapshots 存按日快照，用于画趋势曲线
-- -------------------------------------------------------------
create table if not exists public.competitors (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_id          uuid references public.stores(id) on delete set null,
  product_id        uuid references public.products(id) on delete set null,  -- 我方对标商品
  platform          text not null default 'amazon' check (platform in ('amazon', 'tiktok')),
  marketplace       text not null default 'US',
  asin              text,
  title             text not null,
  brand             text,
  url               text,
  image_url         text,
  currency          text not null default 'USD',
  price             numeric(12,2) not null default 0,   -- 当前售价
  list_price        numeric(12,2) not null default 0,   -- 划线价，用于算折扣
  coupon            text,                               -- 优惠券 / 促销描述
  rating            numeric(3,2) not null default 0 check (rating >= 0 and rating <= 5),
  reviews           integer not null default 0,
  bsr               integer,                            -- 类目排名
  est_monthly_sales integer not null default 0,         -- 预估月销
  seller            text,
  category          text,
  status            text not null default 'tracking'
                    check (status in ('tracking', 'paused', 'archived')),
  note              text,
  last_checked      date,                               -- 最近一次采集日期
  created_at        timestamptz not null default now()
);
create index if not exists idx_competitors_user   on public.competitors(user_id);
create index if not exists idx_competitors_status on public.competitors(status);
-- 同一站点同一个 ASIN 只跟踪一次（ASIN 为空时不去重，允许手动录 TikTok 商品）
create unique index if not exists uq_competitors_asin
  on public.competitors(platform, marketplace, asin) where asin is not null;

create table if not exists public.competitor_snapshots (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  competitor_id     uuid not null references public.competitors(id) on delete cascade,
  snapshot_date     date not null default current_date,
  price             numeric(12,2) not null default 0,
  rating            numeric(3,2) not null default 0,
  reviews           integer not null default 0,
  bsr               integer,
  est_monthly_sales integer not null default 0,
  note              text,
  created_at        timestamptz not null default now(),
  unique (competitor_id, snapshot_date)
);
create index if not exists idx_comp_snap_competitor
  on public.competitor_snapshots(competitor_id, snapshot_date desc);

-- -------------------------------------------------------------
-- 11.5 站外品牌营销：社媒账号 / 站外红人 / 公共关系 / 曝光搜索量
--      统一用 brand.view / brand.edit 权限，负责人 owner_id 参与离职移交
-- -------------------------------------------------------------
create table if not exists public.brand_social_accounts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  platform     text not null,                            -- YouTube / Instagram / TikTok / X ...
  account_name text not null,
  account_url  text,
  followers    integer not null default 0 check (followers >= 0),
  posts_count  integer not null default 0 check (posts_count >= 0),
  owner_id     uuid references public.profiles(id) on delete set null,
  status       text not null default 'active' check (status in ('active', 'paused')),
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists uq_brand_social_account
  on public.brand_social_accounts(lower(platform), lower(account_name));
create index if not exists idx_brand_social_owner on public.brand_social_accounts(owner_id);

create table if not exists public.brand_influencers (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name           text not null,
  platform       text not null,
  handle         text,
  followers      integer not null default 0 check (followers >= 0),
  niche          text,
  country        text,
  contact_email  text,
  contact_wechat text,
  price_cny      numeric(12,2) not null default 0 check (price_cny >= 0),
  status         text not null default 'contacting'
                 check (status in ('contacting', 'negotiating', 'active', 'done', 'paused')),
  last_collab_at date,
  owner_id       uuid references public.profiles(id) on delete set null,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_brand_influencer_owner on public.brand_influencers(owner_id);
create index if not exists idx_brand_influencer_status on public.brand_influencers(status);

create table if not exists public.brand_pr_contacts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  media_name       text not null,
  contact_name     text,
  channel_type     text not null default 'media',          -- media / blog / forum / agency
  contact_email    text,
  contact_phone    text,
  coverage_count   integer not null default 0 check (coverage_count >= 0),
  last_coverage_at date,
  status           text not null default 'active' check (status in ('active', 'paused')),
  owner_id         uuid references public.profiles(id) on delete set null,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_brand_pr_owner on public.brand_pr_contacts(owner_id);

create table if not exists public.brand_metrics (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  metric_date   date not null default current_date,
  channel       text not null default 'overall',          -- overall / google / social / pr
  impressions   integer not null default 0 check (impressions >= 0),
  search_volume integer not null default 0 check (search_volume >= 0),
  site_visits   integer not null default 0 check (site_visits >= 0),
  backlinks     integer not null default 0 check (backlinks >= 0),
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_brand_metrics_date_channel
  on public.brand_metrics(metric_date, lower(channel));
create index if not exists idx_brand_metrics_date on public.brand_metrics(metric_date desc);

-- -------------------------------------------------------------
-- 12. 采购：供应商 / 采购单 / 采购明细
--     采购单金额不落库，由明细行 amount 汇总，避免主表与明细不一致
-- -------------------------------------------------------------
create table if not exists public.suppliers (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name           text not null,
  contact        text,
  phone          text,
  email          text,
  address        text,
  category       text,                                  -- 主营品类
  payment_terms  text not null default '现结',           -- 现结 / 30 天 / 60 天
  lead_time_days integer not null default 30,           -- 生产 + 头程交期
  rating         integer not null default 3 check (rating between 1 and 5),
  status         text not null default 'active' check (status in ('active', 'paused')),
  note           text,
  created_at     timestamptz not null default now()
);
create unique index if not exists uq_suppliers_name on public.suppliers(name);
create index if not exists idx_suppliers_status on public.suppliers(status);

-- 供应商管理库：老库升级只需补列，不覆盖已有值
alter table public.suppliers
  add column if not exists code              text,
  add column if not exists contact_title     text,
  add column if not exists fax               text,
  add column if not exists website           text,
  add column if not exists country           text,
  add column if not exists city              text,
  add column if not exists tax_no            text,
  add column if not exists bank_name         text,
  add column if not exists bank_account      text,
  add column if not exists qualification     text,
  add column if not exists tags              text[] not null default '{}',
  add column if not exists owner_id          uuid references public.profiles(id) on delete set null,
  add column if not exists cooperation_since date,
  add column if not exists updated_at        timestamptz not null default now();
create unique index if not exists uq_suppliers_code
  on public.suppliers(lower(code)) where code is not null and btrim(code) <> '';
create index if not exists idx_suppliers_owner on public.suppliers(owner_id);

-- 供应商可供产品 / 报价：一家供应商可以供多个 SKU，同一 SKU 只留一条报价
create table if not exists public.supplier_products (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  supplier_id     uuid not null references public.suppliers(id) on delete cascade,
  product_id      uuid references public.products(id) on delete set null,
  sku             text not null,
  title           text,
  unit            text not null default '件',
  currency        text not null default 'CNY',
  unit_cost       numeric(14,4) not null default 0 check (unit_cost >= 0),
  moq             integer not null default 1 check (moq >= 1),
  lead_time_days  integer not null default 30 check (lead_time_days >= 0),
  status          text not null default 'active' check (status in ('active', 'paused')),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists uq_supplier_products_sku
  on public.supplier_products(supplier_id, lower(sku));
create index if not exists idx_supplier_products_supplier on public.supplier_products(supplier_id);
create index if not exists idx_supplier_products_product on public.supplier_products(product_id);

-- 供应商联系人：一家供应商可以有多个联系人，每人可留多种联系方式
-- 主表中的 contact/phone/email 仅作为「主联系人快照」，供列表与采购页快速展示
create table if not exists public.supplier_contacts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  supplier_id     uuid not null references public.suppliers(id) on delete cascade,
  name            text not null,
  title           text,
  phone           text,
  mobile          text,
  email           text,
  im              text,                                  -- 微信 / WhatsApp / Telegram
  is_primary      boolean not null default false,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 旧库升级：把主表里已有的单一联系人迁移成一条主联系人（幂等）
insert into public.supplier_contacts (user_id, supplier_id, name, title, phone, email, is_primary)
select s.user_id, s.id, btrim(s.contact), s.contact_title, s.phone, s.email, true
  from public.suppliers s
 where s.contact is not null and btrim(s.contact) <> ''
   and not exists (
     select 1 from public.supplier_contacts c where c.supplier_id = s.id
   );

create index if not exists idx_supplier_contacts_supplier on public.supplier_contacts(supplier_id);
create unique index if not exists uq_supplier_contacts_primary
  on public.supplier_contacts(supplier_id) where is_primary;

create table if not exists public.purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  po_no         text not null,
  supplier_id   uuid references public.suppliers(id) on delete set null,
  store_id      uuid references public.stores(id) on delete set null,
  warehouse     text not null default '国内仓',
  order_date    date not null default current_date,
  expected_date date,                                   -- 预计到仓
  currency      text not null default 'CNY',
  status        text not null default 'draft'
                check (status in ('draft', 'ordered', 'partial', 'received', 'cancelled')),
  shipping_fee  numeric(12,2) not null default 0,       -- 头程 / 运费
  other_fee     numeric(12,2) not null default 0,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_purchase_orders_no on public.purchase_orders(po_no);
create index if not exists idx_po_supplier on public.purchase_orders(supplier_id);
create index if not exists idx_po_status   on public.purchase_orders(status);
create index if not exists idx_po_date     on public.purchase_orders(order_date desc);

create table if not exists public.purchase_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  po_id        uuid not null references public.purchase_orders(id) on delete cascade,
  product_id   uuid references public.products(id) on delete set null,
  sku          text not null,
  title        text,
  quantity     integer not null default 1,
  unit_price   numeric(12,2) not null default 0,        -- 采购单价（不含运费）
  received_qty integer not null default 0,              -- 已到货数量
  amount       numeric(14,2) generated always as (quantity * unit_price) stored,
  created_at   timestamptz not null default now()
);
create index if not exists idx_purchase_items_po  on public.purchase_items(po_id);
create index if not exists idx_purchase_items_sku on public.purchase_items(sku);

-- -------------------------------------------------------------
-- 13. 权限流程：权限申请与审批 / 人员变动流水
--     access_requests 记录「谁申请了哪个角色、为什么、谁批的」
--     employee_events 记录入职、调岗、权限变更、离职等无法回滚的轨迹
--     两者都只追加不修改，作为审计底稿
-- -------------------------------------------------------------
create table if not exists public.access_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind           text not null default 'role' check (kind in ('role', 'system_role')),
  target_role_id uuid references public.roles(id) on delete set null,   -- 申请岗位角色
  target_role    text check (target_role in ('admin', 'member')),        -- 申请系统角色（超管不可申请）
  reason         text not null,
  expect_scope   text,                                                   -- 申请人写的期望权限范围
  status         text not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by     uuid references auth.users(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_access_req_user   on public.access_requests(user_id);
create index if not exists idx_access_req_status on public.access_requests(status, created_at desc);

create table if not exists public.employee_events (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null
             check (event_type in ('hire', 'activate', 'transfer', 'permission', 'disable', 'enable', 'offboard')),
  summary    text not null,
  detail     jsonb not null default '{}'::jsonb,
  actor_id   uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_emp_events_profile on public.employee_events(profile_id, created_at desc);
create index if not exists idx_emp_events_time    on public.employee_events(created_at desc);

-- -------------------------------------------------------------
-- 14. 绩效：按考核周期记录评分与评语
--     一人一周期一条，重新评定覆盖原记录（updated_at 变化可追溯）。
--     department_id 保存评估当时的部门快照，避免调岗后历史报表被改写。
-- -------------------------------------------------------------
create table if not exists public.performance_reviews (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  period        text not null,                          -- 2026-Q4 / 2026-11
  department_id uuid references public.departments(id) on delete set null,
  reviewer_id   uuid references public.profiles(id) on delete set null,
  score         numeric(4,1) not null default 0 check (score >= 0 and score <= 100),
  grade         text not null default 'B' check (grade in ('S', 'A', 'B', 'C', 'D')),
  kpi           jsonb not null default '{}'::jsonb,     -- 分项：{sales, execution, collaboration, growth}
  summary       text,
  improvement   text,
  status        text not null default 'published' check (status in ('draft', 'published')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (profile_id, period)
);
create index if not exists idx_perf_period on public.performance_reviews(period, score desc);
create index if not exists idx_perf_profile on public.performance_reviews(profile_id);

-- -------------------------------------------------------------
-- 15. 业务链路：订单 → 出库 → 缺货 → 采购 → 付款 → 入库 → 成本 → 利润 → 绩效
--
--     一张单子的完整闭环：
--       orders                     卖出（带责任人 owner_id）
--         └→ stock_movements(out)  出库：扣 inventory.available_qty，写流水
--              └→ 库存不足          shortage_plan() 给出补货建议
--                   └→ purchase_orders  采购（带采购员 buyer_id，可回指缺货订单）
--                        ├→ purchase_payments  付款登记 → 付款状态自动维护
--                        └→ stock_movements(in) 到货入库
--                             ├→ 加权成本 → products.cost_price
--                             └→ orders.cost_amount 回填 → orders.profit 生成列自动重算
--      每张单据都带人员字段，绩效与利润可以按人 / 按部门归集。
-- -------------------------------------------------------------

-- 订单：责任人 + 出库状态 + 成本来源
alter table public.orders add column if not exists owner_id        uuid references public.profiles(id) on delete set null;
alter table public.orders add column if not exists stock_state     text not null default 'pending';
alter table public.orders add column if not exists fulfilled_at    timestamptz;
alter table public.orders add column if not exists fulfillment_wh  text;
alter table public.orders add column if not exists cost_source     text not null default 'manual';
do $$ begin
  alter table public.orders drop constraint if exists orders_stock_state_chk;
  alter table public.orders add constraint orders_stock_state_chk
    check (stock_state in ('pending', 'out', 'returned'));
  alter table public.orders drop constraint if exists orders_cost_source_chk;
  alter table public.orders add constraint orders_cost_source_chk
    check (cost_source in ('manual', 'stock'));
end $$;
create index if not exists idx_orders_owner on public.orders(owner_id);
create index if not exists idx_orders_sku   on public.orders(sku);

-- 采购单：采购员 + 付款状态 + 来源（手工 / 缺货补货 / 订单驱动）
alter table public.purchase_orders add column if not exists buyer_id       uuid references public.profiles(id) on delete set null;
alter table public.purchase_orders add column if not exists payment_status text not null default 'unpaid';
alter table public.purchase_orders add column if not exists paid_amount    numeric(14,2) not null default 0;
alter table public.purchase_orders add column if not exists source         text not null default 'manual';
alter table public.purchase_orders add column if not exists source_order_id uuid references public.orders(id) on delete set null;
alter table public.purchase_orders add column if not exists received_at    timestamptz;
-- 财务审核：采购单下给供应商之前由财务确认金额与付款条件，未通过不允许登记付款
alter table public.purchase_orders add column if not exists approval_status text not null default 'pending';
alter table public.purchase_orders add column if not exists approved_by     uuid references public.profiles(id) on delete set null;
alter table public.purchase_orders add column if not exists approved_at     timestamptz;
alter table public.purchase_orders add column if not exists approval_note   text;
do $$ begin
  alter table public.purchase_orders drop constraint if exists purchase_orders_payment_chk;
  alter table public.purchase_orders add constraint purchase_orders_payment_chk
    check (payment_status in ('unpaid', 'partial', 'paid'));
  alter table public.purchase_orders drop constraint if exists purchase_orders_source_chk;
  alter table public.purchase_orders add constraint purchase_orders_source_chk
    check (source in ('manual', 'shortage', 'order'));
  alter table public.purchase_orders drop constraint if exists purchase_orders_approval_chk;
  alter table public.purchase_orders add constraint purchase_orders_approval_chk
    check (approval_status in ('pending', 'approved', 'rejected'));
end $$;
create index if not exists idx_po_buyer  on public.purchase_orders(buyer_id);
create index if not exists idx_po_source on public.purchase_orders(source_order_id);
create index if not exists idx_po_approval on public.purchase_orders(approval_status, order_date desc);

-- 老库升级：已经付过款 / 已到货的历史单视为「已审核」，避免历史数据被新闸门卡住
update public.purchase_orders
   set approval_status = 'approved',
       approved_at     = coalesce(updated_at, now()),
       approval_note   = '历史单据自动通过'
 where approval_status = 'pending'
   and (coalesce(paid_amount, 0) > 0 or status in ('partial', 'received'));

-- 任务：责任人（真人员，不是字符串）+ 单据关联，让协作可回溯
alter table public.tasks add column if not exists owner_id uuid references public.profiles(id) on delete set null;
alter table public.tasks add column if not exists ref_type text;   -- order / purchase / product / competitor
alter table public.tasks add column if not exists ref_id   uuid;
alter table public.tasks add column if not exists ref_no   text;
create index if not exists idx_tasks_owner on public.tasks(owner_id);

-- 绩效：自动算分留痕（人工改分不会被覆盖，只留 metrics 快照）
alter table public.performance_reviews add column if not exists metrics    jsonb not null default '{}'::jsonb;
alter table public.performance_reviews add column if not exists auto_score  numeric(4,1);
alter table public.performance_reviews add column if not exists auto_grade  text;

-- 库存流水：唯一的库存变动底账，inventory.available_qty 是它的累计结果
create table if not exists public.stock_movements (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_id   uuid references public.stores(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  sku        text not null,
  title      text,
  warehouse  text not null default 'FBA-US',
  move_type  text not null check (move_type in ('in', 'out', 'adjust', 'return')),
  qty        integer not null,                        -- 有符号：入库 +，出库 -
  unit_cost  numeric(12,2) not null default 0,        -- 入库成本（用于 SKU 加权成本）
  ref_type   text check (ref_type in ('order', 'purchase', 'manual')),
  ref_id     uuid,
  ref_no     text,                                    -- 单号快照，单据被删也能看懂
  owner_id   uuid references public.profiles(id) on delete set null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists idx_moves_sku  on public.stock_movements(sku, created_at desc);
create index if not exists idx_moves_ref  on public.stock_movements(ref_type, ref_id);
create index if not exists idx_moves_time on public.stock_movements(created_at desc);
create index if not exists idx_moves_owner on public.stock_movements(owner_id);

-- -------------------------------------------------------------
-- 库存调拨（头程）：国内仓 → 海外仓，把「订单缺货」接到采购与出库之间
--   创建调拨时即从来源仓扣货（in_transit），到货确认时写入目标仓；
--   一张调拨可关联订单，出库后订单时间线能看到完整轨迹。
-- -------------------------------------------------------------
create table if not exists public.stock_transfers (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  transfer_no    text not null,
  store_id       uuid references public.stores(id) on delete set null,
  order_id       uuid references public.orders(id) on delete set null,
  product_id     uuid references public.products(id) on delete set null,
  sku            text not null,
  title          text,
  qty            integer not null check (qty > 0),
  from_warehouse text not null default '国内仓',
  to_warehouse   text not null default 'FBA-US',
  status         text not null default 'in_transit',
  received_qty   integer not null default 0,
  shipped_at     timestamptz,
  received_at    timestamptz,
  owner_id       uuid references public.profiles(id) on delete set null,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists uq_stock_transfers_no on public.stock_transfers(transfer_no);
create index if not exists idx_stock_transfers_order  on public.stock_transfers(order_id);
create index if not exists idx_stock_transfers_status on public.stock_transfers(status, created_at desc);
create index if not exists idx_stock_transfers_sku    on public.stock_transfers(sku);
do $$ begin
  alter table public.stock_transfers drop constraint if exists stock_transfers_status_chk;
  alter table public.stock_transfers add constraint stock_transfers_status_chk
    check (status in ('in_transit', 'partial', 'received', 'cancelled'));

  -- 流水类型扩展：调拨出 / 调拨入
  alter table public.stock_movements drop constraint if exists stock_movements_move_type_check;
  alter table public.stock_movements add constraint stock_movements_move_type_check
    check (move_type in ('in', 'out', 'adjust', 'return', 'transfer_out', 'transfer_in'));
  alter table public.stock_movements drop constraint if exists stock_movements_ref_type_check;
  alter table public.stock_movements add constraint stock_movements_ref_type_check
    check (ref_type in ('order', 'purchase', 'manual', 'transfer'));
end $$;

-- 采购付款：一张采购单可以分多次付款
create table if not exists public.purchase_payments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  po_id      uuid not null references public.purchase_orders(id) on delete cascade,
  amount     numeric(14,2) not null default 0,
  currency   text not null default 'CNY',
  paid_at    date not null default current_date,
  method     text not null default 'bank',   -- bank / alipay / wechat / cash / other
  voucher_no text,
  payer_id   uuid references public.profiles(id) on delete set null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists idx_payments_po   on public.purchase_payments(po_id, paid_at desc);
create index if not exists idx_payments_time on public.purchase_payments(paid_at desc);

-- 采购审核流水：提交 / 通过 / 驳回 / 撤回都会留痕，只追加不修改
create table if not exists public.purchase_approvals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  po_id      uuid not null references public.purchase_orders(id) on delete cascade,
  action     text not null check (action in ('submit', 'approve', 'reject', 'revoke')),
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists idx_po_approvals_po   on public.purchase_approvals(po_id, created_at desc);
create index if not exists idx_po_approvals_time on public.purchase_approvals(created_at desc);

-- -------------------------------------------------------------
-- 12b. 自有品牌产品开发：立项 → 调研 → 打样 → 测试 → 量产 → 上市
--      projects 记录项目主档，milestones 记录阶段节点，costs 记录开发投入
-- -------------------------------------------------------------
create table if not exists public.dev_projects (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code         text not null,                            -- 项目编号，如 DEV-2601
  name         text not null,
  category     text,                                     -- 所属类目
  brand        text,                                     -- 自有品牌
  owner_id     uuid references public.profiles(id) on delete set null,
  stage        text not null default 'research',
  status       text not null default 'active',
  priority     text not null default 'normal',
  target_cost  numeric(12,2) not null default 0,
  target_price numeric(12,2) not null default 0,
  target_date  date,
  supplier_id  uuid references public.suppliers(id) on delete set null,
  product_id   uuid references public.products(id) on delete set null, -- 上市后关联 SKU
  score        integer not null default 0 check (score between 0 and 100),
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists uq_dev_projects_code on public.dev_projects(code);
create index if not exists idx_dev_projects_stage  on public.dev_projects(stage, status);
create index if not exists idx_dev_projects_owner  on public.dev_projects(owner_id);

create table if not exists public.dev_milestones (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id  uuid not null references public.dev_projects(id) on delete cascade,
  title       text not null,
  stage       text not null default 'sample',
  owner_id    uuid references public.profiles(id) on delete set null,
  due_date    date,
  status      text not null default 'todo' check (status in ('todo', 'doing', 'done', 'blocked')),
  finished_at timestamptz,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_dev_milestones_project on public.dev_milestones(project_id, due_date);

create table if not exists public.dev_costs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id  uuid not null references public.dev_projects(id) on delete cascade,
  title       text not null,
  category    text not null default 'other',   -- mold / sample / cert / design / logistics / other
  amount      numeric(12,2) not null default 0,
  currency    text not null default 'CNY',
  incurred_at date not null default current_date,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_dev_costs_project on public.dev_costs(project_id, incurred_at desc);

do $$ begin
  alter table public.dev_projects drop constraint if exists dev_projects_stage_chk;
  alter table public.dev_projects add constraint dev_projects_stage_chk
    check (stage in ('research', 'proposal', 'sample', 'testing', 'mass', 'launch'));
  alter table public.dev_projects drop constraint if exists dev_projects_status_chk;
  alter table public.dev_projects add constraint dev_projects_status_chk
    check (status in ('active', 'launched', 'paused', 'dropped'));
  alter table public.dev_projects drop constraint if exists dev_projects_priority_chk;
  alter table public.dev_projects add constraint dev_projects_priority_chk
    check (priority in ('low', 'normal', 'high', 'urgent'));
  alter table public.dev_milestones drop constraint if exists dev_milestones_stage_chk;
  alter table public.dev_milestones add constraint dev_milestones_stage_chk
    check (stage in ('research', 'proposal', 'sample', 'testing', 'mass', 'launch'));
end $$;

-- -------------------------------------------------------------
-- 12c. 费用管理：费用单 / 明细 / 预算 / 审批流水
--   费用单覆盖研发、营销、薪酬社保、差旅、办公与其他支出；
--   一张单多条明细，金额由明细汇总落库（触发器），避免主表与明细对不上。
--   薪酬社保明细可指向具体员工，研发投入可指向开发项目，营销可指向店铺。
--   审批闸门：draft→submit→approve→pay，未审核不能付款（与采购同构）。
-- -------------------------------------------------------------
create table if not exists public.finance_expenses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code          text not null unique,             -- 单号 FY202611-0001
  title         text not null,
  category      text not null default 'other',    -- rd / marketing / payroll / travel / office / other
  subcategory   text,
  owner_id      uuid references public.profiles(id) on delete set null,  -- 费用归属人（工资社保指向员工）
  department_id uuid references public.departments(id) on delete set null,
  store_id      uuid references public.stores(id) on delete set null,
  project_id    uuid references public.dev_projects(id) on delete set null,
  amount        numeric(14,2) not null default 0, -- 由明细汇总
  currency      text not null default 'CNY',
  expense_date  date not null default current_date,
  status        text not null default 'draft',    -- draft / pending / approved / rejected / paid
  approved_by   uuid references public.profiles(id) on delete set null,
  approved_at   timestamptz,
  approval_note text,
  paid_at       date,
  payment_method text,
  voucher_no    text,
  note          text,
  -- 业务来源：费用单可由广告投放/达人合作/站外品牌营销直接归集而来
  source_module text not null default 'manual',  -- manual / ads / creator / brand
  source_id     uuid,                             -- 关联 campaigns/creators/brand_* 记录
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_finance_expenses_date on public.finance_expenses(expense_date desc);
create index if not exists idx_finance_expenses_cat on public.finance_expenses(category, expense_date desc);
create index if not exists idx_finance_expenses_status on public.finance_expenses(status);

-- 旧库补列（幂等）：必须在建索引之前，否则旧库表已存在、create table 不会补列，
-- 建索引时列还不存在会报 42703 column does not exist。
alter table public.finance_expenses add column if not exists source_module text not null default 'manual';
alter table public.finance_expenses add column if not exists source_id uuid;
do $$ begin
  alter table public.finance_expenses drop constraint if exists finance_expenses_source_module_chk;
  alter table public.finance_expenses add constraint finance_expenses_source_module_chk
    check (source_module in ('manual','ads','creator','brand'));
end $$;
-- 补列完成后再建索引
create index if not exists idx_finance_expenses_source on public.finance_expenses(source_module, source_id);

-- 明细：差旅按交通/住宿/餐补逐条，工资按基本工资/社保/公积金逐条
create table if not exists public.finance_expense_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  expense_id  uuid not null references public.finance_expenses(id) on delete cascade,
  category    text not null default 'other',
  item        text not null,
  qty         numeric(12,2) not null default 1,
  unit_price  numeric(14,2) not null default 0,
  amount      numeric(14,2) not null default 0,   -- qty * unit_price
  employee_id uuid references public.profiles(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_finance_expense_items_expense on public.finance_expense_items(expense_id);

-- 预算：按「分类 + 部门 + 月份」设额度，部门为空表示公司级
create table if not exists public.finance_budgets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category      text not null default 'other',
  department_id uuid references public.departments(id) on delete set null,
  period        text not null,                   -- YYYY-MM
  amount        numeric(14,2) not null default 0,
  currency      text not null default 'CNY',
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_finance_budget_scope
  on public.finance_budgets (category, period, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- 审批流水：提交 / 通过 / 驳回 / 撤回 / 付款只追加不修改
create table if not exists public.finance_expense_approvals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  expense_id  uuid not null references public.finance_expenses(id) on delete cascade,
  action      text not null check (action in ('submit','approve','reject','revoke','pay')),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_finance_expense_appr_expense on public.finance_expense_approvals(expense_id, created_at desc);

do $$ begin
  alter table public.finance_expenses drop constraint if exists finance_expenses_status_chk;
  alter table public.finance_expenses add constraint finance_expenses_status_chk
    check (status in ('draft','pending','approved','rejected','paid'));
end $$;

-- 明细汇总金额：金额只认明细，改明细即回写主表（含删明细）
create or replace function public.sync_finance_expense_total()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if tg_op = 'DELETE' then
    v_id := old.expense_id;
  else
    v_id := new.expense_id;
  end if;
  update public.finance_expenses
     set amount = coalesce((select sum(amount) from public.finance_expense_items where expense_id = v_id), 0),
         updated_at = now()
   where id = v_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_finance_expense_item_total on public.finance_expense_items;
create trigger trg_finance_expense_item_total
after insert or update or delete on public.finance_expense_items
for each row execute function public.sync_finance_expense_total();

-- =============================================================
--  行级安全（RLS）与角色权限（多租户版）
--  · 业务数据与人员档案按 company_id 严格隔离；部门 / 岗位 / 角色为平台模板全局共享
--  · super_admin 平台超管：不属于任何公司，通过切换视角管理各公司
--  · admin 公司普通管理员：仅本公司可删业务数据、可管人
--  · member 普通人员：仅本公司可读写业务数据
--  security definer 函数以表所有者身份执行，绕过 RLS，避免策略递归
-- =============================================================

-- 当前公司：普通账号=所属公司；平台超管=切换视角（未切换时看默认公司）
create or replace function public.current_company_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select case
       when p.role = 'super_admin'
         then coalesce(p.active_company_id, '00000000-0000-0000-0000-000000000001'::uuid)
       else p.company_id
     end
       from public.profiles p where p.id = auth.uid()),
    '00000000-0000-0000-0000-000000000001'::uuid
  );
$$;

-- 行归属判定：平台超管同样收敛到当前视角，避免误看 / 误写别家公司
create or replace function public.in_company(row_company uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select row_company is not distinct from public.current_company_id();
$$;

-- 关键 RPC 的租户校验：security definer 会绕过 RLS，必须显式确认目标行属于当前公司
create or replace function public.assert_row_company(p_table text, p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_ok boolean;
begin
  execute format('select public.in_company(company_id) from public.%I where id = $1', p_table)
     into v_ok using p_id;
  if not coalesce(v_ok, false) then
    raise exception '记录不存在或不属于当前公司';
  end if;
end;
$$;

-- 写入时自动补公司归属，各业务页面无需改动
create or replace function public.set_company_id()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := public.current_company_id();
  end if;
  return new;
end;
$$;

-- 所有业务表补列、回填默认公司、建索引并挂自动填充触发器
do $do$
declare
  t text;
  tabs text[] := array[
    'stores','products','orders','inventory','campaigns','creators','tasks','expenses',
    'competitors','competitor_snapshots','suppliers','supplier_products','supplier_contacts',
    'purchase_orders','purchase_items','purchase_payments','purchase_approvals',
    'access_requests','employee_events','performance_reviews',
    'stock_movements','stock_transfers',
    'brand_social_accounts','brand_influencers','brand_pr_contacts','brand_metrics',
    'dev_projects','dev_milestones','dev_costs',
    'finance_expenses','finance_expense_items','finance_budgets','finance_expense_approvals'
  ];
begin
  foreach t in array tabs loop
    execute format('alter table public.%I add column if not exists company_id uuid', t);
    execute format('update public.%I set company_id = ''00000000-0000-0000-0000-000000000001''::uuid where company_id is null', t);
    execute format('create index if not exists %I on public.%I(company_id)', 'idx_' || t || '_company', t);
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_company', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.set_company_id()', 'trg_' || t || '_company', t);
  end loop;
end;
$do$;

create or replace function public.current_role()
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'member');
$$;

-- 只有 status = 'active' 的账号才能读写业务数据；被禁用后立即失效
create or replace function public.is_active_user()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select status = 'active' from public.profiles where id = auth.uid()),
    false
  );
$$;

-- -------------------------------------------------------------
--  营销费用来源汇总：把广告投放 / 达人合作 / 站外品牌营销的
--  「业务发生额」与在费用管理里「已归集的费用」放在一起对照，
--  让三块营销投入与财务台账数据互通。
--  业务金额保留原始口径（广告多为外币、红人报价为 CNY），
--  已归集金额取费用单 amount（以费用单币种为准），前端标注币种。
--  注意：这是 LANGUAGE sql 函数，创建时即解析函数体，必须放在
--  company_id 补列（do 块）及 in_company / is_active_user 之后。
-- -------------------------------------------------------------
create or replace function public.marketing_spend_summary()
returns table (
  source_module   text,
  source_label    text,
  business_amount numeric,   -- 业务侧发生额（原币口径合计）
  recorded_amount numeric,   -- 费用管理已归集金额（费用单口径）
  record_count    bigint,    -- 业务记录条数
  expense_count   bigint     -- 已归集费用单数
)
language sql stable security definer set search_path = public
as $$
  with ads as (
    select coalesce(sum(spend), 0) as amt, count(*)::bigint as cnt from public.campaigns where public.in_company(company_id)
  ),
  creators as (
    -- 达人合作：佣金按 GMV × 佣金率估算；无 GMV 时按 0
    select coalesce(sum(gmv * commission_rate / 100.0), 0) as amt, count(*)::bigint as cnt
      from public.creators where public.in_company(company_id)
  ),
  brand as (
    select coalesce(sum(price_cny), 0) as amt, count(*)::bigint as cnt
      from public.brand_influencers where public.in_company(company_id)
  ),
  recorded as (
    select source_module,
           coalesce(sum(amount), 0) as amt,
           count(*)::bigint as cnt
      from public.finance_expenses
     where source_module in ('ads', 'creator', 'brand') and public.in_company(company_id)
     group by source_module
  )
  select v.mod, v.label, v.biz_amt, coalesce(r.amt, 0), v.biz_cnt, coalesce(r.cnt, 0)
    from (
      select 'ads'::text as mod, '广告投放'::text as label,
             (select amt from ads) as biz_amt, (select cnt from ads) as biz_cnt
      union all
      select 'creator'::text, '达人合作'::text,
             (select amt from creators), (select cnt from creators)
      union all
      select 'brand'::text, '站外品牌营销'::text,
             (select amt from brand), (select cnt from brand)
    ) v
    left join recorded r on r.source_module = v.mod
   where public.is_active_user()
   order by v.mod;
$$;

grant execute on function public.marketing_spend_summary() to authenticated;

-- 通讯录：只暴露姓名 / 邮箱 / 部门 / 岗位 / 角色等公开字段，
-- 不返回备注、设置、最近登录等敏感信息。
-- 组织架构、绩效等页面靠它显示同事姓名，普通成员也能读到（公司通讯录语义）。
create or replace function public.team_directory()
returns table (
  id                uuid,
  full_name         text,
  email             text,
  role              text,
  department_id     uuid,
  position_id       uuid,
  role_id           uuid,
  status            text,
  employment_status text,
  hire_date         date,
  is_leader         boolean
)
language sql stable security definer set search_path = public
as $$
  select p.id, p.full_name, p.email, p.role, p.department_id, p.position_id, p.role_id,
         p.status, coalesce(p.employment_status, 'active'), p.hire_date,
         exists (select 1 from public.departments d where d.leader_id = p.id)
    from public.profiles p
   where public.is_active_user()
     -- 只看本公司同事：平台超管 company_id 为空，普通账号看不到他
     and public.in_company(p.company_id)
   order by p.created_at;
$$;

-- ---------- 工号推荐：按公司内已用编号顺延，离职工号封存不复用 ----------
create or replace function public.recommend_employee_no()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_max integer;
  v_no  text;
begin
  if not (public.is_staff() or public.has_permission('hr.manage')) then
    raise exception '只有管理员或人力岗可以获取推荐工号';
  end if;

  -- 离职工号保留在原档案里（封存），这里不按 employment_status 过滤：
  -- 推荐号永远向后顺延，不会把离职号重新分配给新人。
  select coalesce(max(substring(employee_no from '^[Ee]([0-9]{4,6})$')::integer), 1000)
    into v_max
    from public.profiles
   where public.in_company(company_id)
     and employee_no ~* '^E[0-9]{4,6}$';

  loop
    v_max := v_max + 1;
    v_no  := 'E' || lpad(v_max::text, 4, '0');
    exit when not exists (
      select 1
        from public.profiles
       where public.in_company(company_id)
         and lower(btrim(employee_no)) = lower(v_no)
    );
  end loop;

  return v_no;
end;
$$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select role in ('admin', 'super_admin') and status = 'active'
       from public.profiles where id = auth.uid()),
    false
  );
$$;

create or replace function public.is_super_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select role = 'super_admin' and status = 'active'
       from public.profiles where id = auth.uid()),
    false
  );
$$;

-- ---------- 多租户：公司管理（仅平台超管） ----------
create or replace function public.list_companies()
returns table (id uuid, name text, code text, status text, note text, member_count bigint, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select c.id, c.name, c.code, c.status, c.note,
         (select count(*) from public.profiles p where p.company_id = c.id),
         c.created_at
    from public.companies c
   where public.is_super_admin()
   order by c.created_at;
$$;

create or replace function public.create_company(p_name text, p_code text default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_super_admin() then
    raise exception '只有平台超级管理员可以创建公司';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception '公司名称不能为空';
  end if;
  insert into public.companies (name, code, note)
  values (trim(p_name), nullif(trim(coalesce(p_code, '')), ''), p_note)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.update_company(p_id uuid, p_name text, p_code text, p_status text, p_note text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception '只有平台超级管理员可以管理公司';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception '公司名称不能为空';
  end if;
  update public.companies
     set name = trim(p_name),
         code = nullif(trim(coalesce(p_code, '')), ''),
         status = p_status,
         note = p_note
   where id = p_id;
end;
$$;

create or replace function public.switch_company(p_company uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception '只有平台超级管理员可以切换公司';
  end if;
  if not exists (select 1 from public.companies where id = p_company and status = 'active') then
    raise exception '公司不存在或已停用';
  end if;
  update public.profiles set active_company_id = p_company where id = auth.uid();
end;
$$;

-- 管理员建号后把新同事从默认公司拉进本公司。
-- 走 security definer：新账号此刻还在默认公司，管理员受 RLS 限制看不到他，
-- 但建号流程拿到了 userId，可以用这个函数完成归属分配。
create or replace function public.assign_member_company(p_user uuid, p_company uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception '只有管理员可以分配成员所属公司';
  end if;
  if p_company is not distinct from public.current_company_id() then
    null;
  else
    raise exception '只能把成员分配到自己所在的公司';
  end if;
  if not exists (
    select 1 from public.profiles
     where id = p_user
       and company_id = '00000000-0000-0000-0000-000000000001'::uuid
  ) then
    raise exception '成员不存在，或已经归属其它公司';
  end if;
  update public.profiles set company_id = p_company where id = p_user;
end;
$$;

-- 部门可见范围：本部门 scope ∪ 上级部门 scope（inherit_parent 为 true 时逐级向上）
-- 部门是「团队级」授权：信息中心配全模块，人力资源部配人事 / 绩效职能，
-- 部门内所有成员自动获得，不用给每个人单独配角色。
create or replace function public.dept_scope(p_user uuid)
returns text[]
language sql stable security definer set search_path = public
as $$
  with recursive chain as (
    select d.id, d.parent_id, coalesce(d.scope, '{}') as scope, d.inherit_parent, 1 as lvl
      from public.profiles p
      join public.departments d on d.id = p.department_id
     where p.id = p_user
    union all
    select d.id, d.parent_id, coalesce(d.scope, '{}'), d.inherit_parent, c.lvl + 1
      from chain c
      join public.departments d on d.id = c.parent_id
     where c.inherit_parent and c.lvl < 8
  )
  select coalesce(array_agg(distinct s), '{}')
    from chain c, unnest(c.scope) as s;
$$;

-- 权限判定：模块级权限码（stores.view / orders.edit / data.delete ...）
-- 四层收敛，缺一不可：
--   1) 账号必须 active
--   2) 系统角色给出「上限」：member 永远拿不到管人 / 管组织 / 管系统配置与删除
--   3) 部门范围（departments.scope，含上级继承）给出「团队级授权」
--   4) 岗位角色（roles.permissions）给出「个人范围」
-- 部门与角色取并集；两者都没配时，按系统角色默认值放行（兼容老库）。
-- 管理类权限不受角色 / 部门收窄，否则管理员很容易把自己锁在门外。
create or replace function public.has_permission(code text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((
    select case
      when coalesce(x.status, 'active') <> 'active' then false
      when x.role = 'super_admin' then true
      when code in ('account.manage', 'org.manage', 'system.manage') then x.role = 'admin'
      when x.role = 'admin' then
        x.role_id is null
        or code = any(coalesce(x.role_perms, '{}'))
        or code = any(x.dept)
      when x.role_id is null and coalesce(array_length(x.dept, 1), 0) = 0 then
        -- 未配角色、部门也没配范围：沿用老行为，业务模块全开放
        -- 绩效与人事属于敏感数据，不进入兜底（老库成员需要显式配置才能看）
        (code like '%.view' or code like '%.edit')
        and code not like 'performance.%' and code not like 'hr.%'
      else
        (code = any(coalesce(x.role_perms, '{}')) or code = any(x.dept))
        and (code like '%.view' or code like '%.edit' or code like 'hr.%' or code like 'performance.%'
             or code like 'finance.%')
    end
    from (
      select p.status, p.role, p.role_id,
             r.permissions as role_perms,
             public.dept_scope(p.id) as dept
        from public.profiles p
        left join public.roles r on r.id = p.role_id
       where p.id = auth.uid()
    ) x
  ), false);
$$;

do $do$
declare
  t text;
  tabs text[] := array[
    'profiles','stores','products','orders','inventory',
    'campaigns','creators','tasks','expenses',
    'competitors','competitor_snapshots','suppliers','purchase_orders','purchase_items',
    'departments','positions','roles','access_requests','employee_events',
    'performance_reviews','stock_movements','stock_transfers','purchase_payments','purchase_approvals',
    'brand_social_accounts','brand_influencers','brand_pr_contacts','brand_metrics',
    'dev_projects','dev_milestones','dev_costs',
    'finance_expenses','finance_expense_items','finance_budgets','finance_expense_approvals'
  ];
begin
  foreach t in array tabs loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$do$;

-- ---------- companies（平台级表，普通账号不可直读） ----------
alter table public.companies enable row level security;
drop policy if exists "companies_platform_only" on public.companies;
create policy "companies_platform_only" on public.companies
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- ---------- profiles ----------
drop policy if exists "profiles_select_own"   on public.profiles;
drop policy if exists "profiles_update_own"   on public.profiles;
drop policy if exists "profiles_insert_own"   on public.profiles;
drop policy if exists "profiles_select"       on public.profiles;
drop policy if exists "profiles_update_self"  on public.profiles;
drop policy if exists "profiles_update_staff" on public.profiles;
drop policy if exists "profiles_delete_super" on public.profiles;

-- 本人可见自己；管人 / 管组织 / 人事岗（HR）只可见本公司成员
-- 平台超管 company_id 为空，普通账号无法在列表 / 通讯录里看到他
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or (
      public.in_company(company_id)
      and (
        public.has_permission('account.manage')
        or public.has_permission('org.manage')
        or public.has_permission('hr.view')
      )
    )
  );

-- 本人可改自己的资料（角色 / 状态 / 组织归属由触发器拦截，不能自提权）
create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- 管理员可改他人档案
create policy "profiles_update_staff" on public.profiles
  for update to authenticated
  using (public.is_staff() and public.in_company(company_id))
  with check (public.is_staff() and public.in_company(company_id));

-- 人事岗（HR 部门）也能维护他人档案，但触发器 guard_profile_changes 会
-- 拦住角色 / 岗位角色字段，HR 只能动人事与组织归属，无法借此提权
drop policy if exists "profiles_update_hr" on public.profiles;
create policy "profiles_update_hr" on public.profiles
  for update to authenticated
  using (public.has_permission('hr.manage') and public.in_company(company_id))
  with check (public.has_permission('hr.manage') and public.in_company(company_id));

-- 仅超级管理员可移除档案，且不能移除自己
create policy "profiles_delete_super" on public.profiles
  for delete to authenticated
  using (public.is_super_admin() and public.in_company(company_id) and id <> auth.uid());

-- ---------- 业务表 ----------
-- 读：{模块}.view / 写：{模块}.edit / 删：data.delete
-- 表与权限模块的映射：广告活动归到 ads，费用台账归到 profit
do $do$
declare
  rec record;
begin
  for rec in
    select * from (values
      ('stores',    'stores'),
      ('products',  'products'),
      ('orders',    'orders'),
      ('inventory', 'inventory'),
      ('campaigns', 'ads'),
      ('creators',  'creators'),
      ('tasks',     'tasks'),
      ('expenses',  'profit'),
      ('competitors','competitors'),
      ('suppliers', 'purchase'),
      ('purchase_orders', 'purchase'),
      ('brand_social_accounts', 'brand'),
      ('brand_influencers', 'brand'),
      ('brand_pr_contacts', 'brand'),
      ('brand_metrics', 'brand'),
      ('dev_projects', 'dev'),
      ('finance_expenses', 'expense')
    ) as v(tbl, perm)
  loop
    -- 清理历史策略（旧版为 xxx_owner_all，按 user_id 隔离）
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_owner_all', rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_select',    rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_insert',    rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_update',    rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_delete',    rec.tbl);

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_permission(%L) and public.in_company(company_id))',
      rec.tbl || '_select', rec.tbl, rec.perm || '.view'
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.has_permission(%L) and public.in_company(company_id))',
      rec.tbl || '_insert', rec.tbl, rec.perm || '.edit'
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.has_permission(%L) and public.in_company(company_id)) with check (public.has_permission(%L) and public.in_company(company_id))',
      rec.tbl || '_update', rec.tbl, rec.perm || '.edit', rec.perm || '.edit'
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.has_permission(%L) and public.in_company(company_id))',
      rec.tbl || '_delete', rec.tbl, 'data.delete'
    );
  end loop;
end;
$do$;

-- ---------- 子表（竞品快照 / 采购明细） ----------
-- 这两张表只服务于主表的编辑流程：改一次采购单＝重写明细，
-- 因此 delete 跟随主表的 edit 权限，而不是 data.delete，
-- 否则「能编辑但无删除权」的岗位一改单子就会被 RLS 拒绝。
do $do$
declare
  rec record;
begin
  for rec in
    select * from (values
      ('competitor_snapshots', 'competitors'),
      ('purchase_items',       'purchase'),
      ('purchase_payments',    'purchase'),
      ('stock_movements',      'inventory'),
      ('stock_transfers',      'inventory'),
      ('supplier_products',    'purchase'),
      ('supplier_contacts',    'purchase'),
      ('purchase_approvals',   'purchase'),
      ('dev_milestones',       'dev'),
      ('dev_costs',            'dev'),
      ('finance_expense_items',      'expense'),
      ('finance_budgets',            'expense'),
      ('finance_expense_approvals',  'expense')
    ) as v(tbl, perm)
  loop
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_select', rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_insert', rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_update', rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_delete', rec.tbl);

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_permission(%L) and public.in_company(company_id))',
      rec.tbl || '_select', rec.tbl, rec.perm || '.view'
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.has_permission(%L) and public.in_company(company_id))',
      rec.tbl || '_insert', rec.tbl, rec.perm || '.edit'
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.has_permission(%L) and public.in_company(company_id)) with check (public.has_permission(%L) and public.in_company(company_id))',
      rec.tbl || '_update', rec.tbl, rec.perm || '.edit', rec.perm || '.edit'
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.has_permission(%L) and public.in_company(company_id))',
      rec.tbl || '_delete', rec.tbl, rec.perm || '.edit'
    );
  end loop;
end;
$do$;

-- ---------- 组织架构（部门 / 岗位 / 角色） ----------
-- 全员可读（通讯录、成员列表要显示部门与岗位名），写需要 org.manage
do $do$
declare
  t text;
  tabs text[] := array['departments', 'positions'];
begin
  foreach t in array tabs loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);

    execute format('create policy %I on public.%I for select to authenticated using (public.is_active_user())',
      t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.has_permission(%L))',
      t || '_insert', t, 'org.manage');
    execute format('create policy %I on public.%I for update to authenticated using (public.has_permission(%L)) with check (public.has_permission(%L))',
      t || '_update', t, 'org.manage', 'org.manage');
    execute format('create policy %I on public.%I for delete to authenticated using (public.has_permission(%L))',
      t || '_delete', t, 'org.manage');
  end loop;
end;
$do$;

drop policy if exists "roles_select" on public.roles;
drop policy if exists "roles_insert" on public.roles;
drop policy if exists "roles_update" on public.roles;
drop policy if exists "roles_delete" on public.roles;

create policy "roles_select" on public.roles
  for select to authenticated using (public.is_active_user());
create policy "roles_insert" on public.roles
  for insert to authenticated with check (public.has_permission('org.manage'));
create policy "roles_update" on public.roles
  for update to authenticated
  using (public.has_permission('org.manage'))
  with check (public.has_permission('org.manage'));
-- 内置角色（is_system）不允许删除，避免误删后权限矩阵出现空洞
create policy "roles_delete" on public.roles
  for delete to authenticated
  using (public.has_permission('org.manage') and not is_system);

-- ---------- 权限申请（access_requests） ----------
drop policy if exists "access_req_select"      on public.access_requests;
drop policy if exists "access_req_insert"      on public.access_requests;
drop policy if exists "access_req_update_own"  on public.access_requests;
drop policy if exists "access_req_update_staff" on public.access_requests;

-- 本人看自己的申请；管账号的人看全部（审批列表）
create policy "access_req_select" on public.access_requests
  for select to authenticated
  using (user_id = auth.uid() or public.has_permission('account.manage'));

-- 只能给自己申请，且新建一律 pending：
-- 否则可以伪造一条 approved 记录冒充审批结果
create policy "access_req_insert" on public.access_requests
  for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending');

-- 申请人只能撤回自己的待审批申请
create policy "access_req_update_own" on public.access_requests
  for update to authenticated
  using (user_id = auth.uid() and status = 'pending')
  with check (user_id = auth.uid() and status in ('pending', 'cancelled'));

create policy "access_req_update_staff" on public.access_requests
  for update to authenticated
  using (public.has_permission('account.manage'))
  with check (public.has_permission('account.manage'));

-- ---------- 人员变动流水（employee_events） ----------
drop policy if exists "emp_events_select" on public.employee_events;

-- 本人可见自己的轨迹，管理员可见全部；写入只发生在 security definer 函数里，
-- 所以不开放 insert / update / delete 策略，前端无法伪造审计记录
create policy "emp_events_select" on public.employee_events
  for select to authenticated
  using (profile_id = auth.uid() or public.has_permission('hr.view') or public.has_permission('account.manage'));

-- ---------- 绩效（performance_reviews） ----------
-- 本人看自己的；HR / 管理者看全部；录入与修改需要 performance.edit
drop policy if exists "perf_select" on public.performance_reviews;
drop policy if exists "perf_insert" on public.performance_reviews;
drop policy if exists "perf_update" on public.performance_reviews;
drop policy if exists "perf_delete" on public.performance_reviews;

create policy "perf_select" on public.performance_reviews
  for select to authenticated
  using (profile_id = auth.uid() or public.has_permission('performance.view'));
create policy "perf_insert" on public.performance_reviews
  for insert to authenticated
  with check (public.has_permission('performance.edit'));
create policy "perf_update" on public.performance_reviews
  for update to authenticated
  using (public.has_permission('performance.edit'))
  with check (public.has_permission('performance.edit'));
create policy "perf_delete" on public.performance_reviews
  for delete to authenticated
  using (public.has_permission('performance.edit'));

-- ---------- 档案变更自动留痕：入职 / 调岗 / 权限变更 / 停用 / 离职 ----------
create or replace function public.log_profile_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parts text[] := '{}';
  etype text;
begin
  if tg_op = 'INSERT' then
    insert into public.employee_events (profile_id, event_type, summary, detail, actor_id)
    values (
      new.id, 'hire', '账号档案创建',
      jsonb_build_object('role', new.role, 'employment_status', new.employment_status),
      auth.uid()
    );
    return new;
  end if;

  if new.status is distinct from old.status then
    parts := array_append(parts, case when new.status = 'disabled' then '账号停用' else '账号启用' end);
  end if;
  if new.employment_status is distinct from old.employment_status then
    parts := array_append(parts, case new.employment_status
      when 'pending' then '标记为待入职'
      when 'active'  then '转入在职'
      else '标记为离职' end);
  end if;
  if new.role is distinct from old.role then
    parts := array_append(parts, '系统角色 ' || old.role || ' → ' || new.role);
  end if;
  if new.role_id is distinct from old.role_id then
    parts := array_append(parts, '岗位角色变更');
  end if;
  if new.department_id is distinct from old.department_id then
    parts := array_append(parts, '部门变更');
  end if;
  if new.position_id is distinct from old.position_id then
    parts := array_append(parts, '岗位变更');
  end if;

  if array_length(parts, 1) is null then
    return new;
  end if;

  etype := case
    when new.employment_status = 'left' and old.employment_status <> 'left' then 'offboard'
    when new.employment_status = 'active' and old.employment_status = 'pending' then 'activate'
    when new.role is distinct from old.role or new.role_id is distinct from old.role_id then 'permission'
    when new.department_id is distinct from old.department_id
      or new.position_id is distinct from old.position_id then 'transfer'
    when new.status is distinct from old.status and new.status = 'disabled' then 'disable'
    when new.status is distinct from old.status and new.status = 'active' then 'enable'
    else 'transfer'
  end;

  insert into public.employee_events (profile_id, event_type, summary, detail, actor_id)
  values (
    new.id, etype, array_to_string(parts, '；'),
    jsonb_build_object(
      'role',        jsonb_build_array(old.role, new.role),
      'status',      jsonb_build_array(old.status, new.status),
      'employment',  jsonb_build_array(old.employment_status, new.employment_status),
      'department',  jsonb_build_array(old.department_id, new.department_id),
      'position',    jsonb_build_array(old.position_id, new.position_id),
      'role_id',     jsonb_build_array(old.role_id, new.role_id)
    ),
    auth.uid()
  );
  return new;
end;
$$;

drop trigger if exists trg_log_profile_change on public.profiles;
create trigger trg_log_profile_change
  after insert or update on public.profiles
  for each row execute function public.log_profile_change();

-- ---------- 资源移交：把一个人名下的记录整体转给另一个人 ----------
-- 离职交接会调用它；也可以单独用（调岗、分工调整、休假代管）
create or replace function public.transfer_member_resources(p_from uuid, p_to uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n     int;
  tbl   text;
  moved jsonb := '{}'::jsonb;
  to_name text;
  tabs  text[] := array[
    'stores','products','orders','inventory','campaigns','creators','tasks','expenses',
    'competitors','competitor_snapshots','suppliers','supplier_products','purchase_orders','purchase_items',
    'stock_movements','stock_transfers','brand_social_accounts','brand_influencers','brand_pr_contacts',
    'finance_expenses','finance_expense_items','finance_budgets'
  ];
begin
  perform public.assert_row_company('profiles', p_from);
  perform public.assert_row_company('profiles', p_to);
  if not (public.is_staff() or public.has_permission('hr.manage')) then
    raise exception '只有管理员或人事岗可以移交资源';
  end if;
  if p_from is null or p_to is null then
    raise exception '移交双方都必须指定';
  end if;
  if p_from = p_to then
    raise exception '移交双方不能是同一个人';
  end if;
  if not exists (select 1 from public.profiles where id = p_from) then
    raise exception '原负责人不存在';
  end if;
  if not exists (select 1 from public.profiles where id = p_to and status = 'active') then
    raise exception '接手人不存在或账号已停用';
  end if;

  foreach tbl in array tabs loop
    begin
      execute format('update public.%I set user_id = $1 where user_id = $2', tbl)
        using p_to, p_from;
      get diagnostics n = row_count;
      if n > 0 then
        moved := moved || jsonb_build_object(tbl, n);
      end if;
    exception when undefined_table or undefined_column then
      null;   -- 旧库还没建这张表，跳过
    end;
  end loop;

  select coalesce(full_name, email, '接手人') into to_name from public.profiles where id = p_to;
  insert into public.employee_events (profile_id, event_type, summary, detail, actor_id)
  values (
    p_from, 'transfer',
    '名下资源移交给 ' || to_name,
    jsonb_build_object('moved', moved, 'to', p_to),
    auth.uid()
  );

  return moved;
end;
$$;

-- ---------- 离职交接：转移资源 + 回收权限，一次事务内完成 ----------
-- 前端分步调用会出现「资源转走了但权限没回收」的中间态，所以收进数据库函数。
-- security definer：跨 13 张表批量改 user_id，普通 authenticated 做不到。
create or replace function public.offboard_member(
  p_target   uuid,
  p_handover uuid default null,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t     record;
  moved jsonb := '{}'::jsonb;
begin
  perform public.assert_row_company('profiles', p_target);
  if p_handover is not null then
    perform public.assert_row_company('profiles', p_handover);
  end if;
  if not (public.is_staff() or public.has_permission('hr.manage')) then
    raise exception '只有管理员或人事岗可以办理离职交接';
  end if;
  if p_target = auth.uid() then
    raise exception '不能给自己办理离职';
  end if;

  select * into t from public.profiles where id = p_target;
  if not found then
    raise exception '成员不存在';
  end if;
  if t.role = 'super_admin' then
    raise exception '超级管理员不能直接办理离职，请先把超管权限交给其他账号';
  end if;
  if t.role = 'admin' and not public.is_super_admin() then
    raise exception '只有超级管理员可以办理管理员的离职';
  end if;
  if p_handover = p_target then
    raise exception '交接人不能是离职人自己';
  end if;

  -- 本事务内允许改写角色 / 组织字段（guard_profile_changes 会放行）
  perform set_config('app.offboarding', '1', true);

  -- 资源交接：把离职人名下的记录整体转给接手人；
  -- 不指定接手人时保留原归属（作为团队公共数据），不会丢失
  if p_handover is not null then
    moved := public.transfer_member_resources(p_target, p_handover);
  end if;

  -- 回收权限：清空部门 / 岗位 / 岗位角色，系统角色降为普通人员，账号停用
  update public.profiles
     set status            = 'disabled',
         employment_status = 'left',
         left_at           = now(),
         left_reason       = nullif(btrim(coalesce(p_reason, '')), ''),
         handover_to       = p_handover,
         department_id     = null,
         position_id       = null,
         role_id           = null,
         role              = 'member'
   where id = p_target;

  return jsonb_build_object('handover_to', p_handover, 'moved', moved);
end;
$$;

-- ---------- 权限申请审批：通过即生效，驳回只留痕 ----------
create or replace function public.decide_access_request(
  p_id       uuid,
  p_approve  boolean,
  p_note     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r      record;
  target record;
begin
  perform public.assert_row_company('access_requests', p_id);
  if not public.has_permission('account.manage') then
    raise exception '只有管理员可以审批权限申请';
  end if;

  select * into r from public.access_requests where id = p_id for update;
  if not found then
    raise exception '申请不存在';
  end if;
  if r.status <> 'pending' then
    raise exception '该申请已经处理过了';
  end if;
  if r.user_id = auth.uid() then
    raise exception '不能审批自己的申请';
  end if;

  select * into target from public.profiles where id = r.user_id;
  if not found then
    raise exception '申请人档案不存在';
  end if;
  if target.role = 'super_admin' then
    raise exception '超级管理员的权限不能通过申请流程变更';
  end if;

  if p_approve then
    if r.target_role is not null then
      if r.target_role = 'admin' and not public.is_super_admin() then
        raise exception '只有超级管理员可以授予管理员';
      end if;
      update public.profiles set role = r.target_role where id = r.user_id;
    end if;
    if r.target_role_id is not null then
      if not exists (select 1 from public.roles where id = r.target_role_id) then
        raise exception '申请的角色已被删除';
      end if;
      update public.profiles set role_id = r.target_role_id where id = r.user_id;
    end if;
  end if;

  update public.access_requests
     set status        = case when p_approve then 'approved' else 'rejected' end,
         decided_by    = auth.uid(),
         decided_at    = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_id;
end;
$$;

-- ---------- 角色变更守卫：防止普通成员给自己提权 ----------
create or replace function public.guard_profile_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- SQL Editor / service_role 直连时 auth.uid() 为空，视为后台运维，直接放行
  if auth.uid() is null then
    return new;
  end if;

  -- 离职交接函数在本事务内打标：它要做「降级 + 清空组织 + 停用」的原子操作，
  -- 这些字段平时只有管理员能改，但函数内部已经做过 hr.manage 与目标角色校验
  if coalesce(current_setting('app.offboarding', true), '') = '1' then
    return new;
  end if;

  -- 平台超管账号受保护：其他人不能改他的角色 / 状态 / 公司归属
  if lower(coalesce(old.email, '')) = 'yinsuccess168@163.com'
     and not public.is_super_admin() then
    raise exception '不能修改平台超级管理员账号';
  end if;

  -- 全局超管唯一：只有指定邮箱能持有 super_admin，公司内最高为普通管理员
  if new.role = 'super_admin'
     and lower(coalesce(new.email, '')) <> 'yinsuccess168@163.com' then
    raise exception '公司内最高角色为普通管理员，不能设置超级管理员';
  end if;

  -- 公司归属不能随意改（防串租户）；仅允许管理员把新同事从默认公司拉进本公司
  if new.company_id is distinct from old.company_id then
    if not public.is_super_admin()
       and not (
         public.is_staff()
         and old.company_id = '00000000-0000-0000-0000-000000000001'::uuid
         and new.company_id = public.current_company_id()
       ) then
      raise exception '只有平台超级管理员可以调整账号所属公司';
    end if;
  end if;

  -- 系统角色只能由管理员调整：人事岗（HR）也不行，否则 HR 可以给自己升管理员
  if new.role is distinct from old.role then
    if public.is_super_admin() then
      -- 不允许把自己降级，否则可能把系统锁死
      if old.id = auth.uid() and new.role is distinct from 'super_admin' then
        raise exception '不能降低自己的超级管理员权限';
      end if;
      return new;
    elsif public.is_staff() then
      if old.role = 'super_admin' or new.role = 'super_admin' then
        raise exception '只有超级管理员才能调整超级管理员账号';
      end if;
      return new;
    else
      raise exception '只有管理员可以调整系统角色';
    end if;
  end if;

  -- 账号启停：管理员不限；HR 只能处理普通人员（入职开通、离职停用）
  if new.status is distinct from old.status then
    if public.is_staff() then
      if old.role = 'super_admin' and not public.is_super_admin() then
        raise exception '只有超级管理员才能调整超级管理员账号';
      end if;
    elsif public.has_permission('hr.manage') then
      if old.role <> 'member' then
        raise exception '人事岗只能调整普通人员的账号状态';
      end if;
    else
      raise exception '无权修改账号状态';
    end if;
  end if;

  -- 岗位角色决定业务权限，只认管理员：否则普通成员可以给自己挂全权限角色
  if new.role_id is distinct from old.role_id then
    if not public.is_staff() then
      raise exception '只有管理员可以调整岗位角色';
    end if;
  end if;

  -- 部门 / 岗位归属：管理员和人事岗都可以（入职分配、调岗）
  if new.department_id is distinct from old.department_id
     or new.position_id is distinct from old.position_id then
    if not (public.is_staff() or public.has_permission('hr.manage')) then
      raise exception '无权修改部门或岗位，请联系管理员';
    end if;
    -- 人事岗不能借调岗把自己或他人塞进更高权限的部门
    if not public.is_staff() and new.id = auth.uid() then
      raise exception '人事岗不能调整自己的部门或岗位';
    end if;
  end if;

  -- 人事字段：管理员与 HR 可维护（入职日期、离职时间、交接人）
  if new.employment_status is distinct from old.employment_status
     or new.hire_date      is distinct from old.hire_date
     or new.left_at        is distinct from old.left_at
     or new.left_reason    is distinct from old.left_reason
     or new.handover_to    is distinct from old.handover_to
     or new.provisioned_by is distinct from old.provisioned_by then
    if not (public.is_staff() or public.has_permission('hr.manage')) then
      raise exception '无权修改人事状态或入职离职信息，请联系管理员';
    end if;
  end if;

  -- 员工工号：管理员与人事岗可维护，其他成员（含本人）不能自行修改
  -- 放在数据库守卫层，绕过界面直接调 API 也同样被拦住
  if new.employee_no is distinct from old.employee_no then
    if not (public.is_staff() or public.has_permission('hr.manage')) then
      raise exception '员工工号只能由管理员或人事岗修改';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_profile_changes on public.profiles;
create trigger trg_guard_profile_changes
  before update on public.profiles
  for each row execute function public.guard_profile_changes();

-- ---------- 业务唯一键：改为团队级，避免多人录入同一 SKU 冲突 ----------
alter table public.products drop constraint if exists products_user_id_store_id_sku_key;
create unique index if not exists uq_products_sku on public.products(store_id, sku);

alter table public.inventory drop constraint if exists inventory_user_id_store_id_sku_warehouse_key;
create unique index if not exists uq_inventory_sku on public.inventory(store_id, sku, warehouse);

drop index if exists uq_orders_no;
create unique index if not exists uq_orders_no on public.orders(store_id, order_no);

-- =============================================================
--  16. 业务链路函数
--      所有写操作都走函数：库存、成本、付款、状态的变更必须原子完成，
--      前端直接 update 表会留下「库存扣了但单子没标出库」这类脏数据。
-- =============================================================

-- ---------- SKU 加权采购成本 ----------
-- 用全部入库流水的加权平均作为当前成本，采购价波动会自然反映到利润上。
create or replace function public.sku_avg_cost(p_sku text)
returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select round(sum(qty * unit_cost) / nullif(sum(qty), 0), 2)
       from public.stock_movements
      where sku = p_sku and qty > 0 and unit_cost > 0
        and public.in_company(company_id)),
    0);
$$;

-- ---------- 库存增减（唯一入口） ----------
create or replace function public.bump_inventory(
  p_store_id   uuid,
  p_product_id uuid,
  p_sku        text,
  p_warehouse  text,
  p_delta      integer,
  p_title      text default null
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid;
  v_qty  integer;
begin
  perform public.assert_row_company('stores', p_store_id);
  if p_store_id is null or coalesce(btrim(p_sku), '') = '' then
    return null;                       -- 国内仓或没绑 SKU 时不动店铺库存
  end if;

  select coalesce(user_id, auth.uid()) into v_user from public.stores where id = p_store_id;
  v_user := coalesce(v_user, auth.uid());

  insert into public.inventory (user_id, store_id, product_id, sku, title, warehouse, available_qty)
  values (v_user, p_store_id, p_product_id, btrim(p_sku), p_title,
          coalesce(nullif(btrim(coalesce(p_warehouse, '')), ''), 'FBA-US'), p_delta)
  on conflict (user_id, store_id, sku, warehouse)
  do update set available_qty = inventory.available_qty + p_delta,
                product_id    = coalesce(inventory.product_id, excluded.product_id),
                title         = coalesce(inventory.title, excluded.title),
                updated_at    = now()
  returning available_qty into v_qty;

  return v_qty;
end;
$$;

-- ---------- 订单出库：扣库存 + 写流水 + 回填成本 ----------
-- 库存不足时不抛异常而是返回 ok=false，前端可以顺势引导「生成补货采购单」。
create or replace function public.fulfill_order(
  p_order_id  uuid,
  p_warehouse text    default null,
  p_force     boolean default false
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  o       record;
  v_wh    text;
  v_avail integer;
  v_qty   integer;
  v_cost  numeric(12,2);
begin
  perform public.assert_row_company('orders', p_order_id);
  if not public.has_permission('orders.edit') then
    raise exception '没有订单编辑权限';
  end if;

  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception '订单不存在'; end if;

  if o.stock_state = 'out' then
    return jsonb_build_object('ok', true, 'already', true, 'available', 0);
  end if;

  v_wh  := coalesce(nullif(btrim(coalesce(p_warehouse, '')), ''), o.fulfillment_wh, 'FBA-US');
  v_qty := greatest(1, o.quantity);

  select coalesce(sum(available_qty), 0) into v_avail
    from public.inventory
   where store_id = o.store_id and sku = o.sku and warehouse = v_wh;

  if v_qty > v_avail and not p_force then
    return jsonb_build_object(
      'ok', false, 'reason', 'shortage',
      'available', v_avail, 'need', v_qty, 'shortage', v_qty - v_avail,
      'warehouse', v_wh, 'sku', o.sku);
  end if;

  v_cost := public.sku_avg_cost(o.sku);

  insert into public.stock_movements
    (user_id, store_id, product_id, sku, title, warehouse, move_type, qty, unit_cost,
     ref_type, ref_id, ref_no, owner_id, note)
  values
    (o.user_id, o.store_id, o.product_id, o.sku, o.title, v_wh, 'out', -v_qty, v_cost,
     'order', o.id, o.order_no, coalesce(o.owner_id, auth.uid()), '订单出库');

  perform public.bump_inventory(o.store_id, o.product_id, o.sku, v_wh, -v_qty, o.title);

  update public.orders
     set stock_state    = 'out',
         fulfilled_at   = now(),
         fulfillment_wh = v_wh,
         cost_source    = case when v_cost > 0 then 'stock' else cost_source end,
         cost_amount    = case when v_cost > 0 then round(v_cost * greatest(1, quantity), 2) else cost_amount end
   where id = o.id;

  return jsonb_build_object('ok', true, 'available', v_avail - v_qty,
                            'warehouse', v_wh, 'unit_cost', v_cost);
end;
$$;

-- ---------- 撤销出库（取消 / 退款时把货退回库存） ----------
create or replace function public.restore_order_stock(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  o record;
  m record;
  v_back integer := 0;
begin
  perform public.assert_row_company('orders', p_order_id);
  if not public.has_permission('orders.edit') then
    raise exception '没有订单编辑权限';
  end if;

  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception '订单不存在'; end if;
  if o.stock_state <> 'out' then
    return jsonb_build_object('ok', false, 'reason', 'not_out');
  end if;

  for m in
    select * from public.stock_movements
     where ref_type = 'order' and ref_id = p_order_id and move_type = 'out'
  loop
    insert into public.stock_movements
      (user_id, store_id, product_id, sku, title, warehouse, move_type, qty, unit_cost,
       ref_type, ref_id, ref_no, owner_id, note)
    values
      (m.user_id, m.store_id, m.product_id, m.sku, m.title, m.warehouse, 'return', -m.qty, m.unit_cost,
       'order', o.id, o.order_no, m.owner_id, '出库撤销');

    perform public.bump_inventory(m.store_id, m.product_id, m.sku, m.warehouse, -m.qty, m.title);
    v_back := v_back + (-m.qty);
  end loop;

  update public.orders set stock_state = 'returned' where id = o.id;
  return jsonb_build_object('ok', true, 'restored', v_back);
end;
$$;

-- ---------- 采购单应付总额 ----------
create or replace function public.po_total(p_po_id uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce((select sum(amount) from public.purchase_items
                    where po_id = p_po_id and public.in_company(company_id)), 0)
       + coalesce((select shipping_fee + other_fee from public.purchase_orders
                    where id = p_po_id and public.in_company(company_id)), 0);
$$;

-- ---------- 采购审核：提交（采购员）/ 通过或驳回（财务） ----------
-- 所有判定放在 security definer 函数里：绕过界面直接改表也过不了付款闸门
create or replace function public.submit_purchase(
  p_po_id uuid,
  p_note  text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  po record;
begin
  perform public.assert_row_company('purchase_orders', p_po_id);
  if not public.has_permission('purchase.edit') then
    raise exception '没有采购编辑权限';
  end if;
  select * into po from public.purchase_orders where id = p_po_id for update;
  if not found then raise exception '采购单不存在'; end if;
  if po.status = 'cancelled' then raise exception '已取消的采购单不能提交审核'; end if;
  if po.approval_status = 'approved' and coalesce(po.paid_amount, 0) > 0 then
    raise exception '已付款的采购单不能撤回审核';
  end if;

  update public.purchase_orders
     set approval_status = 'pending', approved_by = null, approved_at = null,
         approval_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
   where id = po.id;
  insert into public.purchase_approvals (user_id, po_id, action, note)
  values (auth.uid(), po.id, case when po.approval_status = 'approved' then 'revoke' else 'submit' end, p_note);
  return jsonb_build_object('ok', true, 'status', 'pending');
end;
$$;

create or replace function public.approve_purchase(
  p_po_id    uuid,
  p_decision text,
  p_note     text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  po     record;
  v_role text;
begin
  perform public.assert_row_company('purchase_orders', p_po_id);
  if not public.has_permission('finance.audit') then
    raise exception '没有采购财务审核权限';
  end if;
  if coalesce(p_decision, '') not in ('approved', 'rejected') then
    raise exception '审核结果只能是 approved 或 rejected';
  end if;
  select * into po from public.purchase_orders where id = p_po_id for update;
  if not found then raise exception '采购单不存在'; end if;
  if po.status = 'cancelled' then raise exception '已取消的采购单不能审核'; end if;
  if po.approval_status <> 'pending' then
    raise exception '该采购单已审核，如需变更请先撤回重新提交';
  end if;
  select role into v_role from public.profiles where id = auth.uid();
  if coalesce(po.buyer_id, po.user_id) = auth.uid() and coalesce(v_role, 'member') <> 'super_admin' then
    raise exception '不能审核自己创建的采购单';
  end if;

  update public.purchase_orders
     set approval_status = p_decision,
         approved_by = auth.uid(),
         approved_at = now(),
         approval_note = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at = now()
   where id = po.id;
  insert into public.purchase_approvals (user_id, po_id, action, note)
  values (auth.uid(), po.id, case when p_decision = 'approved' then 'approve' else 'reject' end, p_note);
  return jsonb_build_object('ok', true, 'status', p_decision);
end;
$$;

-- ---------- 付款登记：自动维护已付金额与付款状态 ----------
create or replace function public.register_payment(
  p_po_id    uuid,
  p_amount   numeric,
  p_paid_at  date default current_date,
  p_method   text default 'bank',
  p_voucher  text default null,
  p_note     text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  po       record;
  v_paid   numeric(14,2);
  v_total  numeric(14,2);
  v_status text;
begin
  perform public.assert_row_company('purchase_orders', p_po_id);
  if not public.has_permission('purchase.edit') then
    raise exception '没有采购编辑权限';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception '付款金额必须大于 0';
  end if;

  select * into po from public.purchase_orders where id = p_po_id for update;
  if not found then raise exception '采购单不存在'; end if;
  if po.approval_status <> 'approved' then
    raise exception '采购单尚未通过财务审核，不能登记付款';
  end if;
  if po.status = 'cancelled' then
    raise exception '已取消的采购单不能付款';
  end if;

  insert into public.purchase_payments
    (user_id, po_id, amount, currency, paid_at, method, voucher_no, payer_id, note)
  values
    (po.user_id, po.id, round(p_amount, 2), po.currency, coalesce(p_paid_at, current_date),
     coalesce(nullif(btrim(coalesce(p_method, '')), ''), 'bank'), p_voucher, auth.uid(), p_note);

  select coalesce(sum(amount), 0) into v_paid from public.purchase_payments where po_id = po.id;
  v_total  := public.po_total(po.id);
  v_status := case when v_paid <= 0 then 'unpaid'
                   when v_paid + 0.01 >= v_total then 'paid'
                   else 'partial' end;

  update public.purchase_orders
     set paid_amount = v_paid, payment_status = v_status, updated_at = now()
   where id = po.id;

  return jsonb_build_object('ok', true, 'paid', v_paid, 'total', v_total, 'status', v_status);
end;
$$;

-- ---------- 费用单提交审核（费用经办人）/ 撤回重审 ----------
create or replace function public.submit_expense(
  p_expense_id uuid,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  ex record;
begin
  perform public.assert_row_company('finance_expenses', p_expense_id);
  if not public.has_permission('expense.edit') then
    raise exception '没有费用编辑权限';
  end if;
  select * into ex from public.finance_expenses where id = p_expense_id for update;
  if not found then raise exception '费用单不存在'; end if;
  if ex.status = 'paid' then raise exception '已付款的费用单不能撤回审核'; end if;
  if coalesce(ex.amount, 0) <= 0 then raise exception '费用金额必须大于 0，请先录入明细'; end if;

  update public.finance_expenses
     set status = 'pending', approved_by = null, approved_at = null,
         approval_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
   where id = ex.id;
  insert into public.finance_expense_approvals (user_id, expense_id, action, note)
  values (auth.uid(), ex.id, case when ex.status = 'approved' then 'revoke' else 'submit' end, p_note);
  return jsonb_build_object('ok', true, 'status', 'pending');
end;
$$;

-- ---------- 费用单财务审核：通过 / 驳回（复用 finance.audit） ----------
create or replace function public.approve_expense(
  p_expense_id uuid,
  p_decision   text,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  ex     record;
  v_role text;
begin
  perform public.assert_row_company('finance_expenses', p_expense_id);
  if not public.has_permission('finance.audit') then
    raise exception '没有费用财务审核权限';
  end if;
  if coalesce(p_decision, '') not in ('approved', 'rejected') then
    raise exception '审核结果只能是 approved 或 rejected';
  end if;
  select * into ex from public.finance_expenses where id = p_expense_id for update;
  if not found then raise exception '费用单不存在'; end if;
  if ex.status <> 'pending' then
    raise exception '费用单不在待审核状态，如需变更请先撤回重新提交';
  end if;
  select role into v_role from public.profiles where id = auth.uid();
  if ex.user_id = auth.uid() and coalesce(v_role, 'member') <> 'super_admin' then
    raise exception '不能审核自己提交的费用单';
  end if;

  update public.finance_expenses
     set status = p_decision,
         approved_by = auth.uid(),
         approved_at = now(),
         approval_note = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at = now()
   where id = ex.id;
  insert into public.finance_expense_approvals (user_id, expense_id, action, note)
  values (auth.uid(), ex.id, p_decision, p_note);
  return jsonb_build_object('ok', true, 'status', p_decision);
end;
$$;

-- ---------- 费用付款登记：先审核后付款，闸门写在数据库里 ----------
create or replace function public.pay_expense(
  p_expense_id   uuid,
  p_paid_at      date default current_date,
  p_method       text default 'bank',
  p_voucher      text default null,
  p_note         text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  ex record;
begin
  perform public.assert_row_company('finance_expenses', p_expense_id);
  if not public.has_permission('expense.edit') then
    raise exception '没有费用编辑权限';
  end if;
  select * into ex from public.finance_expenses where id = p_expense_id for update;
  if not found then raise exception '费用单不存在'; end if;
  if ex.status = 'paid' then raise exception '该费用单已付款，请勿重复登记'; end if;
  if ex.status <> 'approved' then
    raise exception '费用单未通过财务审核，不能登记付款';
  end if;

  update public.finance_expenses
     set status = 'paid',
         paid_at = coalesce(p_paid_at, current_date),
         payment_method = coalesce(nullif(btrim(coalesce(p_method, '')), ''), 'bank'),
         voucher_no = nullif(btrim(coalesce(p_voucher, '')), ''),
         note = coalesce(p_note, ex.note),
         updated_at = now()
   where id = ex.id;
  insert into public.finance_expense_approvals (user_id, expense_id, action, note)
  values (auth.uid(), ex.id, 'pay', p_note);
  return jsonb_build_object('ok', true, 'status', 'paid', 'amount', ex.amount);
end;
$$;

-- ---------- 采购到货入库：写流水 + 加库存 + 回流加权成本 + 刷状态 ----------
create or replace function public.receive_purchase(
  p_po_id     uuid,
  p_lines     jsonb,                -- [{item_id, qty, unit_cost}]
  p_warehouse text default null,
  p_note      text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  po       record;
  line     jsonb;
  it       record;
  i        integer;
  v_qty    integer;
  v_remain integer;
  v_cost   numeric(12,2);
  v_wh     text;
  v_total  integer := 0;
  v_done   boolean;
  v_any    boolean := false;
  v_skus   text[] := '{}';
  v_rows   jsonb := '[]'::jsonb;
begin
  perform public.assert_row_company('purchase_orders', p_po_id);
  if not public.has_permission('purchase.edit') then
    raise exception '没有采购编辑权限';
  end if;

  select * into po from public.purchase_orders where id = p_po_id for update;
  if not found then raise exception '采购单不存在'; end if;
  if po.status = 'cancelled' then
    raise exception '已取消的采购单不能入库';
  end if;
  if po.approval_status = 'rejected' then
    raise exception '采购单已被财务驳回，请先修改并重新提交审核';
  end if;

  v_wh := coalesce(nullif(btrim(coalesce(p_warehouse, '')), ''), po.warehouse, '国内仓');

  for line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select * into it from public.purchase_items
     where id = (line->>'item_id')::uuid and po_id = p_po_id
     for update;
    if not found then continue; end if;

    v_remain := greatest(0, it.quantity - it.received_qty);
    v_qty    := least(v_remain, greatest(0, round(coalesce((line->>'qty')::numeric, 0))::integer));
    if v_qty <= 0 then continue; end if;

    v_cost := coalesce(nullif((line->>'unit_cost')::numeric, 0), it.unit_price, 0);

    update public.purchase_items set received_qty = received_qty + v_qty where id = it.id;

    insert into public.stock_movements
      (user_id, store_id, product_id, sku, title, warehouse, move_type, qty, unit_cost,
       ref_type, ref_id, ref_no, owner_id, note)
    values
      (po.user_id, po.store_id, it.product_id, it.sku, it.title, v_wh, 'in', v_qty, v_cost,
       'purchase', po.id, po.po_no, coalesce(po.buyer_id, auth.uid()),
       coalesce(nullif(btrim(coalesce(p_note, '')), ''), '采购入库'));

    if po.store_id is not null then
      perform public.bump_inventory(po.store_id, it.product_id, it.sku, v_wh, v_qty, it.title);
    end if;

    v_skus  := array_append(v_skus, it.sku);
    v_rows  := v_rows || jsonb_build_object('sku', it.sku, 'qty', v_qty, 'unit_cost', v_cost);
    v_total := v_total + v_qty;
    v_any   := true;
  end loop;

  if not v_any then
    return jsonb_build_object('ok', false, 'reason', 'empty', 'message', '没有可入库的数量');
  end if;

  -- 采购价回流商品档案：后续订单的成本与利润自动跟着变
  for i in 1 .. coalesce(array_length(v_skus, 1), 0) loop
    update public.products p
       set cost_price = c.avg_cost
      from (select public.sku_avg_cost(v_skus[i]) as avg_cost) c
     where p.sku = v_skus[i] and c.avg_cost > 0;
  end loop;

  select bool_and(received_qty >= quantity) into v_done
    from public.purchase_items where po_id = po.id;

  update public.purchase_orders
     set status      = case when v_done then 'received' else 'partial' end,
         received_at = case when v_done then now() else received_at end,
         updated_at  = now()
   where id = po.id;

  return jsonb_build_object('ok', true, 'received', v_total, 'lines', v_rows,
                            'status', case when v_done then 'received' else 'partial' end);
end;
$$;

-- ---------- 缺货补货建议：销量 × 交期 + 安全库存 − 可用 − 在途 ----------
create or replace function public.shortage_plan(p_store_id uuid default null)
returns table (
  sku         text,
  title       text,
  product_id  uuid,
  store_id    uuid,
  available   bigint,
  inbound     bigint,
  safety      bigint,
  avg_daily   numeric,
  days_cover  numeric,
  suggest_qty integer,
  lead_time   integer
)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if p_store_id is not null then
    perform public.assert_row_company('stores', p_store_id);
  end if;
  return query
  with lead as (
    select coalesce(round(avg(lead_time_days))::integer, 30) as d
      from public.suppliers where status = 'active' and public.in_company(company_id)
  ),
  sales as (
    select o.sku, o.store_id, sum(o.quantity)::numeric / 30.0 as daily
      from public.orders o
     where o.order_date >= current_date - 30
       and o.status not in ('cancelled', 'refunded')
       and coalesce(btrim(o.sku), '') <> ''
       and public.in_company(o.company_id)
     group by o.sku, o.store_id
  ),
  inv as (
    select i.sku, i.store_id,
           sum(i.available_qty)::bigint            as available,
           sum(i.inbound_qty)::bigint              as inbound,
           max(i.safety_stock)::bigint             as safety,
           max(i.title)                            as title,
           max(i.product_id::text)::uuid           as product_id
      from public.inventory i
     where public.in_company(i.company_id)
     group by i.sku, i.store_id
  ),
  po as (
    select u.sku, u.store_id, sum(u.inbound_po)::bigint as inbound_po
      from (
        select pi.sku, p.store_id, (pi.quantity - pi.received_qty)::bigint as inbound_po
          from public.purchase_items pi
          join public.purchase_orders p on p.id = pi.po_id
         where p.status in ('ordered', 'partial')
           and public.in_company(p.company_id)
        union all
        select tr.sku, tr.store_id, (tr.qty - tr.received_qty)::bigint
          from public.stock_transfers tr
         where tr.status in ('in_transit', 'partial') and tr.store_id is not null
      ) u
     group by u.sku, u.store_id
  ),
  merged as (
    select coalesce(s.sku, i.sku)                  as sku,
           coalesce(i.store_id, s.store_id)        as store_id,
           i.title, i.product_id,
           coalesce(i.available, 0)                as available,
           coalesce(i.inbound, 0) + coalesce(po.inbound_po, 0) as inbound,
           coalesce(i.safety, 0)                   as safety,
           coalesce(s.daily, 0)                    as daily
      from sales s
      full join inv i on i.sku = s.sku and i.store_id = s.store_id
      left join po on po.sku = coalesce(s.sku, i.sku)
                  and po.store_id = coalesce(i.store_id, s.store_id)
  )
  select m.sku, m.title, m.product_id, m.store_id,
         m.available, m.inbound, m.safety,
         round(m.daily, 2)                                                  as avg_daily,
         case when m.daily > 0 then round((m.available + m.inbound) / m.daily, 1) else null end as days_cover,
         greatest(0, ceil(m.daily * l.d + m.safety - m.available - m.inbound))::integer as suggest_qty,
         l.d                                                                as lead_time
    from merged m cross join lead l
   where (p_store_id is null or m.store_id = p_store_id)
     and greatest(0, ceil(m.daily * l.d + m.safety - m.available - m.inbound)) > 0
   order by greatest(0, ceil(m.daily * l.d + m.safety - m.available - m.inbound)) desc
   limit 200;
end;
$$;

-- ---------- 一键把缺货建议生成采购单（订单驱动补货） ----------
create or replace function public.create_po_from_shortage(
  p_lines       jsonb,                -- [{sku,title,product_id,qty,unit_cost}]
  p_supplier_id uuid default null,
  p_store_id    uuid default null,
  p_order_id    uuid default null,
  p_warehouse   text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_po_id  uuid;
  v_po_no  text;
  v_seq    integer;
  v_prefix text;
  v_sku    text;
  line     jsonb;
  v_count  integer := 0;
  v_amt    numeric(14,2) := 0;
  v_lead   integer := 30;
begin
  -- 可选关联对象都要落在当前公司，避免跨租户生成采购单
  if p_store_id is not null then
    perform public.assert_row_company('stores', p_store_id);
  end if;
  if p_order_id is not null then
    perform public.assert_row_company('orders', p_order_id);
  end if;
  if p_supplier_id is not null then
    perform public.assert_row_company('suppliers', p_supplier_id);
  end if;
  if not public.has_permission('purchase.edit') then
    raise exception '没有采购编辑权限';
  end if;
  if coalesce(jsonb_array_length(coalesce(p_lines, '[]'::jsonb)), 0) = 0 then
    raise exception '没有需要采购的商品';
  end if;

  v_prefix := 'PO' || to_char(current_date, 'YYYYMMDD') || '-';
  select coalesce(max(substring(po_no from '([0-9]+)$')::integer), 0) + 1
    into v_seq
    from public.purchase_orders
   where po_no like v_prefix || '%';
  v_po_no := v_prefix || lpad(v_seq::text, 3, '0');

  if p_supplier_id is not null then
    select coalesce(lead_time_days, 30) into v_lead
      from public.suppliers where id = p_supplier_id;
  end if;

  insert into public.purchase_orders
    (user_id, po_no, supplier_id, store_id, warehouse, order_date, expected_date,
     status, source, source_order_id, buyer_id)
  values
    (auth.uid(), v_po_no, p_supplier_id, p_store_id,
     coalesce(nullif(btrim(coalesce(p_warehouse, '')), ''), '国内仓'),
     current_date, current_date + coalesce(v_lead, 30), 'draft',
     case when p_order_id is null then 'shortage' else 'order' end,
     p_order_id, auth.uid())
  returning id into v_po_id;

  for line in select * from jsonb_array_elements(p_lines) loop
    v_sku := nullif(btrim(coalesce(line->>'sku', '')), '');
    if v_sku is null then continue; end if;

    insert into public.purchase_items (user_id, po_id, product_id, sku, title, quantity, unit_price)
    values (auth.uid(), v_po_id, nullif(line->>'product_id', '')::uuid, v_sku,
            nullif(line->>'title', ''), greatest(1, round(coalesce((line->>'qty')::numeric, 1))::integer),
            coalesce((line->>'unit_cost')::numeric, 0));

    v_count := v_count + 1;
    v_amt   := v_amt + greatest(1, round(coalesce((line->>'qty')::numeric, 1)))::numeric
                     * coalesce((line->>'unit_cost')::numeric, 0);
  end loop;

  if v_count = 0 then
    delete from public.purchase_orders where id = v_po_id;
    raise exception '没有有效的采购明细';
  end if;

  return jsonb_build_object('ok', true, 'po_id', v_po_id, 'po_no', v_po_no,
                            'lines', v_count, 'amount', round(v_amt, 2));
end;
$$;

-- ---------- 单据全链路追踪：一张订单从卖出到补货结算的时间线 ----------
create or replace function public.order_trace(p_order_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_order  record;
  v_result jsonb;
begin
  perform public.assert_row_company('orders', p_order_id);
  if not public.has_permission('orders.view') then
    raise exception '没有订单查看权限';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception '订单不存在'; end if;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.ts), '[]'::jsonb) into v_result
  from (
    select o.created_at as ts, 'order'::text as kind, '订单创建'::text as title,
           concat(o.order_no, ' · ', o.quantity, ' 件 · 单价 ', o.unit_price,
                  ' ', coalesce((select currency from public.stores where id = o.store_id), 'USD')) as detail,
           null::text as ref_no, o.owner_id
      from public.orders o where o.id = p_order_id
    union all
    select m.created_at, 'out', '出库扣减',
           concat('仓库 ', m.warehouse, ' · ', abs(m.qty), ' 件 · 单位成本 ', m.unit_cost),
           m.ref_no, m.owner_id
      from public.stock_movements m
     where m.ref_type = 'order' and m.ref_id = p_order_id
    union all
    select p.created_at, 'purchase', '生成采购单',
           concat(p.po_no, ' · ', coalesce((select name from public.suppliers where id = p.supplier_id), '未指定供应商'),
                  ' · ', p.status),
           p.po_no, p.buyer_id
      from public.purchase_orders p
     where p.source_order_id = p_order_id
    union all
    select pay.created_at, 'payment', '采购付款',
           concat(pay.amount, ' ', pay.currency, ' · ', pay.method),
           (select po_no from public.purchase_orders where id = pay.po_id), pay.payer_id
      from public.purchase_payments pay
      join public.purchase_orders p on p.id = pay.po_id
     where p.source_order_id = p_order_id
    union all
    select m.created_at, 'in', '采购入库',
           concat('仓库 ', m.warehouse, ' · ', m.qty, ' 件 · 单位成本 ', m.unit_cost),
           m.ref_no, m.owner_id
      from public.stock_movements m
      join public.purchase_orders p on p.id = m.ref_id
     where m.ref_type = 'purchase' and p.source_order_id = p_order_id
    union all
    select tr.created_at, 'transfer', '仓库调拨',
           concat(tr.transfer_no, ' · ', tr.from_warehouse, ' → ', tr.to_warehouse,
                  ' · ', tr.qty, ' 件 · ', tr.status),
           tr.transfer_no, tr.owner_id
      from public.stock_transfers tr
     where tr.order_id = p_order_id
    union all
    select a.created_at, 'audit',
           case a.action when 'approve' then '财务审核通过'
                         when 'reject' then '财务驳回'
                         when 'revoke' then '撤回财务审核'
                         else '提交财务审核' end,
           coalesce(nullif(btrim(coalesce(a.note, '')), ''), '—'),
           (select po_no from public.purchase_orders where id = a.po_id), a.user_id
      from public.purchase_approvals a
      join public.purchase_orders p on p.id = a.po_id
     where p.source_order_id = p_order_id
    union all
    select t.created_at, 'task', '关联任务',
           concat(t.title, ' · ', t.status), t.ref_no, t.owner_id
      from public.tasks t
     where t.ref_type = 'order' and t.ref_id = p_order_id
  ) x;

  return jsonb_build_object('order', to_jsonb(v_order), 'timeline', v_result);
end;
$$;

-- ---------- 国内仓 → 海外仓调拨：创建时即锁库存，避免超卖 ----------
create or replace function public.create_stock_transfer(
  p_order_id       uuid,
  p_qty            integer,
  p_from_warehouse text default '国内仓',
  p_to_warehouse   text default 'FBA-US',
  p_note           text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  o       record;
  v_qty   integer;
  v_avail bigint;
  v_no    text;
  v_seq   integer;
  v_id    uuid;
begin
  perform public.assert_row_company('orders', p_order_id);
  if not (public.has_permission('orders.edit') or public.has_permission('inventory.edit')) then
    raise exception '没有订单或库存编辑权限';
  end if;
  if coalesce(nullif(btrim(coalesce(p_from_warehouse, '')), ''), '国内仓')
     = coalesce(nullif(btrim(coalesce(p_to_warehouse, '')), ''), 'FBA-US') then
    raise exception '调出仓与调入仓不能相同';
  end if;

  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception '订单不存在'; end if;
  if o.stock_state = 'out' then raise exception '订单已出库，无需调拨'; end if;
  if o.status in ('cancelled', 'refunded') then raise exception '取消或退款订单不能调拨'; end if;

  v_qty := greatest(1, coalesce(p_qty, 0));
  select coalesce(sum(available_qty), 0) into v_avail
    from public.inventory
   where store_id = o.store_id and sku = o.sku
     and warehouse = coalesce(nullif(btrim(coalesce(p_from_warehouse, '')), ''), '国内仓');
  if v_qty > v_avail then
    return jsonb_build_object('ok', false, 'reason', 'shortage',
                              'available', v_avail, 'need', v_qty);
  end if;

  v_no := 'TR' || to_char(current_date, 'YYYYMMDD') || '-';
  select coalesce(max(substring(transfer_no from '([0-9]+)$')::integer), 0) + 1
    into v_seq from public.stock_transfers where transfer_no like v_no || '%';
  v_no := v_no || lpad(v_seq::text, 3, '0');

  insert into public.stock_transfers
    (user_id, transfer_no, store_id, order_id, product_id, sku, title, qty,
     from_warehouse, to_warehouse, shipped_at, owner_id, note)
  values
    (auth.uid(), v_no, o.store_id, o.id, o.product_id, o.sku, o.title, v_qty,
     coalesce(nullif(btrim(coalesce(p_from_warehouse, '')), ''), '国内仓'),
     coalesce(nullif(btrim(coalesce(p_to_warehouse, '')), ''), 'FBA-US'),
     now(), coalesce(o.owner_id, auth.uid()), p_note)
  returning id into v_id;

  insert into public.stock_movements
    (user_id, store_id, product_id, sku, title, warehouse, move_type, qty, unit_cost,
     ref_type, ref_id, ref_no, owner_id, note)
  values
    (auth.uid(), o.store_id, o.product_id, o.sku, o.title,
     coalesce(nullif(btrim(coalesce(p_from_warehouse, '')), ''), '国内仓'),
     'transfer_out', -v_qty, public.sku_avg_cost(o.sku),
     'transfer', v_id, v_no, coalesce(o.owner_id, auth.uid()),
     coalesce(nullif(btrim(coalesce(p_note, '')), ''), '调拨出库'));

  perform public.bump_inventory(
    o.store_id, o.product_id, o.sku,
    coalesce(nullif(btrim(coalesce(p_from_warehouse, '')), ''), '国内仓'),
    -v_qty, o.title);

  return jsonb_build_object('ok', true, 'transfer_id', v_id, 'transfer_no', v_no, 'qty', v_qty);
end;
$$;

-- ---------- 调拨到货：写流水 + 加目标仓库存 + 更新单据状态 ----------
create or replace function public.receive_stock_transfer(
  p_transfer_id uuid,
  p_qty         integer default null,
  p_note        text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  t       record;
  v_qty   integer;
  v_left  integer;
  v_done  boolean;
begin
  perform public.assert_row_company('stock_transfers', p_transfer_id);
  if not public.has_permission('inventory.edit') then
    raise exception '没有库存编辑权限';
  end if;

  select * into t from public.stock_transfers where id = p_transfer_id for update;
  if not found then raise exception '调拨单不存在'; end if;
  if t.status = 'received' then
    return jsonb_build_object('ok', true, 'already', true, 'received', t.received_qty);
  end if;
  if t.status = 'cancelled' then raise exception '已取消的调拨单不能到货'; end if;

  v_left := greatest(0, t.qty - t.received_qty);
  v_qty  := least(v_left, greatest(1, coalesce(p_qty, v_left)));
  if v_qty <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'empty', 'message', '没有可到货的数量');
  end if;

  insert into public.stock_movements
    (user_id, store_id, product_id, sku, title, warehouse, move_type, qty, unit_cost,
     ref_type, ref_id, ref_no, owner_id, note)
  values
    (auth.uid(), t.store_id, t.product_id, t.sku, t.title, t.to_warehouse,
     'transfer_in', v_qty, public.sku_avg_cost(t.sku),
     'transfer', t.id, t.transfer_no, coalesce(t.owner_id, auth.uid()),
     coalesce(nullif(btrim(coalesce(p_note, '')), ''), '调拨到货'));

  perform public.bump_inventory(t.store_id, t.product_id, t.sku, t.to_warehouse, v_qty, t.title);

  update public.stock_transfers
     set received_qty = t.received_qty + v_qty,
         status       = case when t.received_qty + v_qty >= t.qty then 'received' else 'partial' end,
         received_at  = case when t.received_qty + v_qty >= t.qty then now() else t.received_at end,
         updated_at   = now()
   where id = t.id;

  select t.received_qty + v_qty >= t.qty into v_done;
  return jsonb_build_object('ok', true, 'received', v_qty,
                            'status', case when v_done then 'received' else 'partial' end);
end;
$$;

-- ---------- 订单履约全景：双仓库存 / 在途 / 采购审批付款状态 ----------
create or replace function public.order_flow(p_order_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  o           record;
  v_warehouse jsonb;
  v_transfer  jsonb;
  v_po        jsonb;
  v_stage     text;
  v_advice    text;
  v_need      integer;
begin
  perform public.assert_row_company('orders', p_order_id);
  if not public.has_permission('orders.view') then
    raise exception '没有订单查看权限';
  end if;
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception '订单不存在'; end if;
  v_need := greatest(1, o.quantity);

  select coalesce(jsonb_agg(jsonb_build_object(
           'warehouse', i.warehouse, 'available', i.available_qty, 'inbound', i.inbound_qty
         ) order by i.warehouse), '[]'::jsonb)
    into v_warehouse
    from public.inventory i
   where i.store_id = o.store_id and i.sku = o.sku;

  select coalesce(jsonb_agg(row_to_json(tr)::jsonb order by tr.created_at), '[]'::jsonb)
    into v_transfer
    from public.stock_transfers tr
   where tr.order_id = o.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'po_no', p.po_no, 'status', p.status,
           'approval_status', p.approval_status, 'payment_status', p.payment_status,
           'supplier', (select name from public.suppliers where id = p.supplier_id),
           'qty', (select coalesce(sum(quantity), 0) from public.purchase_items where po_id = p.id),
           'received_qty', (select coalesce(sum(received_qty), 0) from public.purchase_items where po_id = p.id),
           'expected_date', p.expected_date
         ) order by p.created_at), '[]'::jsonb)
    into v_po
    from public.purchase_orders p
   where p.source_order_id = o.id;

  if o.stock_state = 'out' then
    v_stage := 'fulfilled';
    v_advice := '已出库，利润与绩效数据已归集';
  elsif exists (select 1 from public.stock_transfers tr
                 where tr.order_id = o.id and tr.status in ('in_transit', 'partial')) then
    v_stage := 'in_transit';
    v_advice := '头程调拨在途，到货确认后即可出库';
  elsif exists (select 1 from public.purchase_orders p
                 where p.source_order_id = o.id and p.status not in ('received', 'cancelled')) then
    if exists (select 1 from public.purchase_orders p
                where p.source_order_id = o.id and p.approval_status = 'pending') then
      v_stage := 'pending_audit';
      v_advice := '采购单待财务审核，通过后才能付款';
    elsif exists (select 1 from public.purchase_orders p
                   where p.source_order_id = o.id and p.approval_status = 'rejected') then
      v_stage := 'rejected';
      v_advice := '采购单被财务驳回，请修改后重新提交';
    else
      v_stage := 'purchasing';
      v_advice := '采购已通过审核，等待付款与到货入库';
    end if;
  elsif exists (select 1 from public.inventory i
                 where i.store_id = o.store_id and i.sku = o.sku
                   and i.warehouse = coalesce(o.fulfillment_wh, 'FBA-US')
                   and i.available_qty >= v_need) then
    v_stage := 'ready';
    v_advice := '海外仓库存充足，可直接出库';
  else
    v_stage := 'shortage';
    v_advice := '海外仓缺货：先看国内仓能否调拨，不足再生成采购单';
  end if;

  return jsonb_build_object(
    'order_id', o.id, 'order_no', o.order_no, 'sku', o.sku, 'title', o.title,
    'quantity', v_need, 'stock_state', o.stock_state,
    'fulfillment_wh', coalesce(o.fulfillment_wh, 'FBA-US'),
    'stage', v_stage, 'advice', v_advice,
    'warehouses', v_warehouse, 'transfers', v_transfer, 'pos', v_po);
end;
$$;

-- ---------- 人员指标：从订单 / 任务 / 采购里算，不再靠手工填分 ----------
create or replace function public.member_metrics(p_profile_id uuid, p_period text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_start      date;
  v_end        date;
  v_prev_start date;
  v_prev_end   date;
  v_orders     integer := 0;
  v_gmv        numeric := 0;
  v_profit     numeric := 0;
  v_prev_profit numeric := 0;
  v_team_max   numeric := 0;
  v_tasks      integer := 0;
  v_done       integer := 0;
  v_ontime     integer := 0;
  v_pos        integer := 0;
  v_po_amt     numeric := 0;
  v_units      integer := 0;
  v_sales      numeric;
  v_exec       numeric;
  v_collab     numeric;
  v_growth     numeric;
  v_score      numeric;
  v_grade      text;
begin
  perform public.assert_row_company('profiles', p_profile_id);
  if not (public.has_permission('performance.view') or p_profile_id = auth.uid()) then
    raise exception '没有绩效查看权限';
  end if;

  if p_period ~ '^[0-9]{4}-Q[1-4]$' then
    v_start := make_date(split_part(p_period, '-', 1)::integer,
                         (right(p_period, 1)::integer - 1) * 3 + 1, 1);
    v_end   := (v_start + interval '3 month' - interval '1 day')::date;
  else
    v_start := to_date(p_period || '-01', 'YYYY-MM-DD');
    v_end   := (v_start + interval '1 month' - interval '1 day')::date;
  end if;
  v_prev_end   := v_start - 1;
  v_prev_start := (v_start - (v_end - v_start + 1))::date;

  -- 销售：按订单责任人归集
  select count(*), coalesce(sum(gross_amount), 0), coalesce(sum(profit), 0), coalesce(sum(quantity), 0)
    into v_orders, v_gmv, v_profit, v_units
    from public.orders
   where owner_id = p_profile_id
     and order_date between v_start and v_end
     and status <> 'cancelled';

  select coalesce(sum(profit), 0) into v_prev_profit
    from public.orders
   where owner_id = p_profile_id
     and order_date between v_prev_start and v_prev_end
     and status <> 'cancelled';

  select coalesce(max(t), 0) into v_team_max
    from (
      select sum(profit) as t from public.orders
       where owner_id is not null
         and order_date between v_start and v_end
         and status <> 'cancelled'
       group by owner_id
    ) s;

  -- 任务：完成率与按时率
  select count(*),
         count(*) filter (where status = 'done'),
         count(*) filter (where status = 'done'
                            and (due_date is null or completed_at::date <= due_date))
    into v_tasks, v_done, v_ontime
    from public.tasks
   where owner_id = p_profile_id
     and created_at::date between v_start and v_end;

  -- 采购：单量与金额
  select count(*), coalesce(sum(public.po_total(id)), 0)
    into v_pos, v_po_amt
    from public.purchase_orders
   where buyer_id = p_profile_id
     and order_date between v_start and v_end;

  -- 四个分项：销售看团队相对位置，执行看任务完成，协作看按时率，成长看环比
  if v_team_max > 0 then
    v_sales := least(100, greatest(0, round(v_profit / v_team_max * 100)));
  else
    v_sales := case when v_profit > 0 then 70 else 50 end;
  end if;
  v_exec   := case when v_tasks = 0 then 70 else round(v_done * 100.0 / v_tasks) end;
  v_collab := case when v_done  = 0 then 70 else round(v_ontime * 100.0 / v_done) end;
  if v_prev_profit > 0 then
    v_growth := least(100, greatest(0, round(60 + (v_profit - v_prev_profit) / v_prev_profit * 40)));
  elsif v_profit > 0 then
    v_growth := 80;
  else
    v_growth := 50;
  end if;

  v_score := round(v_sales * 0.45 + v_exec * 0.30 + v_collab * 0.15 + v_growth * 0.10, 1);
  v_grade := case when v_score >= 90 then 'S'
                  when v_score >= 80 then 'A'
                  when v_score >= 70 then 'B'
                  when v_score >= 60 then 'C'
                  else 'D' end;

  return jsonb_build_object(
    'period', p_period, 'start', v_start, 'end', v_end,
    'orders', v_orders, 'units', v_units,
    'gmv', round(v_gmv, 2), 'profit', round(v_profit, 2), 'prev_profit', round(v_prev_profit, 2),
    'task_total', v_tasks, 'task_done', v_done, 'task_ontime', v_ontime,
    'po_count', v_pos, 'po_amount', round(v_po_amt, 2),
    'kpi', jsonb_build_object('sales', v_sales, 'execution', v_exec,
                              'collaboration', v_collab, 'growth', v_growth),
    'score', v_score, 'grade', v_grade);
end;
$$;

-- ---------- 按真实数据一键算绩效分 ----------
create or replace function public.apply_performance_score(
  p_profile_id uuid,
  p_period     text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  m       jsonb;
  v_dept  uuid;
begin
  perform public.assert_row_company('profiles', p_profile_id);
  if not public.has_permission('performance.edit') then
    raise exception '没有绩效评定权限';
  end if;

  m := public.member_metrics(p_profile_id, p_period);

  select department_id into v_dept from public.profiles where id = p_profile_id;

  insert into public.performance_reviews
    (profile_id, period, department_id, reviewer_id, score, grade, kpi, metrics,
     auto_score, auto_grade, summary)
  values
    (p_profile_id, p_period, v_dept, auth.uid(),
     (m->>'score')::numeric, m->>'grade', m->'kpi', m,
     (m->>'score')::numeric, m->>'grade', '系统按订单 / 任务 / 采购数据自动生成')
  on conflict (profile_id, period) do update
    set score      = excluded.score,
        grade      = excluded.grade,
        kpi        = excluded.kpi,
        metrics    = excluded.metrics,
        auto_score = excluded.auto_score,
        auto_grade = excluded.auto_grade,
        reviewer_id = auth.uid(),
        updated_at = now();

  return m;
end;
$$;

-- 存量订单补责任人：老数据没有 owner_id，按创建账号回填，否则绩效全是 0
update public.orders o
   set owner_id = o.user_id
 where o.owner_id is null
   and exists (select 1 from public.profiles p where p.id = o.user_id);

update public.purchase_orders p
   set buyer_id = p.user_id
 where p.buyer_id is null
   and exists (select 1 from public.profiles f where f.id = p.user_id);

-- 授权（Supabase 新表默认可能不带权限，这里显式声明）
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.profiles, public.stores, public.products, public.orders,
  public.inventory, public.campaigns, public.creators, public.tasks, public.expenses,
  public.competitors, public.competitor_snapshots,
  public.suppliers, public.supplier_products, public.supplier_contacts,
  public.purchase_orders, public.purchase_items, public.purchase_approvals,
  public.dev_projects, public.dev_milestones, public.dev_costs,
  public.brand_social_accounts, public.brand_influencers,
  public.brand_pr_contacts, public.brand_metrics,
  public.finance_expenses, public.finance_expense_items,
  public.finance_budgets, public.finance_expense_approvals,
  public.departments, public.positions, public.roles,
  public.access_requests, public.employee_events, public.performance_reviews,
  public.stock_movements, public.stock_transfers, public.purchase_payments
  to authenticated;

-- 流程类函数：离职交接 / 权限审批必须可被登录用户调用（函数内部自行校验 is_staff）
grant execute on function public.offboard_member(uuid, uuid, text) to authenticated;
grant execute on function public.transfer_member_resources(uuid, uuid) to authenticated;
grant execute on function public.decide_access_request(uuid, boolean, text) to authenticated;
grant execute on function public.has_permission(text) to authenticated;
grant execute on function public.dept_scope(uuid) to authenticated;
grant execute on function public.team_directory() to authenticated;
grant execute on function public.recommend_employee_no() to authenticated;

-- 多租户：公司表本身不开放直读（无 RLS），一切通过下面的函数并按超管 / 管理员身份校验
grant execute on function public.current_company_id() to authenticated;
grant execute on function public.in_company(uuid) to authenticated;
grant execute on function public.assert_row_company(text, uuid) to authenticated;
grant execute on function public.list_companies() to authenticated;
grant execute on function public.create_company(text, text, text) to authenticated;
grant execute on function public.update_company(uuid, text, text, text, text) to authenticated;
grant execute on function public.switch_company(uuid) to authenticated;
grant execute on function public.assign_member_company(uuid, uuid) to authenticated;

-- 业务链路函数：函数内部各自校验权限，不能靠 grant 兜底
grant execute on function public.sku_avg_cost(text)                          to authenticated;
grant execute on function public.bump_inventory(uuid, uuid, text, text, integer, text) to authenticated;
grant execute on function public.fulfill_order(uuid, text, boolean)          to authenticated;
grant execute on function public.restore_order_stock(uuid)                   to authenticated;
grant execute on function public.po_total(uuid)                              to authenticated;
grant execute on function public.submit_purchase(uuid, text)                         to authenticated;
grant execute on function public.approve_purchase(uuid, text, text)                  to authenticated;
grant execute on function public.register_payment(uuid, numeric, date, text, text, text) to authenticated;
grant execute on function public.receive_purchase(uuid, jsonb, text, text)   to authenticated;
grant execute on function public.shortage_plan(uuid)                         to authenticated;
grant execute on function public.create_po_from_shortage(jsonb, uuid, uuid, uuid, text) to authenticated;
grant execute on function public.order_trace(uuid)                           to authenticated;
grant execute on function public.order_flow(uuid)                            to authenticated;
grant execute on function public.create_stock_transfer(uuid, integer, text, text, text) to authenticated;
grant execute on function public.receive_stock_transfer(uuid, integer, text) to authenticated;
grant execute on function public.member_metrics(uuid, text)                  to authenticated;
grant execute on function public.apply_performance_score(uuid, text)         to authenticated;
grant execute on function public.submit_expense(uuid, text)                  to authenticated;
grant execute on function public.approve_expense(uuid, text, text)           to authenticated;
grant execute on function public.pay_expense(uuid, date, text, text, text)   to authenticated;

-- -------------------------------------------------------------
-- 默认组织数据（按部门编码判重，只补缺的，不会覆盖你已有的配置）
-- scope 决定该部门内所有成员可见的模块与人事职能：
--   信息中心   → 全部业务模块可读写（系统级账号管理仍由管理员角色决定）
--   人力资源部 → 花名册、入离职办理、绩效查看与评定
-- -------------------------------------------------------------
insert into public.departments (name, code, description, sort_order, scope)
select v.name, v.code, v.description, v.sort_order, v.scope
from (values
  ('信息中心',   'IT',      '系统与账号、全模块数据支持',        0,
   array['stores.view','stores.edit','products.view','products.edit',
         'orders.view','orders.edit','inventory.view','inventory.edit',
         'purchase.view','purchase.edit','profit.view','profit.edit',
         'ads.view','ads.edit','creators.view','creators.edit',
         'competitors.view','competitors.edit','tasks.view','tasks.edit',
         'performance.view','performance.edit','hr.view',
         'brand.view','brand.edit','dev.view','dev.edit']::text[]),
  ('人力资源部', 'HR',      '招聘入离职、花名册与绩效管理',      1,
   array['hr.view','hr.manage',
         'performance.view','performance.edit','tasks.view','tasks.edit']::text[]),
  ('运营部',     'OPS',     '店铺日常运营、Listing 与库存周转',  2,
   array['stores.view','stores.edit','products.view','products.edit',
         'orders.view','orders.edit','inventory.view','inventory.edit',
         'purchase.view','purchase.edit','tasks.view','tasks.edit',
         'performance.view']::text[]),
  ('广告投放部', 'ADS',     '站内广告与站外投放',                3,
   array['ads.view','ads.edit','competitors.view','competitors.edit',
         'products.view','tasks.view','performance.view']::text[]),
  ('内容营销部', 'CONTENT', '达人合作、短视频与直播',            4,
   array['creators.view','creators.edit','products.view',
         'tasks.view','tasks.edit','performance.view',
         'brand.view','brand.edit']::text[]),
  ('财务部',     'FIN',     '利润核算、费用与税务',              5,
   array['profit.view','profit.edit','orders.view','purchase.view',
         'products.view','stores.view','performance.view']::text[])
) as v(name, code, description, sort_order, scope)
where not exists (
  select 1 from public.departments d
   where lower(coalesce(d.code, '')) = lower(v.code) or d.name = v.name
);

-- 老库：部门没有编码 / 范围时补上默认值，已有配置一律不动
update public.departments d
   set code = v.code
  from (values ('信息中心','IT'), ('人力资源部','HR'), ('运营部','OPS'),
               ('广告投放部','ADS'), ('内容营销部','CONTENT'), ('财务部','FIN')
       ) as v(name, code)
 where d.name = v.name and d.code is null;

update public.departments d
   set scope = v.scope
  from (values
    ('信息中心',   array['stores.view','stores.edit','products.view','products.edit',
                          'orders.view','orders.edit','inventory.view','inventory.edit',
                          'purchase.view','purchase.edit','profit.view','profit.edit',
                          'ads.view','ads.edit','creators.view','creators.edit',
                          'competitors.view','competitors.edit','tasks.view','tasks.edit',
                          'performance.view','performance.edit','hr.view',
         'brand.view','brand.edit']::text[]),
    ('人力资源部', array['hr.view','hr.manage',
                          'performance.view','performance.edit','tasks.view','tasks.edit']::text[]),
    ('运营部',     array['stores.view','stores.edit','products.view','products.edit',
                          'orders.view','orders.edit','inventory.view','inventory.edit',
                          'purchase.view','purchase.edit','tasks.view','tasks.edit',
                          'performance.view']::text[]),
    ('广告投放部', array['ads.view','ads.edit','competitors.view','competitors.edit',
                          'products.view','tasks.view','performance.view']::text[]),
    ('内容营销部', array['creators.view','creators.edit','products.view',
                          'tasks.view','tasks.edit','performance.view',
         'brand.view','brand.edit']::text[]),
    ('财务部',     array['profit.view','profit.edit','orders.view','purchase.view',
                          'products.view','stores.view','performance.view']::text[])
  ) as v(name, scope)
 where d.name = v.name and coalesce(array_length(d.scope, 1), 0) = 0;

insert into public.positions (name, level, description, sort_order)
select v.name, v.level, v.description, v.sort_order
from (values
  ('运营专员',   'P3', '负责店铺日常运营与 Listing 优化', 1),
  ('高级运营',   'P5', '负责多店铺运营策略与团队协作',   2),
  ('广告投手',   'P4', '负责广告投放与 ACOS 优化',       3),
  ('达人BD',     'P4', '负责达人建联、寄样与内容跟进',   4),
  ('财务专员',   'P4', '负责利润核算与费用台账',         5),
  ('产品开发专员', 'P4', '负责自有品牌新品立项与打样跟进', 6)
) as v(name, level, description, sort_order)
where not exists (select 1 from public.positions);

-- 内置角色：覆盖跨境电商团队最常见的四种分工，可改权限、不可删除
insert into public.roles (name, description, permissions, is_system, sort_order)
select v.name, v.description, v.permissions, true, v.sort_order
from (values
  ('运营专员', '店铺、商品、订单、库存与任务的全流程操作',
   array['stores.view','stores.edit','products.view','products.edit',
         'orders.view','orders.edit','inventory.view','inventory.edit',
         'tasks.view','tasks.edit']::text[], 1),
  ('广告投手', '广告活动与商品数据，不接触订单与财务',
   array['ads.view','ads.edit','products.view','tasks.view']::text[], 2),
  ('内容达人', '达人建联、站外品牌营销与内容合作',
   array['creators.view','creators.edit','products.view','tasks.view','tasks.edit',
         'brand.view','brand.edit']::text[], 3),
  ('财务核算', '订单与利润只读，可维护费用台账，不能改动业务单据',
   array['profit.view','profit.edit','orders.view','stores.view','products.view']::text[], 4),
  ('只读观察员', '全部业务模块只读，适合老板或外部顾问',
   array['stores.view','products.view','orders.view','inventory.view',
         'ads.view','creators.view','profit.view','tasks.view','brand.view']::text[], 5)
) as v(name, description, permissions, sort_order)
where not exists (select 1 from public.roles);

-- 人力资源专员：给「需要办入离职、录绩效」的成员用；
-- 不配这个角色也行——把成员放进人力资源部，部门范围同样会给到这些权限
insert into public.roles (name, description, permissions, is_system, sort_order)
select '人力资源专员', '办理入职离职、维护花名册、录入绩效',
       array['hr.view','hr.manage','performance.view','performance.edit',
             'tasks.view','tasks.edit']::text[], true, 6
 where not exists (select 1 from public.roles where name = '人力资源专员');

-- 财务审核员：只审采购单与付款条件，不直接改采购业务单据
insert into public.roles (name, description, permissions, is_system, sort_order)
select '财务审核员', '审核采购单金额与付款条件，通过后才能登记付款',
       array['finance.audit','purchase.view','profit.view','orders.view','products.view']::text[], true, 7
 where not exists (select 1 from public.roles where name = '财务审核员');

-- 产品开发专员：自有品牌新品从立项到上市的跟进
insert into public.roles (name, description, permissions, is_system, sort_order)
select '产品开发专员', '自有品牌新品立项、打样、测试与上市跟进',
       array['dev.view','dev.edit','products.view','tasks.view','tasks.edit','purchase.view','brand.view']::text[], true, 8
 where not exists (select 1 from public.roles where name = '产品开发专员');

-- 新增模块的权限补齐：内置角色只在表为空时插入，
-- 老库重跑脚本时不会重新生成，这里按「缺什么补什么」的方式补上，
-- 已经存在的权限码不会重复，也不会覆盖管理员手工调整过的其他权限。
do $do$
declare
  rec record;
begin
  for rec in
    select * from (values
      ('运营专员',   'competitors.view'), ('运营专员', 'competitors.edit'),
      ('运营专员',   'purchase.view'),    ('运营专员', 'purchase.edit'),
      ('广告投手',   'competitors.view'), ('广告投手', 'competitors.edit'),
      ('内容达人',   'competitors.view'),
      ('财务核算',   'purchase.view'),
      ('只读观察员', 'competitors.view'), ('只读观察员', 'purchase.view'),
      ('运营专员',   'performance.view'), ('财务核算', 'performance.view'),
      ('只读观察员', 'performance.view'),
      ('内容达人',   'brand.view'), ('内容达人',   'brand.edit'),
      ('只读观察员', 'brand.view'),
      ('财务核算',   'finance.audit'),
      ('财务审核员', 'finance.audit'), ('财务审核员', 'purchase.view'),
      ('运营专员',   'dev.view'), ('运营专员', 'dev.edit'),
      ('产品开发专员', 'dev.view'), ('产品开发专员', 'dev.edit'),
      ('只读观察员', 'dev.view'),
      -- 费用管理：经办人可记账提交，财务有审核权（finance.audit 已授予财务角色）
      ('财务核算',   'expense.view'), ('财务核算',   'expense.edit'),
      ('财务审核员', 'expense.view'), ('财务审核员', 'expense.edit'),
      ('运营专员',   'expense.view'), ('运营专员', 'expense.edit'),
      ('产品开发专员', 'expense.view'), ('产品开发专员', 'expense.edit'),
      ('内容达人',   'expense.view'), ('内容达人',   'expense.edit'),
      ('广告投手',   'expense.view'), ('广告投手',   'expense.edit'),
      ('只读观察员', 'expense.view')
    ) as v(role_name, code)
  loop
    update public.roles
       set permissions = array_append(permissions, rec.code)
     where name = rec.role_name
       and is_system
       and not (rec.code = any(permissions));
  end loop;

  -- 老库部门范围补齐：品牌营销、产品开发、财务审核按「缺什么补什么」追加
  for rec in
    select * from (values
      ('信息中心',   'brand.view'), ('信息中心',   'brand.edit'),
      ('内容营销部', 'brand.view'), ('内容营销部', 'brand.edit'),
      ('信息中心',   'dev.view'), ('信息中心',   'dev.edit'),
      ('运营部',     'dev.view'), ('运营部',     'dev.edit'),
      ('财务部',     'finance.audit'),
      -- 费用管理：财务全权，其他部门可记账（审批仍受 finance.audit 约束）
      ('信息中心',   'expense.view'), ('信息中心',   'expense.edit'),
      ('财务部',     'expense.view'), ('财务部',     'expense.edit'),
      ('运营部',     'expense.view'), ('运营部',     'expense.edit'),
      ('广告投放部', 'expense.view'), ('广告投放部', 'expense.edit'),
      ('内容营销部', 'expense.view'), ('内容营销部', 'expense.edit'),
      ('人力资源部', 'expense.view'), ('人力资源部', 'expense.edit')
    ) as v(dept_name, code)
  loop
    update public.departments
       set scope = array_append(scope, rec.code)
     where name = rec.dept_name
       and not (rec.code = any(scope));
  end loop;
end;
$do$;

-- 历史数据里若还没有超级管理员，把最早注册的账号提升上来，避免没人能管账号
select public.ensure_super_admin();

-- =============================================================
--  完成。接下来回到应用：登录 → 系统会自动检测并进入工作台。
--  第一个注册的账号自动成为「超级管理员」，其余新注册账号为「普通人员」，
--  由超级管理员在「账号管理」页调整角色，在「组织架构」页维护部门 / 岗位 / 自定义角色。
-- =============================================================
