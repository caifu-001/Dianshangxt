-- ============================================================
--  超管「权限流程」权限诊断脚本（只读，不改任何数据）
--  用法：Supabase 控制台 → SQL Editor → 全选粘贴 → Run
--  目的：一次性看清超管账号状态、权限函数结果、权限申请 RLS 策略，
--        用真实数据定位「超管没权限」的根因。把运行结果截图发回即可。
-- ============================================================

-- ① 超管账号真实状态（重点看 role / status / active_company_id）
select
  id,
  email,
  role,
  status,
  company_id,
  active_company_id,
  (role = 'super_admin')       as is_super_role,
  (status = 'active')          as is_active
from public.profiles
where lower(coalesce(email, '')) = 'yinsuccess168@163.com';

-- ② 当前执行的权限函数结果（以 SQL Editor 身份运行，auth.uid() 为空 → 预期都是 false）
--    这一步主要确认函数存在、没被改坏。
select
  public.is_super_admin()                  as anon_is_super,
  public.has_permission('account.manage')  as anon_can_manage;

-- ③ access_requests 表上当前生效的 RLS 策略（看 using / with_check 是否含 is_super_admin 例外）
-- 兼容写法：直接读 pg_policy 系统表，避免 pg_policies 视图列名在 PG15+ 改成 qual 导致报错
select
  p.polname                                    as policyname,
  trim(p.polcmd::text)                         as command,
  pg_get_expr(p.polqual, c.oid)                as using_expression,
  pg_get_expr(p.polwithcheck, c.oid)           as with_check
from pg_policy p
join pg_class c      on c.oid = p.polrelid
join pg_namespace n  on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'access_requests'
order by p.polname;

-- ④ access_requests 是否有 company_id 列（缺列会导致策略引用 company_id 时失效）
select
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'access_requests'
  and column_name  = 'company_id';

-- ⑤ 全部权限申请（含各公司），按状态统计——用 service_role 的 SQL Editor 能绕过 RLS 看到全量
select
  status,
  count(*) as cnt
from public.access_requests
group by status
order by status;
