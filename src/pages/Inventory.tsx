import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Boxes,
  ClipboardList,
  PackageCheck,
  Pencil,
  Plus,
  ShoppingCart,
  Trash2,
  Truck,
} from 'lucide-react'
import dayjs from 'dayjs'
import { deleteRow, fetchRows, insertRow, insertRows, updateRow } from '../lib/db'
import { useAuth } from '../context/AuthContext'
import { MOVE_META, createPoFromShortage, fetchShortagePlan, receiveStockTransfer } from '../lib/flow'
import type { InventoryItem, Product, ShortageRow, StockMovement, StockTransfer, Store, Supplier } from '../lib/types'
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
  Segmented,
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

  // 视图：库存盘点 / 出入库流水 / 补货建议
  const [view, setView] = useState<'stock' | 'moves' | 'transfers' | 'replenish'>('stock')
  const [moveSearch, setMoveSearch] = useState('')
  const [moveType, setMoveType] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [poSupplier, setPoSupplier] = useState('')
  const [poCreating, setPoCreating] = useState(false)
  const [receiving, setReceiving] = useState<StockTransfer | null>(null)
  const [receiveQty, setReceiveQty] = useState('')
  const [receiveNote, setReceiveNote] = useState('')
  const [receiveBusy, setReceiveBusy] = useState(false)

  const { can } = useAuth()
  const canBuy = can('purchase.edit')
  const canStock = can('inventory.edit')

  const { data, loading, error, reload } = useAsync(async () => {
    const [inventory, stores, products, movements, transfers, shortage, suppliers] = await Promise.all([
      fetchRows<InventoryItem>('inventory', { order: { column: 'updated_at', ascending: false } }),
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
      fetchRows<Product>('products'),
      // 流水是库存变动的底账：谁在什么时候、因为哪张单子、动了多少件
      fetchRows<StockMovement>('stock_movements', {
        order: { column: 'created_at', ascending: false },
        limit: 500,
      }).catch(() => [] as StockMovement[]),
      fetchRows<StockTransfer>('stock_transfers', {
        order: { column: 'created_at', ascending: false },
        limit: 300,
      }).catch(() => [] as StockTransfer[]),
      fetchShortagePlan(null).catch(() => [] as ShortageRow[]),
      fetchRows<Supplier>('suppliers', { filters: [['status', 'eq', 'active']] }).catch(() => [] as Supplier[]),
    ])
    return { inventory, stores, products, movements, transfers, shortage, suppliers }
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
      const nextQty = Math.round(Number(form.available_qty) || 0)
      const cost = productMap.get(form.product_id)?.cost_price ?? 0

      if (editing) {
        const delta = nextQty - Number(editing.available_qty)
        await updateRow('inventory', editing.id, payload)
        // 手工改数量必须留痕，否则流水和库存对不上就再也查不清了
        if (delta !== 0) {
          await insertRow('stock_movements', {
            store_id: payload.store_id,
            product_id: payload.product_id,
            sku: payload.sku,
            title: payload.title,
            warehouse: payload.warehouse,
            move_type: 'adjust',
            qty: delta,
            unit_cost: cost,
            ref_type: 'manual',
            note: '手工盘点调整',
          }).catch(() => undefined)
        }
        push(delta === 0 ? '库存已更新' : `库存已更新，差额 ${delta > 0 ? '+' : ''}${delta} 件已记入流水`)
      } else {
        await insertRow('inventory', payload)
        if (nextQty !== 0) {
          await insertRow('stock_movements', {
            store_id: payload.store_id,
            product_id: payload.product_id,
            sku: payload.sku,
            title: payload.title,
            warehouse: payload.warehouse,
            move_type: 'in',
            qty: nextQty,
            unit_cost: cost,
            ref_type: 'manual',
            note: '期初库存录入',
          }).catch(() => undefined)
        }
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

  /* ---------------- 流水与补货 ---------------- */

  const moveRows = useMemo(() => {
    const kw = moveSearch.trim().toLowerCase()
    return (data?.movements ?? []).filter((m) => {
      if (moveType && m.move_type !== moveType) return false
      if (!kw) return true
      return [m.sku, m.title ?? '', m.ref_no ?? '', m.warehouse].some((v) => v.toLowerCase().includes(kw))
    })
  }, [data, moveSearch, moveType])

  const shortageRows = useMemo(() => {
    const list = data?.shortage ?? []
    return storeFilter ? list.filter((r) => r.store_id === storeFilter) : list
  }, [data, storeFilter])

  const pickedLines = useMemo(
    () => shortageRows.filter((r) => picked.includes(r.sku)),
    [shortageRows, picked],
  )

  async function createPoFromPicked() {
    if (!pickedLines.length) {
      push('请先勾选要采购的 SKU', 'error')
      return
    }
    setPoCreating(true)
    try {
      const res = await createPoFromShortage(
        pickedLines.map((r) => {
          const product = r.product_id ? productMap.get(r.product_id) : undefined
          return {
            sku: r.sku,
            title: r.title,
            product_id: r.product_id,
            qty: r.suggest_qty,
            unit_cost: product?.cost_price ?? 0,
          }
        }),
        poSupplier || null,
        storeFilter || null,
        null,
      )
      push(`已生成采购单 ${res.po_no}（${res.lines} 个 SKU），到「采购管理」付款并入库`)
      setPicked([])
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '生成采购单失败', 'error')
    } finally {
      setPoCreating(false)
    }
  }

  function openReceive(t: StockTransfer) {
    setReceiving(t)
    setReceiveQty(String(Math.max(1, t.qty - t.received_qty)))
    setReceiveNote('')
  }

  async function handleReceive() {
    if (!receiving) return
    const qty = Math.max(1, Math.round(Number(receiveQty) || 0))
    if (qty > receiving.qty - receiving.received_qty)
      return push(`最多还能收 ${num(receiving.qty - receiving.received_qty)} 件`, 'error')
    setReceiveBusy(true)
    try {
      const res = await receiveStockTransfer(receiving.id, qty, receiveNote.trim() || undefined)
      if (!res?.ok && !res?.already) throw new Error(res?.reason ?? '到货确认失败')
      push(`已确认到货 ${num(res.received ?? qty)} 件，目标仓库存已更新`)
      setReceiving(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '到货确认失败', 'error')
    } finally {
      setReceiveBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="库存管理"
        description="可售天数自动测算；每笔出入库都留流水，缺货可直接转成采购单"
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

      <div className="mb-3">
        <Segmented
          value={view}
          onChange={(v) => setView(v as typeof view)}
          size="sm"
          options={[
            { value: 'stock', label: '库存盘点' },
            { value: 'moves', label: `出入库流水 ${data?.movements?.length ?? 0}` },
            {
              value: 'transfers',
              label: `在途调拨 ${(data?.transfers ?? []).filter((t) => t.status !== 'received' && t.status !== 'cancelled').length}`,
            },
            { value: 'replenish', label: `补货建议 ${shortageRows.length}` },
          ]}
        />
      </div>

      {view === 'stock' && (
        <>
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
        </>
      )}

      {view === 'moves' && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
            <SearchInput
              value={moveSearch}
              onChange={setMoveSearch}
              placeholder="SKU / 单号 / 仓库"
              className="w-full sm:w-60"
            />
            <Select
              className="w-full sm:w-32"
              value={moveType}
              onChange={setMoveType}
              placeholder="全部类型"
              options={Object.entries(MOVE_META).map(([value, v]) => ({ value, label: v.label }))}
            />
            <span className="ml-auto text-[11.5px] text-ink-400">
              最近 <span className="num text-ink-700 font-medium">{num(moveRows.length)}</span> 条变动
            </span>
          </div>

          {loading ? (
            <LoadingBlock rows={8} />
          ) : !moveRows.length ? (
            <EmptyState
              icon={<Boxes className="w-5 h-5" />}
              title="还没有出入库记录"
              description="订单出库、采购入库、手工盘点都会自动写一条流水，这里能看到每件货的来龙去脉。"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px]">
                <thead>
                  <tr>
                    <th className="th w-28">时间</th>
                    <th className="th w-20">类型</th>
                    <th className="th">SKU / 商品</th>
                    <th className="th">仓库</th>
                    <th className="th text-right">数量</th>
                    <th className="th text-right">单价成本</th>
                    <th className="th">来源单据</th>
                  </tr>
                </thead>
                <tbody>
                  {moveRows.slice(0, 300).map((m) => {
                    const meta = MOVE_META[m.move_type] ?? MOVE_META.adjust
                    const store = m.store_id ? storeMap.get(m.store_id) : null
                    const inbound = Number(m.qty) > 0
                    return (
                      <tr key={m.id} className="hover:bg-ink-50/60">
                        <td className="td">
                          <p className="num text-[11.5px] text-ink-600">{dayjs(m.created_at).format('MM-DD HH:mm')}</p>
                        </td>
                        <td className="td">
                          <span className={cn('text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap', meta.cls)}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="td">
                          <p className="text-[12px] font-mono text-ink-800 truncate max-w-[200px]">{m.sku}</p>
                          <p className="text-[10.5px] text-ink-400 truncate max-w-[220px]">{m.title ?? '—'}</p>
                        </td>
                        <td className="td">
                          <p className="text-[11.5px] text-ink-600">{m.warehouse}</p>
                          <p className="text-[10.5px] text-ink-400 truncate max-w-[110px]">{store?.name ?? '国内仓'}</p>
                        </td>
                        <td className="td text-right">
                          <span
                            className={cn(
                              'num text-[12.5px] font-semibold inline-flex items-center gap-0.5',
                              inbound ? 'text-emerald-600' : 'text-rose-600',
                            )}
                          >
                            {inbound ? <ArrowDownLeft className="w-3 h-3" /> : <ArrowUpRight className="w-3 h-3" />}
                            {inbound ? '+' : ''}
                            {num(m.qty)}
                          </span>
                        </td>
                        <td className="td text-right num text-[11.5px] text-ink-500">
                          {Number(m.unit_cost) > 0 ? Number(m.unit_cost).toFixed(2) : '—'}
                        </td>
                        <td className="td">
                          <p className="text-[11.5px] text-ink-600 font-mono truncate max-w-[160px]">{m.ref_no ?? '—'}</p>
                          <p className="text-[10.5px] text-ink-400">{m.note ?? ''}</p>
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

      {view === 'transfers' && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
            <div className="flex-1 min-w-[220px]">
              <p className="text-[12px] font-medium text-ink-800">公司国内仓 → 海外仓调拨（头程）</p>
              <p className="text-[11px] text-ink-400 mt-0.5">
                创建时即从来源仓扣货；确认到货后写入目标仓，订单履约中心会显示「调拨在途」
              </p>
            </div>
          </div>
          {(data?.transfers ?? []).length === 0 ? (
            <EmptyState
              icon={<Truck className="w-5 h-5" />}
              title="暂无调拨单"
              description="在订单列表点「履约中心」，把国内仓库存调到海外仓即可跟踪在途。"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="bg-ink-50/70 text-ink-500">
                  <tr>
                    <th className="th text-left">调拨单</th>
                    <th className="th text-left">商品</th>
                    <th className="th text-left">路线</th>
                    <th className="th text-right">数量</th>
                    <th className="th text-left">状态</th>
                    <th className="th text-left">创建时间</th>
                    <th className="th text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.transfers ?? []).map((t) => (
                    <tr key={t.id} className="border-t border-ink-100 hover:bg-ink-50/60">
                      <td className="td font-mono text-ink-700">{t.transfer_no}</td>
                      <td className="td">
                        <p className="text-ink-700 truncate max-w-[180px]">{t.title ?? t.sku}</p>
                        <p className="text-[10.5px] text-ink-400 font-mono">{t.sku}</p>
                      </td>
                      <td className="td text-ink-600">
                        {t.from_warehouse} → {t.to_warehouse}
                      </td>
                      <td className="td text-right num">{num(t.qty)}（已收 {num(t.received_qty)}）</td>
                      <td className="td">
                        <Badge
                          tone={
                            t.status === 'received' ? 'green' : t.status === 'cancelled' ? 'gray' : 'amber'
                          }
                        >
                          {{ in_transit: '在途', partial: '部分到货', received: '已到货', cancelled: '已取消' }[t.status] ?? t.status}
                        </Badge>
                      </td>
                      <td className="td text-ink-500 num">{dayjs(t.created_at).format('MM-DD HH:mm')}</td>
                      <td className="td text-right">
                        {canStock && t.status !== 'received' && t.status !== 'cancelled' && (
                          <Button size="sm" icon={<PackageCheck className="w-3.5 h-3.5" />} onClick={() => openReceive(t)}>
                            确认到货
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {view === 'replenish' && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
            <div className="flex-1 min-w-[200px]">
              <p className="text-[12px] font-medium text-ink-800">按近 30 天销量与供应商交期测算的补货清单</p>
              <p className="text-[11px] text-ink-400 mt-0.5">
                建议量 = 日均销量 × 交期 + 安全库存 − 可用 − 在途；勾选后一键生成草稿采购单
              </p>
            </div>
            <Select
              className="w-full sm:w-40"
              value={poSupplier}
              onChange={setPoSupplier}
              placeholder="选择供应商"
              options={(data?.suppliers ?? []).map((x) => ({ value: x.id, label: x.name }))}
            />
            {canBuy && (
              <Button
                variant="primary"
                icon={<ShoppingCart className="w-3.5 h-3.5" />}
                onClick={createPoFromPicked}
                loading={poCreating}
                disabled={!pickedLines.length}
              >
                生成采购单 {pickedLines.length ? `(${pickedLines.length})` : ''}
              </Button>
            )}
          </div>

          {loading ? (
            <LoadingBlock rows={8} />
          ) : !shortageRows.length ? (
            <EmptyState
              icon={<PackageCheck className="w-5 h-5" />}
              title="暂时不需要补货"
              description="当前所有 SKU 的可用库存 + 在途都能覆盖交期内的销量。"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr>
                    <th className="th w-10">
                      <input
                        type="checkbox"
                        className="w-3.5 h-3.5 accent-brand-600"
                        checked={picked.length === shortageRows.length && shortageRows.length > 0}
                        onChange={(e) => setPicked(e.target.checked ? shortageRows.map((r) => r.sku) : [])}
                      />
                    </th>
                    <th className="th">SKU / 商品</th>
                    <th className="th">店铺</th>
                    <th className="th text-right">可用</th>
                    <th className="th text-right">在途</th>
                    <th className="th text-right">日均</th>
                    <th className="th text-right">可售天数</th>
                    <th className="th text-right">建议补货</th>
                    <th className="th text-right">交期</th>
                  </tr>
                </thead>
                <tbody>
                  {shortageRows.map((r) => {
                    const store = r.store_id ? storeMap.get(r.store_id) : null
                    const on = picked.includes(r.sku)
                    const danger = r.days_cover !== null && r.days_cover < 15
                    return (
                      <tr
                        key={`${r.sku}-${r.store_id ?? 'na'}`}
                        className={cn('cursor-pointer', on ? 'bg-brand-50/50' : 'hover:bg-ink-50/60')}
                        onClick={() =>
                          setPicked((prev) => (prev.includes(r.sku) ? prev.filter((x) => x !== r.sku) : [...prev, r.sku]))
                        }
                      >
                        <td className="td" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="w-3.5 h-3.5 accent-brand-600"
                            checked={on}
                            onChange={(e) =>
                              setPicked((prev) => (e.target.checked ? [...prev, r.sku] : prev.filter((x) => x !== r.sku)))
                            }
                          />
                        </td>
                        <td className="td">
                          <p className="text-[12px] font-mono text-ink-800 truncate max-w-[180px]">{r.sku}</p>
                          <p className="text-[10.5px] text-ink-400 truncate max-w-[220px]">{r.title ?? '—'}</p>
                        </td>
                        <td className="td text-[11.5px] text-ink-600">{store?.name ?? '—'}</td>
                        <td className="td text-right num text-[12px] text-ink-700">{num(r.available)}</td>
                        <td className="td text-right num text-[12px] text-ink-500">{num(r.inbound)}</td>
                        <td className="td text-right num text-[12px] text-ink-500">{Number(r.avg_daily).toFixed(1)}</td>
                        <td className="td text-right">
                          <span className={cn('num text-[12px]', danger ? 'text-rose-600 font-medium' : 'text-ink-500')}>
                            {r.days_cover === null ? '—' : `${r.days_cover} 天`}
                          </span>
                        </td>
                        <td className="td text-right num text-[12.5px] font-semibold text-brand-700">
                          {num(r.suggest_qty)}
                        </td>
                        <td className="td text-right num text-[11.5px] text-ink-500">{r.lead_time} 天</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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

      {/* 调拨到货确认 */}
      <Modal
        open={!!receiving}
        onClose={() => setReceiving(null)}
        title="确认调拨到货"
        description={receiving ? `${receiving.transfer_no} · ${receiving.from_warehouse} → ${receiving.to_warehouse}` : undefined}
        width="max-w-md"
        footer={
          <>
            <Button onClick={() => setReceiving(null)}>取消</Button>
            <Button variant="primary" loading={receiveBusy} onClick={handleReceive}>
              确认到货
            </Button>
          </>
        }
      >
        {receiving && (
          <div className="space-y-3">
            <div className="rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2 text-[11.5px] text-ink-600">
              {receiving.sku} · 共 {num(receiving.qty)} 件，已收 {num(receiving.received_qty)} 件，
              还可收 <b className="text-ink-900">{num(receiving.qty - receiving.received_qty)}</b> 件
            </div>
            <Field label="本次到货数量">
              <input
                className="input num"
                type="number"
                value={receiveQty}
                onChange={(e) => setReceiveQty(e.target.value)}
              />
            </Field>
            <Field label="备注">
              <input
                className="input"
                value={receiveNote}
                placeholder="如：首批到货，尾款待付"
                onChange={(e) => setReceiveNote(e.target.value)}
              />
            </Field>
            <p className="text-[10.5px] text-ink-400">
              确认后写入「transfer_in」库存流水，目标仓库存立即增加；订单履约中心可继续出库。
            </p>
          </div>
        )}
      </Modal>
    </>
  )
}
