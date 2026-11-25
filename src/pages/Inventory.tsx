import { useMemo, useState } from 'react'
import { AlertTriangle, Boxes, ClipboardList, PackageCheck, Pencil, Plus, Trash2, Truck } from 'lucide-react'
import { deleteRow, fetchRows, insertRow, insertRows, updateRow } from '../lib/db'
import type { InventoryItem, Product, Store } from '../lib/types'
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
import { cn, daysAgo, num, today } from '../lib/utils'

const PAGE_SIZE = 20

const WAREHOUSES = ['FBA-US', 'FBA-UK', 'FBA-DE', 'FBA-JP', 'US-3PL', 'UK-3PL', '国内仓']

type Level = 'out' | 'urgent' | 'low' | 'healthy' | 'over'

const LEVEL_META: Record<Level, { label: string; tone: 'red' | 'amber' | 'green' | 'gray' | 'blue'; bar: string }> = {
  out: { label: '已断货', tone: 'red', bar: 'bg-rose-500' },
  urgent: { label: '紧急补货', tone: 'red', bar: 'bg-orange-500' },
  low: { label: '偏低', tone: 'amber', bar: 'bg-amber-400' },
  healthy: { label: '健康', tone: 'green', bar: 'bg-emerald-500' },
  over: { label: '滞销', tone: 'gray', bar: 'bg-slate-400' },
}

interface FormState {
  store_id: string
  product_id: string
  sku: string
  title: string
  warehouse: string
  available_qty: string
  inbound_qty: string
  reserved_qty: string
  safety_stock: string
  avg_daily_sales: string
}

const EMPTY: FormState = {
  store_id: '',
  product_id: '',
  sku: '',
  title: '',
  warehouse: 'FBA-US',
  available_qty: '0',
  inbound_qty: '0',
  reserved_qty: '0',
  safety_stock: '60',
  avg_daily_sales: '1',
}

function computeLevel(item: InventoryItem): { level: Level; days: number; suggest: number } {
  const daily = Number(item.avg_daily_sales)
  const days = daily > 0 ? item.available_qty / daily : 999
  let level: Level = 'healthy'
  if (item.available_qty <= 0) level = 'out'
  else if (days < 14) level = 'urgent'
  else if (days < 30) level = 'low'
  else if (days > 150 && item.available_qty > item.safety_stock * 4) level = 'over'
  const target = daily * 45 + item.safety_stock
  const suggest = Math.max(0, Math.ceil(target - item.available_qty - item.inbound_qty))
  return { level, days, suggest }
}

