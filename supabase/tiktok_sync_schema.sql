-- ============================================================
-- TikTok Shop 数据自动同步 — 数据库增量脚本
--
-- 依赖：先执行 schema.sql，再执行 platform_sync_schema.sql。
-- 本脚本只做 TikTok 所需的增量调整，不重建三张通用表。
--
-- 用法：Supabase 控制台 → SQL Editor → New query → 粘贴全文 → Run。
--       重跑安全：全部 if exists / 幂等写法。
-- ============================================================

-- ---------- 1. 放开 region 约束（原约束只允许 na/eu/fe，Amazon 专用） ----------
alter table public.platform_connections
  drop constraint if exists platform_connections_region_check;
alter table public.platform_connections
  add constraint platform_connections_region_check
  check (region in (
    'na','eu','fe',                                  -- Amazon 区域
    'us','uk','my','sg','ph','th','vn','id','es','ie','fr','de','it','jp',
    'br','mx','au','ca','global'                     -- TikTok 及其它站点
  ));

-- ---------- 2. sync_runs 作业类型补充（TikTok 可能有退货作业） ----------
alter table public.sync_runs
  drop constraint if exists sync_runs_job_type_check;
alter table public.sync_runs
  add constraint sync_runs_job_type_check
  check (job_type in ('orders','products','inventory','financial','returns','all'));

-- ---------- 3. 兼容旧数据：Amazon 连接的 region 仍是 na/eu/fe，无需迁移 ----------
-- TikTok 连接用 region 存站点代码（如 us / my / sg），marketplace_ids 可留空。

notify pgrst, 'reload schema';

-- ---------- 验证 ----------
select
  conname,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.platform_connections'::regclass
  and conname = 'platform_connections_region_check';
