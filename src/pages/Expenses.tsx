import { useMemo, useState } from 'react'
import {
  BarChart3,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Coins,
  FileText,
  Pencil,
  Plus,
  Receipt,
  Trash2,
  TrendingUp,
  Wallet,
  XCircle,
} from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import dayjs from 'dayjs'
import { deleteRow, deleteWhere, fetchRows, insertRows, updateRow } from '../lib/db'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../context/AuthContext'
import { cn, downloadTextFile, fmtDate, money, num, pct, toCsv, today } from '../lib/utils'
import {
  EXPENSE_APPROVAL_ACTION_META,
  EXPENSE_CATEGORY_META,
  EXPENSE_STATUS_META,
  EXPENSE_SUB_ITEMS,
  PAY_METHODS,
  approveExpense,
  payExpense,
  submitExpense,
} from '../lib/flow'
import type {
  Department,
  DevProject,
  ExpenseCategory,
  ExpenseStatus,
  FinanceBudget,
  FinanceExpense,
  FinanceExpenseApproval,
  FinanceExpenseItem,
  Store,
} from '../lib/types'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBlock,
  Field,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Segmented,
  Select,
  useToast,
} from '../components/ui'

type View = 'records' | 'budgets' | 'audit' | 'stats'
const PAGE_SIZE = 8

const CATEGORIES: ExpenseCategory[] = ['rd', 'marketing', 'payroll', 'travel', 'office', 'other']
const STATUS_ORDER: ExpenseStatus[] = ['draft', 'pending', 'approved', 'rejected', 'paid']

interface DirectoryRow {
  id: string
  full_name: string | null
  email: string | null
  department_id: string | null
}

interface ItemDraft {
  key: string
  category: ExpenseCategory
  item: string
  qty: string
  unit_price: string
  employee_id: string
  note: string
}

interface ExpenseForm {
  id?: string
  code: string
  title: string
  category: ExpenseCategory
  subcategory: string
  owner_id: string
  department_id: string
  store_id: string
  project_id: string
  currency: string
  expense_date: string
  note: string
  items: ItemDraft[]
}

const newItem = (category: ExpenseCategory = 'other'): ItemDraft => ({
  key: Math.random().toString(36).slice(2),
  category,
  item: '',
  qty: '1',
  unit_price: '0',
  employee_id: '',
  note: '',
})

const emptyForm = (): ExpenseForm => ({
  code: '',
  title: '',
  category: 'other',
  subcategory: '',
  owner_id: '',
  department_id: '',
  store_id: '',
  project_id: '',
  currency: 'CNY',
  expense_date: today(),
  note: '',
  items: [newItem()],
})

interface BudgetForm {
  id?: string
  category: ExpenseCategory
  department_id: string
  period: string
  amount: string
  currency: string
  note: string
}

const emptyBudget = (): BudgetForm => ({
  category: 'rd',
  department_id: '',
  period: dayjs().format('YYYY-MM'),
  amount: '0',
  currency: 'CNY',
  note: '',
})

