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

-- 新用户注册后自动建档：库里第一个注册者自动成为超级管理员
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
  select count(*) into existing_count from public.profiles;
  assigned_role := case when existing_count = 0 then 'super_admin' else 'member' end;

  insert into public.profiles (id, email, full_name, role, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    assigned_role,
    'active'
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
  if not exists (select 1 from public.profiles where role = 'super_admin') then
    update public.profiles set role = 'super_admin'
    where id = (select id from public.profiles order by created_at asc limit 1);
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

-- =============================================================
--  行级安全（RLS）与角色权限
--  权限模型：团队共享同一份业务数据，按角色控制「可删 / 可管人」
--    super_admin  超级管理员：全部权限，可管理任何账号
--    admin        普通管理员：可删除业务数据，可管理普通人员
--    member       普通人员  ：可读写业务数据，不可删除、不可管人
--  security definer 函数以表所有者身份执行，绕过 RLS，避免策略递归
-- =============================================================
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
   order by p.created_at;
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
        and (code like '%.view' or code like '%.edit' or code like 'hr.%' or code like 'performance.%')
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
    'performance_reviews'
  ];
begin
  foreach t in array tabs loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$do$;

-- ---------- profiles ----------
drop policy if exists "profiles_select_own"   on public.profiles;
drop policy if exists "profiles_update_own"   on public.profiles;
drop policy if exists "profiles_insert_own"   on public.profiles;
drop policy if exists "profiles_select"       on public.profiles;
drop policy if exists "profiles_update_self"  on public.profiles;
drop policy if exists "profiles_update_staff" on public.profiles;
drop policy if exists "profiles_delete_super" on public.profiles;

-- 本人可见自己；管人 / 管组织 / 人事岗（HR）可见全部
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or public.has_permission('account.manage')
    or public.has_permission('org.manage')
    or public.has_permission('hr.view')
  );

-- 本人可改自己的资料（角色 / 状态 / 组织归属由触发器拦截，不能自提权）
create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- 管理员可改他人档案
create policy "profiles_update_staff" on public.profiles
  for update to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- 人事岗（HR 部门）也能维护他人档案，但触发器 guard_profile_changes 会
-- 拦住角色 / 岗位角色字段，HR 只能动人事与组织归属，无法借此提权
drop policy if exists "profiles_update_hr" on public.profiles;
create policy "profiles_update_hr" on public.profiles
  for update to authenticated
  using (public.has_permission('hr.manage'))
  with check (public.has_permission('hr.manage'));

-- 仅超级管理员可移除档案，且不能移除自己
create policy "profiles_delete_super" on public.profiles
  for delete to authenticated
  using (public.is_super_admin() and id <> auth.uid());

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
      ('purchase_orders', 'purchase')
    ) as v(tbl, perm)
  loop
    -- 清理历史策略（旧版为 xxx_owner_all，按 user_id 隔离）
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_owner_all', rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_select',    rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_insert',    rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_update',    rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_delete',    rec.tbl);

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_permission(%L))',
      rec.tbl || '_select', rec.tbl, rec.perm || '.view'
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.has_permission(%L))',
      rec.tbl || '_insert', rec.tbl, rec.perm || '.edit'
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.has_permission(%L)) with check (public.has_permission(%L))',
      rec.tbl || '_update', rec.tbl, rec.perm || '.edit', rec.perm || '.edit'
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.has_permission(%L))',
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
      ('purchase_items',       'purchase')
    ) as v(tbl, perm)
  loop
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_select', rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_insert', rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_update', rec.tbl);
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_delete', rec.tbl);

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_permission(%L))',
      rec.tbl || '_select', rec.tbl, rec.perm || '.view'
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.has_permission(%L))',
      rec.tbl || '_insert', rec.tbl, rec.perm || '.edit'
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.has_permission(%L)) with check (public.has_permission(%L))',
      rec.tbl || '_update', rec.tbl, rec.perm || '.edit', rec.perm || '.edit'
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.has_permission(%L))',
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
    'competitors','competitor_snapshots','suppliers','purchase_orders','purchase_items'
  ];
begin
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

-- 授权（Supabase 新表默认可能不带权限，这里显式声明）
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.profiles, public.stores, public.products, public.orders,
  public.inventory, public.campaigns, public.creators, public.tasks, public.expenses,
  public.competitors, public.competitor_snapshots,
  public.suppliers, public.purchase_orders, public.purchase_items,
  public.departments, public.positions, public.roles,
  public.access_requests, public.employee_events, public.performance_reviews
  to authenticated;

-- 流程类函数：离职交接 / 权限审批必须可被登录用户调用（函数内部自行校验 is_staff）
grant execute on function public.offboard_member(uuid, uuid, text) to authenticated;
grant execute on function public.transfer_member_resources(uuid, uuid) to authenticated;
grant execute on function public.decide_access_request(uuid, boolean, text) to authenticated;
grant execute on function public.has_permission(text) to authenticated;
grant execute on function public.dept_scope(uuid) to authenticated;
grant execute on function public.team_directory() to authenticated;

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
         'performance.view','performance.edit','hr.view']::text[]),
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
         'tasks.view','tasks.edit','performance.view']::text[]),
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
                          'performance.view','performance.edit','hr.view']::text[]),
    ('人力资源部', array['hr.view','hr.manage',
                          'performance.view','performance.edit','tasks.view','tasks.edit']::text[]),
    ('运营部',     array['stores.view','stores.edit','products.view','products.edit',
                          'orders.view','orders.edit','inventory.view','inventory.edit',
                          'purchase.view','purchase.edit','tasks.view','tasks.edit',
                          'performance.view']::text[]),
    ('广告投放部', array['ads.view','ads.edit','competitors.view','competitors.edit',
                          'products.view','tasks.view','performance.view']::text[]),
    ('内容营销部', array['creators.view','creators.edit','products.view',
                          'tasks.view','tasks.edit','performance.view']::text[]),
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
  ('财务专员',   'P4', '负责利润核算与费用台账',         5)
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
  ('内容达人', '达人建联与内容合作，可查看到商品与任务',
   array['creators.view','creators.edit','products.view','tasks.view','tasks.edit']::text[], 3),
  ('财务核算', '订单与利润只读，可维护费用台账，不能改动业务单据',
   array['profit.view','profit.edit','orders.view','stores.view','products.view']::text[], 4),
  ('只读观察员', '全部业务模块只读，适合老板或外部顾问',
   array['stores.view','products.view','orders.view','inventory.view',
         'ads.view','creators.view','profit.view','tasks.view']::text[], 5)
) as v(name, description, permissions, sort_order)
where not exists (select 1 from public.roles);

-- 人力资源专员：给「需要办入离职、录绩效」的成员用；
-- 不配这个角色也行——把成员放进人力资源部，部门范围同样会给到这些权限
insert into public.roles (name, description, permissions, is_system, sort_order)
select '人力资源专员', '办理入职离职、维护花名册、录入绩效',
       array['hr.view','hr.manage','performance.view','performance.edit',
             'tasks.view','tasks.edit']::text[], true, 6
 where not exists (select 1 from public.roles where name = '人力资源专员');

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
      ('只读观察员', 'performance.view')
    ) as v(role_name, code)
  loop
    update public.roles
       set permissions = array_append(permissions, rec.code)
     where name = rec.role_name
       and is_system
       and not (rec.code = any(permissions));
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
