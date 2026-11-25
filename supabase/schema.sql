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
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists idx_departments_parent on public.departments(parent_id);

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

-- 权限判定：模块级权限码（stores.view / orders.edit / data.delete ...）
-- 三层收敛，缺一不可：
--   1) 账号必须 active
--   2) 系统角色给出「上限」：member 永远拿不到管理类权限
--   3) 自定义角色（roles.permissions）给出「范围」：没配角色时按角色默认值放行
-- 管理类权限（管人 / 管组织 / 管系统配置）不受自定义角色收窄，
-- 否则管理员很容易把自己锁在门外。
create or replace function public.has_permission(code text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((
    select case
      when coalesce(p.status, 'active') <> 'active' then false
      when p.role = 'super_admin' then true
      -- 管理类：只有系统角色管理员及以上可以，自定义角色无法授予或剥夺
      when code in ('account.manage', 'org.manage', 'system.manage') then p.role = 'admin'
      -- 未分配自定义角色：按系统角色默认值
      when p.role_id is null then
        case when p.role = 'admin' then true
             else code like '%.view' or code like '%.edit'
        end
      -- 已分配自定义角色：必须在角色权限内，且不能突破系统角色上限
      else
        coalesce(code = any(coalesce(r.permissions, '{}')), false)
        and (p.role = 'admin' or code like '%.view' or code like '%.edit')
    end
    from public.profiles p
    left join public.roles r on r.id = p.role_id
    where p.id = auth.uid()
  ), false);
$$;

do $do$
declare
  t text;
  tabs text[] := array[
    'profiles','stores','products','orders','inventory',
    'campaigns','creators','tasks','expenses',
    'competitors','competitor_snapshots','suppliers','purchase_orders','purchase_items',
    'departments','positions','roles'
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

-- 本人可见自己；管人或管组织的人可见全部（账号管理页 / 组织架构页需要）
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or public.has_permission('account.manage')
    or public.has_permission('org.manage')
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

  if new.role is distinct from old.role or new.status is distinct from old.status then
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
      raise exception '无权修改角色或账号状态';
    end if;
  end if;

  -- 组织归属（部门 / 岗位 / 自定义角色）同样只能由管理员调整：
  -- 否则普通成员可以给自己挂一个全权限角色，绕过整条权限链
  if new.role_id       is distinct from old.role_id
     or new.department_id is distinct from old.department_id
     or new.position_id   is distinct from old.position_id then
    if not public.is_staff() then
      raise exception '无权修改部门、岗位或自定义角色，请联系管理员';
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
  public.departments, public.positions, public.roles
  to authenticated;

-- -------------------------------------------------------------
-- 默认组织数据（仅当表为空时写入，不会覆盖你已有的配置）
-- -------------------------------------------------------------
insert into public.departments (name, description, sort_order)
select v.name, v.description, v.sort_order
from (values
  ('运营部',     '店铺日常运营、Listing 与库存周转', 1),
  ('广告投放部', '站内广告与站外投放',             2),
  ('内容营销部', '达人合作、短视频与直播',         3),
  ('财务部',     '利润核算、费用与税务',           4)
) as v(name, description, sort_order)
where not exists (select 1 from public.departments);

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
      ('只读观察员', 'competitors.view'), ('只读观察员', 'purchase.view')
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
