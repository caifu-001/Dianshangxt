-- ============================================================
-- 费用单号全局唯一生成（修复多租户下 409 Conflict）
--
-- 问题：finance_expenses.code 是全局 unique（schema.sql:1100），
--       但前端 genCode() 只能看到当前公司的单据（RLS 隔离），
--       每家公司都从 FY202611-0001 开始算 -> 后创建者撞号 409。
-- 方案：用 SECURITY DEFINER 函数跨公司读全表 max，配合事务级
--       advisory lock 保证并发安全，返回下一个全局唯一单号。
-- 幂等：可重复执行。
-- ============================================================

create or replace function public.next_expense_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text := 'FY' || to_char(now(), 'YYYYMM') || '-';
  v_seq integer;
begin
  -- 事务级锁：同一时刻只允许一个事务生成单号，杜绝并发生成同号
  perform pg_advisory_xact_lock(2026110001);

  select coalesce(max(substring(code from length(v_prefix) + 1)::integer), 0) + 1
    into v_seq
    from public.finance_expenses
   where code like v_prefix || '%'
     and substring(code from length(v_prefix) + 1) ~ '^[0-9]+$';

  return v_prefix || lpad(v_seq::text, 4, '0');
end $$;

revoke all on function public.next_expense_code() from public;
grant execute on function public.next_expense_code() to authenticated;

notify pgrst, 'reload schema';

-- 验证：执行后应返回一个形如 FY202611-0001 的单号
-- select public.next_expense_code();
