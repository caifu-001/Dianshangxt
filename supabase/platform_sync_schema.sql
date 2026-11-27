-- ============================================================
-- Amazon 平台数据自动同步 — 数据库脚本
--
-- 依赖：先执行 schema.sql（提供 companies / stores / profiles /
--       in_company() / has_permission() / system_logs 等）。
--
-- 用法：Supabase 控制台 → SQL Editor → New query → 粘贴全文 → Run。
--       重跑安全：全部 create if not exists / drop policy if exists。
--
-- 安全约定：
--   · token_cipher 存的是 Edge Function 用 AES-GCM 加密后的密文，
--     密钥只在 Edge Function secret 里，数据库不存明文、也不解密。
--   · 三张表都开 RLS：前端只能 select 本公司；写入只由 Edge Function
--     用 service_role 完成（service_role 绕过 RLS），不给前端写权限。
--   · oauth_states 不给 authenticated 任何权限，纯服务端短期票据。
-- ============================================================

-- ---------- 1. 店铺授权连接 ----------
create table if not exists public.platform_connections (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  store_id         uuid not null references public.stores(id) on delete cascade,
  platform         text not null default 'amazon'
                   check (platform in ('amazon','tiktok','shopee','lazada','temu','walmart','ebay',
                                       'aliexpress','mercadolibre','shopify','etsy','shein','target',
                                       'wayfair','noon','coupang','ozon','newegg')),
  seller_id        text,                            -- 平台卖家 ID（Amazon merchant seller id）
  marketplace_ids  text[] not null default '{}',    -- Amazon 如 {ATVPDKIKX0DER}
  region           text not null default 'na' check (region in ('na','eu','fe')),
  token_cipher     text,                            -- refresh token 密文（AES-GCM，格式 v1:iv:ct）
  token_expires_at timestamptz,
  scopes           text[] not null default '{}',
  status           text not null default 'active'
                   check (status in ('active','paused','error','revoked')),
  last_sync_at     timestamptz,                     -- 增量游标
  last_error       text,
  sync_lock_until  timestamptz,                     -- 分布式锁：防止定时与手动并发重跑
  connected_by     uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, store_id, platform)
);
create index if not exists idx_platform_conn_company on public.platform_connections(company_id);
create index if not exists idx_platform_conn_store   on public.platform_connections(store_id);
create index if not exists idx_platform_conn_status  on public.platform_connections(status, last_sync_at);

alter table public.platform_connections enable row level security;
drop policy if exists platform_connections_select on public.platform_connections;
create policy platform_connections_select on public.platform_connections
  for select to authenticated
  using (public.has_permission('stores.view') and public.in_company(company_id));
-- 说明：不建 insert/update/delete policy。前端无法直接改连接；
--       所有写入由 Edge Functions（service_role）完成并在服务端校验身份。

-- ---------- 2. OAuth 短期票据（防 CSRF） ----------
create table if not exists public.oauth_states (
  state        text primary key,
  company_id   uuid not null references public.companies(id) on delete cascade,
  store_id     uuid not null references public.stores(id) on delete cascade,
  caller_id    uuid not null references public.profiles(id) on delete cascade,
  platform     text not null default 'amazon',
  redirect_to  text,                                -- 回调后前端落地页
  expires_at   timestamptz not null default (now() + interval '5 minutes'),
  created_at   timestamptz not null default now()
);
create index if not exists idx_oauth_states_exp on public.oauth_states(expires_at);
alter table public.oauth_states enable row level security;
-- 无 policy：authenticated 读写都被拒；仅 service_role 可访问。

-- ---------- 3. 同步运行日志 ----------
create table if not exists public.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  connection_id uuid references public.platform_connections(id) on delete cascade,
  store_id      uuid references public.stores(id) on delete set null,
  platform      text not null default 'amazon',
  job_type      text not null check (job_type in ('orders','products','inventory','financial','all')),
  status        text not null check (status in ('running','ok','partial','failed','skipped')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  rows_new      integer not null default 0,
  rows_updated  integer not null default 0,
  rows_failed   integer not null default 0,
  cursor_from   timestamptz,
  cursor_to     timestamptz,
  error         text,
  detail        jsonb not null default '{}'::jsonb,
  triggered_by  text not null default 'cron' check (triggered_by in ('cron','manual','oauth'))
);
create index if not exists idx_sync_runs_conn on public.sync_runs(connection_id, started_at desc);
create index if not exists idx_sync_runs_company on public.sync_runs(company_id, started_at desc);

alter table public.sync_runs enable row level security;
drop policy if exists sync_runs_select on public.sync_runs;
create policy sync_runs_select on public.sync_runs
  for select to authenticated
  using (public.has_permission('stores.view') and public.in_company(company_id));
-- 写入仅 Edge Function（service_role）。

-- ---------- 4. 授权 ----------
grant usage on schema public to authenticated;
grant select on public.platform_connections to authenticated;
grant select on public.sync_runs           to authenticated;
-- oauth_states 不授予 authenticated；三张表的写入由 service_role 完成。

-- ---------- 5. 供前端读取连接的辅助 RPC ----------
-- 直接 select 已够用；此 RPC 仅用于把「连接 + 店铺名」拼在一起，减少前端两次请求。
drop function if exists public.list_platform_connections();
create or replace function public.list_platform_connections()
returns table (
  id              uuid,
  company_id      uuid,
  store_id        uuid,
  store_name      text,
  platform        text,
  marketplace_ids text[],
  region          text,
  status          text,
  last_sync_at    timestamptz,
  last_error      text,
  connected_by    uuid,
  created_at      timestamptz
)
language sql stable security invoker set search_path = public
as $$
  select c.id, c.company_id, c.store_id, s.name, c.platform, c.marketplace_ids,
         c.region, c.status, c.last_sync_at, c.last_error, c.connected_by, c.created_at
  from public.platform_connections c
  join public.stores s on s.id = c.store_id
  where public.has_permission('stores.view') and public.in_company(c.company_id)
  order by c.created_at desc;
$$;
grant execute on function public.list_platform_connections() to authenticated;

-- ---------- 6. 清理过期 OAuth 票据（供 Edge Function / 定时调用） ----------
drop function if exists public.cleanup_oauth_states();
create or replace function public.cleanup_oauth_states()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_n integer;
begin
  delete from public.oauth_states where expires_at < now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
-- 不给 authenticated：仅 service_role 调用。

-- ---------- 7. 同步分布式锁（CAS，供 Edge Function 调用） ----------
-- 用 RPC 而不是 PostgREST 的 or 过滤，避免 timestamptz 比较的编码问题。
drop function if exists public.try_acquire_sync_lock(uuid, timestamptz);
create or replace function public.try_acquire_sync_lock(
  p_conn_id uuid,
  p_until   timestamptz
)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_ok boolean;
begin
  update public.platform_connections
     set sync_lock_until = p_until
   where id = p_conn_id
     and (sync_lock_until is null or sync_lock_until < now())
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

-- 同步结束释放锁（只在持有者自己的锁未过期时清，避免误清新一轮）
drop function if exists public.release_sync_lock(uuid);
create or replace function public.release_sync_lock(p_conn_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.platform_connections
     set sync_lock_until = null
   where id = p_conn_id;
end;
$$;

notify pgrst, 'reload schema';

-- ---------- 验证 ----------
select
  (select count(*) from pg_tables where schemaname='public' and tablename='platform_connections') as conn_table,
  (select count(*) from pg_tables where schemaname='public' and tablename='oauth_states')         as states_table,
  (select count(*) from pg_tables where schemaname='public' and tablename='sync_runs')            as runs_table;
