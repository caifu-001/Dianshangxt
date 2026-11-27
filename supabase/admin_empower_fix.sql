-- ============================================================
--  公司管理员权限补全（增量热修复脚本 / 幂等可重复执行）
--  目标：让「公司管理员（admin）」在本公司内拥有最高权限，
--        不再被硬编码的 is_super_admin() 卡住权限流程。
--
--  生效范围（本次放开）：
--   1. 权限申请审批可授予本公司成员「管理员」角色
--   2. 公司管理员可办理本公司任意角色成员的离职（含其他管理员）
--   3. 公司管理员可移除本公司成员档案（不能删自己 / 平台超管账号）
--   4. 公司管理员可查看 / 清理本公司演示数据
--   5. 修复权限申请列表跨公司泄露（RLS 补租户过滤），同时保留平台超管跨公司看/批的能力
--   6. 人员变动记录：超管可见所有公司（原先被 in_company 收敛到默认公司，导致看不到全量）
--
--  仍保留超管专属（平台级，不下放）：
--   创建/维护公司、审核公司入驻、跨公司调人、切换管理视角、
--   系统日志查看与清理、数据源初始化、导出脚本、平台超管账号。
--
--  执行方式：Supabase 控制台 → SQL Editor → 粘贴全选 → Run。
-- ============================================================

-- ---------- 0. 前置：确保 access_requests 有 company_id 列 ----------
-- 关键！老版本库若缺此列，第 6 步 create policy 引用 company_id 会直接报错，
-- 导致超管例外策略创建失败 → 表现为「执行了脚本，超管还是没权限」。
alter table public.access_requests add column if not exists company_id uuid;
update public.access_requests
   set company_id = '00000000-0000-0000-0000-000000000001'::uuid
 where company_id is null;

-- ---------- 1. 演示数据统计：公司管理员可看本公司 ----------
create or replace function public.demo_data_stats()
returns table (module text, table_name text, row_count bigint)
language plpgsql security definer set search_path = public
as $$
declare
  v_company uuid := public.current_company_id();
  v_stores  uuid[] := public.demo_store_ids();
begin
  if not (public.is_super_admin() or public.has_permission('system.manage')) then
    raise exception '只有管理员可以查看演示数据统计';
  end if;

  return query select * from (values
    ('店铺',       'stores',              (select count(*)::bigint from public.stores              where company_id = v_company and id = any(v_stores))),
    ('商品',       'products',            (select count(*)::bigint from public.products            where company_id = v_company and (sku like 'AH-%' or sku like 'LB-%' or sku like 'GL-%'))),
    ('订单',       'orders',              (select count(*)::bigint from public.orders              where company_id = v_company and store_id = any(v_stores))),
    ('库存',       'inventory',           (select count(*)::bigint from public.inventory           where company_id = v_company and store_id = any(v_stores))),
    ('广告',       'campaigns',           (select count(*)::bigint from public.campaigns           where company_id = v_company and store_id = any(v_stores))),
    ('达人',       'creators',            (select count(*)::bigint from public.creators            where company_id = v_company and store_id = any(v_stores))),
    ('任务',       'tasks',               (select count(*)::bigint from public.tasks               where company_id = v_company and store_id = any(v_stores))),
    ('费用',       'expenses',            (select count(*)::bigint from public.expenses            where company_id = v_company and store_id = any(v_stores))),
    ('竞品',       'competitors',         (select count(*)::bigint from public.competitors         where company_id = v_company and store_id = any(v_stores))),
    ('竞品快照',   'competitor_snapshots',(select count(*)::bigint from public.competitor_snapshots where company_id = v_company and competitor_id in (select id from public.competitors where company_id = v_company and store_id = any(v_stores)))),
    ('供应商',     'suppliers',           (select count(*)::bigint from public.suppliers           where company_id = v_company and name in ('东莞恒美家居制品厂','义乌市雅陶瓷业有限公司','广州妆源生物科技','杭州丝语丝绸'))),
    ('产品开发',   'dev_projects',        (select count(*)::bigint from public.dev_projects        where company_id = v_company and name in ('竹木折叠收纳盒（欧美站）','便携陶瓷咖啡杯套装','真丝发圈礼盒'))),
    ('财务费用',   'finance_expenses',    (select count(*)::bigint from public.finance_expenses    where company_id = v_company and title in ('11 月美国站广告充值','深圳-广州供应商验厂差旅','竹木收纳盒 FDA 检测费','10 月员工社保与公积金','海外红人内容合作尾款','英国站 VAT 季度申报服务费','ERP 软件年度订阅（草稿）'))),
    ('品牌社媒',   'brand_social_accounts',(select count(*)::bigint from public.brand_social_accounts where company_id = v_company and account_name in ('HomyLife Official','homylife_home','homylife.us','HomyLife Board'))),
    ('站外红人',   'brand_influencers',   (select count(*)::bigint from public.brand_influencers   where company_id = v_company and handle in ('@emilyhome','@sofialives','@mikeunboxes','@tianyuanxm'))),
    ('公关联系人', 'brand_pr_contacts',   (select count(*)::bigint from public.brand_pr_contacts   where company_id = v_company and media_name in ('Home Living Weekly','The Pretty House Blog','Reddit r/HomeDecor'))),
    ('品牌指标',   'brand_metrics',       (select count(*)::bigint from public.brand_metrics       where company_id = v_company and note = '自动演示数据'))
  ) as t(module, table_name, row_count)
  where row_count > 0;