export default function Inventory() {
  const { push } = useToast()
  const [search, setSearch] = useState('')
  const [storeFilter, setStoreFilter] = useState('')
  const [levelFilter, setLevelFilter] = useState('')
  const [page, setPage] = useState(1)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<InventoryItem | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<InventoryItem | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [creatingTasks, setCreatingTasks] = useState(false)

  const { data, loading, error, reload } = useAsync(async () => {
    const [inventory, stores, products] = await Promise.all([
      fetchRows<InventoryItem>('inventory', { order: { column: 'updated_at', ascending: false } }),
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
      fetchRows<Product>('products'),
    ])
    return { inventory, stores, products }
  }, [])

  const storeMap = useMemo(() => new Map((data?.stores ?? []).map((s) => [s.id, s])), [data])
  const productMap = useMemo(() => new Map((data?.products ?? []).map((p) => [p.id, p])), [data])

  const enriched = useMemo(
    () => (data?.inventory ?? []).map((item) => ({ ...item, ...computeLevel(item) })),
    [data],
  )

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return enriched.filter((i) => {
      if (storeFilter && i.store_id !== storeFilter) return false
      if (levelFilter && i.level !== levelFilter) return false
      if (!kw) return true
      return [i.sku, i.title ?? '', i.warehouse].some((v) => v.toLowerCase().includes(kw))
    })
  }, [enriched, search, storeFilter, levelFilter])

  const kpi = useMemo(() => {
    const totalQty = enriched.reduce((s, i) => s + i.available_qty, 0)
    const inbound = enriched.reduce((s, i) => s + i.inbound_qty, 0)
    const out = enriched.filter((i) => i.level === 'out').length
    const risky = enriched.filter((i) => i.level === 'urgent' || i.level === 'low').length
    return { totalQty, inbound, out, risky, skus: enriched.length }
  }, [enriched])

  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const formProducts = useMemo(
    () => (data?.products ?? []).filter((p) => !form.store_id || p.store_id === form.store_id),
    [data, form.store_id],
  )

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY, store_id: storeFilter || data?.stores[0]?.id || '' })
    setModalOpen(true)
  }

  function openEdit(item: InventoryItem) {
    setEditing(item)
    setForm({
      store_id: item.store_id,
      product_id: item.product_id ?? '',
      sku: item.sku,
      title: item.title ?? '',
      warehouse: item.warehouse,
      available_qty: String(item.available_qty),
      inbound_qty: String(item.inbound_qty),
      reserved_qty: String(item.reserved_qty),
      safety_stock: String(item.safety_stock),
      avg_daily_sales: String(item.avg_daily_sales),
    })
    setModalOpen(true)
  }

  function pickProduct(productId: string) {
    const product = productMap.get(productId)
    if (!product) {
      setForm((f) => ({ ...f, product_id: '', sku: '', title: '' }))
      return
    }
    setForm((f) => ({
      ...f,
      product_id: productId,
      store_id: product.store_id,
      sku: product.sku,
      title: product.title,
    }))
  }

  async function handleSave() {
    if (!form.store_id) return push('请选择店铺', 'error')
    if (!form.sku.trim()) return push('请填写 SKU', 'error')
    setSaving(true)
    try {
      const payload = {
        store_id: form.store_id,
        product_id: form.product_id || null,
        sku: form.sku.trim(),
        title: form.title.trim() || null,
        warehouse: form.warehouse,
        available_qty: Math.round(Number(form.available_qty) || 0),
        inbound_qty: Math.round(Number(form.inbound_qty) || 0),
        reserved_qty: Math.round(Number(form.reserved_qty) || 0),
        safety_stock: Math.round(Number(form.safety_stock) || 0),
        avg_daily_sales: Number(form.avg_daily_sales) || 0,
        updated_at: new Date().toISOString(),
      }
      if (editing) {
        await updateRow('inventory', editing.id, payload)
        push('库存已更新')
      } else {
        await insertRow('inventory', payload)
        push('库存记录已创建')
      }
      setModalOpen(false)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate|unique/i.test(msg) ? '该店铺 + SKU + 仓库已有库存记录' : msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleting) return
    setConfirmLoading(true)
    try {
      await deleteRow('inventory', deleting.id)
      push('库存记录已删除')
      setDeleting(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirmLoading(false)
    }
  }

  async function createReplenishTasks() {
    const targets = enriched.filter((i) => (i.level === 'out' || i.level === 'urgent' || i.level === 'low') && i.suggest > 0)
    if (!targets.length) {
      push('当前没有需要补货的 SKU', 'info')
      return
    }
    setCreatingTasks(true)
    try {
      await insertRows(
        'tasks',
        targets.map((i) => ({
          store_id: i.store_id,
          title: `补货：${i.sku} × ${i.suggest} 件（${i.warehouse}）`,
          description: `当前可售 ${i.available_qty} 件，日均销量 ${i.avg_daily_sales}，在途 ${i.inbound_qty} 件，安全库存 ${i.safety_stock}。按 45 天备货测算建议补 ${i.suggest} 件。`,
          module: 'inventory',
          priority: i.level === 'out' || i.level === 'urgent' ? 'high' : 'medium',
          status: 'todo',
          due_date: daysAgo(-3),
        })),
      )
      push(`已生成 ${targets.length} 条补货任务，可在任务看板查看`)
    } catch (err) {
      push(err instanceof Error ? err.message : '生成失败', 'error')
    } finally {
      setCreatingTasks(false)
    }
  }

  return (
    <>
      <PageHeader
        title="库存管理"
        description="可售天数自动测算，库龄与在途一目了然"
        actions={
          <>
            <Button icon={<ClipboardList className="w-3.5 h-3.5" />} onClick={createReplenishTasks} loading={creatingTasks} disabled={!enriched.length}>
              生成补货任务
            </Button>
            <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate} disabled={!data?.stores.length}>
              新增库存
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        {[
          { label: '可用库存总量', value: num(kpi.totalQty), icon: <Boxes className="w-4 h-4" />, tone: 'bg-brand-50 text-brand-600' },
          { label: '在途数量', value: num(kpi.inbound), icon: <Truck className="w-4 h-4" />, tone: 'bg-blue-50 text-blue-600' },
          { label: '断货 SKU', value: num(kpi.out), icon: <AlertTriangle className="w-4 h-4" />, tone: 'bg-rose-50 text-rose-600' },
          { label: '库存偏低 SKU', value: num(kpi.risky), icon: <PackageCheck className="w-4 h-4" />, tone: 'bg-amber-50 text-amber-600' },
        ].map((k) => (
          <div key={k.label} className="card px-4 py-3 flex items-center gap-3">
            <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', k.tone)}>{k.icon}</span>
            <div>
              <p className="text-[11px] text-ink-500">{k.label}</p>
              <p className="num text-[17px] font-semibold text-ink-900 leading-tight">{k.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="SKU / 商品 / 仓库" className="w-full sm:w-60" />
          <Select
            className="w-full sm:w-40"
            value={storeFilter}
            onChange={(v) => { setStoreFilter(v); setPage(1) }}
            placeholder="全部店铺"
            options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            className="w-full sm:w-32"
            value={levelFilter}
            onChange={(v) => { setLevelFilter(v); setPage(1) }}
            placeholder="全部状态"
            options={Object.entries(LEVEL_META).map(([value, v]) => ({ value, label: v.label }))}
          />
          <span className="ml-auto text-[11.5px] text-ink-400">
            共 <span className="num text-ink-700 font-medium">{num(filtered.length)}</span> 条库存记录
          </span>
        </div>

        {error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : loading ? (
          <LoadingBlock rows={7} />
        ) : !data?.stores.length ? (
          <EmptyState icon={<Boxes className="w-5 h-5" />} title="请先创建店铺" description="库存记录需要归属到店铺与仓库。" />
        ) : pageRows.length === 0 ? (
          <EmptyState
            icon={<Boxes className="w-5 h-5" />}
            title={enriched.length ? '没有匹配的库存记录' : '还没有库存数据'}
            description={enriched.length ? '换个筛选条件试试' : '按 SKU + 仓库维度录入库存，系统会自动计算可售天数与补货建议。'}
            action={
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
                新增库存
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px]">
              <thead>
                <tr>
                  <th className="th">SKU / 商品</th>
                  <th className="th">店铺 · 仓库</th>
                  <th className="th text-right">可用</th>
                  <th className="th text-right">在途</th>
                  <th className="th text-right">预留</th>
                  <th className="th text-right">日均销量</th>
                  <th className="th w-[170px]">可售天数</th>
                  <th className="th text-right">建议补货</th>
                  <th className="th">状态</th>
                  <th className="th w-16" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((i) => {
                  const store = storeMap.get(i.store_id)
                  const meta = LEVEL_META[i.level]
                  const barWidth = Math.min(100, (i.days / 60) * 100)
                  return (
                    <tr key={i.id} className="hover:bg-ink-50/60 group">
                      <td className="td">
                        <p className="text-[12.5px] font-medium text-ink-800 font-mono">{i.sku}</p>
                        <p className="text-[10.5px] text-ink-400 truncate max-w-[230px]">{i.title ?? '—'}</p>
                      </td>
                      <td className="td">
                        <p className="text-[11.5px] text-ink-600 truncate max-w-[130px]">{store?.name ?? '—'}</p>
                        <p className="text-[10.5px] text-ink-400">{i.warehouse}</p>
                      </td>
                      <td className="td text-right num font-medium">{num(i.available_qty)}</td>
                      <td className="td text-right num text-ink-500">{num(i.inbound_qty)}</td>
                      <td className="td text-right num text-ink-400">{num(i.reserved_qty)}</td>
                      <td className="td text-right num text-ink-500">{num(i.avg_daily_sales, 1)}</td>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                            <div className={cn('h-full rounded-full', meta.bar)} style={{ width: `${barWidth}%` }} />
                          </div>
                          <span className={cn('num text-[11.5px] w-14 text-right', i.days < 14 ? 'text-rose-600 font-medium' : 'text-ink-600')}>
                            {Number(i.avg_daily_sales) <= 0 ? '—' : i.days > 999 ? '999+ 天' : `${Math.floor(i.days)} 天`}
                          </span>
                        </div>
                      </td>
                      <td className="td text-right num text-ink-700">{i.suggest > 0 ? num(i.suggest) : '—'}</td>
                      <td className="td">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100" onClick={() => openEdit(i)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button data-perm="delete" className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50" onClick={() => setDeleting(i)}>
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
        title={editing ? '编辑库存' : '新增库存'}
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
              onChange={(v) => setForm({ ...form, store_id: v, product_id: '', sku: '', title: '' })}
              placeholder="选择店铺"
              options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
          <Field label="关联商品">
            <Select
              value={form.product_id}
              onChange={pickProduct}
              placeholder="不关联，手动填写 SKU"
              options={formProducts.map((p) => ({ value: p.id, label: `${p.sku} · ${p.title}` }))}
            />
          </Field>
          <Field label="SKU" required>
            <input className="input font-mono" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
          </Field>
          <Field label="仓库">
            <Select value={form.warehouse} onChange={(v) => setForm({ ...form, warehouse: v })} options={WAREHOUSES.map((w) => ({ value: w, label: w }))} />
          </Field>
          <Field label="可用库存">
            <input className="input num" type="number" value={form.available_qty} onChange={(e) => setForm({ ...form, available_qty: e.target.value })} />
          </Field>
          <Field label="在途数量">
            <input className="input num" type="number" value={form.inbound_qty} onChange={(e) => setForm({ ...form, inbound_qty: e.target.value })} />
          </Field>
          <Field label="预留 / 待发">
            <input className="input num" type="number" value={form.reserved_qty} onChange={(e) => setForm({ ...form, reserved_qty: e.target.value })} />
          </Field>
          <Field label="安全库存">
            <input className="input num" type="number" value={form.safety_stock} onChange={(e) => setForm({ ...form, safety_stock: e.target.value })} />
          </Field>
          <Field label="日均销量" hint="用于测算可售天数，可从订单数据估算" className="sm:col-span-2">
            <input className="input num" type="number" step="0.1" value={form.avg_daily_sales} onChange={(e) => setForm({ ...form, avg_daily_sales: e.target.value })} />
          </Field>
          <div className="sm:col-span-2 rounded-lg bg-ink-50 border border-ink-100 px-3 py-2 text-[11.5px] text-ink-500">
            更新日期将记录为 {today()}。可售天数 = 可用库存 ÷ 日均销量；建议补货量按 45 天备货 + 安全库存测算。
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={confirmLoading}
        title="删除库存记录"
        message={`确定删除 ${deleting?.sku} 在 ${deleting?.warehouse} 的库存记录吗？`}
      />
    </>
  )
}
