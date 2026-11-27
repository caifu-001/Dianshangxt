import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Check,
  Circle,
  ClipboardList,
  Coins,
  FlaskConical,
  Link2,
  Pencil,
  Plus,
  Rocket,
  Trash2,
} from 'lucide-react'
import dayjs from 'dayjs'
import { callRpc, deleteRow, fetchRows, insertRow, updateRow } from '../lib/db'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../context/AuthContext'
import { convert, useFx } from '../lib/fx'
import { cn, dayDiff, fmtDate, money, num, relativeDay, today } from '../lib/utils'
import type {
  DevCost,
  DevMilestone,
  DevMilestoneStatus,
  DevPriority,
  DevProject,
  DevProjectStatus,
  DevStage,
  FinanceExpense,
  Order,
  Product,
  Supplier,
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

type Tone = 'gray' | 'blue' | 'green' | 'red' | 'amber' | 'violet'
type View = 'projects' | 'board' | 'costs'
const PAGE_SIZE = 10

const STAGE_ORDER: DevStage[] = ['research', 'proposal', 'sample', 'testing', 'mass', 'launch']
const STAGE_META: Record<DevStage, { label: string; tone: Tone }> = {
  research: { label: '市场调研', tone: 'gray' },
  proposal: { label: '立项评审', tone: 'violet' },
  sample: { label: '打样中', tone: 'blue' },
  testing: { label: '测试验证', tone: 'amber' },
  mass: { label: '量产备货', tone: 'blue' },
  launch: { label: '已上市', tone: 'green' },
}
const STATUS_META: Record<DevProjectStatus, { label: string; tone: Tone }> = {
  active: { label: '进行中', tone: 'blue' },
  launched: { label: '已上市', tone: 'green' },
  paused: { label: '暂停', tone: 'amber' },
  dropped: { label: '已放弃', tone: 'gray' },
}
const PRIORITY_META: Record<DevPriority, { label: string; tone: Tone }> = {
  low: { label: '低', tone: 'gray' },
  normal: { label: '普通', tone: 'blue' },
  high: { label: '高', tone: 'amber' },
  urgent: { label: '紧急', tone: 'red' },
}
const MILESTONE_META: Record<DevMilestoneStatus, { label: string; tone: Tone }> = {
  todo: { label: '待办', tone: 'gray' },
  doing: { label: '进行中', tone: 'blue' },
  done: { label: '已完成', tone: 'green' },
  blocked: { label: '受阻', tone: 'red' },
}
const COST_CATEGORIES = [
  { value: 'mold', label: '模具 / 治具' },
  { value: 'sample', label: '打样费' },
  { value: 'cert', label: '认证 / 检测' },
  { value: 'design', label: '设计 / 版权' },
  { value: 'logistics', label: '物流 / 关税' },
  { value: 'other', label: '其他' },
]
const COST_TEXT: Record<string, string> = Object.fromEntries(COST_CATEGORIES.map((c) => [c.value, c.label]))

interface DirectoryRow {
  id: string
  full_name: string | null
  email: string | null
}

interface ProjectForm {
  id?: string
  code: string
  name: string
  category: string
  brand: string
  owner_id: string
  stage: DevStage
  status: DevProjectStatus
  priority: DevPriority
  target_cost: string
  target_price: string
  target_date: string
  supplier_id: string
  product_id: string
  score: string
  note: string
}

const emptyForm = (): ProjectForm => ({
  code: '',
  name: '',
  category: '',
  brand: '',
  owner_id: '',
  stage: 'research',
  status: 'active',
  priority: 'normal',
  target_cost: '0',
  target_price: '0',
  target_date: '',
  supplier_id: '',
  product_id: '',
  score: '60',
  note: '',
})

export default function Development() {
  const { push } = useToast()
  const { user, can } = useAuth()
  const canEdit = can('dev.edit')
  const fx = useFx()
  const [searchParams, setSearchParams] = useSearchParams()

  const [view, setView] = useState<View>('projects')
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)

  const [form, setForm] = useState<ProjectForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<DevProject | null>(null)
  const [deleteCost, setDeleteCost] = useState<DevCost | null>(null)
  const [deleteMilestone, setDeleteMilestone] = useState<DevMilestone | null>(null)

  const [msDraft, setMsDraft] = useState({ title: '', stage: 'sample' as DevStage, owner_id: '', due_date: '' })
  const [costDraft, setCostDraft] = useState({
    title: '',
    category: 'sample',
    amount: '',
    currency: 'CNY',
    incurred_at: today(),
  })

  const { data, loading, error, reload } = useAsync(async () => {
    const [projects, milestones, costs, suppliers, products, orders, directory, devExpenses] = await Promise.all([
      fetchRows<DevProject>('dev_projects', { order: { column: 'created_at', ascending: false } }),
      fetchRows<DevMilestone>('dev_milestones', { order: { column: 'created_at' } }),
      fetchRows<DevCost>('dev_costs', { order: { column: 'incurred_at', ascending: false } }),
      fetchRows<Supplier>('suppliers', { order: { column: 'created_at' } }).catch(() => [] as Supplier[]),
      fetchRows<Product>('products', { order: { column: 'created_at' } }).catch(() => [] as Product[]),
      fetchRows<Order>('orders', { columns: 'id,sku,gross_amount,profit,status,order_date', order: { column: 'order_date', ascending: false } }).catch(
        () => [] as Order[],
      ),
      callRpc<DirectoryRow[]>('team_directory').catch(() => [] as DirectoryRow[]),
      fetchRows<FinanceExpense>('finance_expenses', {
        columns: 'id,source_module,source_id,status,amount,currency,code',
        filters: [['source_module', 'eq', 'dev']],
      }).catch(() => [] as FinanceExpense[]),
    ])
    return { projects, milestones, costs, suppliers, products, orders, directory, devExpenses }
  }, [])

  // 从费用管理「查看该业务记录」跳回：?focus=dev_cost_id 打开费用台账并定位项目
  const focusCostId = searchParams.get('focus')
  useEffect(() => {
    if (loading || !focusCostId) return
    const cost = (data?.costs ?? []).find((c) => c.id === focusCostId)
    if (cost) {
      setView('costs')
      setDetailId(cost.project_id)
    }
    setSearchParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, focusCostId, data])

  const memberMap = useMemo(() => new Map((data?.directory ?? []).map((m) => [m.id, m])), [data])
  const supplierMap = useMemo(() => new Map((data?.suppliers ?? []).map((s) => [s.id, s])), [data])
  const productMap = useMemo(() => new Map((data?.products ?? []).map((p) => [p.id, p])), [data])
  const memberOptions = useMemo(
    () =>
      (data?.directory ?? [])
        .filter((m) => !m.email?.includes('disabled'))
        .map((m) => ({ value: m.id, label: m.full_name || m.email || '未命名' })),
    [data],
  )

  const milestonesByProject = useMemo(() => {
    const map = new Map<string, DevMilestone[]>()
    for (const m of data?.milestones ?? []) {
      if (!map.has(m.project_id)) map.set(m.project_id, [])
      map.get(m.project_id)!.push(m)
    }
    return map
  }, [data])
  const costsByProject = useMemo(() => {
    const map = new Map<string, DevCost[]>()
    for (const c of data?.costs ?? []) {
      if (!map.has(c.project_id)) map.set(c.project_id, [])
      map.get(c.project_id)!.push(c)
    }
    return map
  }, [data])

  // 每笔开发费用对应的费用管理单据（source_module=dev, source_id=dev_cost.id）
  const expenseByCost = useMemo(() => {
    const map = new Map<string, FinanceExpense>()
    for (const e of data?.devExpenses ?? []) {
      if (e.source_id) map.set(e.source_id, e)
    }
    return map
  }, [data])

  /** 跳转到费用管理，预填归集这张开发费用 */
  function goCollect(costId: string) {
    const base = import.meta.env.BASE_URL.replace(/\/+$/, '')
    window.open(`${base}/expenses?source=dev&source_id=${costId}`, '_blank')
  }

  const progressOf = (projectId: string) => {
    const list = milestonesByProject.get(projectId) ?? []
    const done = list.filter((m) => m.status === 'done').length
    return { done, total: list.length, pct: list.length ? Math.round((done / list.length) * 100) : 0 }
  }
  const spentOf = (projectId: string) =>
    (costsByProject.get(projectId) ?? []).reduce((s, c) => s + convert(Number(c.amount), c.currency, 'CNY', fx), 0)

  const kpi = useMemo(() => {
    const month = dayjs().format('YYYY-MM')
    return {
      active: (data?.projects ?? []).filter((p) => p.status === 'active').length,
      openMs: (data?.milestones ?? []).filter((m) => m.status !== 'done').length,
      monthSpend: (data?.costs ?? [])
        .filter((c) => c.incurred_at.startsWith(month))
        .reduce((s, c) => s + convert(Number(c.amount), c.currency, 'CNY', fx), 0),
      launched: (data?.projects ?? []).filter((p) => p.status === 'launched').length,
    }
  }, [data, fx])

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return (data?.projects ?? []).filter((p) => {
      if (stageFilter && p.stage !== stageFilter) return false
      if (statusFilter && p.status !== statusFilter) return false
      if (!kw) return true
      return [p.code, p.name, p.category ?? '', p.brand ?? '', supplierMap.get(p.supplier_id ?? '')?.name ?? '']
        .some((v) => v.toLowerCase().includes(kw))
    })
  }, [data, search, stageFilter, statusFilter, supplierMap])
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const detail = detailId ? (data?.projects ?? []).find((p) => p.id === detailId) ?? null : null
  const detailMilestones = detail ? milestonesByProject.get(detail.id) ?? [] : []
  const detailCosts = detail ? costsByProject.get(detail.id) ?? [] : []
  const detailProduct = detail?.product_id ? productMap.get(detail.product_id) ?? null : null
  const detailSales = detailProduct
    ? (data?.orders ?? []).filter(
        (o) => o.sku === detailProduct.sku && o.status !== 'cancelled' && o.status !== 'refunded',
      )
    : []

  function genCode() {
    return `DEV-${dayjs().format('YYMM')}-${String((data?.projects ?? []).length + 1).padStart(2, '0')}`
  }

  function openCreate() {
    setForm({ ...emptyForm(), code: genCode(), owner_id: user?.id ?? '' })
  }

  function openEdit(p: DevProject) {
    setForm({
      id: p.id,
      code: p.code,
      name: p.name,
      category: p.category ?? '',
      brand: p.brand ?? '',
      owner_id: p.owner_id ?? '',
      stage: p.stage,
      status: p.status,
      priority: p.priority,
      target_cost: String(p.target_cost),
      target_price: String(p.target_price),
      target_date: p.target_date ?? '',
      supplier_id: p.supplier_id ?? '',
      product_id: p.product_id ?? '',
      score: String(p.score),
      note: p.note ?? '',
    })
  }

  async function saveProject() {
    if (!form) return
    if (!form.name.trim()) return push('请填写项目名称', 'error')
    if (!form.code.trim()) return push('请填写项目编号', 'error')
    setSaving(true)
    try {
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        category: form.category.trim() || null,
        brand: form.brand.trim() || null,
        owner_id: form.owner_id || null,
        stage: form.stage,
        status: form.status,
        priority: form.priority,
        target_cost: Math.max(0, Number(form.target_cost) || 0),
        target_price: Math.max(0, Number(form.target_price) || 0),
        target_date: form.target_date || null,
        supplier_id: form.supplier_id || null,
        product_id: form.product_id || null,
        score: Math.min(100, Math.max(0, Math.round(Number(form.score) || 0))),
        note: form.note.trim() || null,
        updated_at: new Date().toISOString(),
      }
      if (form.id) await updateRow('dev_projects', form.id, payload)
      else await insertRow('dev_projects', { ...payload, user_id: user?.id })
      push(form.id ? '项目已更新' : '项目已创建，可继续添加阶段节点与开发费用')
      setForm(null)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate|unique/i.test(msg) ? '项目编号已存在' : msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    try {
      await deleteRow('dev_projects', deleting.id)
      push('项目及其节点、费用已删除')
      setDeleting(null)
      setDetailId(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  async function addMilestone() {
    if (!detail || !msDraft.title.trim()) return push('请填写节点名称', 'error')
    try {
      await insertRow('dev_milestones', {
        project_id: detail.id,
        title: msDraft.title.trim(),
        stage: msDraft.stage,
        owner_id: msDraft.owner_id || null,
        due_date: msDraft.due_date || null,
        status: 'todo',
        user_id: user?.id,
      })
      setMsDraft({ title: '', stage: detail.stage, owner_id: '', due_date: '' })
      push('阶段节点已添加')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '添加失败', 'error')
    }
  }

  async function cycleMilestone(m: DevMilestone) {
    const next: DevMilestoneStatus = m.status === 'todo' ? 'doing' : m.status === 'doing' ? 'done' : 'todo'
    try {
      await updateRow('dev_milestones', m.id, {
        status: next,
        finished_at: next === 'done' ? new Date().toISOString() : null,
      })
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '更新失败', 'error')
    }
  }

  async function confirmDeleteMilestone() {
    if (!deleteMilestone) return
    try {
      await deleteRow('dev_milestones', deleteMilestone.id)
      setDeleteMilestone(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  async function addCost() {
    if (!detail || !costDraft.title.trim()) return push('请填写费用名称', 'error')
    const amount = Number(costDraft.amount)
    if (!(amount > 0)) return push('请填写大于 0 的金额', 'error')
    try {
      await insertRow('dev_costs', {
        project_id: detail.id,
        title: costDraft.title.trim(),
        category: costDraft.category,
        amount: Math.round(amount * 100) / 100,
        currency: costDraft.currency,
        incurred_at: costDraft.incurred_at || today(),
        user_id: user?.id,
      })
      setCostDraft((d) => ({ ...d, title: '', amount: '' }))
      push('开发费用已登记')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '登记失败', 'error')
    }
  }

  async function confirmDeleteCost() {
    if (!deleteCost) return
    try {
      await deleteRow('dev_costs', deleteCost.id)
      setDeleteCost(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  function progressCell(p: DevProject) {
    const pr = progressOf(p.id)
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden min-w-[48px]">
          <div className="h-full rounded-full bg-brand-500" style={{ width: `${pr.pct}%` }} />
        </div>
        <span className="num text-[10.5px] text-ink-500 w-11 text-right">
          {pr.done}/{pr.total}
        </span>
      </div>
    )
  }

  return (
    <>
      <PageHeader
        title="产品开发"
        description="自有品牌新品从市场调研、立项、打样到上市的全过程，关联供应商、成本与销售表现"
        actions={
          <>
            <Segmented
              value={view}
              onChange={(v) => { setView(v as View); setSearch(''); setPage(1) }}
              options={[
                { value: 'projects', label: '项目清单' },
                { value: 'board', label: '阶段看板' },
                { value: 'costs', label: '费用台账' },
              ]}
            />
            {canEdit && (
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
                新建项目
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        {[
          { label: '进行中项目', value: num(kpi.active), icon: <FlaskConical className="w-4 h-4" />, tone: 'bg-brand-50 text-brand-600' },
          { label: '待推进节点', value: num(kpi.openMs), icon: <ClipboardList className="w-4 h-4" />, tone: 'bg-blue-50 text-blue-600' },
          { label: '本月开发投入（CNY）', value: money(kpi.monthSpend, 'CNY'), icon: <Coins className="w-4 h-4" />, tone: 'bg-amber-50 text-amber-600' },
          { label: '已上市 SKU 项目', value: num(kpi.launched), icon: <Rocket className="w-4 h-4" />, tone: 'bg-emerald-50 text-emerald-600' },
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
        <div className="card"><LoadingBlock rows={7} /></div>
      ) : view === 'projects' ? (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
            <SearchInput
              value={search}
              onChange={(v) => { setSearch(v); setPage(1) }}
              placeholder="项目编号 / 名称 / 类目 / 品牌 / 供应商"
              className="w-full sm:w-64"
            />
            <Select
              className="w-full sm:w-32"
              value={stageFilter}
              onChange={(v) => { setStageFilter(v); setPage(1) }}
              placeholder="全部阶段"
              options={STAGE_ORDER.map((s) => ({ value: s, label: STAGE_META[s].label }))}
            />
            <Select
              className="w-full sm:w-32"
              value={statusFilter}
              onChange={(v) => { setStatusFilter(v); setPage(1) }}
              placeholder="全部状态"
              options={Object.entries(STATUS_META).map(([value, v]) => ({ value, label: v.label }))}
            />
            <span className="ml-auto text-[11.5px] text-ink-400">
              共 <span className="num text-ink-700 font-medium">{num(filtered.length)}</span> 个项目
            </span>
          </div>
          {pageRows.length === 0 ? (
            <EmptyState
              icon={<FlaskConical className="w-5 h-5" />}
              title={filtered.length ? '没有匹配的项目' : '还没有开发项目'}
              description="从一个想法开始：新建项目后填写目标成本与售价，再逐步添加打样、测试和上市节点。"
              action={
                canEdit ? (
                  <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
                    新建项目
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px]">
                <thead>
                  <tr>
                    <th className="th">项目 / 编号</th>
                    <th className="th">类目 / 品牌</th>
                    <th className="th">负责人 / 供应商</th>
                    <th className="th">阶段 / 状态</th>
                    <th className="th w-[120px]">节点进度</th>
                    <th className="th text-right">目标成本 / 已投入</th>
                    <th className="th">目标上市</th>
                    <th className="th w-24" />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((p) => {
                    const stage = STAGE_META[p.stage] ?? STAGE_META.research
                    const status = STATUS_META[p.status] ?? STATUS_META.active
                    const spent = spentOf(p.id)
                    return (
                      <tr key={p.id} className="hover:bg-ink-50/60 group cursor-pointer" onClick={() => setDetailId(p.id)}>
                        <td className="td">
                          <p className="text-[12.5px] font-medium text-ink-800 truncate max-w-[220px]">{p.name}</p>
                          <p className="text-[10.5px] text-ink-400 font-mono">{p.code}</p>
                        </td>
                        <td className="td">
                          <p className="text-[11.5px] text-ink-700">{p.category || '未分类'}</p>
                          <p className="text-[10.5px] text-ink-400">{p.brand || '自有品牌'}</p>
                        </td>
                        <td className="td">
                          <p className="text-[11.5px] text-ink-700">
                            {p.owner_id ? memberMap.get(p.owner_id)?.full_name ?? '—' : '未指派'}
                          </p>
                          <p className="text-[10.5px] text-ink-400 truncate max-w-[160px]">
                            {p.supplier_id ? supplierMap.get(p.supplier_id)?.name ?? '—' : '未指定供应商'}
                          </p>
                        </td>
                        <td className="td">
                          <div className="flex flex-wrap gap-1">
                            <Badge tone={stage.tone}>{stage.label}</Badge>
                            <Badge tone={status.tone}>{status.label}</Badge>
                            {p.priority === 'urgent' && <Badge tone="red">紧急</Badge>}
                          </div>
                        </td>
                        <td className="td">{progressCell(p)}</td>
                        <td className="td text-right">
                          <p className="num text-[12px] text-ink-800">{money(p.target_cost, 'CNY')}</p>
                          <p className={cn('num text-[10.5px]', spent > p.target_cost ? 'text-rose-600' : 'text-ink-400')}>
                            已投 {money(spent, 'CNY')}
                          </p>
                        </td>
                        <td className="td">
                          <p className="text-[11.5px] text-ink-600 num">{p.target_date ? fmtDate(p.target_date, 'MM-DD') : '未定'}</p>
                          {p.target_date && (
                            <p className={cn('text-[10.5px]', dayDiff(p.target_date) < 0 && p.status === 'active' ? 'text-rose-600' : 'text-ink-400')}>
                              {relativeDay(p.target_date)}
                            </p>
                          )}
                        </td>
                        <td className="td" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-0.5">
                            {canEdit && (
                              <button
                                className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                                onClick={() => openEdit(p)}
                                title="编辑"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {canEdit && (
                              <button
                                className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                                onClick={() => setDeleting(p)}
                                title="删除"
                              >
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
          {filtered.length > PAGE_SIZE && (
            <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} />
          )}
        </div>
      ) : view === 'board' ? (
        <div className="overflow-x-auto pb-2">
          <div className="grid grid-cols-6 gap-3 min-w-[1120px]">
            {STAGE_ORDER.map((stage) => {
              const rows = (data?.projects ?? []).filter((p) => p.stage === stage)
              return (
                <div key={stage} className="rounded-xl border border-ink-200/70 bg-ink-50/40 p-2.5">
                  <div className="flex items-center justify-between px-1 pb-2">
                    <p className="text-[11.5px] font-semibold text-ink-600">{STAGE_META[stage].label}</p>
                    <span className="num text-[10.5px] text-ink-400">{rows.length}</span>
                  </div>
                  <div className="space-y-2">
                    {rows.length === 0 && (
                      <p className="text-[10.5px] text-ink-400 px-1 py-4 text-center">暂无项目</p>
                    )}
                    {rows.map((p) => {
                      const pr = progressOf(p.id)
                      return (
                        <button
                          key={p.id}
                          className="w-full text-left rounded-lg border border-ink-200/70 bg-white p-2.5 hover:border-brand-300 hover:shadow-sm transition"
                          onClick={() => setDetailId(p.id)}
                        >
                          <p className="text-[11.5px] font-medium text-ink-800 line-clamp-2">{p.name}</p>
                          <p className="text-[10px] text-ink-400 font-mono mt-0.5">{p.code}</p>
                          <div className="mt-2 flex items-center gap-2">
                            <div className="flex-1 h-1 rounded-full bg-ink-100 overflow-hidden">
                              <div className="h-full bg-brand-500 rounded-full" style={{ width: `${pr.pct}%` }} />
                            </div>
                            <span className="num text-[10px] text-ink-400">{pr.pct}%</span>
                          </div>
                          <p className="text-[10px] text-ink-400 mt-1.5">
                            {p.owner_id ? memberMap.get(p.owner_id)?.full_name ?? '未指派' : '未指派'} ·{' '}
                            {p.target_date ? fmtDate(p.target_date, 'MM-DD') : '未定交期'}
                          </p>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-ink-100">
            <div>
              <p className="text-[12.5px] font-medium text-ink-700">开发费用台账</p>
              <p className="text-[10.5px] text-ink-400">打样、模具、认证等投入按项目归集；点「去归集」可一键带入费用管理走审批付款流程</p>
            </div>
            <span className="text-[11.5px] text-ink-400">
              共 <span className="num text-ink-700 font-medium">{num(data?.costs.length ?? 0)}</span> 笔
            </span>
          </div>
          {(data?.costs.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Coins className="w-5 h-5" />}
              title="还没有开发费用"
              description="打开某个项目的详情，登记打样费、模具费或认证费，就能看到投入与预算的差距。"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px]">
                <thead>
                  <tr>
                    <th className="th">项目</th>
                    <th className="th">费用项</th>
                    <th className="th">类别</th>
                    <th className="th text-right">金额</th>
                    <th className="th">归集状态</th>
                    <th className="th">发生日期</th>
                    <th className="th">备注</th>
                    <th className="th w-16" />
                  </tr>
                </thead>
                <tbody>
                  {(data?.costs ?? []).map((c) => {
                    const p = (data?.projects ?? []).find((x) => x.id === c.project_id)
                    return (
                      <tr key={c.id} className="hover:bg-ink-50/60">
                        <td className="td">
                          <button className="text-[11.5px] text-brand-600 hover:underline" onClick={() => setDetailId(c.project_id)}>
                            {p?.name ?? '已删除项目'}
                          </button>
                          <p className="text-[10px] text-ink-400 font-mono">{p?.code ?? ''}</p>
                        </td>
                        <td className="td text-[11.5px] text-ink-700">{c.title}</td>
                        <td className="td"><Badge tone="gray">{COST_TEXT[c.category] ?? c.category}</Badge></td>
                        <td className="td text-right num text-ink-800">{money(c.amount, c.currency)}</td>
                        <td className="td">
                          {expenseByCost.has(c.id) ? (
                            <Badge tone="green">已归集</Badge>
                          ) : canEdit ? (
                            <button
                              className="inline-flex items-center gap-0.5 text-[11px] text-brand-600 hover:underline"
                              onClick={() => goCollect(c.id)}
                              title="跳转到费用管理，自动带入金额与科目"
                            >
                              <Link2 className="w-3 h-3" /> 去归集
                            </button>
                          ) : (
                            <span className="text-[11px] text-ink-400">未归集</span>
                          )}
                        </td>
                        <td className="td text-[11px] text-ink-500 num">{fmtDate(c.incurred_at)}</td>
                        <td className="td text-[11px] text-ink-400 truncate max-w-[200px]">{c.note || '—'}</td>
                        <td className="td">
                          {canEdit && (
                            <button
                              className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                              onClick={() => setDeleteCost(c)}
                              title="删除"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
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
      )}

      {/* ---------------- 项目详情 ---------------- */}
      <Modal
        open={!!detail}
        onClose={() => setDetailId(null)}
        title={detail?.name ?? '项目详情'}
        description={detail ? `${detail.code} · ${detail.category || '未分类'} · ${detail.brand || '自有品牌'}` : undefined}
        width="max-w-4xl"
        footer={<Button onClick={() => setDetailId(null)}>关闭</Button>}
      >
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {[
                { label: '阶段', value: STAGE_META[detail.stage]?.label ?? detail.stage },
                { label: '状态', value: STATUS_META[detail.status]?.label ?? detail.status },
                { label: '优先级', value: PRIORITY_META[detail.priority]?.label ?? detail.priority },
                { label: '评分', value: `${detail.score} / 100` },
                { label: '目标成本', value: money(detail.target_cost, 'CNY') },
                { label: '目标售价', value: money(detail.target_price, 'CNY') },
                { label: '已投入', value: money(spentOf(detail.id), 'CNY') },
                { label: '目标上市', value: detail.target_date ? fmtDate(detail.target_date) : '未定' },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-ink-200/70 px-3 py-2">
                  <p className="text-[10.5px] text-ink-400">{s.label}</p>
                  <p className="text-[12.5px] font-medium text-ink-900 mt-0.5 truncate">{s.value}</p>
                </div>
              ))}
            </div>

            {(detail.owner_id || detail.supplier_id || detail.product_id || detail.note) && (
              <div className="rounded-lg bg-ink-50 border border-ink-100 px-3 py-2 text-[11.5px] text-ink-600 space-y-1">
                {detail.owner_id && (
                  <p>负责人：{memberMap.get(detail.owner_id)?.full_name ?? '—'}</p>
                )}
                {detail.supplier_id && (
                  <p>打样供应商：{supplierMap.get(detail.supplier_id)?.name ?? '—'}</p>
                )}
                {detail.product_id && (
                  <p>关联在售 SKU：{productMap.get(detail.product_id)?.sku ?? '—'}</p>
                )}
                {detail.note && <p className="whitespace-pre-wrap pt-1">备注：{detail.note}</p>}
              </div>
            )}

            {detailProduct && (
              <div className="rounded-lg border border-ink-200/70 px-3 py-2.5">
                <p className="text-[11px] font-semibold text-ink-600 mb-1.5">
                  关联 SKU 销售表现 · {detailProduct.sku}
                </p>
                <div className="grid grid-cols-3 gap-2 text-[11.5px]">
                  <div>
                    <span className="text-ink-400">订单数 </span>
                    <span className="num font-medium text-ink-800">{num(detailSales.length)}</span>
                  </div>
                  <div>
                    <span className="text-ink-400">销售额 </span>
                    <span className="num font-medium text-ink-800">
                      {money(detailSales.reduce((s, o) => s + Number(o.gross_amount), 0), 'CNY')}
                    </span>
                  </div>
                  <div>
                    <span className="text-ink-400">毛利 </span>
                    <span className="num font-medium text-emerald-600">
                      {money(detailSales.reduce((s, o) => s + Number(o.profit), 0), 'CNY')}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-lg border border-ink-200/70 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-ink-50/60">
                <p className="text-[11px] font-semibold text-ink-600">
                  阶段节点（{detailMilestones.filter((m) => m.status === 'done').length}/{detailMilestones.length}）
                </p>
                {canEdit && (
                  <span className="text-[10px] text-ink-400">点圆圈可切换 待办 → 进行中 → 已完成</span>
                )}
              </div>
              {detailMilestones.length === 0 ? (
                <p className="px-3 py-4 text-[11.5px] text-ink-400">还没有节点，添加一个开始推进吧。</p>
              ) : (
                <div className="divide-y divide-ink-100">
                  {detailMilestones.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 px-3 py-2">
                      {canEdit ? (
                        <button onClick={() => cycleMilestone(m)} title="切换状态" className="shrink-0">
                          {m.status === 'done' ? (
                            <Check className="w-4 h-4 text-emerald-600" />
                          ) : m.status === 'doing' ? (
                            <span className="block w-3.5 h-3.5 rounded-full border-2 border-blue-500 bg-blue-100" />
                          ) : (
                            <Circle className="w-4 h-4 text-ink-300" />
                          )}
                        </button>
                      ) : (
                        <span className="shrink-0">
                          {m.status === 'done' ? <Check className="w-4 h-4 text-emerald-600" /> : <Circle className="w-4 h-4 text-ink-300" />}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className={cn('text-[11.5px] truncate', m.status === 'done' ? 'text-ink-400 line-through' : 'text-ink-700')}>
                          {m.title}
                        </p>
                        <p className="text-[10px] text-ink-400">
                          {STAGE_META[m.stage]?.label ?? m.stage} ·{' '}
                          {m.owner_id ? memberMap.get(m.owner_id)?.full_name ?? '未指派' : '未指派'} ·{' '}
                          {m.due_date ? fmtDate(m.due_date, 'MM-DD') : '未定期限'}
                        </p>
                      </div>
                      <Badge tone={MILESTONE_META[m.status]?.tone ?? 'gray'}>{MILESTONE_META[m.status]?.label ?? m.status}</Badge>
                      {canEdit && (
                        <button
                          className="p-1 rounded text-ink-300 hover:text-rose-600"
                          onClick={() => setDeleteMilestone(m)}
                          title="删除节点"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {canEdit && (
                <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-t border-ink-100 bg-ink-50/30">
                  <input
                    className="input flex-1 min-w-[160px]"
                    placeholder="新增节点，如：确认包装刀模"
                    value={msDraft.title}
                    onChange={(e) => setMsDraft({ ...msDraft, title: e.target.value })}
                  />
                  <select
                    className="input w-28"
                    value={msDraft.stage}
                    onChange={(e) => setMsDraft({ ...msDraft, stage: e.target.value as DevStage })}
                  >
                    {STAGE_ORDER.map((s) => <option key={s} value={s}>{STAGE_META[s].label}</option>)}
                  </select>
                  <select
                    className="input w-28"
                    value={msDraft.owner_id}
                    onChange={(e) => setMsDraft({ ...msDraft, owner_id: e.target.value })}
                  >
                    <option value="">未指派</option>
                    {memberOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  <input
                    className="input w-32"
                    type="date"
                    value={msDraft.due_date}
                    onChange={(e) => setMsDraft({ ...msDraft, due_date: e.target.value })}
                  />
                  <Button size="sm" variant="primary" icon={<Plus className="w-3 h-3" />} onClick={addMilestone}>
                    添加
                  </Button>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-ink-200/70 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-ink-50/60">
                <p className="text-[11px] font-semibold text-ink-600">
                  开发费用（{money(spentOf(detail.id), 'CNY')}）
                </p>
                <p className="text-[10px] text-ink-400">预算 {money(detail.target_cost, 'CNY')}</p>
              </div>
              {detailCosts.length === 0 ? (
                <p className="px-3 py-4 text-[11.5px] text-ink-400">还没有费用记录。</p>
              ) : (
                <div className="divide-y divide-ink-100">
                  {detailCosts.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 px-3 py-2 text-[11.5px]">
                      <Badge tone="gray">{COST_TEXT[c.category] ?? c.category}</Badge>
                      <span className="text-ink-700 flex-1 truncate">{c.title}</span>
                      <span className="text-[10.5px] text-ink-400 num">{fmtDate(c.incurred_at, 'MM-DD')}</span>
                      <span className="num font-medium text-ink-800">{money(c.amount, c.currency)}</span>
                      {expenseByCost.has(c.id) ? (
                        <Badge tone="green">已归集</Badge>
                      ) : canEdit ? (
                        <button
                          className="inline-flex items-center gap-0.5 text-[10.5px] text-brand-600 hover:underline"
                          onClick={() => goCollect(c.id)}
                          title="跳转到费用管理，自动带入金额与科目"
                        >
                          <Link2 className="w-3 h-3" /> 去归集
                        </button>
                      ) : null}
                      {canEdit && (
                        <button className="p-1 rounded text-ink-300 hover:text-rose-600" onClick={() => setDeleteCost(c)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {canEdit && (
                <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-t border-ink-100 bg-ink-50/30">
                  <input
                    className="input flex-1 min-w-[140px]"
                    placeholder="费用名称，如：首版打样"
                    value={costDraft.title}
                    onChange={(e) => setCostDraft({ ...costDraft, title: e.target.value })}
                  />
                  <select
                    className="input w-28"
                    value={costDraft.category}
                    onChange={(e) => setCostDraft({ ...costDraft, category: e.target.value })}
                  >
                    {COST_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <input
                    className="input w-24 num"
                    type="number"
                    min="0"
                    placeholder="金额"
                    value={costDraft.amount}
                    onChange={(e) => setCostDraft({ ...costDraft, amount: e.target.value })}
                  />
                  <select
                    className="input w-24"
                    value={costDraft.currency}
                    onChange={(e) => setCostDraft({ ...costDraft, currency: e.target.value })}
                  >
                    {['CNY', 'USD', 'EUR', 'GBP'].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input
                    className="input w-32"
                    type="date"
                    value={costDraft.incurred_at}
                    onChange={(e) => setCostDraft({ ...costDraft, incurred_at: e.target.value })}
                  />
                  <Button size="sm" variant="primary" icon={<Plus className="w-3 h-3" />} onClick={addCost}>
                    登记
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* ---------------- 新建 / 编辑项目 ---------------- */}
      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? '编辑开发项目' : '新建开发项目'}
        description="目标成本与售价用于和开发投入、在售 SKU 表现做对比"
        width="max-w-3xl"
        footer={
          <>
            <Button onClick={() => setForm(null)}>取消</Button>
            <Button variant="primary" onClick={saveProject} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <div className="grid sm:grid-cols-3 gap-3">
              <Field label="项目编号" required>
                <input className="input font-mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
              </Field>
              <Field label="项目名称" required>
                <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：竹木折叠收纳盒" />
              </Field>
              <Field label="所属类目">
                <input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="家居 / 厨房" />
              </Field>
              <Field label="自有品牌">
                <input className="input" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} placeholder="HOMELY" />
              </Field>
              <Field label="负责人">
                <Select
                  value={form.owner_id}
                  onChange={(v) => setForm({ ...form, owner_id: v })}
                  placeholder="未指派"
                  options={memberOptions}
                />
              </Field>
              <Field label="打样供应商">
                <Select
                  value={form.supplier_id}
                  onChange={(v) => setForm({ ...form, supplier_id: v })}
                  placeholder="未指定"
                  options={(data?.suppliers ?? []).map((s) => ({ value: s.id, label: s.name }))}
                />
              </Field>
            </div>

            <div className="grid sm:grid-cols-4 gap-3">
              <Field label="当前阶段">
                <Select
                  value={form.stage}
                  onChange={(v) => setForm({ ...form, stage: v as DevStage })}
                  options={STAGE_ORDER.map((s) => ({ value: s, label: STAGE_META[s].label }))}
                />
              </Field>
              <Field label="项目状态">
                <Select
                  value={form.status}
                  onChange={(v) => setForm({ ...form, status: v as DevProjectStatus })}
                  options={Object.entries(STATUS_META).map(([value, v]) => ({ value, label: v.label }))}
                />
              </Field>
              <Field label="优先级">
                <Select
                  value={form.priority}
                  onChange={(v) => setForm({ ...form, priority: v as DevPriority })}
                  options={Object.entries(PRIORITY_META).map(([value, v]) => ({ value, label: v.label }))}
                />
              </Field>
              <Field label="立项评分" hint="0-100，可用于排期取舍">
                <input
                  className="input num"
                  type="number"
                  min="0"
                  max="100"
                  value={form.score}
                  onChange={(e) => setForm({ ...form, score: e.target.value })}
                />
              </Field>
              <Field label="目标成本（CNY）">
                <input
                  className="input num"
                  type="number"
                  min="0"
                  value={form.target_cost}
                  onChange={(e) => setForm({ ...form, target_cost: e.target.value })}
                />
              </Field>
              <Field label="目标售价（CNY）">
                <input
                  className="input num"
                  type="number"
                  min="0"
                  value={form.target_price}
                  onChange={(e) => setForm({ ...form, target_price: e.target.value })}
                />
              </Field>
              <Field label="目标上市日">
                <input
                  className="input"
                  type="date"
                  value={form.target_date}
                  onChange={(e) => setForm({ ...form, target_date: e.target.value })}
                />
              </Field>
              <Field label="关联在售 SKU" hint="上市后关联商品档案，可看真实销售与毛利">
                <Select
                  value={form.product_id}
                  onChange={(v) => setForm({ ...form, product_id: v })}
                  placeholder="暂不关联"
                  options={(data?.products ?? []).map((p) => ({ value: p.id, label: `${p.sku} · ${p.title ?? ''}` }))}
                />
              </Field>
            </div>

            <Field label="项目说明">
              <textarea
                className="textarea"
                rows={3}
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="目标用户、差异化卖点、认证要求、风险点…"
              />
            </Field>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="删除开发项目"
        message={`确定删除「${deleting?.name ?? ''}」吗？项目下的阶段节点与费用记录会一起删除。`}
      />
      <ConfirmDialog
        open={!!deleteMilestone}
        onClose={() => setDeleteMilestone(null)}
        onConfirm={confirmDeleteMilestone}
        title="删除阶段节点"
        message={`确定删除节点「${deleteMilestone?.title ?? ''}」吗？`}
      />
      <ConfirmDialog
        open={!!deleteCost}
        onClose={() => setDeleteCost(null)}
        onConfirm={confirmDeleteCost}
        title="删除费用记录"
        message={deleteCost && expenseByCost.has(deleteCost.id)
          ? `确定删除「${deleteCost.title}」这笔开发费用吗？注意：费用管理中由它归集生成的费用单会保留为独立财务凭证，不会一起删除。`
          : `确定删除「${deleteCost?.title ?? ''}」这笔开发费用吗？`}
      />
    </>
  )
}