end;
$$;

-- ---------- 2. 演示数据清理：公司管理员可清理本公司 ----------
create or replace function public.purge_demo_data(p_confirm text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_company uuid := public.current_company_id();
  v_stores  uuid[] := public.demo_store_ids();
  v_result  jsonb := '{}'::jsonb;
  v_n       bigint;
begin
  if not (public.is_super_admin() or public.has_permission('system.manage')) then
    raise exception '只有管理员可以清理演示数据';
  end if;
  if p_confirm is distinct from 'PURGE DEMO' then
    raise exception '清理演示数据需要显式确认';
  end if;

  -- 子表先、父表后，避免外键冲突；每一步都叠加 company_id 隔离。
  delete from public.competitor_snapshots where company_id = v_company
    and competitor_id in (select id from public.competitors where company_id = v_company and store_id = any(v_stores));
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('competitor_snapshots', v_n);

  delete from public.competitors where company_id = v_company and store_id = any(v_stores);
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('competitors', v_n);

  delete from public.orders where company_id = v_company and store_id = any(v_stores);
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('orders', v_n);

  delete from public.inventory where company_id = v_company and store_id = any(v_stores);
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('inventory', v_n);

  delete from public.campaigns where company_id = v_company and store_id = any(v_stores);
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('campaigns', v_n);

  delete from public.creators where company_id = v_company and store_id = any(v_stores);
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('creators', v_n);

  delete from public.tasks where company_id = v_company and store_id = any(v_stores);
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('tasks', v_n);

  delete from public.expenses where company_id = v_company and store_id = any(v_stores);
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('expenses', v_n);

  -- 采购：先流水与明细，再主单与供应商档案
  delete from public.purchase_items where company_id = v_company
    and po_id in (select id from public.purchase_orders where company_id = v_company
                  and (store_id = any(v_stores) or supplier_id in (select id from public.suppliers where company_id = v_company and name in ('东莞恒美家居制品厂','义乌市雅陶瓷业有限公司','广州妆源生物科技','杭州丝语丝绸'))));
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('purchase_items', v_n);

  delete from public.purchase_approvals where company_id = v_company
    and po_id in (select id from public.purchase_orders where company_id = v_company
                  and (store_id = any(v_stores) or supplier_id in (select id from public.suppliers where company_id = v_company and name in ('东莞恒美家居制品厂','义乌市雅陶瓷业有限公司','广州妆源生物科技','杭州丝语丝绸'))));
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('purchase_approvals', v_n);

  delete from public.purchase_payments where company_id = v_company
    and po_id in (select id from public.purchase_orders where company_id = v_company
                  and (store_id = any(v_stores) or supplier_id in (select id from public.suppliers where company_id = v_company and name in ('东莞恒美家居制品厂','义乌市雅陶瓷业有限公司','广州妆源生物科技','杭州丝语丝绸'))));
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('purchase_payments', v_n);

  delete from public.purchase_orders where company_id = v_company
    and (store_id = any(v_stores) or supplier_id in (select id from public.suppliers where company_id = v_company and name in ('东莞恒美家居制品厂','义乌市雅陶瓷业有限公司','广州妆源生物科技','杭州丝语丝绸')));
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('purchase_orders', v_n);

  delete from public.supplier_contacts where company_id = v_company
    and supplier_id in (select id from public.suppliers where company_id = v_company and name in ('东莞恒美家居制品厂','义乌市雅陶瓷业有限公司','广州妆源生物科技','杭州丝语丝绸'));
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('supplier_contacts', v_n);

  delete from public.supplier_products where company_id = v_company
    and supplier_id in (select id from public.suppliers where company_id = v_company and name in ('东莞恒美家居制品厂','义乌市雅陶瓷业有限公司','广州妆源生物科技','杭州丝语丝绸'));
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('supplier_products', v_n);

  delete from public.suppliers where company_id = v_company and name in ('东莞恒美家居制品厂','义乌市雅陶瓷业有限公司','广州妆源生物科技','杭州丝语丝绸');
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('suppliers', v_n);

  -- 履约：调拨单与库存流水（seed 的备注以「演示」开头，真实单据不会这样写）
  delete from public.stock_movements where company_id = v_company and note like '演示%';
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('stock_movements', v_n);

  delete from public.stock_transfers where company_id = v_company and note like '演示%';
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('stock_transfers', v_n);

  -- 产品开发：按 seed 固定的三个项目名识别（真实项目也用 DEV- 编号，不能用前缀判断）
  delete from public.dev_milestones where company_id = v_company
    and project_id in (select id from public.dev_projects where company_id = v_company and name in ('竹木折叠收纳盒（欧美站）','便携陶瓷咖啡杯套装','真丝发圈礼盒'));
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('dev_milestones', v_n);

  delete from public.dev_costs where company_id = v_company
    and project_id in (select id from public.dev_projects where company_id = v_company and name in ('竹木折叠收纳盒（欧美站）','便携陶瓷咖啡杯套装','真丝发圈礼盒'));
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('dev_costs', v_n);

  delete from public.dev_projects where company_id = v_company and name in ('竹木折叠收纳盒（欧美站）','便携陶瓷咖啡杯套装','真丝发圈礼盒');
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('dev_projects', v_n);

  -- 财务费用：按 seed 固定的七个标题识别（真实费用单也用 FY 编号，不能用前缀判断）
  delete from public.finance_expense_items where company_id = v_company
    and expense_id in (select id from public.finance_expenses where company_id = v_company and title in ('11 月美国站广告充值','深圳-广州供应商验厂差旅','竹木收纳盒 FDA 检测费','10 月员工社保与公积金','海外红人内容合作尾款','英国站 VAT 季度申报服务费','ERP 软件年度订阅（草稿）'));
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('finance_expense_items', v_n);

  delete from public.finance_expense_approvals where company_id = v_company
    and expense_id in (select id from public.finance_expenses where company_id = v_company and title in ('11 月美国站广告充值','深圳-广州供应商验厂差旅','竹木收纳盒 FDA 检测费','10 月员工社保与公积金','海外红人内容合作尾款','英国站 VAT 季度申报服务费','ERP 软件年度订阅（草稿）'));
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('finance_expense_approvals', v_n);

  delete from public.finance_expenses where company_id = v_company and title in ('11 月美国站广告充值','深圳-广州供应商验厂差旅','竹木收纳盒 FDA 检测费','10 月员工社保与公积金','海外红人内容合作尾款','英国站 VAT 季度申报服务费','ERP 软件年度订阅（草稿）');
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('finance_expenses', v_n);

  delete from public.finance_budgets where company_id = v_company and note in ('新品检测与打样预算','广告与红人投放预算','工资社保公积金预算','差旅预算','办公行政预算');
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('finance_budgets', v_n);

  -- 站外品牌营销
  delete from public.brand_social_accounts where company_id = v_company and account_name in ('HomyLife Official','homylife_home','homylife.us','HomyLife Board');
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('brand_social_accounts', v_n);

  delete from public.brand_influencers where company_id = v_company and handle in ('@emilyhome','@sofialives','@mikeunboxes','@tianyuanxm');
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('brand_influencers', v_n);

  delete from public.brand_pr_contacts where company_id = v_company and media_name in ('Home Living Weekly','The Pretty House Blog','Reddit r/HomeDecor');
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('brand_pr_contacts', v_n);

  delete from public.brand_metrics where company_id = v_company and note = '自动演示数据';
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('brand_metrics', v_n);

  -- 最后删父表：商品与店铺（子表已通过外键级联或上面的显式删除处理）
  delete from public.products where company_id = v_company and (sku like 'AH-%' or sku like 'LB-%' or sku like 'GL-%');
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('products', v_n);

  delete from public.stores where company_id = v_company and id = any(v_stores);
  get diagnostics v_n = row_count; v_result := v_result || jsonb_build_object('stores', v_n);

  -- 留痕：清理本身记入系统日志
  perform public.record_system_event(
    'system', 'demo_data_purged',
    '清理演示数据，共删除 ' || (select coalesce(sum(value::bigint), 0) from jsonb_each_text(v_result)) || ' 条',
    v_result, 'demo_data', null, 'warning');

  return v_result;
end;
$$;

-- ---------- 3. 离职交接：公司管理员可办理本公司管理员离职 ----------
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
  -- 本公司范围内，管理员可办理本公司任意角色的离职（含其他管理员）。
  -- assert_row_company 已确保目标属于调用者公司，不存在跨租户操作；
  -- 超管账号本身不可离职，上面已单独拦截。
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

-- ---------- 4. 权限审批：公司管理员可授予本公司成员管理员角色 ----------
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
  -- 平台超管可跨公司审批（全局最高权限，不受当前管理视角约束）；
  -- 公司管理员没有超管角色，仍受 assert_row_company 限制，只能批本公司的申请。
  if not public.is_super_admin() then
    perform public.assert_row_company('access_requests', p_id);
  end if;
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
      -- 本公司最高角色为普通管理员，公司管理员可在本公司内授予/回收 admin。
      -- assert_row_company 已确保申请属于本公司；超管账号上面已单独拦截。
      if r.target_role not in ('admin', 'member') then
        raise exception '只能授予管理员或普通人员';
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

-- ---------- 5. 档案移除：公司管理员可移除本公司档案（不可删自己 / 超管账号） ----------
drop policy if exists "profiles_delete_super" on public.profiles;
drop policy if exists "profiles_delete_staff" on public.profiles;
create policy "profiles_delete_staff" on public.profiles
  for delete to authenticated
  using (
    public.in_company(company_id)
    and id <> auth.uid()
    and lower(coalesce(email, '')) <> 'yinsuccess168@163.com'
    and (public.is_super_admin() or public.has_permission('account.manage'))
  );

-- ---------- 6. 权限申请列表/审批：补租户过滤，但保留超管跨公司能力 ----------
-- 公司管理员：只能看/批本公司的申请（杜绝跨公司泄露）
-- 平台超管：全局最高权限，不受「当前管理视角」约束，可看/批所有公司的申请
drop policy if exists "access_req_select" on public.access_requests;
create policy "access_req_select" on public.access_requests
  for select to authenticated
  using (
    user_id = auth.uid()
    or (
      public.has_permission('account.manage')
      and (public.is_super_admin() or public.in_company(company_id))
    )
  );

drop policy if exists "access_req_update_staff" on public.access_requests;
create policy "access_req_update_staff" on public.access_requests
  for update to authenticated
  using (
    public.has_permission('account.manage')
    and (public.is_super_admin() or public.in_company(company_id))
  )
  with check (
    public.has_permission('account.manage')
    and (public.is_super_admin() or public.in_company(company_id))
  );

-- ---------- 7. 人员变动记录：超管可见所有公司，公司管理员仍限本公司 ----------
-- 背景：emp_events_select 原先只有 in_company 过滤，而 in_company 会把超管收敛到
-- 「当前管理视角」（默认公司），导致超管在权限流程页只看到默认公司的变动记录，
-- 表现为「超管看不到所有」。这里给超管开全局例外，普通管理员/HR 仍严格限本公司。
drop policy if exists "emp_events_select" on public.employee_events;
create policy "emp_events_select" on public.employee_events
  for select to authenticated
  using (
    profile_id = auth.uid()
    or public.is_super_admin()
    or (
      public.in_company(company_id)
      and (public.has_permission('hr.view') or public.has_permission('account.manage'))
    )
  );

-- ---------- 自检：执行完立刻看策略是否落地（应看到 2 条，using 里含 is_super_admin） ----------
-- 兼容写法：直接读 pg_policy 系统表，避免 pg_policies 视图列名在 PG15+ 改成 qual 导致报错
select
  p.polname                       as policyname,
  trim(p.polcmd::text)            as command,
  pg_get_expr(p.polqual, c.oid)   as using_expression
from pg_policy p
join pg_class c      on c.oid = p.polrelid
join pg_namespace n  on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'access_requests'
  and p.polname in ('access_req_select', 'access_req_update_staff')
order by p.polname;

-- 若上面返回 2 行、且 using_expression 里能看到 is_super_admin，说明修复已真正生效。
-- 本脚本可安全重复执行（幂等）。

