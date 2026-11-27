-- ============================================================
-- 热修复：费用管理「审批中心」点通过/驳回报 400
-- 根因：数据库里的 approve_expense 函数仍是旧版，
--       把 'approved'/'rejected'（费用单状态）写进了
--       finance_expense_approvals.action（流水动作枚举，
--       只允许 submit/approve/reject/revoke/pay），触发 check 约束 → 400。
--
-- 用法：Supabase 控制台 → SQL Editor → New query →
--       粘贴本文件全部内容 → Run。执行完刷新前端即可。
--
-- 说明：先 DROP 再 CREATE，避免 42P13（create or replace 不能改签名/返回类型）。
--       只重建费用提交/审核/付款三个函数，不影响其它数据。
-- ============================================================

drop function if exists public.submit_expense(uuid, text);
drop function if exists public.approve_expense(uuid, text, text);
drop function if exists public.pay_expense(uuid, date, text, text, text);

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
  -- action 是流水动作枚举（approve/reject），不是费用单状态枚举（approved/rejected）
  insert into public.finance_expense_approvals (user_id, expense_id, action, note)
  values (auth.uid(), ex.id, case when p_decision = 'approved' then 'approve' else 'reject' end, p_note);
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

grant execute on function public.submit_expense(uuid, text)           to authenticated;
grant execute on function public.approve_expense(uuid, text, text)    to authenticated;
grant execute on function public.pay_expense(uuid, date, text, text, text) to authenticated;

notify pgrst, 'reload schema';

-- 验证：下面这条应返回 3 行，且 approve_expense 的 _check 列为 OK（旧版会显示「仍是旧版」）
select proname,
       case
         when proname <> 'approve_expense' then '-'
         when pg_get_functiondef(oid) like '%else ''reject'' end%'
           then 'OK: 已写入 approve/reject'
         else '仍是旧版！'
       end as _check
from pg_proc
where proname in ('submit_expense','approve_expense','pay_expense')
order by proname;
