import { useMemo, useState } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  CalendarClock,
  CircleDollarSign,
  ClipboardCheck,
  Container,
  Factory,
  PackageCheck,
  Pencil,
  Phone,
  Plus,
  Trash2,
  Truck,
} from 'lucide-react'
import dayjs from 'dayjs'
import { deleteRow, deleteWhere, fetchRows, insertRow, insertRows, updateRow } from '../lib/db'
import { PAYMENT_TERMS, PO_STATUS, PURCHASE_WAREHOUSES, SUPPLIER_STATUS } from '../lib/constants'
import type { Product, PurchaseItem, PurchaseOrder, PurchaseStatus, Store, Supplier } from '../lib/types'
import { useAsync } from '../hooks/useAsync'
import { convert, useFx } from '../lib/fx'
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
import { DonutChart, RankBars, SimpleBars } from '../components/charts'
import { cn, dayDiff, fmtDate, money, num, relativeDay, today } from '../lib/utils'

const PAGE_SIZE = 15

type Tab = 'orders' | 'suppliers' | 'analysis'

const STATUS_COLOR: Record<string, string> = {
  draft: '#cbd5e1',
  ordered: '#3b6ef6',
  partial: '#f59e0b',
  received: '#10b981',
  cancelled: '#f43f5e',
}

let draftSeq = 0
const nextKey = () => `row-${++draftSeq}`

interface PoDraft {
  po_no: string
  supplier_id: string
  store_id: string
  warehouse: string
  order_date: string
  expected_date: string
  currency: string
  status: PurchaseStatus
  shipping_fee: string
  other_fee: string
  note: string
}

const EMPTY_PO: PoDraft = {
  po_no: '',
  supplier_id: '',
  store_id: '',
  warehouse: '国内仓',
  order_date: today(),
  expected_date: '',
  currency: 'CNY',
  status: 'ordered',
  shipping_fee: '0',
  other_fee: '0',
  note: '',
}

interface ItemDraft {
  key: string
  product_id: string
  sku: string
  title: string
  quantity: string
  unit_price: string
  /** 编辑已有采购单时带出，保存时按 SKU 继承，避免重写明细把收货进度清零 */
  received_qty: number
}

const emptyItem = (): ItemDraft => ({
  key: nextKey(),
  product_id: '',
  sku: '',
  title: '',
  quantity: '1',
  unit_price: '0',
  received_qty: 0,
})

interface SupplierDraft {
  name: string
  contact: string
  phone: string
  email: string
  address: string
  category: string
  payment_terms: string
  lead_time_days: string
  rating: string
  status: 'active' | 'paused'
  note: string
}

const EMPTY_SUPPLIER: SupplierDraft = {
  name: '',
  contact: '',
  phone: '',
  email: '',
  address: '',
  category: '',
  payment_terms: '30 天账期',
  lead_time_days: '30',
  rating: '3',
  status: 'active',
  note: '',
}

const CURRENCY_OPTIONS = ['CNY', 'USD', 'GBP', 'EUR', 'JPY']

