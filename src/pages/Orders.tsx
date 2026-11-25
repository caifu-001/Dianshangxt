import { useMemo, useState } from 'react'
import {
  ArrowRight,
  Download,
  GitBranch,
  Pencil,
  Plus,
  Receipt,
  ShoppingCart,
  Trash2,
  Undo2,
  Upload,
  PackageCheck,
} from 'lucide-react'
import dayjs from 'dayjs'
import { callRpc, deleteRow, fetchRows, insertRow, insertRows, updateRow } from '../lib/db'
import { ORDER_STATUS } from '../lib/constants'
import { useAuth } from '../context/AuthContext'
import {
  STOCK_STATE_META,
  TRACE_META,
  createPoFromShortage,
  fetchOrderTrace,
  fulfillOrder,
  restoreOrderStock,
} from '../lib/flow'
import type { Order, Product, Store, Supplier, TraceEvent } from '../lib/types'
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
import { ImportModal } from '../components/ImportModal'
import type { ImportField } from '../components/ImportModal'
import { cn, daysAgo, downloadTextFile, money, num, pct, toCsv, today } from '../lib/utils'
import { convert, useFx } from '../lib/fx'

const PAGE_SIZE = 25

interface FormState {
  store_id: string
  order_no: string
  order_date: string
  product_id: string
  sku: string
  title: string
  customer_name: string
  country: string
  quantity: string
  unit_price: string
  cost_amount: string
  platform_fee: string
  fba_fee: string
  shipping_fee: string
  ad_cost: string
  refund_amount: string
  other_fee: string
  status: Order['status']
  note: string
  owner_id: string
}

const EMPTY: FormState = {
  store_id: '',
  order_no: '',
  order_date: today(),
  product_id: '',
  sku: '',
  title: '',
  customer_name: '',
  country: '',
  quantity: '1',
  unit_price: '',
  cost_amount: '',
  platform_fee: '',
  fba_fee: '',
  shipping_fee: '',
  ad_cost: '',
  refund_amount: '',
  other_fee: '',
  status: 'delivered',
  note: '',
  owner_id: '',
}

const IMPORT_FIELDS: ImportField[] = [
  { key: 'store', label: '店铺', aliases: ['店铺', 'store', 'store_name'] },
  { key: 'order_no', label: '订单号', aliases: ['order_no', 'order id', 'order-id', 'amazon-order-id', '订单号', '订单编号'], required: true },
  { key: 'order_date', label: '日期', aliases: ['date', 'order_date', 'purchase-date', '付款时间', '日期', '下单时间'] },
  { key: 'sku', label: 'SKU', aliases: ['sku', 'seller_sku', 'msku', '商家sku'] },
  { key: 'title', label: '商品', aliases: ['title', 'product_name', '商品名称', 'item_name'] },
  { key: 'quantity', label: '数量', aliases: ['quantity', 'qty', '数量', '件数'], numeric: true },
  { key: 'unit_price', label: '单价', aliases: ['price', 'unit_price', 'item-price', '单价', '售价'], numeric: true },
  { key: 'platform_fee', label: '佣金', aliases: ['commission', 'platform_fee', 'referral fee', '佣金'], numeric: true },
  { key: 'fba_fee', label: '履约费', aliases: ['fba_fee', 'fulfillment fee', 'shipping cost', '配送费', '履约费'], numeric: true },
  { key: 'shipping_fee', label: '物流', aliases: ['shipping_fee', '头程', '物流费'], numeric: true },
  { key: 'ad_cost', label: '广告分摊', aliases: ['ad_cost', '广告费', '广告'], numeric: true },
  { key: 'refund_amount', label: '退款', aliases: ['refund', 'refund_amount', '退款'], numeric: true },
  { key: 'country', label: '国家', aliases: ['country', 'ship-country', '国家', '站点'] },
  { key: 'customer_name', label: '买家', aliases: ['buyer', 'customer', 'recipient-name', '买家'] },
]

const toNum = (v: string | number | null | undefined) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** 通讯录（team_directory）：责任人下拉用，普通成员也能读到 */
interface DirectoryRow {
  id: string
  full_name: string | null
  email: string | null
  status: string
  employment_status: string
}

interface ShortagePrompt {
  order: Order
  available: number
  need: number
  shortage: number
  warehouse: string
  qty: string
  supplier_id: string
  unit_cost: string
}

