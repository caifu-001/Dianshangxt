-- ============================================================
--  权限流程可见性验证脚本（只读，不改任何数据/策略）
--  目的：用数据库真实 RLS 验证「超管看全部 / 公司管理员看本公司」是否成立。
--
--  原理：SQL Editor 以 postgres 身份执行时绕过 RLS，看不到真实效果。
--  本脚本临时切换到 authenticated 角色 + 指定 JWT 用户身份，让 RLS 真正生效，
--  分别统计超管、某公司管理员能看到的申请/变动记录/成员数量。
--
--  执行方式：Supabase → SQL Editor → 全选 → Run。
--  看不懂没关系，把三段结果截图发我即可。
-- ============================================================

-- ---------- ① 找到真实用户（超管 + 一个公司管理员） ----------
select id, email, role, status, company_id, active_company_id
from public.profiles
where role = 'super_admin'
   or (role = 'admin' and status = 'active')
order by role, email;
-- 记下超管的 id（下面 ② 的 <超管ID>）和一个管理员的 id（③ 的 <管理员ID>）。

-- ---------- ② 模拟超管身份，看能查到多少 ----------
-- 把 <超管ID> 换成 ① 里 role=super_admin 那行的 id（含引号）
/*
set local role authenticated;
set local request.jwt.claim.sub = '<超管ID>';
set local request.jwt.claim.role = 'authenticated';
select
  '超管视角' as who,
  (select count(*) from public.access_requests)   as 权限申请,
  (select count(*) from public.employee_events)   as 变动记录,
  (select count(*) from public.profiles)          as 成员档案;
reset role;
*/

-- ---------- ③ 模拟公司管理员身份，看能查到多少 ----------
-- 把 <管理员ID> 换成 ① 里 role=admin 那行的 id（含引号）
/*
set local role authenticated;
set local request.jwt.claim.sub = '<管理员ID>';
set local request.jwt.claim.role = 'authenticated';
select
  '公司管理员视角' as who,
  (select count(*) from public.access_requests)   as 权限申请,
  (select count(*) from public.employee_events)   as 变动记录,
  (select count(*) from public.profiles)          as 成员档案;
reset role;
*/

-- ---------- ④ 全表真实总量（postgres 绕过 RLS，作为对照基准） ----------
select
  '全表真实总量' as who,
  (select count(*) from public.access_requests) as 权限申请,
  (select count(*) from public.employee_events) as 变动记录,
  (select count(*) from public.profiles)        as 成员档案;

-- ============================================================
--  期望结果：
--   ② 超管视角的「变动记录 / 成员档案」应等于 ④ 全表总量（超管看全部）。
--   ③ 管理员视角应 ≤ ④，且只含其所属公司的记录（管理员看本公司）。
--   若 ② 明显小于 ④，说明超管仍被收敛，策略未生效（需重跑 admin_empower_fix.sql）。
--   若三者「权限申请」都是 0，说明表里根本没有申请记录，页面空属正常，
--      需用成员账号提交一条申请后再看（见下方说明）。
-- ============================================================