export default function Procurement() {
  const { push } = useToast()
  const fx = useFx()

  const [tab, setTab] = useState<Tab>('orders')
  const [search, setSearch] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)

  const [poOpen, setPoOpen] = useState(false)
  const [editingPo, setEditingPo] = useState<PurchaseOrder | null>(null)
  const [poDraft, setPoDraft] = useState<PoDraft>(EMPTY_PO)
  const [itemDrafts, setItemDrafts] = useState<ItemDraft[]>([])
  const [savingPo, setSavingPo] = useState(false)

  const [detailPoId, setDetailPoId] = useState<string | null>(null)

  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [receiptRows, setReceiptRows] = useState<Record<string, string>>({})
  const [receiptWarehouse, setReceiptWarehouse] = useState('国内仓')
  const [syncStock, setSyncStock] = useState(true)
  const [receiving, setReceiving] = useState(false)

  const [supOpen, setSupOpen] = useState(false)
  const [editingSup, setEditingSup] = useState<Supplier | null>(null)
  const [supDraft, setSupDraft] = useState<SupplierDraft>(EMPTY_SUPPLIER)
  const [savingSup, setSavingSup] = useState(false)

  const [deletingPo, setDeletingPo] = useState<PurchaseOrder | null>(null)
  const [deletingSup, setDeletingSup] = useState<Supplier | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)

  const { data, loading, error, reload } = useAsync(async () => {
    const [orders, items, suppliers, products, stores] = await Promise.all([
      fetchRows<PurchaseOrder>('purchase_orders', { order: { column: 'order_date', ascending: false } }),
      fetchRows<PurchaseItem>('purchase_items', { order: { column: 'created_at' } }),
      fetchRows<Supplier>('suppliers', { order: { column: 'created_at' } }),
      fetchRows<Product>('products'),
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
    ])
    return { orders, items, suppliers, products, stores }
  }, [])

  const itemsByPo = useMemo(() => {
    const map = new Map<string, PurchaseItem[]>()
    for (const item of data?.items ?? []) {
      if (!map.has(item.po_id)) map.set(item.po_id, [])
      map.get(item.po_id)!.push(item)
    }
    return map
  }, [data])

  const poMap = useMemo(() => new Map((data?.orders ?? []).map((o) => [o.id, o])), [data])
  const supplierMap = useMemo(() => new Map((data?.suppliers ?? []).map((s) => [s.id, s])), [data])
  const productMap = useMemo(() => new Map((data?.products ?? []).map((p) => [p.id, p])), [data])

  const itemsOf = (poId: string) => itemsByPo.get(poId) ?? []

  /** 采购单金额 = 明细合计 + 运费 + 其他费用（库里不存合计，避免和明细对不上） */
  function totalOf(po: PurchaseOrder) {
    const itemSum = itemsOf(po.id).reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0)
    return itemSum + Number(po.shipping_fee) + Number(po.other_fee)
  }

  function cnyOf(po: PurchaseOrder) {
    return convert(totalOf(po), po.currency, 'CNY', fx)
  }

  function progressOf(poId: string) {
    const list = itemsOf(poId)
    const qty = list.reduce((s, i) => s + Number(i.quantity), 0)
    const received = list.reduce((s, i) => s + Number(i.received_qty), 0)
    return { qty, received, pct: qty ? Math.min(100, (received / qty) * 100) : 0 }
  }

  const kpi = useMemo(() => {
    const active = (data?.orders ?? []).filter((o) => o.status === 'ordered' || o.status === 'partial')
    let pendingQty = 0
    let amountCny = 0
    let overdue = 0
    for (const po of active) {
      const list = itemsByPo.get(po.id) ?? []
      const itemSum = list.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0)
      amountCny += convert(
        itemSum + Number(po.shipping_fee) + Number(po.other_fee),
        po.currency,
        'CNY',
        fx,
      )
      pendingQty += list.reduce((s, i) => s + Math.max(0, Number(i.quantity) - Number(i.received_qty)), 0)
      if (po.expected_date && dayDiff(po.expected_date) < 0) overdue += 1
    }
    return { activeCount: active.length, pendingQty, amountCny, overdue }
  }, [data, itemsByPo, fx])

  const supplierStats = useMemo(() => {
    const map = new Map<string, { count: number; amountCny: number; lastDate: string | null }>()
    for (const po of data?.orders ?? []) {
      if (!po.supplier_id) continue
      if (po.status === 'cancelled' || po.status === 'draft') continue
      const list = itemsByPo.get(po.id) ?? []
      const itemSum = list.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0)
      const total = itemSum + Number(po.shipping_fee) + Number(po.other_fee)
      const current = map.get(po.supplier_id) ?? { count: 0, amountCny: 0, lastDate: null }
      current.count += 1
      current.amountCny += convert(total, po.currency, 'CNY', fx)
      if (!current.lastDate || po.order_date > current.lastDate) current.lastDate = po.order_date
      map.set(po.supplier_id, current)
    }
    return map
  }, [data, itemsByPo, fx])

  const filteredOrders = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return (data?.orders ?? []).filter((po) => {
      if (supplierFilter && po.supplier_id !== supplierFilter) return false
      if (statusFilter && po.status !== statusFilter) return false
      if (!kw) return true
      const supName = po.supplier_id ? supplierMap.get(po.supplier_id)?.name ?? '' : ''
      const skus = itemsOf(po.id).map((i) => `${i.sku} ${i.title ?? ''}`).join(' ')
      return [po.po_no, supName, skus].some((v) => v.toLowerCase().includes(kw))
    })
  }, [data, search, supplierFilter, statusFilter, supplierMap, itemsByPo])

  const pageRows = filteredOrders.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const filteredSuppliers = useMemo(() => {
    const kw = search.trim().toLowerCase()
    if (!kw) return data?.suppliers ?? []
    return (data?.suppliers ?? []).filter((s) =>
      [s.name, s.contact ?? '', s.category ?? '', s.phone ?? ''].some((v) => v.toLowerCase().includes(kw)),
    )
  }, [data, search])

  const detailPo = detailPoId ? poMap.get(detailPoId) ?? null : null
  const receiptPo = receiptId ? poMap.get(receiptId) ?? null : null
  const receiptItems = receiptPo ? itemsOf(receiptPo.id) : []

  /* ---------------- 采购单表单 ---------------- */

  function genPoNo() {
    const prefix = `PO-${dayjs().format('YYMMDD')}`
    const used = (data?.orders ?? []).filter((o) => o.po_no.startsWith(prefix)).length
    return `${prefix}-${String(used + 1).padStart(2, '0')}`
  }

  function openCreatePo() {
    setEditingPo(null)
    setPoDraft({
      ...EMPTY_PO,
      po_no: genPoNo(),
      supplier_id: data?.suppliers[0]?.id ?? '',
      store_id: data?.stores[0]?.id ?? '',
      expected_date: dayjs().add(30, 'day').format('YYYY-MM-DD'),
    })
    setItemDrafts([emptyItem()])
    setPoOpen(true)
  }

  function openEditPo(po: PurchaseOrder) {
    setEditingPo(po)
    setPoDraft({
      po_no: po.po_no,
      supplier_id: po.supplier_id ?? '',
      store_id: po.store_id ?? '',
      warehouse: po.warehouse,
      order_date: po.order_date,
      expected_date: po.expected_date ?? '',
      currency: po.currency,
      status: po.status,
      shipping_fee: String(po.shipping_fee),
      other_fee: String(po.other_fee),
      note: po.note ?? '',
    })
    const list = itemsOf(po.id)
    setItemDrafts(
      list.length
        ? list.map((i) => ({
            key: nextKey(),
            product_id: i.product_id ?? '',
            sku: i.sku,
            title: i.title ?? '',
            quantity: String(i.quantity),
            unit_price: String(i.unit_price),
            received_qty: i.received_qty,
          }))
        : [emptyItem()],
    )
    setPoOpen(true)
  }

  function pickItemProduct(index: number, productId: string) {
    const product = productMap.get(productId)
    setItemDrafts((prev) =>
      prev.map((row, i) =>
        i === index
          ? {
              ...row,
              product_id: productId,
              sku: product?.sku ?? '',
              title: product?.title ?? '',
              unit_price: product ? String(product.cost_price) : row.unit_price,
            }
          : row,
      ),
    )
  }

  function updateItem(index: number, patch: Partial<ItemDraft>) {
    setItemDrafts((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const draftItemSum = itemDrafts.reduce(
    (s, r) => s + (Number(r.quantity) || 0) * (Number(r.unit_price) || 0),
    0,
  )
  const draftTotal = draftItemSum + (Number(poDraft.shipping_fee) || 0) + (Number(poDraft.other_fee) || 0)

  async function handleSavePo() {
    if (!poDraft.po_no.trim()) return push('请填写采购单号', 'error')
    const valid = itemDrafts.filter((r) => r.sku.trim() && Number(r.quantity) > 0)
    if (!valid.length) return push('至少需要一条有效明细：SKU + 数量', 'error')

    setSavingPo(true)
    try {
      const payload = {
        po_no: poDraft.po_no.trim(),
        supplier_id: poDraft.supplier_id || null,
        store_id: poDraft.store_id || null,
        warehouse: poDraft.warehouse,
        order_date: poDraft.order_date || today(),
        expected_date: poDraft.expected_date || null,
        currency: poDraft.currency,
        status: poDraft.status,
        shipping_fee: Number(poDraft.shipping_fee) || 0,
        other_fee: Number(poDraft.other_fee) || 0,
        note: poDraft.note.trim() || null,
        updated_at: new Date().toISOString(),
      }

      let poId = editingPo?.id
      if (editingPo) {
        await updateRow('purchase_orders', editingPo.id, payload)
      } else {
        const created = await insertRow<PurchaseOrder>('purchase_orders', payload)
        poId = created.id
      }
      if (!poId) throw new Error('采购单创建失败')

      // 明细整体重写：先记下旧行的收货进度（按 SKU 对应），再删旧插新
      const receivedMap = new Map(itemsOf(poId).map((i) => [i.sku, Number(i.received_qty)]))
      await deleteWhere('purchase_items', 'po_id', poId)
      await insertRows(
        'purchase_items',
        valid.map((r) => ({
          po_id: poId,
          product_id: r.product_id || null,
          sku: r.sku.trim(),
          title: r.title.trim() || null,
          quantity: Math.round(Number(r.quantity)) || 1,
          unit_price: Number(r.unit_price) || 0,
          received_qty: Math.min(
            Math.round(Number(r.quantity)) || 1,
            receivedMap.get(r.sku.trim()) ?? 0,
          ),
        })),
      )

      push(editingPo ? '采购单已更新' : '采购单已创建')
      setPoOpen(false)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate|unique/i.test(msg) ? '采购单号已存在，换一个' : msg, 'error')
    } finally {
      setSavingPo(false)
    }
  }

  /* ---------------- 收货 ---------------- */

  function openReceipt(po: PurchaseOrder) {
    const rows: Record<string, string> = {}
    for (const item of itemsOf(po.id)) {
      rows[item.id] = String(Math.max(0, Number(item.quantity) - Number(item.received_qty)))
    }
    setReceiptRows(rows)
    setReceiptWarehouse(po.warehouse)
    setSyncStock(!!po.store_id)
    setReceiptId(po.id)
  }

  async function handleReceive() {
    if (!receiptPo) return
    const lines = receiptItems
      .map((item) => {
        const remain = Math.max(0, Number(item.quantity) - Number(item.received_qty))
        const typed = Math.round(Number(receiptRows[item.id]) || 0)
        return { item, qty: Math.min(Math.max(0, typed), remain) }
      })
      .filter((l) => l.qty > 0)

    if (!lines.length) return push('没有可登记的到货数量', 'info')

    setReceiving(true)
    try {
      for (const line of lines) {
        await updateRow('purchase_items', line.item.id, {
          received_qty: Number(line.item.received_qty) + line.qty,
        })
      }

      const receivedAfter = new Map(lines.map((l) => [l.item.id, Number(l.item.received_qty) + l.qty]))
      const allReceived = receiptItems.every(
        (item) => (receivedAfter.get(item.id) ?? Number(item.received_qty)) >= Number(item.quantity),
      )
      await updateRow('purchase_orders', receiptPo.id, {
        status: allReceived ? 'received' : 'partial',
        updated_at: new Date().toISOString(),
      })

      let syncedQty = 0
      let syncFailed = 0
      const storeId = receiptPo.store_id
      if (syncStock && storeId) {
        for (const line of lines) {
          try {
            const existing = await fetchRows<{ id: string; available_qty: number }>('inventory', {
              filters: [
                ['store_id', 'eq', storeId],
                ['sku', 'eq', line.item.sku],
                ['warehouse', 'eq', receiptWarehouse],
              ],
              columns: 'id, available_qty',
              limit: 1,
            })
            if (existing.length) {
              await updateRow('inventory', existing[0].id, {
                available_qty: Number(existing[0].available_qty) + line.qty,
                updated_at: new Date().toISOString(),
              })
            } else {
              await insertRow('inventory', {
                store_id: storeId,
                product_id: line.item.product_id || null,
                sku: line.item.sku,
                title: line.item.title,
                warehouse: receiptWarehouse,
                available_qty: line.qty,
                inbound_qty: 0,
                reserved_qty: 0,
                safety_stock: 0,
                avg_daily_sales: 0,
                updated_at: new Date().toISOString(),
              })
            }
            syncedQty += line.qty
          } catch {
            // 库存同步失败（例如没有库存编辑权限）不阻断收货本身
            syncFailed += 1
          }
        }
      }

      const parts = [`已登记 ${lines.length} 条明细到货`]
      if (syncedQty) parts.push(`同步入库 ${num(syncedQty)} 件到 ${receiptWarehouse}`)
      if (syncFailed) parts.push(`${syncFailed} 个 SKU 未同步库存（检查库存权限）`)
      if (allReceived) parts.push('整单已到齐')
      push(parts.join('，'), syncFailed ? 'error' : 'success')
      setReceiptId(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '收货失败', 'error')
    } finally {
      setReceiving(false)
    }
  }

  /* ---------------- 供应商 ---------------- */

  function openCreateSupplier() {
    setEditingSup(null)
    setSupDraft(EMPTY_SUPPLIER)
    setSupOpen(true)
  }

  function openEditSupplier(sup: Supplier) {
    setEditingSup(sup)
    setSupDraft({
      name: sup.name,
      contact: sup.contact ?? '',
      phone: sup.phone ?? '',
      email: sup.email ?? '',
      address: sup.address ?? '',
      category: sup.category ?? '',
      payment_terms: sup.payment_terms,
      lead_time_days: String(sup.lead_time_days),
      rating: String(sup.rating),
      status: sup.status,
      note: sup.note ?? '',
    })
    setSupOpen(true)
  }

  async function handleSaveSupplier() {
    if (!supDraft.name.trim()) return push('请填写供应商名称', 'error')
    setSavingSup(true)
    try {
      const payload = {
        name: supDraft.name.trim(),
        contact: supDraft.contact.trim() || null,
        phone: supDraft.phone.trim() || null,
        email: supDraft.email.trim() || null,
        address: supDraft.address.trim() || null,
        category: supDraft.category.trim() || null,
        payment_terms: supDraft.payment_terms,
        lead_time_days: Math.max(0, Math.round(Number(supDraft.lead_time_days) || 0)),
        rating: Math.min(5, Math.max(1, Math.round(Number(supDraft.rating) || 3))),
        status: supDraft.status,
        note: supDraft.note.trim() || null,
      }
      if (editingSup) {
        await updateRow('suppliers', editingSup.id, payload)
        push('供应商已更新')
      } else {
        await insertRow('suppliers', payload)
        push('供应商已创建')
      }
      setSupOpen(false)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate|unique/i.test(msg) ? '已存在同名供应商' : msg, 'error')
    } finally {
      setSavingSup(false)
    }
  }

  /* ---------------- 删除 ---------------- */

  async function handleDeletePo() {
    if (!deletingPo) return
    setConfirmLoading(true)
    try {
      await deleteRow('purchase_orders', deletingPo.id)
      push('采购单已删除')
      if (detailPoId === deletingPo.id) setDetailPoId(null)
      setDeletingPo(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirmLoading(false)
    }
  }

  async function handleDeleteSupplier() {
    if (!deletingSup) return
    setConfirmLoading(true)
    try {
      await deleteRow('suppliers', deletingSup.id)
      push('供应商已删除，历史采购单会保留但不再关联')
      setDeletingSup(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirmLoading(false)
    }
  }

  /* ---------------- 分析 ---------------- */

  const monthSeries = useMemo(() => {
    const months = Array.from({ length: 6 }, (_, i) => dayjs().subtract(5 - i, 'month').format('YYYY-MM'))
    const sums = new Map(months.map((m) => [m, 0]))
    for (const po of data?.orders ?? []) {
      if (po.status === 'cancelled' || po.status === 'draft') continue
      const key = dayjs(po.order_date).format('YYYY-MM')
      if (!sums.has(key)) continue
      const list = itemsByPo.get(po.id) ?? []
      const itemSum = list.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0)
      const total = itemSum + Number(po.shipping_fee) + Number(po.other_fee)
      sums.set(key, (sums.get(key) ?? 0) + convert(total, po.currency, 'CNY', fx))
    }
    return months.map((m) => ({ name: dayjs(`${m}-01`).format('M月'), value: Math.round(sums.get(m) ?? 0) }))
  }, [data, itemsByPo, fx])

  const topSuppliers = useMemo(
    () =>
      Array.from(supplierStats.entries())
        .map(([id, stat]) => {
          // 中文供应商名普遍偏长，轴向标签留 9 个字，完整名字在供应商页看
          const full = supplierMap.get(id)?.name ?? '已删除供应商'
          return { name: full.length > 9 ? `${full.slice(0, 9)}…` : full, value: Math.round(stat.amountCny) }
        })
        .sort((a, b) => b.value - a.value)
        .slice(0, 6)
        .reverse(),
    [supplierStats, supplierMap],
  )

  const statusDonut = useMemo(() => {
    const counts = new Map<string, number>()
    for (const po of data?.orders ?? []) counts.set(po.status, (counts.get(po.status) ?? 0) + 1)
    return Object.entries(PO_STATUS)
      .map(([key, meta]) => ({ name: meta.label, value: counts.get(key) ?? 0, color: STATUS_COLOR[key] ?? '#cbd5e1' }))
      .filter((d) => d.value > 0)
  }, [data])

  const priceMoves = useMemo(() => {
    const bySku = new Map<string, Array<{ price: number; date: string; poNo: string; supplier: string }>>()
    for (const item of data?.items ?? []) {
      const po = poMap.get(item.po_id)
      if (!po || po.status === 'cancelled' || po.status === 'draft') continue
      const list = bySku.get(item.sku) ?? []
      list.push({
        price: Number(item.unit_price),
        date: po.order_date,
        poNo: po.po_no,
        supplier: po.supplier_id ? supplierMap.get(po.supplier_id)?.name ?? '—' : '—',
      })
      bySku.set(item.sku, list)
    }
    const rows: Array<{
      sku: string
      last: { price: number; date: string; poNo: string; supplier: string }
      prev: { price: number; date: string; poNo: string; supplier: string }
      diff: number
      pct: number
    }> = []
    for (const [sku, list] of bySku) {
      if (list.length < 2) continue
      list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      const last = list[list.length - 1]
      const prev = list[list.length - 2]
      const diff = last.price - prev.price
      rows.push({ sku, last, prev, diff, pct: prev.price ? (diff / prev.price) * 100 : 0 })
    }
    return rows.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 8)
  }, [data, poMap, supplierMap])

  const analysisSummary = useMemo(() => {
    const months = monthSeries
    const sixMonth = months.reduce((s, m) => s + m.value, 0)
    const thisMonth = months[months.length - 1]?.value ?? 0
    const suppliers = (data?.suppliers ?? []).filter((s) => s.status === 'active')
    const avgLead = suppliers.length
      ? Math.round(suppliers.reduce((s, x) => s + Number(x.lead_time_days), 0) / suppliers.length)
      : 0
    const top = topSuppliers[topSuppliers.length - 1]
    return { sixMonth, thisMonth, supplierCount: suppliers.length, avgLead, topName: top?.name ?? '—', topValue: top?.value ?? 0 }
  }, [monthSeries, data, topSuppliers])

  return (
    <>
      <PageHeader
        title="采购管理"
        description="供应商 → 采购单 → 到货入库，把采购成本与库存串成一条链路"
        actions={
          <>
            <Segmented
              value={tab}
              onChange={(v) => { setTab(v as Tab); setSearch(''); setPage(1) }}
              options={[
                { value: 'orders', label: '采购单' },
                { value: 'suppliers', label: '供应商' },
                { value: 'analysis', label: '采购分析' },
              ]}
            />
            {tab === 'orders' && (
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreatePo}>
                新建采购单
              </Button>
            )}
            {tab === 'suppliers' && (
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreateSupplier}>
                新增供应商
              </Button>
            )}
          </>
        }
      />

      {tab === 'orders' && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            {[
              { label: '在途采购单', value: num(kpi.activeCount), icon: <Truck className="w-4 h-4" />, tone: 'bg-brand-50 text-brand-600' },
              { label: '待收货件数', value: num(kpi.pendingQty), icon: <Container className="w-4 h-4" />, tone: 'bg-blue-50 text-blue-600' },
              { label: '在途金额（CNY）', value: money(kpi.amountCny, 'CNY'), icon: <CircleDollarSign className="w-4 h-4" />, tone: 'bg-emerald-50 text-emerald-600' },
              { label: '逾期未到', value: num(kpi.overdue), icon: <CalendarClock className="w-4 h-4" />, tone: 'bg-rose-50 text-rose-600' },
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

          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
              <SearchInput
                value={search}
                onChange={(v) => { setSearch(v); setPage(1) }}
                placeholder="采购单号 / 供应商 / SKU"
                className="w-full sm:w-60"
              />
              <Select
                className="w-full sm:w-44"
                value={supplierFilter}
                onChange={(v) => { setSupplierFilter(v); setPage(1) }}
                placeholder="全部供应商"
                options={(data?.suppliers ?? []).map((s) => ({ value: s.id, label: s.name }))}
              />
              <Select
                className="w-full sm:w-32"
                value={statusFilter}
                onChange={(v) => { setStatusFilter(v); setPage(1) }}
                placeholder="全部状态"
                options={Object.entries(PO_STATUS).map(([value, v]) => ({ value, label: v.label }))}
              />
              <span className="ml-auto text-[11.5px] text-ink-400">
                共 <span className="num text-ink-700 font-medium">{num(filteredOrders.length)}</span> 张采购单
              </span>
            </div>

            {error ? (
              <ErrorBlock message={error} onRetry={reload} />
            ) : loading ? (
              <LoadingBlock rows={6} />
            ) : pageRows.length === 0 ? (
              <EmptyState
                icon={<Truck className="w-5 h-5" />}
                title={filteredOrders.length ? '没有匹配的采购单' : '还没有采购单'}
                description={
                  filteredOrders.length
                    ? '换个条件试试'
                    : '先新增供应商，再按 SKU 下采购单；到货时登记数量，可直接加进对应仓库的库存。'
                }
                action={
                  <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreatePo}>
                    新建采购单
                  </Button>
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px]">
                  <thead>
                    <tr>
                      <th className="th">采购单号</th>
                      <th className="th">供应商</th>
                      <th className="th">明细</th>
                      <th className="th text-right">金额</th>
                      <th className="th">下单 / 预计到仓</th>
                      <th className="th w-[150px]">收货进度</th>
                      <th className="th">状态</th>
                      <th className="th w-28" />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((po) => {
                      const supplier = po.supplier_id ? supplierMap.get(po.supplier_id) : null
                      const list = itemsOf(po.id)
                      const prog = progressOf(po.id)
                      const meta = PO_STATUS[po.status]
                      const late = po.expected_date && dayDiff(po.expected_date) < 0 && po.status !== 'received' && po.status !== 'cancelled'
                      const canReceive = po.status === 'ordered' || po.status === 'partial'
                      return (
                        <tr key={po.id} className="hover:bg-ink-50/60 group cursor-pointer" onClick={() => setDetailPoId(po.id)}>
                          <td className="td">
                            <p className="text-[12.5px] font-medium text-ink-800 font-mono">{po.po_no}</p>
                            <p className="text-[10.5px] text-ink-400">{po.warehouse}</p>
                          </td>
                          <td className="td">
                            <p className="text-[12px] text-ink-700 truncate max-w-[160px]">{supplier?.name ?? '—'}</p>
                            <p className="text-[10.5px] text-ink-400 truncate max-w-[160px]">{supplier?.contact ?? ''}</p>
                          </td>
                          <td className="td">
                            <p className="text-[12px] text-ink-700">
                              <span className="num">{list.length}</span> 个 SKU · <span className="num">{num(prog.qty)}</span> 件
                            </p>
                            <p className="text-[10.5px] text-ink-400 font-mono truncate max-w-[180px]">
                              {list.slice(0, 2).map((i) => i.sku).join(' / ') || '—'}
                              {list.length > 2 ? ` +${list.length - 2}` : ''}
                            </p>
                          </td>
                          <td className="td text-right">
                            <p className="num font-medium text-ink-800">{money(totalOf(po), po.currency)}</p>
                            {po.currency !== 'CNY' && (
                              <p className="text-[10.5px] text-ink-400 num">≈ {money(cnyOf(po), 'CNY')}</p>
                            )}
                          </td>
                          <td className="td">
                            <p className="text-[11.5px] text-ink-600 num">{fmtDate(po.order_date, 'MM-DD')}</p>
                            <p className={cn('text-[10.5px] num', late ? 'text-rose-600 font-medium' : 'text-ink-400')}>
                              {po.expected_date
                                ? `${fmtDate(po.expected_date, 'MM-DD')}${
                                    po.status === 'ordered' || po.status === 'partial'
                                      ? ` · ${relativeDay(po.expected_date)}`
                                      : ''
                                  }`
                                : '未定'}
                            </p>
                          </td>
                          <td className="td">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                                <div
                                  className={cn('h-full rounded-full', prog.pct >= 100 ? 'bg-emerald-500' : 'bg-brand-500')}
                                  style={{ width: `${prog.pct}%` }}
                                />
                              </div>
                              <span className="num text-[11px] text-ink-500 w-16 text-right">
                                {num(prog.received)}/{num(prog.qty)}
                              </span>
                            </div>
                          </td>
                          <td className="td">
                            <Badge tone={meta?.tone ?? 'gray'}>{meta?.label ?? po.status}</Badge>
                          </td>
                          <td className="td" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              {canReceive && (
                                <button
                                  className="p-1.5 rounded-md text-ink-400 hover:text-emerald-600 hover:bg-emerald-50"
                                  onClick={() => openReceipt(po)}
                                  title="登记到货"
                                >
                                  <PackageCheck className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100" onClick={() => openEditPo(po)} title="编辑">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                data-perm="delete"
                                className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                                onClick={() => setDeletingPo(po)}
                                title="删除"
                              >
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

            {filteredOrders.length > PAGE_SIZE && (
              <Pagination page={page} pageSize={PAGE_SIZE} total={filteredOrders.length} onChange={setPage} />
            )}
          </div>
        </>
      )}

      {tab === 'suppliers' && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            {[
              { label: '供应商总数', value: num((data?.suppliers ?? []).length), icon: <Factory className="w-4 h-4" />, tone: 'bg-brand-50 text-brand-600' },
              { label: '合作中', value: num((data?.suppliers ?? []).filter((s) => s.status === 'active').length), icon: <Building2 className="w-4 h-4" />, tone: 'bg-emerald-50 text-emerald-600' },
              {
                label: '平均交期',
                value: `${num(
                  (data?.suppliers ?? []).length
                    ? Math.round(
                        (data?.suppliers ?? []).reduce((s, x) => s + Number(x.lead_time_days), 0) /
                          (data?.suppliers ?? []).length,
                      )
                    : 0,
                )} 天`,
                icon: <CalendarClock className="w-4 h-4" />,
                tone: 'bg-blue-50 text-blue-600',
              },
              {
                label: '高评级（4★+）',
                value: num((data?.suppliers ?? []).filter((s) => Number(s.rating) >= 4).length),
                icon: <PackageCheck className="w-4 h-4" />,
                tone: 'bg-amber-50 text-amber-600',
              },
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

          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
              <SearchInput
                value={search}
                onChange={(v) => setSearch(v)}
                placeholder="供应商 / 联系人 / 品类"
                className="w-full sm:w-64"
              />
              <span className="ml-auto text-[11.5px] text-ink-400">
                共 <span className="num text-ink-700 font-medium">{num(filteredSuppliers.length)}</span> 家供应商
              </span>
            </div>

            {error ? (
              <ErrorBlock message={error} onRetry={reload} />
            ) : loading ? (
              <LoadingBlock rows={5} />
            ) : filteredSuppliers.length === 0 ? (
              <EmptyState
                icon={<Factory className="w-5 h-5" />}
                title={(data?.suppliers ?? []).length ? '没有匹配的供应商' : '还没有供应商档案'}
                description={
                  (data?.suppliers ?? []).length
                    ? '换个关键词试试'
                    : '把常用工厂 / 贸易商录进来，采购单直接引用，交期与账期一目了然。'
                }
                action={
                  <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreateSupplier}>
                    新增供应商
                  </Button>
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1020px]">
                  <thead>
                    <tr>
                      <th className="th">供应商</th>
                      <th className="th">联系人</th>
                      <th className="th">账期 / 交期</th>
                      <th className="th">评级</th>
                      <th className="th text-right">累计采购额</th>
                      <th className="th text-right">单数</th>
                      <th className="th">状态</th>
                      <th className="th w-20" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSuppliers.map((sup) => {
                      const stat = supplierStats.get(sup.id)
                      const meta = SUPPLIER_STATUS[sup.status]
                      return (
                        <tr key={sup.id} className="hover:bg-ink-50/60 group">
                          <td className="td">
                            <p className="text-[12.5px] font-medium text-ink-800">{sup.name}</p>
                            <p className="text-[10.5px] text-ink-400 truncate max-w-[220px]">
                              {sup.category ? `${sup.category} · ` : ''}
                              {sup.address ?? '—'}
                            </p>
                          </td>
                          <td className="td">
                            <p className="text-[12px] text-ink-700">{sup.contact ?? '—'}</p>
                            <p className="text-[10.5px] text-ink-400 flex items-center gap-1">
                              {sup.phone && <Phone className="w-2.5 h-2.5" />}
                              {sup.phone ?? sup.email ?? ''}
                            </p>
                          </td>
                          <td className="td">
                            <p className="text-[11.5px] text-ink-600">{sup.payment_terms}</p>
                            <p className="text-[10.5px] text-ink-400 num">{sup.lead_time_days} 天交期</p>
                          </td>
                          <td className="td">
                            <span className="text-[11.5px] text-amber-500 tracking-tight">
                              {'★'.repeat(Number(sup.rating) || 0)}
                              <span className="text-ink-200">{'★'.repeat(5 - (Number(sup.rating) || 0))}</span>
                            </span>
                          </td>
                          <td className="td text-right">
                            <p className="num text-[12.5px] text-ink-800">
                              {stat ? money(stat.amountCny, 'CNY') : '—'}
                            </p>
                            {stat?.lastDate && <p className="text-[10px] text-ink-400">最近 {fmtDate(stat.lastDate, 'MM-DD')}</p>}
                          </td>
                          <td className="td text-right num text-ink-600">{stat ? num(stat.count) : '—'}</td>
                          <td className="td">
                            <Badge tone={meta?.tone ?? 'gray'}>{meta?.label ?? sup.status}</Badge>
                          </td>
                          <td className="td">
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100" onClick={() => openEditSupplier(sup)}>
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                data-perm="delete"
                                className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                                onClick={() => setDeletingSup(sup)}
                              >
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
          </div>
        </>
      )}

      {tab === 'analysis' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: '本月采购额（CNY）', value: money(analysisSummary.thisMonth, 'CNY') },
              { label: '近 6 个月累计', value: money(analysisSummary.sixMonth, 'CNY') },
              { label: '采购额最高供应商', value: analysisSummary.topName, sub: money(analysisSummary.topValue, 'CNY') },
              { label: '合作中供应商 / 平均交期', value: `${num(analysisSummary.supplierCount)} 家`, sub: `${num(analysisSummary.avgLead)} 天` },
            ].map((k) => (
              <div key={k.label} className="card px-4 py-3">
                <p className="text-[11px] text-ink-500">{k.label}</p>
                <p className="num text-[17px] font-semibold text-ink-900 leading-tight mt-0.5 truncate">{k.value}</p>
                {k.sub && <p className="text-[10.5px] text-ink-400 num mt-0.5">{k.sub}</p>}
              </div>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-3">
            <div className="card p-4">
              <p className="text-[13px] font-medium text-ink-800">近 6 个月采购额</p>
              <p className="text-[11px] text-ink-400 mb-2">按采购单下单日期归集，折算人民币</p>
              <SimpleBars data={monthSeries} currency="CNY" height={230} />
            </div>
            <div className="card p-4">
              <p className="text-[13px] font-medium text-ink-800">供应商采购额 Top</p>
              <p className="text-[11px] text-ink-400 mb-2">不含草稿与已取消的采购单</p>
              {topSuppliers.length ? (
                <RankBars data={topSuppliers} currency="CNY" height={230} name="采购额" labelWidth={128} />
              ) : (
                <div className="h-[230px] flex items-center justify-center text-[12px] text-ink-400">还没有可分析的采购数据</div>
              )}
            </div>
          </div>

          <div className="grid lg:grid-cols-[300px_1fr] gap-3">
            <div className="card p-4">
              <p className="text-[13px] font-medium text-ink-800 mb-1">采购单状态分布</p>
              {statusDonut.length ? (
                <>
                  <DonutChart
                    data={statusDonut}
                    height={190}
                    centerLabel="采购单"
                    centerValue={num((data?.orders ?? []).length)}
                  />
                  <div className="mt-1 space-y-1">
                    {statusDonut.map((item) => (
                      <div key={item.name} className="flex items-center gap-2 text-[11.5px] text-ink-600">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: item.color }} />
                        <span className="flex-1">{item.name}</span>
                        <span className="num text-ink-800">{num(item.value)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="h-[190px] flex items-center justify-center text-[12px] text-ink-400">暂无采购单</div>
              )}
            </div>

            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-ink-100">
                <p className="text-[13px] font-medium text-ink-800">SKU 采购单价变动</p>
                <p className="text-[11px] text-ink-400">同一个 SKU 最近两次采购价的对比，涨得多的排前面</p>
              </div>
              {priceMoves.length === 0 ? (
                <EmptyState
                  icon={<ArrowUpRight className="w-5 h-5" />}
                  title="数据还不够"
                  description="同一个 SKU 至少要有两次采购记录，才能看出单价是涨还是跌。"
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px]">
                    <thead>
                      <tr>
                        <th className="th">SKU</th>
                        <th className="th text-right">上次单价</th>
                        <th className="th text-right">最近单价</th>
                        <th className="th text-right">变动</th>
                        <th className="th">最近采购单</th>
                      </tr>
                    </thead>
                    <tbody>
                      {priceMoves.map((row) => (
                        <tr key={row.sku} className="hover:bg-ink-50/60">
                          <td className="td font-mono text-[11.5px] text-ink-700">{row.sku}</td>
                          <td className="td text-right num text-ink-500">{money(row.prev.price, 'CNY')}</td>
                          <td className="td text-right num text-ink-800">{money(row.last.price, 'CNY')}</td>
                          <td className="td text-right">
                            <span
                              className={cn(
                                'inline-flex items-center gap-0.5 num text-[12px] font-medium',
                                row.diff > 0 ? 'text-rose-600' : row.diff < 0 ? 'text-emerald-600' : 'text-ink-400',
                              )}
                            >
                              {row.diff > 0 ? <ArrowUpRight className="w-3 h-3" /> : row.diff < 0 ? <ArrowDownRight className="w-3 h-3" /> : null}
                              {row.diff === 0 ? '持平' : `${Math.abs(row.pct).toFixed(1)}%`}
                            </span>
                          </td>
                          <td className="td">
                            <p className="text-[11px] text-ink-600 font-mono">{row.last.poNo}</p>
                            <p className="text-[10px] text-ink-400">{row.last.supplier} · {fmtDate(row.last.date, 'MM-DD')}</p>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------------- 采购单详情 ---------------- */}
      <Modal
        open={!!detailPo}
        onClose={() => setDetailPoId(null)}
        title={detailPo?.po_no ?? '采购单详情'}
        description={
          detailPo
            ? `${detailPo.supplier_id ? supplierMap.get(detailPo.supplier_id)?.name ?? '—' : '未指定供应商'} · 下单 ${fmtDate(detailPo.order_date)}`
            : undefined
        }
        width="max-w-3xl"
        footer={
          <>
            <Button onClick={() => setDetailPoId(null)}>关闭</Button>
            {detailPo && (
              <Button icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => { const po = detailPo; setDetailPoId(null); openEditPo(po) }}>
                编辑
              </Button>
            )}
            {detailPo && (detailPo.status === 'ordered' || detailPo.status === 'partial') && (
              <Button variant="primary" icon={<PackageCheck className="w-3.5 h-3.5" />} onClick={() => { const po = detailPo; setDetailPoId(null); openReceipt(po) }}>
                登记到货
              </Button>
            )}
          </>
        }
      >
        {detailPo && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: '状态', value: PO_STATUS[detailPo.status]?.label ?? detailPo.status },
                { label: '仓库', value: detailPo.warehouse },
                { label: '预计到仓', value: detailPo.expected_date ? `${fmtDate(detailPo.expected_date)}（${relativeDay(detailPo.expected_date)}）` : '未定' },
                { label: '金额合计', value: money(totalOf(detailPo), detailPo.currency) },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-ink-200/70 px-3 py-2">
                  <p className="text-[10.5px] text-ink-400">{s.label}</p>
                  <p className="text-[12.5px] font-medium text-ink-900 mt-0.5 truncate">{s.value}</p>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-ink-200/70 overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">SKU / 商品</th>
                    <th className="th text-right">数量</th>
                    <th className="th text-right">单价</th>
                    <th className="th text-right">小计</th>
                    <th className="th w-[120px]">已到</th>
                  </tr>
                </thead>
                <tbody>
                  {itemsOf(detailPo.id).map((item) => (
                    <tr key={item.id} className="hover:bg-ink-50/60">
                      <td className="td">
                        <p className="text-[12px] font-mono text-ink-800">{item.sku}</p>
                        <p className="text-[10.5px] text-ink-400 truncate max-w-[260px]">{item.title ?? '—'}</p>
                      </td>
                      <td className="td text-right num">{num(item.quantity)}</td>
                      <td className="td text-right num text-ink-600">{money(item.unit_price, detailPo.currency)}</td>
                      <td className="td text-right num font-medium">{money(Number(item.quantity) * Number(item.unit_price), detailPo.currency)}</td>
                      <td className="td">
                        <div className="flex items-center gap-1.5">
                          <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-emerald-500"
                              style={{ width: `${Math.min(100, (Number(item.received_qty) / Math.max(1, Number(item.quantity))) * 100)}%` }}
                            />
                          </div>
                          <span className="num text-[10.5px] text-ink-500 w-14 text-right">
                            {num(item.received_qty)}/{num(item.quantity)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-ink-50/60">
                    <td className="td text-[11.5px] text-ink-500" colSpan={3}>
                      运费 {money(detailPo.shipping_fee, detailPo.currency)} · 其他 {money(detailPo.other_fee, detailPo.currency)}
                    </td>
                    <td className="td text-right num font-semibold text-ink-900">{money(totalOf(detailPo), detailPo.currency)}</td>
                    <td className="td" />
                  </tr>
                </tfoot>
              </table>
            </div>

            {detailPo.note && (
              <div className="rounded-lg bg-ink-50 border border-ink-100 px-3 py-2 text-[11.5px] text-ink-600 whitespace-pre-wrap">
                {detailPo.note}
              </div>
            )}
            {detailPo.currency !== 'CNY' && (
              <p className="text-[11px] text-ink-400">
                按当前汇率折算约 <span className="num text-ink-600">{money(cnyOf(detailPo), 'CNY')}</span>
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* ---------------- 新建 / 编辑采购单 ---------------- */}
      <Modal
        open={poOpen}
        onClose={() => setPoOpen(false)}
        title={editingPo ? '编辑采购单' : '新建采购单'}
        description="明细里选商品会自动带出 SKU 与档案成本，数量与单价可覆盖"
        width="max-w-4xl"
        footer={
          <>
            <Button onClick={() => setPoOpen(false)}>取消</Button>
            <Button variant="primary" onClick={handleSavePo} loading={savingPo}>
              保存
            </Button>
          </>
        }
      >
        <div className="grid sm:grid-cols-4 gap-3">
          <Field label="采购单号" required>
            <input className="input font-mono" value={poDraft.po_no} onChange={(e) => setPoDraft({ ...poDraft, po_no: e.target.value })} />
          </Field>
          <Field label="供应商">
            <Select
              value={poDraft.supplier_id}
              onChange={(v) => setPoDraft({ ...poDraft, supplier_id: v })}
              placeholder="未指定"
              options={(data?.suppliers ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
          <Field label="归属店铺" hint="同步库存时需要">
            <Select
              value={poDraft.store_id}
              onChange={(v) => setPoDraft({ ...poDraft, store_id: v })}
              placeholder="不指定"
              options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
          <Field label="收货仓库">
            <Select
              value={poDraft.warehouse}
              onChange={(v) => setPoDraft({ ...poDraft, warehouse: v })}
              options={PURCHASE_WAREHOUSES.map((w) => ({ value: w, label: w }))}
            />
          </Field>

          <Field label="下单日期">
            <input className="input" type="date" value={poDraft.order_date} onChange={(e) => setPoDraft({ ...poDraft, order_date: e.target.value })} />
          </Field>
          <Field label="预计到仓">
            <input className="input" type="date" value={poDraft.expected_date} onChange={(e) => setPoDraft({ ...poDraft, expected_date: e.target.value })} />
          </Field>
          <Field label="币种">
            <Select
              value={poDraft.currency}
              onChange={(v) => setPoDraft({ ...poDraft, currency: v })}
              options={CURRENCY_OPTIONS.map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="状态">
            <Select
              value={poDraft.status}
              onChange={(v) => setPoDraft({ ...poDraft, status: v as PurchaseStatus })}
              options={Object.entries(PO_STATUS).map(([value, v]) => ({ value, label: v.label }))}
            />
          </Field>

          <div className="sm:col-span-4">
            <div className="flex items-center justify-between mb-1.5">
              <label className="label !mb-0">采购明细</label>
              <Button size="sm" icon={<Plus className="w-3 h-3" />} onClick={() => setItemDrafts((prev) => [...prev, emptyItem()])}>
                添加一行
              </Button>
            </div>

            <div className="rounded-lg border border-ink-200/70 overflow-hidden">
              <div className="grid grid-cols-[1fr_76px_96px_96px_28px] gap-2 px-3 py-2 bg-ink-50/70 text-[10.5px] font-semibold uppercase tracking-wide text-ink-500">
                <span>商品 / SKU</span>
                <span className="text-right">数量</span>
                <span className="text-right">单价</span>
                <span className="text-right">小计</span>
                <span />
              </div>
              <div className="divide-y divide-ink-100 max-h-[300px] overflow-y-auto">
                {itemDrafts.map((row, index) => (
                  <div key={row.key} className="grid grid-cols-[1fr_76px_96px_96px_28px] gap-2 px-3 py-2 items-start">
                    <div className="min-w-0">
                      <Select
                        value={row.product_id}
                        onChange={(v) => pickItemProduct(index, v)}
                        placeholder="选择商品，或下方手填 SKU"
                        options={(data?.products ?? []).map((p) => ({
                          value: p.id,
                          label: `${p.sku} · ${p.title.slice(0, 26)}`,
                        }))}
                      />
                      {row.product_id ? (
                        <p className="mt-1 text-[10px] text-ink-400 font-mono truncate">{row.sku}</p>
                      ) : (
                        <input
                          className="input mt-1 h-8 font-mono text-[12px]"
                          placeholder="SKU"
                          value={row.sku}
                          onChange={(e) => updateItem(index, { sku: e.target.value })}
                        />
                      )}
                    </div>
                    <input
                      className="input h-9 text-right num !px-2"
                      type="number"
                      min="1"
                      value={row.quantity}
                      onChange={(e) => updateItem(index, { quantity: e.target.value })}
                    />
                    <input
                      className="input h-9 text-right num !px-2"
                      type="number"
                      step="0.01"
                      value={row.unit_price}
                      onChange={(e) => updateItem(index, { unit_price: e.target.value })}
                    />
                    <div className="h-9 flex items-center justify-end num text-[12.5px] text-ink-700">
                      {money((Number(row.quantity) || 0) * (Number(row.unit_price) || 0), poDraft.currency)}
                    </div>
                    <button
                      className="h-9 flex items-center justify-center rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                      onClick={() => setItemDrafts((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))}
                      title="删除此行"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <Field label="运费 / 头程">
            <input className="input num" type="number" step="0.01" value={poDraft.shipping_fee} onChange={(e) => setPoDraft({ ...poDraft, shipping_fee: e.target.value })} />
          </Field>
          <Field label="其他费用">
            <input className="input num" type="number" step="0.01" value={poDraft.other_fee} onChange={(e) => setPoDraft({ ...poDraft, other_fee: e.target.value })} />
          </Field>
          <div className="sm:col-span-2 rounded-lg bg-ink-50 border border-ink-100 px-3 py-2 self-end">
            <p className="text-[10.5px] text-ink-400">
              合计（明细 {money(draftItemSum, poDraft.currency)} + 运费与其他）
            </p>
            <p className="num text-[15px] font-semibold text-ink-900">{money(draftTotal, poDraft.currency)}</p>
          </div>

          <Field label="备注" className="sm:col-span-4">
            <textarea
              className="textarea"
              rows={2}
              value={poDraft.note}
              onChange={(e) => setPoDraft({ ...poDraft, note: e.target.value })}
              placeholder="交期约定、验货要求、付款条件…"
            />
          </Field>
        </div>
      </Modal>

      {/* ---------------- 登记到货 ---------------- */}
      <Modal
        open={!!receiptPo}
        onClose={() => setReceiptId(null)}
        title="登记到货"
        description={receiptPo ? `${receiptPo.po_no} · 未到数量已预填，按实际到货修改` : undefined}
        width="max-w-2xl"
        footer={
          <>
            <Button onClick={() => setReceiptId(null)}>取消</Button>
            <Button variant="primary" onClick={handleReceive} loading={receiving} icon={<ClipboardCheck className="w-3.5 h-3.5" />}>
              确认收货
            </Button>
          </>
        }
      >
        {receiptPo && (
          <div className="space-y-3">
            <div className="rounded-lg border border-ink-200/70 overflow-hidden">
              <div className="grid grid-cols-[1fr_56px_56px_78px] gap-2 px-3 py-2 bg-ink-50/70 text-[10.5px] font-semibold uppercase tracking-wide text-ink-500">
                <span>SKU</span>
                <span className="text-right">订购</span>
                <span className="text-right">已到</span>
                <span className="text-right">本次到货</span>
              </div>
              <div className="divide-y divide-ink-100 max-h-[280px] overflow-y-auto">
                {receiptItems.map((item) => {
                  const remain = Math.max(0, Number(item.quantity) - Number(item.received_qty))
                  return (
                    <div key={item.id} className="grid grid-cols-[1fr_56px_56px_78px] gap-2 px-3 py-2 items-center">
                      <div className="min-w-0">
                        <p className="text-[12px] font-mono text-ink-800 truncate">{item.sku}</p>
                        <p className="text-[10px] text-ink-400 truncate">{item.title ?? '—'}</p>
                      </div>
                      <span className="text-right num text-[12px] text-ink-600">{num(item.quantity)}</span>
                      <span className="text-right num text-[12px] text-ink-400">{num(item.received_qty)}</span>
                      <input
                        className="input h-8 text-right num !px-2"
                        type="number"
                        min="0"
                        max={remain}
                        value={receiptRows[item.id] ?? ''}
                        disabled={remain === 0}
                        onChange={(e) => setReceiptRows((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      />
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="入库仓库" hint="同店铺 + SKU + 仓库会累加到可售库存">
                <Select
                  value={receiptWarehouse}
                  onChange={setReceiptWarehouse}
                  options={PURCHASE_WAREHOUSES.map((w) => ({ value: w, label: w }))}
                />
              </Field>
              <div className="flex items-start pt-6">
                <label className="flex items-center gap-2 text-[12px] text-ink-600 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5 accent-brand-600"
                    checked={syncStock}
                    disabled={!receiptPo.store_id}
                    onChange={(e) => setSyncStock(e.target.checked)}
                  />
                  同步到库存可售数量
                  {!receiptPo.store_id && <span className="text-[11px] text-rose-500">（采购单未指定店铺）</span>}
                </label>
              </div>
            </div>

            <p className="text-[11px] text-ink-500 leading-relaxed">
              收货会把到货数量累加到明细的「已到」，全部到齐后采购单状态自动变为「已入库」。
              同步库存时不会改动商品档案成本；如需更新成本，请到「商品管理」调整。
            </p>
          </div>
        )}
      </Modal>

      {/* ---------------- 供应商表单 ---------------- */}
      <Modal
        open={supOpen}
        onClose={() => setSupOpen(false)}
        title={editingSup ? '编辑供应商' : '新增供应商'}
        width="max-w-2xl"
        footer={
          <>
            <Button onClick={() => setSupOpen(false)}>取消</Button>
            <Button variant="primary" onClick={handleSaveSupplier} loading={savingSup}>
              保存
            </Button>
          </>
        }
      >
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="供应商名称" required className="sm:col-span-2">
            <input className="input" value={supDraft.name} onChange={(e) => setSupDraft({ ...supDraft, name: e.target.value })} placeholder="如 东莞恒美家居制品厂" />
          </Field>
          <Field label="主营品类">
            <input className="input" value={supDraft.category} onChange={(e) => setSupDraft({ ...supDraft, category: e.target.value })} placeholder="如 竹木餐厨" />
          </Field>
          <Field label="联系人">
            <input className="input" value={supDraft.contact} onChange={(e) => setSupDraft({ ...supDraft, contact: e.target.value })} placeholder="王经理" />
          </Field>
          <Field label="电话 / 微信">
            <input className="input" value={supDraft.phone} onChange={(e) => setSupDraft({ ...supDraft, phone: e.target.value })} placeholder="138…" />
          </Field>
          <Field label="邮箱">
            <input className="input" value={supDraft.email} onChange={(e) => setSupDraft({ ...supDraft, email: e.target.value })} placeholder="sales@…" />
          </Field>
          <Field label="地址" className="sm:col-span-2">
            <input className="input" value={supDraft.address} onChange={(e) => setSupDraft({ ...supDraft, address: e.target.value })} placeholder="工厂 / 发货地址" />
          </Field>
          <Field label="账期">
            <Select
              value={supDraft.payment_terms}
              onChange={(v) => setSupDraft({ ...supDraft, payment_terms: v })}
              options={PAYMENT_TERMS.map((t) => ({ value: t, label: t }))}
            />
          </Field>
          <Field label="交期（天）" hint="从下单到可发货的平均天数">
            <input className="input num" type="number" value={supDraft.lead_time_days} onChange={(e) => setSupDraft({ ...supDraft, lead_time_days: e.target.value })} />
          </Field>
          <Field label="评级">
            <Select
              value={supDraft.rating}
              onChange={(v) => setSupDraft({ ...supDraft, rating: v })}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${'★'.repeat(n)} ${n} 分` }))}
            />
          </Field>
          <Field label="合作状态">
            <Select
              value={supDraft.status}
              onChange={(v) => setSupDraft({ ...supDraft, status: v as 'active' | 'paused' })}
              options={Object.entries(SUPPLIER_STATUS).map(([value, v]) => ({ value, label: v.label }))}
            />
          </Field>
          <Field label="备注" className="sm:col-span-2">
            <textarea className="textarea" rows={2} value={supDraft.note} onChange={(e) => setSupDraft({ ...supDraft, note: e.target.value })} placeholder="起订量、开票能力、验厂情况…" />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deletingPo}
        onClose={() => setDeletingPo(null)}
        onConfirm={handleDeletePo}
        loading={confirmLoading}
        title="删除采购单"
        message={`确定删除 ${deletingPo?.po_no ?? ''} 吗？该单的采购明细会一起删除，已同步到库存的数量不会回滚。`}
      />

      <ConfirmDialog
        open={!!deletingSup}
        onClose={() => setDeletingSup(null)}
        onConfirm={handleDeleteSupplier}
        loading={confirmLoading}
        title="删除供应商"
        message={`确定删除「${deletingSup?.name ?? ''}」吗？历史采购单会保留，但不再关联这家供应商。`}
      />
    </>
  )
}