export default function Orders() {
  const { push } = useToast()
  const { user, can } = useAuth()
  const canEdit = can('orders.edit')
  const canBuy = can('purchase.edit')
  const [search, setSearch] = useState('')
  const [storeFilter, setStoreFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [from, setFrom] = useState(daysAgo(29))
  const [to, setTo] = useState(today())
  const [page, setPage] = useState(1)
  const [modalOpen, setModalOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importStore, setImportStore] = useState('')
  const [editing, setEditing] = useState<Order | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Order | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [shortage, setShortage] = useState<ShortagePrompt | null>(null)
  const [shortageSaving, setShortageSaving] = useState(false)
  const [trace, setTrace] = useState<{ order: Order; timeline: TraceEvent[] } | null>(null)
  const [traceLoading, setTraceLoading] = useState(false)
  const fx = useFx()

  const { data, loading, error, reload } = useAsync(async () => {
    const [orders, stores, products, directory, suppliers] = await Promise.all([
      fetchRows<Order>('orders', {
        filters: [
          ['order_date', 'gte', from],
          ['order_date', 'lte', to],
        ],
        order: { column: 'order_date', ascending: false },
        limit: 2000,
      }),
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
      fetchRows<Product>('products'),
      callRpc<DirectoryRow[]>('team_directory').catch(() => []),
      fetchRows<Supplier>('suppliers', { filters: [['status', 'eq', 'active']] }).catch(() => []),
    ])
    return { orders, stores, products, directory, suppliers }
  }, [from, to])

  /** 可选责任人：在职且账号正常的成员 */
  const memberOptions = useMemo(
    () =>
      (data?.directory ?? [])
        .filter((m) => m.status === 'active' && (m.employment_status ?? 'active') === 'active')
        .map((m) => ({ value: m.id, label: m.full_name || m.email || '未命名' })),
    [data],
  )
  const memberMap = useMemo(() => new Map((data?.directory ?? []).map((m) => [m.id, m])), [data])

  const storeMap = useMemo(() => new Map((data?.stores ?? []).map((s) => [s.id, s])), [data])
  const productMap = useMemo(() => new Map((data?.products ?? []).map((p) => [p.id, p])), [data])

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return (data?.orders ?? []).filter((o) => {
      if (storeFilter && o.store_id !== storeFilter) return false
      if (statusFilter && o.status !== statusFilter) return false
      if (!kw) return true
      return [o.order_no, o.sku ?? '', o.title ?? '', o.customer_name ?? ''].some((v) => v.toLowerCase().includes(kw))
    })
  }, [data, search, storeFilter, statusFilter])

  const totals = useMemo(() => {
    const cv = (value: number | string, storeId: string) =>
      convert(Number(value ?? 0), storeMap.get(storeId)?.currency ?? 'USD', 'USD', fx)
    const live = filtered.filter((o) => o.status !== 'cancelled')
    return {
      sales: live.reduce((s, o) => s + cv(o.gross_amount, o.store_id), 0),
      profit: live.reduce((s, o) => s + cv(o.profit, o.store_id), 0),
      count: filtered.length,
      refund: filtered.reduce((s, o) => s + cv(o.refund_amount, o.store_id), 0),
      pendingOut: live.filter((o) => (o.stock_state ?? 'pending') !== 'out').length,
    }
  }, [filtered, storeMap, fx])

  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const formProducts = useMemo(
    () => (data?.products ?? []).filter((p) => !form.store_id || p.store_id === form.store_id),
    [data, form.store_id],
  )

  const preview = useMemo(() => {
    const qty = toNum(form.quantity) || 0
    const gross = qty * toNum(form.unit_price)
    const fees =
      toNum(form.cost_amount) + toNum(form.platform_fee) + toNum(form.fba_fee) +
      toNum(form.shipping_fee) + toNum(form.ad_cost) + toNum(form.refund_amount) + toNum(form.other_fee)
    const profit = gross - fees
    return { gross, fees, profit, margin: gross ? (profit / gross) * 100 : 0 }
  }, [form])

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY, store_id: storeFilter || data?.stores[0]?.id || '', owner_id: user?.id ?? '' })
    setModalOpen(true)
  }

  function openEdit(order: Order) {
    setEditing(order)
    setForm({
      store_id: order.store_id,
      order_no: order.order_no,
      order_date: order.order_date,
      product_id: order.product_id ?? '',
      sku: order.sku ?? '',
      title: order.title ?? '',
      customer_name: order.customer_name ?? '',
      country: order.country ?? '',
      quantity: String(order.quantity),
      unit_price: String(order.unit_price),
      cost_amount: String(order.cost_amount),
      platform_fee: String(order.platform_fee),
      fba_fee: String(order.fba_fee),
      shipping_fee: String(order.shipping_fee),
      ad_cost: String(order.ad_cost),
      refund_amount: String(order.refund_amount),
      other_fee: String(order.other_fee),
      status: order.status,
      note: order.note ?? '',
      owner_id: order.owner_id ?? '',
    })
    setModalOpen(true)
  }

  function pickProduct(productId: string) {
    if (!productId) {
      setForm((f) => ({ ...f, product_id: '', sku: '', title: '' }))
      return
    }
    const product = productMap.get(productId)
    const store = product ? storeMap.get(product.store_id) : undefined
    const qty = toNum(form.quantity) || 1
    if (!product) return
    setForm((f) => ({
      ...f,
      product_id: productId,
      store_id: product.store_id,
      sku: product.sku,
      title: product.title,
      unit_price: String(product.sale_price),
      cost_amount: String(Number((product.cost_price * qty).toFixed(2))),
      platform_fee: String(Number((product.sale_price * qty * (store?.platform === 'amazon' ? 0.15 : 0.08)).toFixed(2))),
      country: f.country || store?.marketplace || '',
    }))
  }

  function changeQuantity(value: string) {
    const qty = toNum(value) || 0
    setForm((f) => {
      const product = f.product_id ? productMap.get(f.product_id) : undefined
      const store = product ? storeMap.get(product.store_id) : undefined
      if (!product) return { ...f, quantity: value }
      const unit = toNum(f.unit_price)
      return {
        ...f,
        quantity: value,
        cost_amount: String(Number((product.cost_price * qty).toFixed(2))),
        platform_fee: String(Number((unit * qty * (store?.platform === 'amazon' ? 0.15 : 0.08)).toFixed(2))),
      }
    })
  }

  async function handleSave() {
    if (!form.store_id) return push('请选择店铺', 'error')
    if (!form.order_no.trim()) return push('请填写订单号', 'error')
    if (!form.sku.trim()) return push('请选择或填写 SKU', 'error')
    setSaving(true)
    try {
      const payload = {
        store_id: form.store_id,
        product_id: form.product_id || null,
        order_no: form.order_no.trim(),
        order_date: form.order_date || today(),
        channel: storeMap.get(form.store_id)?.platform ?? 'amazon',
        sku: form.sku.trim(),
        title: form.title.trim() || null,
        customer_name: form.customer_name.trim() || null,
        country: form.country.trim() || null,
        quantity: Math.max(1, Math.round(toNum(form.quantity))),
        unit_price: toNum(form.unit_price),
        cost_amount: toNum(form.cost_amount),
        platform_fee: toNum(form.platform_fee),
        fba_fee: toNum(form.fba_fee),
        shipping_fee: toNum(form.shipping_fee),
        ad_cost: toNum(form.ad_cost),
        refund_amount: toNum(form.refund_amount),
        other_fee: toNum(form.other_fee),
        status: form.status,
        note: form.note.trim() || null,
        owner_id: form.owner_id || user?.id || null,
      }
      if (editing) {
        await updateRow('orders', editing.id, payload)
        push('订单已更新')
      } else {
        await insertRow('orders', payload)
        push('订单已创建')
      }
      setModalOpen(false)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate|unique/i.test(msg) ? '该店铺下订单号已存在' : msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  /* ---------------- 出库与链路 ---------------- */

  async function handleFulfill(order: Order, force = false) {
    setBusyId(order.id)
    try {
      const res = await fulfillOrder(order.id, order.fulfillment_wh, force)
      if (!res?.ok && res?.reason === 'shortage') {
        const product = order.product_id ? productMap.get(order.product_id) : undefined
        setShortage({
          order,
          available: res.available ?? 0,
          need: res.need ?? order.quantity,
          shortage: res.shortage ?? order.quantity,
          warehouse: res.warehouse ?? 'FBA-US',
          qty: String(res.shortage || order.quantity),
          supplier_id: '',
          unit_cost: String(product?.cost_price ?? 0),
        })
        return
      }
      if (force) setShortage(null)
      push(force ? '已强制出库，库存可能出现负数' : `已出库，剩余可用 ${num(res?.available ?? 0)} 件`)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '出库失败', 'error')
    } finally {
      setBusyId('')
    }
  }

  async function handleRestore(order: Order) {
    setBusyId(order.id)
    try {
      const res = await restoreOrderStock(order.id)
      if (res?.ok) {
        push(`已退回库存 ${num(res.restored ?? 0)} 件`)
        reload()
      } else if (res?.reason === 'not_out') {
        push('该订单还没出库，无需退回', 'error')
      }
    } catch (err) {
      push(err instanceof Error ? err.message : '退回失败', 'error')
    } finally {
      setBusyId('')
    }
  }

  async function handleCreatePo() {
    if (!shortage) return
    const qty = Math.max(1, Math.round(toNum(shortage.qty)))
    setShortageSaving(true)
    try {
      const res = await createPoFromShortage(
        [
          {
            sku: shortage.order.sku ?? '',
            title: shortage.order.title,
            product_id: shortage.order.product_id,
            qty,
            unit_cost: toNum(shortage.unit_cost),
          },
        ],
        shortage.supplier_id || null,
        shortage.order.store_id,
        shortage.order.id,
      )
      push(`已生成采购单 ${res.po_no}，到货后在「采购管理」入库即可回补库存`)
      setShortage(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '生成采购单失败', 'error')
    } finally {
      setShortageSaving(false)
    }
  }

  async function openTrace(order: Order) {
    setTrace({ order, timeline: [] })
    setTraceLoading(true)
    try {
      const res = await fetchOrderTrace(order.id)
      setTrace({ order, timeline: res.timeline ?? [] })
    } catch (err) {
      push(err instanceof Error ? err.message : '读取链路失败', 'error')
      setTrace(null)
    } finally {
      setTraceLoading(false)
    }
  }

  async function handleDelete() {
    if (!deleting) return
    setConfirmLoading(true)
    try {
      await deleteRow('orders', deleting.id)
      push('订单已删除')
      setDeleting(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirmLoading(false)
    }
  }

  async function handleImport(rows: Array<Record<string, string>>) {
    const fallback = importStore || storeFilter || data?.stores[0]?.id
    const byName = new Map((data?.stores ?? []).map((s) => [s.name.trim().toLowerCase(), s]))
    const bySku = new Map<string, Product>()
    for (const p of data?.products ?? []) bySku.set(`${p.store_id}::${p.sku.toLowerCase()}`, p)

    const payload: Array<Record<string, unknown>> = []
    let skipped = 0
    for (const row of rows) {
      const store = (row.store && byName.get(row.store.trim().toLowerCase())) || (fallback ? storeMap.get(fallback) : undefined)
      if (!store || !row.order_no) {
        skipped += 1
        continue
      }
      const product = row.sku ? bySku.get(`${store.id}::${row.sku.toLowerCase()}`) : undefined
      const qty = Math.max(1, Math.round(toNum(row.quantity)) || 1)
      const unit = toNum(row.unit_price) || product?.sale_price || 0
      const gross = qty * unit
      payload.push({
        store_id: store.id,
        product_id: product?.id ?? null,
        order_no: row.order_no,
        order_date: row.order_date ? dayjs(row.order_date).format('YYYY-MM-DD') : today(),
        channel: store.platform,
        sku: row.sku || product?.sku || 'UNKNOWN',
        title: row.title || product?.title || null,
        customer_name: row.customer_name || null,
        country: row.country || store.marketplace,
        quantity: qty,
        unit_price: unit,
        cost_amount: product ? Number((product.cost_price * qty).toFixed(2)) : 0,
        platform_fee: toNum(row.platform_fee) || Number((gross * (store.platform === 'amazon' ? 0.15 : 0.08)).toFixed(2)),
        fba_fee: toNum(row.fba_fee),
        shipping_fee: toNum(row.shipping_fee),
        ad_cost: toNum(row.ad_cost),
        refund_amount: toNum(row.refund_amount),
        other_fee: 0,
        status: 'delivered',
      })
    }
    if (!payload.length) throw new Error('没有可导入的有效行（需包含订单号）')
    for (let i = 0; i < payload.length; i += 200) {
      await insertRows('orders', payload.slice(i, i + 200))
    }
    push(`成功导入 ${payload.length} 条订单${skipped ? `，跳过 ${skipped} 行` : ''}`)
    reload()
  }

  function handleExport() {
    const rows = filtered.map((o) => ({
      订单号: o.order_no,
      日期: o.order_date,
      店铺: storeMap.get(o.store_id)?.name ?? '',
      平台: o.channel,
      SKU: o.sku ?? '',
      商品: o.title ?? '',
      数量: o.quantity,
      销售额: o.gross_amount,
      成本: o.cost_amount,
      佣金: o.platform_fee,
      履约费: o.fba_fee,
      物流: o.shipping_fee,
      广告: o.ad_cost,
      退款: o.refund_amount,
      其他: o.other_fee,
      净利润: o.profit,
      状态: ORDER_STATUS[o.status]?.label ?? o.status,
      出库: STOCK_STATE_META[o.stock_state ?? 'pending']?.label ?? '',
      责任人: (o.owner_id && memberMap.get(o.owner_id)?.full_name) || '',
      成本来源: o.cost_source === 'stock' ? '采购加权成本' : '手工填写',
    }))
    downloadTextFile(`订单明细_${from}_${to}.csv`, toCsv(rows), 'text/csv;charset=utf-8')
  }

  return (
    <>
      <PageHeader
        title="订单管理"
        description="每笔订单的利润由系统自动计算，平台费用可按实际回款修正"
        actions={
          <>
            <Button icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setImportOpen(true)} disabled={!data?.stores.length}>
              导入报表
            </Button>
            <Button icon={<Download className="w-3.5 h-3.5" />} onClick={handleExport} disabled={!filtered.length}>
              导出
            </Button>
            <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate} disabled={!data?.stores.length}>
              录入订单
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
        {[
          { label: '本期销售额 ≈USD', value: money(totals.sales, 'USD', 0), tone: 'text-ink-900' },
          { label: '本期净利润 ≈USD', value: money(totals.profit, 'USD', 0), tone: totals.profit >= 0 ? 'text-emerald-600' : 'text-rose-600' },
          { label: '订单数', value: num(totals.count), tone: 'text-ink-900' },
          { label: '待出库', value: num(totals.pendingOut), tone: totals.pendingOut > 0 ? 'text-amber-600' : 'text-ink-900' },
          { label: '退款金额 ≈USD', value: money(totals.refund, 'USD', 0), tone: 'text-rose-600' },
        ].map((item) => (
          <div key={item.label} className="card px-4 py-3">
            <p className="text-[11px] text-ink-500">{item.label}</p>
            <p className={cn('num text-[18px] font-semibold mt-1', item.tone)}>{item.value}</p>
          </div>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="订单号 / SKU / 买家" className="w-full sm:w-60" />
          <Select
            className="w-full sm:w-40"
            value={storeFilter}
            onChange={(v) => { setStoreFilter(v); setPage(1) }}
            placeholder="全部店铺"
            options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            className="w-full sm:w-28"
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1) }}
            placeholder="全部状态"
            options={Object.entries(ORDER_STATUS).map(([value, v]) => ({ value, label: v.label }))}
          />
          <div className="flex items-center gap-1.5 text-[12px] text-ink-500">
            <input type="date" className="input !w-[140px] !h-8" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} />
            <span>—</span>
            <input type="date" className="input !w-[140px] !h-8" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} />
          </div>
        </div>

        {error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : loading ? (
          <LoadingBlock rows={8} />
        ) : !data?.stores.length ? (
          <EmptyState icon={<ShoppingCart className="w-5 h-5" />} title="请先创建店铺" description="订单需要归属到店铺，先去「店铺管理」完成配置。" />
        ) : pageRows.length === 0 ? (
          <EmptyState
            icon={<Receipt className="w-5 h-5" />}
            title="该筛选条件下没有订单"
            description="调整日期范围，或导入平台订单报表（Amazon 订单报告 / TikTok 订单导出）。"
            action={
              <Button variant="primary" onClick={() => setImportOpen(true)} icon={<Upload className="w-3.5 h-3.5" />}>
                导入订单报表
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px]">
              <thead>
                <tr>
                  <th className="th">订单</th>
                  <th className="th">店铺</th>
                  <th className="th">商品</th>
                  <th className="th text-right">数量</th>
                  <th className="th text-right">销售额</th>
                  <th className="th text-right">总成本</th>
                  <th className="th text-right">净利润</th>
                  <th className="th text-right">利润率</th>
                  <th className="th">状态</th>
                  <th className="th">出库 / 责任人</th>
                  <th className="th w-24" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((o) => {
                  const store = storeMap.get(o.store_id)
                  const cost = Number(o.cost_amount) + Number(o.platform_fee) + Number(o.fba_fee) + Number(o.shipping_fee) + Number(o.ad_cost) + Number(o.refund_amount) + Number(o.other_fee)
                  const margin = Number(o.gross_amount) ? (Number(o.profit) / Number(o.gross_amount)) * 100 : 0
                  const status = ORDER_STATUS[o.status]
                  const currency = store?.currency ?? 'USD'
                  const stockMeta = STOCK_STATE_META[o.stock_state ?? 'pending'] ?? STOCK_STATE_META.pending
                  const ownerName = (o.owner_id && memberMap.get(o.owner_id)?.full_name) || '未指派'
                  return (
                    <tr key={o.id} className="hover:bg-ink-50/60 group">
                      <td className="td">
                        <p className="text-[12px] font-medium text-ink-800 font-mono">{o.order_no}</p>
                        <p className="text-[10.5px] text-ink-400">{o.order_date}</p>
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              'w-4 h-4 rounded flex items-center justify-center text-[8px] font-bold text-white shrink-0',
                              store?.platform === 'amazon' ? 'bg-amazon' : 'bg-tiktok',
                            )}
                          >
                            {store?.platform === 'amazon' ? 'a' : 't'}
                          </span>
                          <span className="text-[11.5px] truncate max-w-[110px]">{store?.name ?? '—'}</span>
                        </div>
                      </td>
                      <td className="td">
                        <p className="text-[12px] text-ink-700 truncate max-w-[240px]">{o.title ?? '—'}</p>
                        <p className="text-[10.5px] text-ink-400 font-mono">{o.sku ?? '—'}</p>
                      </td>
                      <td className="td text-right num text-ink-500">{o.quantity}</td>
                      <td className="td text-right num font-medium">{money(o.gross_amount, currency)}</td>
                      <td className="td text-right num text-ink-500">{money(cost, currency)}</td>
                      <td className={cn('td text-right num font-semibold', Number(o.profit) >= 0 ? 'text-emerald-700' : 'text-rose-600')}>
                        {money(o.profit, currency)}
                      </td>
                      <td className="td text-right">
                        <span className={cn('num text-[12px]', margin >= 20 ? 'text-emerald-600' : margin >= 8 ? 'text-amber-600' : 'text-rose-600')}>
                          {pct(margin)}
                        </span>
                      </td>
                      <td className="td">
                        <Badge tone={status?.tone ?? 'gray'}>{status?.label ?? o.status}</Badge>
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              'text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap',
                              stockMeta.cls,
                            )}
                          >
                            {stockMeta.label}
                          </span>
                          <span className="text-[11px] text-ink-500 truncate max-w-[72px]" title={ownerName}>
                            {ownerName}
                          </span>
                        </div>
                        {o.cost_source === 'stock' && (
                          <p className="text-[9.5px] text-emerald-600 mt-0.5">成本取自采购入库</p>
                        )}
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-0.5">
                          {canEdit && o.status !== 'cancelled' && (
                            o.stock_state === 'out' ? (
                              <button
                                className="p-1.5 rounded-md text-ink-400 hover:text-amber-600 hover:bg-amber-50 disabled:opacity-40"
                                title="退回库存"
                                disabled={busyId === o.id}
                                onClick={() => handleRestore(o)}
                              >
                                <Undo2 className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <button
                                className="p-1.5 rounded-md text-ink-400 hover:text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
                                title="出库并扣减库存"
                                disabled={busyId === o.id}
                                onClick={() => handleFulfill(o)}
                              >
                                <PackageCheck className="w-3.5 h-3.5" />
                              </button>
                            )
                          )}
                          <button
                            className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-brand-50"
                            title="查看全链路"
                            onClick={() => openTrace(o)}
                          >
                            <GitBranch className="w-3.5 h-3.5" />
                          </button>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100" onClick={() => openEdit(o)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button data-perm="delete" className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50" onClick={() => setDeleting(o)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
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
        {!loading && filtered.length > 0 && filtered.length <= PAGE_SIZE && (
          <div className="px-5 py-2.5 border-t border-ink-100 text-[11px] text-ink-400">
            共 {filtered.length} 条 · 含最多 2000 条查询上限，更长周期建议按月导出
          </div>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? '编辑订单' : '录入订单'}
        width="max-w-3xl"
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>取消</Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="店铺" required>
              <Select
                value={form.store_id}
                onChange={(v) => setForm({ ...form, store_id: v, product_id: '', sku: '', title: '' })}
                placeholder="选择店铺"
                options={(data?.stores ?? []).map((s) => ({ value: s.id, label: `${s.name}（${s.marketplace}）` }))}
              />
            </Field>
            <Field label="订单号" required>
              <input className="input font-mono" value={form.order_no} onChange={(e) => setForm({ ...form, order_no: e.target.value })} placeholder="平台订单号" />
            </Field>
            <Field label="下单日期">
              <input type="date" className="input" value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} />
            </Field>
            <Field label="选择商品（自动带出成本与售价）" className="sm:col-span-2">
              <Select
                value={form.product_id}
                onChange={pickProduct}
                placeholder="不选择，手动填写"
                options={formProducts.map((p) => ({ value: p.id, label: `${p.sku} · ${p.title}` }))}
              />
            </Field>
            <Field label="数量">
              <input className="input num" type="number" min="1" value={form.quantity} onChange={(e) => changeQuantity(e.target.value)} />
            </Field>
            <Field label="SKU" required>
              <input className="input font-mono" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="SKU" />
            </Field>
            <Field label="商品名称" className="sm:col-span-2">
              <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="单价">
              <input className="input num" type="number" step="0.01" value={form.unit_price} onChange={(e) => setForm({ ...form, unit_price: e.target.value })} />
            </Field>
            <Field label="买家">
              <input className="input" value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} placeholder="选填" />
            </Field>
            <Field label="国家 / 站点">
              <input className="input" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="US / UK …" />
            </Field>
          </div>

          <div>
            <p className="text-[11px] font-semibold text-ink-500 uppercase tracking-wide mb-2">费用明细</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                { key: 'cost_amount', label: '采购成本' },
                { key: 'platform_fee', label: '平台佣金' },
                { key: 'fba_fee', label: 'FBA / 履约费' },
                { key: 'shipping_fee', label: '头程 / 物流' },
                { key: 'ad_cost', label: '广告分摊' },
                { key: 'refund_amount', label: '退款金额' },
              ].map((f) => (
                <Field key={f.key} label={f.label}>
                  <input
                    className="input num"
                    type="number"
                    step="0.01"
                    value={form[f.key as keyof FormState] as string}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value } as FormState)}
                  />
                </Field>
              ))}
              <Field label="其他费用">
                <input className="input num" type="number" step="0.01" value={form.other_fee} onChange={(e) => setForm({ ...form, other_fee: e.target.value })} />
              </Field>
              <Field label="订单状态">
                <Select
                  value={form.status}
                  onChange={(v) => setForm({ ...form, status: v as Order['status'] })}
                  options={Object.entries(ORDER_STATUS).map(([value, v]) => ({ value, label: v.label }))}
                />
              </Field>
              <Field label="责任人" hint="这一单的业绩与利润算到他名下，绩效自动统计">
                <Select
                  value={form.owner_id}
                  onChange={(v) => setForm({ ...form, owner_id: v })}
                  options={memberOptions}
                  placeholder="默认当前登录人"
                />
              </Field>
            </div>
          </div>

          <div className="rounded-xl border border-ink-200 bg-ink-50/60 px-4 py-3">
            <div className="grid grid-cols-4 gap-3 text-center">
              <div>
                <p className="text-[10.5px] text-ink-400">销售额</p>
                <p className="num text-[14px] font-semibold text-ink-900 mt-0.5">{preview.gross.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-[10.5px] text-ink-400">总支出</p>
                <p className="num text-[14px] font-semibold text-ink-700 mt-0.5">{preview.fees.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-[10.5px] text-ink-400">净利润</p>
                <p className={cn('num text-[14px] font-semibold mt-0.5', preview.profit >= 0 ? 'text-emerald-600' : 'text-rose-600')}>
                  {preview.profit.toFixed(2)}
                </p>
              </div>
              <div>
                <p className="text-[10.5px] text-ink-400">利润率</p>
                <p className={cn('num text-[14px] font-semibold mt-0.5', preview.margin >= 15 ? 'text-emerald-600' : 'text-amber-600')}>
                  {preview.margin.toFixed(1)}%
                </p>
              </div>
            </div>
          </div>

          <Field label="备注">
            <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="选填" />
          </Field>
        </div>
      </Modal>

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="导入订单报表"
        fields={IMPORT_FIELDS}
        onImport={handleImport}
        note="Amazon「订单报告」与 TikTok「订单导出」的 CSV 均可直接使用；佣金留空时按 Amazon 15% / TikTok 8% 估算，SKU 匹配到商品档案时会自动带出成本。"
        extra={
          <Field label="默认店铺（CSV 无店铺列时使用）">
            <Select
              value={importStore || storeFilter || data?.stores[0]?.id || ''}
              onChange={setImportStore}
              options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
        }
      />

      {/* 缺货：订单驱动补货 */}
      <Modal
        open={!!shortage}
        onClose={() => setShortage(null)}
        title="库存不足，需要补货"
        width="max-w-lg"
        footer={
          <>
            <Button onClick={() => setShortage(null)}>取消</Button>
            <Button onClick={() => shortage && handleFulfill(shortage.order, true)}>仍然出库</Button>
            {canBuy && (
              <Button variant="primary" loading={shortageSaving} onClick={handleCreatePo}>
                生成采购单
              </Button>
            )}
          </>
        }
      >
        {shortage && (
          <div className="space-y-3">
            <div className="rounded-xl border border-amber-200/70 bg-amber-50/70 px-3.5 py-3">
              <p className="text-[12px] text-amber-900 font-medium">
                {shortage.order.sku} · {shortage.order.title || '未命名商品'}
              </p>
              <p className="text-[11px] text-amber-700 mt-1">
                仓库「{shortage.warehouse}」可用库存不够，无法直接出库。
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                { label: '可用库存', value: num(shortage.available), tone: 'text-ink-800' },
                { label: '本单需求', value: num(shortage.need), tone: 'text-ink-800' },
                { label: '缺口', value: num(shortage.shortage), tone: 'text-rose-600' },
              ].map((x) => (
                <div key={x.label} className="rounded-lg border border-ink-200/70 bg-white px-3 py-2 text-center">
                  <p className="text-[10.5px] text-ink-400">{x.label}</p>
                  <p className={cn('num text-[15px] font-semibold mt-0.5', x.tone)}>{x.value}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="采购数量">
                <input
                  className="input num"
                  type="number"
                  min="1"
                  value={shortage.qty}
                  onChange={(e) => setShortage({ ...shortage, qty: e.target.value })}
                />
              </Field>
              <Field label="采购单价">
                <input
                  className="input num"
                  type="number"
                  step="0.01"
                  value={shortage.unit_cost}
                  onChange={(e) => setShortage({ ...shortage, unit_cost: e.target.value })}
                />
              </Field>
            </div>

            <Field label="指定供应商" hint="留空则先建单，稍后在采购管理里补">
              <Select
                value={shortage.supplier_id}
                onChange={(v) => setShortage({ ...shortage, supplier_id: v })}
                options={(data?.suppliers ?? []).map((x) => ({ value: x.id, label: x.name }))}
                placeholder="（暂不指定）"
              />
            </Field>

            <pre className="text-[10.5px] leading-relaxed text-ink-500 bg-ink-50 rounded-lg px-3 py-2 whitespace-pre-wrap font-sans">
              生成的采购单会回指这张订单，之后在「采购管理」付款、到货入库，成本自动回流商品档案，
              这张订单的利润会按实际采购成本重算。
            </pre>
          </div>
        )}
      </Modal>

      {/* 单据链路：一张订单的完整闭环 */}
      <Modal
        open={!!trace}
        onClose={() => setTrace(null)}
        title={`单据链路 · ${trace?.order.order_no ?? ''}`}
        width="max-w-2xl"
        footer={<Button onClick={() => setTrace(null)}>关闭</Button>}
      >
        <div className="rounded-xl border border-ink-200/70 bg-ink-50/60 px-3.5 py-2.5 mb-4 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-600">
          {['订单', '出库', '缺货补货', '采购付款', '到货入库'].map((x, i, arr) => (
            <span key={x} className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded bg-white border border-ink-200/70">{x}</span>
              {i < arr.length - 1 && <ArrowRight className="w-3 h-3 text-ink-300" />}
            </span>
          ))}
        </div>

        {traceLoading ? (
          <LoadingBlock rows={4} />
        ) : !trace?.timeline.length ? (
          <EmptyState
            icon={<GitBranch className="w-5 h-5" />}
            title="这条链路还没有后续动作"
            description="订单出库后会记录扣库存流水；库存不足时生成的采购单、付款、入库也会自动串进来。"
          />
        ) : (
          <ol className="relative ml-1 pl-4 border-l border-ink-200 space-y-3.5">
            {trace.timeline.map((e, i) => {
              const meta = TRACE_META[e.kind] ?? TRACE_META.order
              const owner = (e.owner_id && memberMap.get(e.owner_id)?.full_name) || ''
              return (
                <li key={`${e.kind}-${i}`} className="relative">
                  <span className={cn('absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full ring-2 ring-white', meta.dot)} />
                  <div className="flex items-center gap-2">
                    <span className={cn('text-[10px] font-medium', meta.cls)}>{meta.label}</span>
                    <span className="text-[12.5px] font-medium text-ink-800">{e.title}</span>
                    <span className="ml-auto num text-[10.5px] text-ink-400">{dayjs(e.ts).format('MM-DD HH:mm')}</span>
                  </div>
                  {e.detail && <p className="text-[11.5px] text-ink-500 mt-0.5 leading-relaxed">{e.detail}</p>}
                  {owner && <p className="text-[10.5px] text-ink-400 mt-0.5">经手 {owner}</p>}
                </li>
              )
            })}
          </ol>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={confirmLoading}
        title="删除订单"
        message={`确定删除订单 ${deleting?.order_no} 吗？该订单会从所有统计中移除。`}
      />
    </>
  )
}
