import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Megaphone, Pause, Pencil, Play, Plus, Receipt, Target, Trash2 } from 'lucide-react'
import { deleteRow, fetchRows, insertRow, updateRow } from '../lib/db'
import { AD_TYPES, CAMPAIGN_STATUS } from '../lib/constants'
import type { Campaign, Store } from '../lib/types'
import { useAsync } from '../hooks/useAsync'
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
  Select,
  useToast,
} from '../components/ui'
import { SimpleBars } from '../components/charts'
import { cn, money, num, pct, sum, today } from '../lib/utils'
import { convert, useFx } from '../lib/fx'

const PAGE_SIZE = 15

interface FormState {
  store_id: string
  name: string
  ad_type: string
  status: Campaign['status']
  daily_budget: string
  spend: string
  impressions: string
  clicks: string
  orders_count: string
  sales: string
  start_date: string
  end_date: string
  note: string
}

const EMPTY: FormState = {
  store_id: '',
  name: '',
  ad_type: 'SP',
  status: 'active',
  daily_budget: '',
  spend: '',
  impressions: '',
  clicks: '',
  orders_count: '',
  sales: '',
  start_date: today(),
  end_date: '',
  note: '',
}

export default function Ads({ embedded = false }: { embedded?: boolean }) {
  const { push } = useToast()
  const [search, setSearch] = useState('')
  const [storeFilter, setStoreFilter] = useState('')
  const [platformFilter, setPlatformFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Campaign | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Campaign | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)

  const { data, loading, error, reload } = useAsync(async () => {
    const [campaigns, stores] = await Promise.all([
      fetchRows<Campaign>('campaigns', { order: { column: 'created_at', ascending: false } }),
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
    ])
    return { campaigns, stores }
  }, [])

  const storeMap = useMemo(() => new Map((data?.stores ?? []).map((s) => [s.id, s])), [data])
  const fx = useFx()

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return (data?.campaigns ?? []).filter((c) => {
      if (storeFilter && c.store_id !== storeFilter) return false
      if (platformFilter && c.platform !== platformFilter) return false
      if (statusFilter && c.status !== statusFilter) return false
      if (!kw) return true
      return c.name.toLowerCase().includes(kw)
    })
  }, [data, search, storeFilter, platformFilter, statusFilter])

  const kpi = useMemo(() => {
    const cv = (value: number | string, storeId: string) =>
      convert(Number(value ?? 0), storeMap.get(storeId)?.currency ?? 'USD', 'USD', fx)
    const spend = filtered.reduce((s, c) => s + cv(c.spend, c.store_id), 0)
    const sales = filtered.reduce((s, c) => s + cv(c.sales, c.store_id), 0)
    const clicks = sum(filtered, (c) => c.clicks)
    const impressions = sum(filtered, (c) => c.impressions)
    const orders = sum(filtered, (c) => c.orders_count)
    return {
      spend,
      sales,
      acos: sales ? (spend / sales) * 100 : 0,
      roas: spend ? sales / spend : 0,
      clicks,
      ctr: impressions ? (clicks / impressions) * 100 : 0,
      cvr: clicks ? (orders / clicks) * 100 : 0,
      cpc: clicks ? spend / clicks : 0,
      orders,
      active: filtered.filter((c) => c.status === 'active').length,
    }
  }, [filtered, storeMap, fx])

  const chartData = useMemo(
    () =>
      filtered
        .slice()
        .sort((a, b) => Number(b.sales) - Number(a.sales))
        .slice(0, 6)
        .map((c) => ({
          name: c.name.split('·')[1]?.trim() || c.name.slice(0, 10),
          value: convert(Number(c.sales), storeMap.get(c.store_id)?.currency ?? 'USD', 'USD', fx),
        })),
    [filtered, storeMap, fx],
  )

  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY, store_id: storeFilter || data?.stores[0]?.id || '' })
    setModalOpen(true)
  }

  function openEdit(c: Campaign) {
    setEditing(c)
    setForm({
      store_id: c.store_id,
      name: c.name,
      ad_type: c.ad_type,
      status: c.status,
      daily_budget: String(c.daily_budget),
      spend: String(c.spend),
      impressions: String(c.impressions),
      clicks: String(c.clicks),
      orders_count: String(c.orders_count),
      sales: String(c.sales),
      start_date: c.start_date,
      end_date: c.end_date ?? '',
      note: c.note ?? '',
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.store_id) return push('请选择店铺', 'error')
    if (!form.name.trim()) return push('请填写活动名称', 'error')
    setSaving(true)
    try {
      const store = storeMap.get(form.store_id)
      const payload = {
        store_id: form.store_id,
        name: form.name.trim(),
        platform: store?.platform ?? 'amazon',
        ad_type: form.ad_type,
        status: form.status,
        daily_budget: Number(form.daily_budget) || 0,
        spend: Number(form.spend) || 0,
        impressions: Math.round(Number(form.impressions) || 0),
        clicks: Math.round(Number(form.clicks) || 0),
        orders_count: Math.round(Number(form.orders_count) || 0),
        sales: Number(form.sales) || 0,
        start_date: form.start_date || today(),
        end_date: form.end_date || null,
        note: form.note.trim() || null,
      }
      if (editing) {
        await updateRow('campaigns', editing.id, payload)
        push('广告活动已更新')
      } else {
        await insertRow('campaigns', payload)
        push('广告活动已创建')
      }
      setModalOpen(false)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function toggleStatus(c: Campaign) {
    setToggling(c.id)
    try {
      await updateRow('campaigns', c.id, { status: c.status === 'active' ? 'paused' : 'active' })
      push(c.status === 'active' ? '已暂停该活动' : '已恢复投放')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setToggling(null)
    }
  }

  async function handleDelete() {
    if (!deleting) return
    setConfirmLoading(true)
    try {
      await deleteRow('campaigns', deleting.id)
      push('广告活动已删除')
      setDeleting(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirmLoading(false)
    }
  }

  const adTypeOptions = form.store_id && storeMap.get(form.store_id)?.platform === 'tiktok'
    ? ['GMV_MAX', 'VIDEO', 'LIVE', 'PSA']
    : ['SP', 'SB', 'SD']

  const headerActions = (
    <>
      <Link to="/expenses?source=ads" className="btn btn-sm btn-default">
        <Receipt className="w-3.5 h-3.5" /> 广告费用归集
      </Link>
      <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate} disabled={!data?.stores.length}>
        新建广告活动
      </Button>
    </>
  )

  return (
    <>
      {embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h2 className="text-[14px] font-semibold text-ink-900">广告投放</h2>
            <p className="text-[11px] text-ink-500">ACOS、ROAS、点击转化率一屏掌握</p>
          </div>
          <div className="flex items-center gap-2">{headerActions}</div>
        </div>
      ) : (
        <PageHeader
          title="广告投放"
          description="ACOS、ROAS、点击转化率一屏掌握，超目标的活动一眼看穿"
          actions={headerActions}
        />
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        {[
          { label: '广告花费', value: money(kpi.spend, 'USD', 0), sub: `${kpi.active} 个活动投放中`, icon: <Megaphone className="w-4 h-4" />, tone: 'bg-amber-50 text-amber-600' },
          { label: '广告销售额', value: money(kpi.sales, 'USD', 0), sub: `${num(kpi.orders)} 单`, icon: <Activity className="w-4 h-4" />, tone: 'bg-brand-50 text-brand-600' },
          { label: 'ACOS', value: pct(kpi.acos), sub: `ROAS ${kpi.roas.toFixed(2)}`, icon: <Target className="w-4 h-4" />, tone: kpi.acos <= 30 ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600' },
          { label: '点击转化率', value: pct(kpi.cvr), sub: `CPC ${money(kpi.cpc)} · CTR ${pct(kpi.ctr)}`, icon: <Activity className="w-4 h-4" />, tone: 'bg-violet-50 text-violet-600' },
        ].map((k) => (
          <div key={k.label} className="card p-4">
            <div className="flex items-start justify-between">
              <span className="text-[11px] text-ink-500">{k.label}</span>
              <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center', k.tone)}>{k.icon}</span>
            </div>
            <p className="num text-[20px] font-semibold text-ink-900 mt-1.5 leading-tight">{k.value}</p>
            <p className="text-[10.5px] text-ink-400 mt-1">{k.sub}</p>
          </div>
        ))}
      </div>

      {chartData.length > 0 && (
        <div className="card p-4 mb-3">
          <h3 className="text-[13px] font-semibold text-ink-900 mb-1">活动销售额 Top 6</h3>
          <SimpleBars data={chartData} height={190} />
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="搜索活动名称" className="w-full sm:w-56" />
          <Select
            className="w-full sm:w-40"
            value={storeFilter}
            onChange={(v) => { setStoreFilter(v); setPage(1) }}
            placeholder="全部店铺"
            options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            className="w-full sm:w-32"
            value={platformFilter}
            onChange={(v) => { setPlatformFilter(v); setPage(1) }}
            placeholder="全部平台"
            options={[
              { value: 'amazon', label: 'Amazon' },
              { value: 'tiktok', label: 'TikTok Shop' },
            ]}
          />
          <Select
            className="w-full sm:w-28"
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1) }}
            placeholder="全部状态"
            options={Object.entries(CAMPAIGN_STATUS).map(([value, v]) => ({ value, label: v.label }))}
          />
        </div>

        {error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : loading ? (
          <LoadingBlock rows={6} />
        ) : !data?.stores.length ? (
          <EmptyState icon={<Megaphone className="w-5 h-5" />} title="请先创建店铺" description="广告活动需要归属到店铺。" />
        ) : pageRows.length === 0 ? (
          <EmptyState
            icon={<Megaphone className="w-5 h-5" />}
            title={filtered.length ? '没有匹配的活动' : '还没有广告活动'}
            description="记录活动花费与产出，系统会自动算出 ACOS / ROAS / 转化率。"
            action={
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
                新建广告活动
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px]">
              <thead>
                <tr>
                  <th className="th">广告活动</th>
                  <th className="th">店铺 / 平台</th>
                  <th className="th">类型</th>
                  <th className="th text-right">花费</th>
                  <th className="th text-right">销售额</th>
                  <th className="th text-right">ACOS</th>
                  <th className="th text-right">ROAS</th>
                  <th className="th text-right">CTR</th>
                  <th className="th text-right">CVR</th>
                  <th className="th">状态</th>
                  <th className="th w-24" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((c) => {
                  const store = storeMap.get(c.store_id)
                  const acos = Number(c.sales) ? (Number(c.spend) / Number(c.sales)) * 100 : 0
                  const roas = Number(c.spend) ? Number(c.sales) / Number(c.spend) : 0
                  const ctr = Number(c.impressions) ? (Number(c.clicks) / Number(c.impressions)) * 100 : 0
                  const cvr = Number(c.clicks) ? (Number(c.orders_count) / Number(c.clicks)) * 100 : 0
                  const overTarget = store && acos > store.target_acos
                  const status = CAMPAIGN_STATUS[c.status]
                  return (
                    <tr key={c.id} className="hover:bg-ink-50/60 group">
                      <td className="td">
                        <p className="text-[12.5px] font-medium text-ink-800 truncate max-w-[220px]">{c.name}</p>
                        <p className="text-[10.5px] text-ink-400">
                          日预算 {money(c.daily_budget, store?.currency, 0)} · 起投 {c.start_date}
                        </p>
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              'w-4 h-4 rounded flex items-center justify-center text-[8px] font-bold text-white shrink-0',
                              c.platform === 'amazon' ? 'bg-amazon' : 'bg-tiktok',
                            )}
                          >
                            {c.platform === 'amazon' ? 'a' : 't'}
                          </span>
                          <span className="text-[11.5px] truncate max-w-[110px]">{store?.name ?? '—'}</span>
                        </div>
                      </td>
                      <td className="td">
                        <Badge tone={c.platform === 'amazon' ? 'amber' : 'violet'}>{AD_TYPES[c.ad_type] ?? c.ad_type}</Badge>
                      </td>
                      <td className="td text-right num">{money(c.spend, store?.currency, 0)}</td>
                      <td className="td text-right num font-medium">{money(c.sales, store?.currency, 0)}</td>
                      <td className="td text-right">
                        <span className={cn('num text-[12px] font-medium', overTarget ? 'text-rose-600' : 'text-emerald-600')}>
                          {pct(acos)}
                        </span>
                        {overTarget && <p className="text-[9.5px] text-rose-400">超目标 {pct(store.target_acos, 0)}</p>}
                      </td>
                      <td className="td text-right num">{roas.toFixed(2)}</td>
                      <td className="td text-right num text-ink-500">{pct(ctr, 2)}</td>
                      <td className="td text-right num text-ink-500">{pct(cvr, 2)}</td>
                      <td className="td">
                        <Badge tone={status?.tone ?? 'gray'} dot>
                          {status?.label ?? c.status}
                        </Badge>
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100 disabled:opacity-40"
                            onClick={() => toggleStatus(c)}
                            disabled={toggling === c.id}
                            title={c.status === 'active' ? '暂停' : '恢复'}
                          >
                            {c.status === 'active' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                          </button>
                          <button className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100" onClick={() => openEdit(c)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <Link to={`/expenses?source=ads&source_id=${c.id}`} className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-brand-50" title="记一笔费用并归集到该活动">
                            <Receipt className="w-3.5 h-3.5" />
                          </Link>
                          <button data-perm="delete" className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50" onClick={() => setDeleting(c)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > PAGE_SIZE && <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} />}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? '编辑广告活动' : '新建广告活动'}
        width="max-w-2xl"
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>取消</Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="店铺" required>
            <Select
              value={form.store_id}
              onChange={(v) => setForm({ ...form, store_id: v })}
              placeholder="选择店铺"
              options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
          <Field label="活动名称" required>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：SP 自动-广泛匹配" />
          </Field>
          <Field label="广告类型">
            <Select value={form.ad_type} onChange={(v) => setForm({ ...form, ad_type: v })} options={adTypeOptions.map((t) => ({ value: t, label: AD_TYPES[t] ?? t }))} />
          </Field>
          <Field label="投放状态">
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v as Campaign['status'] })}
              options={Object.entries(CAMPAIGN_STATUS).map(([value, v]) => ({ value, label: v.label }))}
            />
          </Field>
          <Field label="日预算">
            <input className="input num" type="number" step="0.01" value={form.daily_budget} onChange={(e) => setForm({ ...form, daily_budget: e.target.value })} />
          </Field>
          <Field label="累计花费">
            <input className="input num" type="number" step="0.01" value={form.spend} onChange={(e) => setForm({ ...form, spend: e.target.value })} />
          </Field>
          <Field label="曝光量">
            <input className="input num" type="number" value={form.impressions} onChange={(e) => setForm({ ...form, impressions: e.target.value })} />
          </Field>
          <Field label="点击量">
            <input className="input num" type="number" value={form.clicks} onChange={(e) => setForm({ ...form, clicks: e.target.value })} />
          </Field>
          <Field label="广告订单数">
            <input className="input num" type="number" value={form.orders_count} onChange={(e) => setForm({ ...form, orders_count: e.target.value })} />
          </Field>
          <Field label="广告销售额">
            <input className="input num" type="number" step="0.01" value={form.sales} onChange={(e) => setForm({ ...form, sales: e.target.value })} />
          </Field>
          <Field label="开始日期">
            <input type="date" className="input" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
          </Field>
          <Field label="结束日期">
            <input type="date" className="input" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
          </Field>
          <Field label="备注" className="sm:col-span-2">
            <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="选填：投放策略、否定词计划等" />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={confirmLoading}
        title="删除广告活动"
        message={`确定删除「${deleting?.name}」吗？`}
      />
    </>
  )
}