export default function Expenses() {
  const { push } = useToast()
  const { user, can } = useAuth()
  const canEdit = can('expense.edit')
  const canAudit = can('finance.audit')

  const [view, setView] = useState<View>('records')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [monthFilter, setMonthFilter] = useState('')
  const [page, setPage] = useState(1)
  const [form, setForm] = useState<ExpenseForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<FinanceExpense | null>(null)
  const [deleteBudget, setDeleteBudget] = useState<FinanceBudget | null>(null)
  const [budgetForm, setBudgetForm] = useState<BudgetForm | null>(null)
  const [payTarget, setPayTarget] = useState<FinanceExpense | null>(null)
  const [payDraft, setPayDraft] = useState({ paid_at: today(), method: 'bank', voucher: '', note: '' })

  const load = async () => {
    const [expenses, items, budgets, approvals, directory, departments, stores, projects] = await Promise.all([
      fetchRows<FinanceExpense>('finance_expenses', { order: { column: 'expense_date', ascending: false } }),
      fetchRows<FinanceExpenseItem>('finance_expense_items', { order: { column: 'created_at', ascending: true } }),
      fetchRows<FinanceBudget>('finance_budgets', { order: { column: 'period', ascending: false } }),
      fetchRows<FinanceExpenseApproval>('finance_expense_approvals', { order: { column: 'created_at', ascending: false } }),
      fetchRows<DirectoryRow>('team_directory'),
      fetchRows<Department>('departments'),
      fetchRows<Store>('stores'),
      fetchRows<DevProject>('dev_projects').catch(() => [] as DevProject[]),
    ])
    return { expenses, items, budgets, approvals, directory, departments, stores, projects }
  }

  const { data, loading, error, reload } = useAsync(load, [])

  const memberMap = useMemo(() => new Map((data?.directory ?? []).map((m) => [m.id, m])), [data])
  const deptMap = useMemo(() => new Map((data?.departments ?? []).map((d) => [d.id, d])), [data])
  const storeMap = useMemo(() => new Map((data?.stores ?? []).map((s) => [s.id, s])), [data])
  const projectMap = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.id, p])), [data])
  const itemsByExpense = useMemo(() => {
    const map = new Map<string, FinanceExpenseItem[]>()
    for (const it of data?.items ?? []) {
      const arr = map.get(it.expense_id) ?? []
      arr.push(it)
      map.set(it.expense_id, arr)
    }
    return map
  }, [data])
  const approvalsByExpense = useMemo(() => {
    const map = new Map<string, FinanceExpenseApproval[]>()
    for (const a of data?.approvals ?? []) {
      const arr = map.get(a.expense_id) ?? []
      arr.push(a)
      map.set(a.expense_id, arr)
    }
    return map
  }, [data])

  const memberName = (id?: string | null) => (id ? memberMap.get(id)?.full_name || '未知成员' : '—')
  const deptName = (id?: string | null) => (id ? deptMap.get(id)?.name || '—' : '公司级')

  const kpi = useMemo(() => {
    const rows = data?.expenses ?? []
    const now = dayjs()
    const month = now.format('YYYY-MM')
    const monthRows = rows.filter((e) => dayjs(e.expense_date).format('YYYY-MM') === month)
    const monthSpend = monthRows.reduce((s, e) => s + Number(e.amount || 0), 0)
    const pending = rows.filter((e) => e.status === 'pending')
    const paid = rows.filter((e) => e.status === 'paid').reduce((s, e) => s + Number(e.amount || 0), 0)
    const budgets = (data?.budgets ?? []).filter((b) => b.period === month)
    const budgetTotal = budgets.reduce((s, b) => s + Number(b.amount || 0), 0)
    return {
      monthSpend,
      pending: pending.length,
      paid,
      budgetTotal,
      usage: budgetTotal > 0 ? (monthSpend / budgetTotal) * 100 : 0,
      total: rows.length,
    }
  }, [data])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data?.expenses ?? []).filter((e) => {
      if (statusFilter && e.status !== statusFilter) return false
      if (catFilter && e.category !== catFilter) return false
      if (monthFilter && dayjs(e.expense_date).format('YYYY-MM') !== monthFilter) return false
      if (!q) return true
      return (
        e.title.toLowerCase().includes(q) ||
        e.code.toLowerCase().includes(q) ||
        (e.note ?? '').toLowerCase().includes(q) ||
        memberName(e.owner_id).toLowerCase().includes(q)
      )
    })
  }, [data, search, statusFilter, catFilter, monthFilter, memberMap])

  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const auditRows = useMemo(
    () => (data?.expenses ?? []).filter((e) => e.status === 'pending').sort((a, b) => a.expense_date.localeCompare(b.expense_date)),
    [data],
  )

  function genCode() {
    const prefix = `FY${dayjs().format('YYYYMM')}-`
    const seq = (data?.expenses ?? []).reduce((max, e) => {
      if (e.code.startsWith(prefix)) {
        const n = parseInt(e.code.slice(prefix.length), 10)
        if (!Number.isNaN(n)) return Math.max(max, n)
      }
      return max
    }, 0) + 1
    return `${prefix}${String(seq).padStart(4, '0')}`
  }

  function openCreate() {
    setForm({ ...emptyForm(), code: genCode() })
  }

  function openEdit(e: FinanceExpense) {
    const its = itemsByExpense.get(e.id) ?? []
    setForm({
      id: e.id,
      code: e.code,
      title: e.title,
      category: e.category,
      subcategory: e.subcategory ?? '',
      owner_id: e.owner_id ?? '',
      department_id: e.department_id ?? '',
      store_id: e.store_id ?? '',
      project_id: e.project_id ?? '',
      currency: e.currency,
      expense_date: e.expense_date,
      note: e.note ?? '',
      items: its.length
        ? its.map((it) => ({
            key: it.id,
            category: it.category,
            item: it.item,
            qty: String(it.qty),
            unit_price: String(it.unit_price),
            employee_id: it.employee_id ?? '',
            note: it.note ?? '',
          }))
        : [newItem(e.category)],
    })
  }

  function itemAmount(it: ItemDraft) {
    return (Number(it.qty) || 0) * (Number(it.unit_price) || 0)
  }

  const formTotal = form ? form.items.reduce((s, it) => s + itemAmount(it), 0) : 0

  async function saveExpense() {
    if (!form) return
    if (!form.title.trim()) return push('请填写费用事由', 'error')
    if (form.items.length === 0 || form.items.some((it) => !it.item.trim())) {
      return push('请至少填写一条费用明细的名称', 'error')
    }
    if (formTotal <= 0) return push('费用金额必须大于 0', 'error')
    setSaving(true)
    try {
      const payload = {
        title: form.title.trim(),
        category: form.category,
        subcategory: form.subcategory ? form.subcategory.trim() : null,
        owner_id: form.owner_id || null,
        department_id: form.department_id || null,
        store_id: form.store_id || null,
        project_id: form.project_id || null,
        currency: form.currency,
        expense_date: form.expense_date,
        note: form.note ? form.note.trim() : null,
        user_id: user?.id,
      }
      let id: string
      if (form.id) {
        await updateRow('finance_expenses', form.id, payload)
        id = form.id
        // 重写明细：先删再插，由触发器汇总回主表金额
        await deleteWhere('finance_expense_items', 'expense_id', id)
      } else {
        const row = await insertRows<{ id: string }>('finance_expenses', [{ ...payload, code: form.code, status: 'draft' }])
        id = row[0].id
      }
      await insertRows('finance_expense_items', form.items.map((it) => ({
        expense_id: id,
        category: it.category,
        item: it.item.trim(),
        qty: Number(it.qty) || 0,
        unit_price: Number(it.unit_price) || 0,
        amount: itemAmount(it),
        employee_id: it.employee_id || null,
        note: it.note ? it.note.trim() : null,
        user_id: user?.id,
      })))
      push(form.id ? '费用单已更新' : '费用单已创建，可提交财务审核')
      setForm(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setSaving(true)
    try {
      if (deleting.status !== 'draft') {
        push('只有草稿状态的费用单可以删除，已提交的单请先走完流程', 'error')
        setDeleting(null)
        setSaving(false)
        return
      }
      await deleteRow('finance_expenses', deleting.id)
      push('费用单已删除')
      setDeleting(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function doSubmit(e: FinanceExpense, note?: string) {
    try {
      const res = await submitExpense(e.id, note)
      push(res.status === 'pending' ? '已提交财务审核' : '状态已更新')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '提交失败', 'error')
    }
  }

  async function doAudit(e: FinanceExpense, decision: 'approved' | 'rejected', note?: string) {
    try {
      const res = await approveExpense(e.id, decision, note)
      push(res.status === 'approved' ? '已通过，经办人可登记付款' : '已驳回，经办人可修改后重提')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '审核失败', 'error')
    }
  }

  async function doPay() {
    if (!payTarget) return
    setSaving(true)
    try {
      await payExpense(
        payTarget.id,
        payDraft.paid_at || undefined,
        payDraft.method,
        payDraft.voucher || undefined,
        payDraft.note || undefined,
      )
      push('付款已登记，费用单闭环完成')
      setPayTarget(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '登记付款失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function saveBudget() {
    if (!budgetForm) return
    const amount = Number(budgetForm.amount) || 0
    if (amount <= 0) return push('预算金额必须大于 0', 'error')
    setSaving(true)
    try {
      const payload = {
        category: budgetForm.category,
        department_id: budgetForm.department_id || null,
        period: budgetForm.period,
        amount,
        currency: budgetForm.currency,
        note: budgetForm.note ? budgetForm.note.trim() : null,
      }
      if (budgetForm.id) await updateRow('finance_budgets', budgetForm.id, payload)
      else await insertRows('finance_budgets', [{ ...payload, user_id: user?.id }])
      push('预算已保存')
      setBudgetForm(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function confirmDeleteBudget() {
    if (!deleteBudget) return
    setSaving(true)
    try {
      await deleteRow('finance_budgets', deleteBudget.id)
      push('预算已删除')
      setDeleteBudget(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  function exportCsv() {
    const rows = filtered.map((e) => ({
      单号: e.code,
      日期: e.expense_date,
      事由: e.title,
      类别: EXPENSE_CATEGORY_META[e.category]?.label ?? e.category,
      明细科目: e.subcategory ?? '',
      归属人: memberName(e.owner_id),
      部门: deptName(e.department_id),
      金额: e.amount,
      币种: e.currency,
      状态: EXPENSE_STATUS_META[e.status]?.label ?? e.status,
      付款日期: e.paid_at ?? '',
      备注: e.note ?? '',
    }))
    downloadTextFile(`费用台账_${today()}.csv`, toCsv(rows))
    push('已导出 CSV')
  }

  /* ---------------- 统计：分类饼图 + 月度趋势 ---------------- */
  const stats = useMemo(() => {
    const rows = data?.expenses ?? []
    const byCat = CATEGORIES.map((c) => ({
      name: EXPENSE_CATEGORY_META[c]?.label ?? c,
      value: rows.filter((e) => e.category === c).reduce((s, e) => s + Number(e.amount || 0), 0),
    })).filter((r) => r.value > 0)
    const months = new Map<string, number>()
    for (const e of rows) {
      const m = dayjs(e.expense_date).format('YYYY-MM')
      months.set(m, (months.get(m) ?? 0) + Number(e.amount || 0))
    }
    const trend = Array.from(months.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([month, value]) => ({ month: month.slice(2), value: Math.round(value) }))
    const byDept = Array.from(new Set(rows.map((e) => e.department_id).filter(Boolean))).map((id) => ({
      name: deptName(id),
      value: rows.filter((e) => e.department_id === id).reduce((s, e) => s + Number(e.amount || 0), 0),
    })).sort((a, b) => b.value - a.value)
    return { byCat, trend, byDept }
  }, [data, deptMap])

  const detail = detailId ? (data?.expenses ?? []).find((e) => e.id === detailId) : null

  return (
    <>
      <PageHeader
        title="费用管理"
        description="研发、营销、薪酬社保、差旅等费用的单据、明细、预算与审批全流程管理"
        actions={
          <>
            <Segmented
              value={view}
              onChange={(v) => { setView(v as View); setSearch(''); setPage(1) }}
              options={[
                { value: 'records', label: '费用单' },
                { value: 'budgets', label: '预算管理' },
                { value: 'audit', label: `审批中心${kpi.pending ? ` (${kpi.pending})` : ''}` },
                { value: 'stats', label: '统计分析' },
              ]}
            />
            {canEdit && view === 'records' && (
              <>
                <Button size="sm" onClick={exportCsv}>导出 CSV</Button>
                <Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
                  记一笔费用
                </Button>
              </>
            )}
            {canEdit && view === 'budgets' && (
              <Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setBudgetForm(emptyBudget())}>
                新增预算
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        {[
          { label: '本月费用（原币合计）', value: money(kpi.monthSpend, 'CNY', 0), icon: <CircleDollarSign className="w-4 h-4" />, tone: 'bg-brand-50 text-brand-600' },
          { label: '待财务审核', value: num(kpi.pending), icon: <ClipboardList className="w-4 h-4" />, tone: 'bg-amber-50 text-amber-600' },
          { label: '预算使用进度', value: kpi.budgetTotal > 0 ? pct(kpi.usage, 0) : '未设预算', icon: <Wallet className="w-4 h-4" />, tone: 'bg-violet-50 text-violet-600' },
          { label: '累计已付款', value: money(kpi.paid, 'CNY', 0), icon: <CheckCircle2 className="w-4 h-4" />, tone: 'bg-emerald-50 text-emerald-600' },
        ].map((k) => (
          <div key={k.label} className="card px-4 py-3 flex items-center gap-3">
            <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', k.tone)}>{k.icon}</span>
            <div className="min-w-0">
              <p className="text-[11px] text-ink-500">{k.label}</p>
              <p className="num text-[17px] font-semibold text-ink-900 leading-tight truncate">{k.value}</p>
            </div>
          </div>
        ))}
      </div>

      {error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : loading ? (
        <div className="card"><LoadingBlock rows={8} /></div>
      ) : view === 'records' ? (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
            <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="搜索单号 / 事由 / 归属人…" className="w-60" />
            <Select value={statusFilter} onChange={(v) => { setStatusFilter(v); setPage(1) }} placeholder="全部状态"
              options={STATUS_ORDER.map((s) => ({ value: s, label: EXPENSE_STATUS_META[s].label }))} className="w-36" />
            <Select value={catFilter} onChange={(v) => { setCatFilter(v); setPage(1) }} placeholder="全部类别"
              options={CATEGORIES.map((c) => ({ value: c, label: EXPENSE_CATEGORY_META[c].label }))} className="w-32" />
            <input type="month" className="input w-36" value={monthFilter} onChange={(e) => { setMonthFilter(e.target.value); setPage(1) }} />
          </div>
          {paged.length === 0 ? (
            <EmptyState icon={<Receipt className="w-5 h-5" />} title="还没有符合条件的费用单"
              description={canEdit ? '点「记一笔费用」录入第一张单，支持一条单多笔明细' : '请联系有费用编辑权限的同事录入'} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-[11px] text-ink-400 border-b border-ink-100 bg-ink-50/50">
                    <th className="px-4 py-2.5 font-medium">单号 / 日期</th>
                    <th className="px-4 py-2.5 font-medium">事由</th>
                    <th className="px-4 py-2.5 font-medium">类别</th>
                    <th className="px-4 py-2.5 font-medium">归属</th>
                    <th className="px-4 py-2.5 font-medium text-right">金额（原币）</th>
                    <th className="px-4 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((e) => {
                    const st = EXPENSE_STATUS_META[e.status] ?? EXPENSE_STATUS_META.draft
                    const cat = EXPENSE_CATEGORY_META[e.category] ?? EXPENSE_CATEGORY_META.other
                    return (
                      <tr key={e.id} className="border-b border-ink-100/70 hover:bg-ink-50/40">
                        <td className="px-4 py-2.5">
                          <button className="num text-brand-600 hover:underline font-medium" onClick={() => setDetailId(e.id)}>{e.code}</button>
                          <p className="text-[11px] text-ink-400 mt-0.5">{fmtDate(e.expense_date)}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="font-medium text-ink-800 max-w-[240px] truncate">{e.title}</p>
                          {e.note && <p className="text-[11px] text-ink-400 max-w-[240px] truncate">{e.note}</p>}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium', cat.tone)}>{cat.label}</span>
                          {e.subcategory && <p className="text-[11px] text-ink-400 mt-0.5">{e.subcategory}</p>}
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-ink-700">{memberName(e.owner_id)}</p>
                          <p className="text-[11px] text-ink-400">{deptName(e.department_id)}</p>
                        </td>
                        <td className="px-4 py-2.5 text-right num font-medium text-ink-900">{money(e.amount, e.currency)}</td>
                        <td className="px-4 py-2.5">
                          <span className={cn('inline-flex px-1.5 py-0.5 rounded border text-[11px]', st.cls)}>{st.label}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            <button className="p-1.5 rounded text-ink-400 hover:text-brand-600 hover:bg-brand-50" title="查看详情" onClick={() => setDetailId(e.id)}>
                              <FileText className="w-3.5 h-3.5" />
                            </button>
                            {canEdit && (e.status === 'draft' || e.status === 'rejected') && (
                              <button className="p-1.5 rounded text-ink-400 hover:text-brand-600 hover:bg-brand-50" title="编辑" onClick={() => openEdit(e)}>
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {canEdit && (e.status === 'draft' || e.status === 'rejected') && (
                              <Button size="sm" variant="primary" onClick={() => void doSubmit(e)}>提交审核</Button>
                            )}
                            {canEdit && e.status === 'approved' && (
                              <Button size="sm" onClick={() => { setPayTarget(e); setPayDraft({ paid_at: today(), method: 'bank', voucher: '', note: '' }) }}>登记付款</Button>
                            )}
                            {canEdit && e.status === 'approved' && (
                              <button className="p-1.5 rounded text-amber-500 hover:bg-amber-50" title="撤回重审" onClick={() => void doSubmit(e, '撤回重审')}>
                                <XCircle className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {canEdit && e.status === 'draft' && (
                              <button className="p-1.5 rounded text-ink-400 hover:text-rose-600 hover:bg-rose-50" title="删除" onClick={() => setDeleting(e)}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} />
        </div>
      ) : view === 'budgets' ? (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-ink-100">
            <p className="text-[12px] text-ink-500">按「类别 + 部门 + 月份」设置预算额度，费用单通过审核后计入占用。部门留空表示公司级预算。</p>
          </div>
          {(data?.budgets ?? []).length === 0 ? (
            <EmptyState icon={<Wallet className="w-5 h-5" />} title="还没有预算" description={canEdit ? '点「新增预算」设置月度额度' : '预算由有费用编辑权限的同事维护'} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-[11px] text-ink-400 border-b border-ink-100 bg-ink-50/50">
                    <th className="px-4 py-2.5 font-medium">月份</th>
                    <th className="px-4 py-2.5 font-medium">类别</th>
                    <th className="px-4 py-2.5 font-medium">部门</th>
                    <th className="px-4 py-2.5 font-medium text-right">预算额度</th>
                    <th className="px-4 py-2.5 font-medium text-right">已占用</th>
                    <th className="px-4 py-2.5 font-medium">使用情况</th>
                    <th className="px-4 py-2.5 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.budgets ?? []).map((b) => {
                    const used = (data?.expenses ?? [])
                      .filter((e) => e.category === b.category && e.department_id === b.department_id
                        && dayjs(e.expense_date).format('YYYY-MM') === b.period && e.status !== 'rejected')
                      .reduce((s, e) => s + Number(e.amount || 0), 0)
                    const rate = b.amount > 0 ? (used / b.amount) * 100 : 0
                    return (
                      <tr key={b.id} className="border-b border-ink-100/70 hover:bg-ink-50/40">
                        <td className="px-4 py-2.5 num">{b.period}</td>
                        <td className="px-4 py-2.5">
                          <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium', EXPENSE_CATEGORY_META[b.category]?.tone)}>
                            {EXPENSE_CATEGORY_META[b.category]?.label ?? b.category}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">{deptName(b.department_id)}</td>
                        <td className="px-4 py-2.5 text-right num font-medium">{money(b.amount, b.currency)}</td>
                        <td className="px-4 py-2.5 text-right num">{money(used, b.currency)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden min-w-[60px]">
                              <div className={cn('h-full rounded-full', rate > 100 ? 'bg-rose-500' : rate > 80 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(rate, 100)}%` }} />
                            </div>
                            <span className={cn('num text-[11px] w-10 text-right', rate > 100 ? 'text-rose-600' : 'text-ink-600')}>{pct(rate, 0)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          {canEdit && (
                            <div className="flex items-center justify-end gap-1">
                              <button className="p-1.5 rounded text-ink-400 hover:text-brand-600 hover:bg-brand-50" title="编辑" onClick={() => setBudgetForm({
                                id: b.id, category: b.category, department_id: b.department_id ?? '', period: b.period,
                                amount: String(b.amount), currency: b.currency, note: b.note ?? '',
                              })}><Pencil className="w-3.5 h-3.5" /></button>
                              <button className="p-1.5 rounded text-ink-400 hover:text-rose-600 hover:bg-rose-50" title="删除" onClick={() => setDeleteBudget(b)}><Trash2 className="w-3.5 h-3.5" /></button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : view === 'audit' ? (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-ink-100 flex items-center justify-between">
            <p className="text-[12px] text-ink-500">待财务审核的费用单。审核通过后经办人才能登记付款，审核与付款都会被记录。</p>
            {!canAudit && <Badge tone="gray">当前账号无财务审核权限</Badge>}
          </div>
          {auditRows.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="w-5 h-5" />} title="没有待审核的费用单" description="费用提交后会自动出现在这里" />
          ) : (
            <div className="divide-y divide-ink-100">
              {auditRows.map((e) => (
                <div key={e.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                  <div className="min-w-[180px] flex-1">
                    <div className="flex items-center gap-2">
                      <button className="num text-brand-600 hover:underline text-[12px]" onClick={() => setDetailId(e.id)}>{e.code}</button>
                      <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium', EXPENSE_CATEGORY_META[e.category]?.tone)}>
                        {EXPENSE_CATEGORY_META[e.category]?.label}
                      </span>
                    </div>
                    <p className="text-[13px] font-medium text-ink-800 mt-0.5">{e.title}</p>
                    <p className="text-[11px] text-ink-400">
                      {memberName(e.user_id)} 提交 · {fmtDate(e.expense_date)} · {deptName(e.department_id)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="num text-[15px] font-semibold text-ink-900">{money(e.amount, e.currency)}</p>
                    <p className="text-[11px] text-ink-400">{itemsByExpense.get(e.id)?.length ?? 0} 条明细</p>
                  </div>
                  {canAudit ? (
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="primary" icon={<CheckCircle2 className="w-3.5 h-3.5" />} onClick={() => void doAudit(e, 'approved')}>通过</Button>
                      <Button size="sm" variant="danger" icon={<XCircle className="w-3.5 h-3.5" />} onClick={() => void doAudit(e, 'rejected')}>驳回</Button>
                    </div>
                  ) : (
                    <Badge tone="amber">待财务处理</Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-3">
                <Coins className="w-4 h-4 text-brand-600" />
                <h3 className="text-[13px] font-semibold text-ink-900">费用类别占比（原币合计）</h3>
              </div>
              {stats.byCat.length === 0 ? (
                <p className="text-[12px] text-ink-400 py-10 text-center">暂无费用数据</p>
              ) : (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={stats.byCat} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={78} paddingAngle={2}>
                        {stats.byCat.map((_, i) => <Cell key={i} fill={['#6366f1', '#0ea5e9', '#f59e0b', '#10b981', '#8b5cf6', '#94a3b8'][i % 6]} />)}
                      </Pie>
                      <Tooltip formatter={(v) => money(Number(v), 'CNY', 0)} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="w-4 h-4 text-brand-600" />
                <h3 className="text-[13px] font-semibold text-ink-900">近 12 个月费用趋势</h3>
              </div>
              {stats.trend.length === 0 ? (
                <p className="text-[12px] text-ink-400 py-10 text-center">暂无费用数据</p>
              ) : (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={stats.trend} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                      <Tooltip formatter={(v) => money(Number(v), 'CNY', 0)} />
                      <Bar dataKey="value" fill="#6366f1" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 className="w-4 h-4 text-brand-600" />
              <h3 className="text-[13px] font-semibold text-ink-900">部门费用分布（原币合计）</h3>
            </div>
            {stats.byDept.length === 0 ? (
              <p className="text-[12px] text-ink-400 py-8 text-center">暂无按部门归属的费用</p>
            ) : (
              <div className="space-y-2.5">
                {stats.byDept.map((d) => {
                  const max = stats.byDept[0]?.value || 1
                  return (
                    <div key={d.name} className="flex items-center gap-3">
                      <span className="w-24 text-[12px] text-ink-600 truncate">{d.name}</span>
                      <div className="flex-1 h-2 rounded-full bg-ink-100 overflow-hidden">
                        <div className="h-full rounded-full bg-brand-500" style={{ width: `${(d.value / max) * 100}%` }} />
                      </div>
                      <span className="num text-[12px] text-ink-700 w-24 text-right">{money(d.value, 'CNY', 0)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 费用单编辑 */}
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? '编辑费用单' : '记一笔费用'}
        description="一张费用单可填多条明细，金额自动汇总；保存后提交财务审核" width="max-w-3xl"
        footer={
          <>
            <Button onClick={() => setForm(null)}>取消</Button>
            <Button variant="primary" loading={saving} onClick={() => void saveExpense()}>{form?.id ? '保存修改' : '创建费用单'}</Button>
          </>
        }>
        {form && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="单号"><input className="input" value={form.code} disabled /></Field>
              <Field label="费用事由" required><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="如：11 月美国站广告充值" /></Field>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <Field label="费用类别">
                <Select value={form.category} onChange={(v) => setForm({ ...form, category: v as ExpenseCategory, subcategory: '' })}
                  options={CATEGORIES.map((c) => ({ value: c, label: EXPENSE_CATEGORY_META[c].label }))} />
              </Field>
              <Field label="明细科目">
                <Select value={form.subcategory} onChange={(v) => setForm({ ...form, subcategory: v })} placeholder="可不填"
                  options={(EXPENSE_SUB_ITEMS[form.category] ?? []).map((s) => ({ value: s, label: s }))} />
              </Field>
              <Field label="费用日期"><input type="date" className="input" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} /></Field>
              <Field label="归属人">
                <Select value={form.owner_id} onChange={(v) => setForm({ ...form, owner_id: v })} placeholder="不限"
                  options={(data?.directory ?? []).map((m) => ({ value: m.id, label: m.full_name || m.email || m.id }))} />
              </Field>
              <Field label="归属部门">
                <Select value={form.department_id} onChange={(v) => setForm({ ...form, department_id: v })} placeholder="公司级"
                  options={(data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} />
              </Field>
              <Field label="关联店铺">
                <Select value={form.store_id} onChange={(v) => setForm({ ...form, store_id: v })} placeholder="不关联"
                  options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))} />
              </Field>
              <Field label="关联开发项目">
                <Select value={form.project_id} onChange={(v) => setForm({ ...form, project_id: v })} placeholder="不关联"
                  options={(data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} />
              </Field>
              <Field label="币种">
                <Select value={form.currency} onChange={(v) => setForm({ ...form, currency: v })}
                  options={['CNY', 'USD', 'GBP', 'EUR', 'JPY'].map((c) => ({ value: c, label: c }))} />
              </Field>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="label mb-0">费用明细 <span className="text-rose-500">*</span></p>
                <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setForm({ ...form, items: [...form.items, newItem(form.category)] })}>添加明细</Button>
              </div>
              <div className="space-y-2">
                {form.items.map((it, idx) => (
                  <div key={it.key} className="rounded-lg border border-ink-200 bg-ink-50/40 p-2.5">
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
                      <Field label="科目"><input className="input" value={it.item} onChange={(e) => {
                        const items = [...form.items]; items[idx] = { ...it, item: e.target.value }; setForm({ ...form, items })
                      }} placeholder="如：住宿费" /></Field>
                      <Field label="数量"><input className="input num" type="number" min="0" step="0.01" value={it.qty} onChange={(e) => {
                        const items = [...form.items]; items[idx] = { ...it, qty: e.target.value }; setForm({ ...form, items })
                      }} /></Field>
                      <Field label="单价"><input className="input num" type="number" min="0" step="0.01" value={it.unit_price} onChange={(e) => {
                        const items = [...form.items]; items[idx] = { ...it, unit_price: e.target.value }; setForm({ ...form, items })
                      }} /></Field>
                      <Field label="金额">
                        <div className="input num bg-ink-100 flex items-center">{money(itemAmount(it), form.currency)}</div>
                      </Field>
                      <Field label="员工（薪酬社保用）">
                        <Select value={it.employee_id} onChange={(v) => {
                          const items = [...form.items]; items[idx] = { ...it, employee_id: v }; setForm({ ...form, items })
                        }} placeholder="不限"
                          options={(data?.directory ?? []).map((m) => ({ value: m.id, label: m.full_name || m.email || m.id }))} />
                      </Field>
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      <input className="input flex-1 mr-2" value={it.note} onChange={(e) => {
                        const items = [...form.items]; items[idx] = { ...it, note: e.target.value }; setForm({ ...form, items })
                      }} placeholder="明细备注（可选）" />
                      {form.items.length > 1 && (
                        <button className="p-1.5 rounded text-ink-400 hover:text-rose-600 hover:bg-rose-50" onClick={() => setForm({ ...form, items: form.items.filter((_, i) => i !== idx) })}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between mt-2 px-1">
                <span className="text-[12px] text-ink-500">{form.items.length} 条明细</span>
                <span className="text-[13px] font-semibold text-ink-900">合计：{money(formTotal, form.currency)}</span>
              </div>
            </div>
            <Field label="备注"><textarea className="input min-h-[60px]" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="报销事由、附件说明等" /></Field>
          </div>
        )}
      </Modal>

      {/* 费用单详情 */}
      <Modal open={!!detail} onClose={() => setDetailId(null)} title={detail?.code ?? '费用单详情'} description={detail?.title} width="max-w-2xl">
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-[12px]">
              {[
                { label: '类别', value: EXPENSE_CATEGORY_META[detail.category]?.label ?? detail.category },
                { label: '归属', value: `${memberName(detail.owner_id)} / ${deptName(detail.department_id)}` },
                { label: '日期', value: fmtDate(detail.expense_date) },
                { label: '状态', value: EXPENSE_STATUS_META[detail.status]?.label ?? detail.status },
              ].map((k) => (
                <div key={k.label} className="rounded-lg bg-ink-50 px-3 py-2">
                  <p className="text-ink-400 text-[11px]">{k.label}</p>
                  <p className="text-ink-800 font-medium mt-0.5 truncate" title={k.value}>{k.value}</p>
                </div>
              ))}
            </div>
            {detail.subcategory && <p className="text-[12px] text-ink-500">明细科目：{detail.subcategory}</p>}
            {detail.store_id && <p className="text-[12px] text-ink-500">关联店铺：{storeMap.get(detail.store_id)?.name ?? '—'}</p>}
            {detail.project_id && <p className="text-[12px] text-ink-500">关联项目：{projectMap.get(detail.project_id)?.name ?? '—'}</p>}

            <div>
              <p className="label">费用明细</p>
              <div className="rounded-lg border border-ink-200 overflow-hidden">
                <table className="w-full text-[12px]">
                  <thead><tr className="bg-ink-50 text-[11px] text-ink-400">
                    <th className="px-3 py-2 text-left font-medium">科目</th>
                    <th className="px-3 py-2 text-right font-medium">数量</th>
                    <th className="px-3 py-2 text-right font-medium">单价</th>
                    <th className="px-3 py-2 text-right font-medium">金额</th>
                  </tr></thead>
                  <tbody>
                    {(itemsByExpense.get(detail.id) ?? []).map((it) => (
                      <tr key={it.id} className="border-t border-ink-100">
                        <td className="px-3 py-2">
                          {it.item}
                          {it.employee_id && <span className="ml-1 text-[11px] text-brand-600">· {memberName(it.employee_id)}</span>}
                          {it.note && <p className="text-[11px] text-ink-400">{it.note}</p>}
                        </td>
                        <td className="px-3 py-2 text-right num">{num(it.qty, 2)}</td>
                        <td className="px-3 py-2 text-right num">{money(it.unit_price, detail.currency)}</td>
                        <td className="px-3 py-2 text-right num font-medium">{money(it.amount, detail.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-right text-[13px] font-semibold mt-2">合计：{money(detail.amount, detail.currency)}</p>
            </div>

            <div>
              <p className="label">审批与付款流水</p>
              <div className="space-y-1.5">
                {(approvalsByExpense.get(detail.id) ?? []).length === 0 ? (
                  <p className="text-[12px] text-ink-400">暂无流水（草稿状态）</p>
                ) : (approvalsByExpense.get(detail.id) ?? []).map((a) => {
                  const meta = EXPENSE_APPROVAL_ACTION_META[a.action] ?? EXPENSE_APPROVAL_ACTION_META.submit
                  return (
                    <div key={a.id} className="flex items-start gap-2 text-[12px]">
                      <span className={cn('font-medium', meta.cls)}>{meta.label}</span>
                      <span className="text-ink-400">{memberName(a.user_id)} · {fmtDate(a.created_at)}</span>
                      {a.note && <span className="text-ink-500">— {a.note}</span>}
                    </div>
                  )
                })}
              </div>
              {detail.approval_note && <p className="text-[12px] text-ink-500 mt-2">审核意见：{detail.approval_note}</p>}
            </div>
          </div>
        )}
      </Modal>

      {/* 付款登记 */}
      <Modal open={!!payTarget} onClose={() => setPayTarget(null)} title="登记费用付款"
        description={payTarget ? `${payTarget.code} · ${payTarget.title} · ${money(payTarget.amount, payTarget.currency)}` : ''}
        footer={<><Button onClick={() => setPayTarget(null)}>取消</Button><Button variant="primary" loading={saving} onClick={() => void doPay()}>确认付款</Button></>}>
        <div className="space-y-3">
          <Field label="付款日期"><input type="date" className="input" value={payDraft.paid_at} onChange={(e) => setPayDraft({ ...payDraft, paid_at: e.target.value })} /></Field>
          <Field label="付款方式"><Select value={payDraft.method} onChange={(v) => setPayDraft({ ...payDraft, method: v })} options={PAY_METHODS} /></Field>
          <Field label="凭证号"><input className="input" value={payDraft.voucher} onChange={(e) => setPayDraft({ ...payDraft, voucher: e.target.value })} placeholder="如：银行回单号 / 支付宝流水号" /></Field>
          <Field label="备注"><input className="input" value={payDraft.note} onChange={(e) => setPayDraft({ ...payDraft, note: e.target.value })} /></Field>
          <p className="text-[11px] text-ink-400">付款后费用单状态将变为「已付款」，流程闭环，不可再撤回。</p>
        </div>
      </Modal>

      {/* 预算编辑 */}
      <Modal open={!!budgetForm} onClose={() => setBudgetForm(null)} title={budgetForm?.id ? '编辑预算' : '新增预算'}
        footer={<><Button onClick={() => setBudgetForm(null)}>取消</Button><Button variant="primary" loading={saving} onClick={() => void saveBudget()}>保存</Button></>}>
        {budgetForm && (
          <div className="space-y-3">
            <Field label="月份"><input type="month" className="input" value={budgetForm.period} onChange={(e) => setBudgetForm({ ...budgetForm, period: e.target.value })} /></Field>
            <Field label="费用类别">
              <Select value={budgetForm.category} onChange={(v) => setBudgetForm({ ...budgetForm, category: v as ExpenseCategory })}
                options={CATEGORIES.map((c) => ({ value: c, label: EXPENSE_CATEGORY_META[c].label }))} />
            </Field>
            <Field label="部门" hint="留空表示公司级预算">
              <Select value={budgetForm.department_id} onChange={(v) => setBudgetForm({ ...budgetForm, department_id: v })} placeholder="公司级"
                options={(data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} />
            </Field>
            <Field label="预算金额"><input className="input num" type="number" min="0" step="0.01" value={budgetForm.amount} onChange={(e) => setBudgetForm({ ...budgetForm, amount: e.target.value })} /></Field>
            <Field label="币种">
              <Select value={budgetForm.currency} onChange={(v) => setBudgetForm({ ...budgetForm, currency: v })}
                options={['CNY', 'USD', 'GBP', 'EUR'].map((c) => ({ value: c, label: c }))} />
            </Field>
            <Field label="备注"><input className="input" value={budgetForm.note} onChange={(e) => setBudgetForm({ ...budgetForm, note: e.target.value })} /></Field>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => void confirmDelete()}
        title="删除费用单" message={`确定删除 ${deleting?.code ?? ''} 吗？该单共有 ${deleting ? (itemsByExpense.get(deleting.id)?.length ?? 0) : 0} 条明细，删除后不可恢复。`} loading={saving} />
      <ConfirmDialog open={!!deleteBudget} onClose={() => setDeleteBudget(null)} onConfirm={() => void confirmDeleteBudget()}
        title="删除预算" message={`确定删除 ${deleteBudget?.period ?? ''} ${deleteBudget ? (EXPENSE_CATEGORY_META[deleteBudget.category]?.label ?? '') : ''} 的预算吗？`} loading={saving} />
    </>
  )
}
