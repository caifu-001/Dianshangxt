-- =============================================================
--  跨境电商运营中台 · 数据库初始化脚本
--  适用：Supabase (PostgreSQL 15+)
--  使用方法：Supabase 控制台 → SQL Editor → 粘贴全部内容 → Run
--  脚本可重复执行（幂等）
-- =============================================================

create extension if not exists pgcrypto;

-- -------------------------------------------------------------
-- 1. 用户档案
-- -------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  company     text,
  role        text not null default 'owner',
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- 新用户注册后自动建档
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

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

-- =============================================================
--  行级安全（RLS）：每个账号只能看到自己的数据
-- =============================================================
do $do$
declare
  t text;
  tabs text[] := array[
    'profiles','stores','products','orders','inventory',
    'campaigns','creators','tasks','expenses'
  ];
begin
  foreach t in array tabs loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$do$;

-- profiles
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (id = auth.uid());
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (id = auth.uid());

-- 其余业务表统一策略：user_id = auth.uid()
do $do$
declare
  t text;
  tabs text[] := array['stores','products','orders','inventory','campaigns','creators','tasks','expenses'];
begin
  foreach t in array tabs loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_owner_all', t
    );
  end loop;
end;
$do$;

-- 授权（Supabase 新表默认可能不带权限，这里显式声明）
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.profiles, public.stores, public.products, public.orders,
  public.inventory, public.campaigns, public.creators, public.tasks, public.expenses
  to authenticated;

-- =============================================================
--  完成。接下来回到应用：登录 → 系统会自动检测并进入工作台。
-- =============================================================
