import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Award,
  Building2,
  ChevronRight,
  Download,
  Factory,
  FileText,
  Globe2,
  Pencil,
  Plus,
  Receipt,
  Star,
  Trash2,
  TrendingUp,
  Truck,
  Upload,
  UserRound,
  Wallet,
} from 'lucide-react'
import dayjs from 'dayjs'
import { callRpc, deleteRow, deleteWhere, fetchRows, insertRow, insertRows, updateRow } from '../lib/db'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../context/AuthContext'
import { convert, useFx } from '../lib/fx'
import { cn, downloadTextFile, fmtDate, money, num, toCsv } from '../lib/utils'
import type {
  Product,
  PurchaseItem,
  PurchaseOrder,
  Supplier,
  SupplierContact,
  SupplierProduct,
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

/* ------------------------------------------------------------------ */
/*  常量与工具                                                          */
/* ------------------------------------------------------------------ */

const PAGE_SIZE = 12

const CATALOG = [
  '竹木餐厨',
  '陶瓷餐具',
  '家居家纺',
  '护肤美妆',
  '3C 电子',
  '服装配饰',
  '户外运动',
  '宠物用品',
  '包装耗材',
  '其他',
]

const PAY_TERMS = ['现结', '预付 30%', '预付 50%', '30 天账期', '45 天账期', '60 天账期', '货到付款']

const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: '合作中', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200/60' },
  paused: { label: '暂停合作', cls: 'bg-ink-100 text-ink-500 border-ink-200/60' },
}

function StarRow({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`评分 ${value}/5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn('w-3 h-3', n <= value ? 'fill-amber-400 text-amber-400' : 'text-ink-200')}
        />
      ))}
    </span>
  )
}

interface DirectoryRow {
  id: string
  full_name: string | null
  email: string | null
  status: string
  employment_status: string
}

/** 供应商维度的供货绩效，全部由采购单 / 明细 / 付款 汇总而来 */
interface SupplierStat {
  supplierId: string
  orders: number
  amount: number
  paid: number
  unpaid: number
  qty: number
  onTime: number
  onTimeTotal: number
  lastOrderAt: string | null
}

interface SupForm {
  id?: string
  code: string
  name: string
  contact: string
  contact_title: string
  phone: string
  fax: string
  email: string
  website: string
  country: string
  city: string
  address: string
  category: string
  tags: string
  payment_terms: string
  lead_time_days: string
  rating: string
  qualification: string
  tax_no: string
  bank_name: string
  bank_account: string
  owner_id: string
  cooperation_since: string
  status: 'active' | 'paused'
  note: string
}

const EMPTY_SUP: SupForm = {
  code: '',
  name: '',
  contact: '',
  contact_title: '',
  phone: '',
  fax: '',
  email: '',
  website: '',
  country: '',
  city: '',
  address: '',
  category: '',
  tags: '',
  payment_terms: '现结',
  lead_time_days: '30',
  rating: '3',
  qualification: '',
  tax_no: '',
  bank_name: '',
  bank_account: '',
  owner_id: '',
  cooperation_since: '',
  status: 'active',
  note: '',
}

interface SpForm {
  /** 前端行标识，批量编辑时用 */
  key: string
  id?: string
  supplier_id: string
  product_id: string
  sku: string
  title: string
  unit: string
  currency: string
  unit_cost: string
  moq: string
  lead_time_days: string
  status: 'active' | 'paused'
  note: string
}

const EMPTY_SP: SpForm = {
  key: '',
  supplier_id: '',
  product_id: '',
  sku: '',
  title: '',
  unit: '件',
  currency: 'CNY',
  unit_cost: '0',
  moq: '1',
  lead_time_days: '30',
  status: 'active',
  note: '',
}

/* ---------------- 多联系人 / 多商品编辑助手 ---------------- */

let rowSeq = 0
/** 前端临时行 ID（新建记录还没数据库 id 时使用） */
function uid() {
  rowSeq += 1
  return `row-${Date.now().toString(36)}-${rowSeq}`
}

interface ContactForm {
  key: string
  id?: string
  name: string
  title: string
  phone: string
  mobile: string
  email: string
  im: string
  is_primary: boolean
  note: string
}

function newContactForm(primary = false): ContactForm {
  return {
    key: uid(),
    name: '',
    title: '',
    phone: '',
    mobile: '',
    email: '',
    im: '',
    is_primary: primary,
    note: '',
  }
}

function contactFromRow(c: SupplierContact): ContactForm {
  return {
    key: c.id,
    id: c.id,
    name: c.name,
    title: c.title ?? '',
    phone: c.phone ?? '',
    mobile: c.mobile ?? '',
    email: c.email ?? '',
    im: c.im ?? '',
    is_primary: c.is_primary,
    note: c.note ?? '',
  }
}

function newSpForm(): SpForm {
  return { ...EMPTY_SP, key: uid() }
}

function spFromRow(sp: SupplierProduct): SpForm {
  return {
    ...EMPTY_SP,
    key: sp.id,
    id: sp.id,
    supplier_id: sp.supplier_id,
    product_id: sp.product_id ?? '',
    sku: sp.sku,
    title: sp.title ?? '',
    unit: sp.unit,
    currency: sp.currency,
    unit_cost: String(sp.unit_cost),
    moq: String(sp.moq),
    lead_time_days: String(sp.lead_time_days),
    status: sp.status,
    note: sp.note ?? '',
  }
}

/* ------------------------------------------------------------------ */

export default function Suppliers() {
  const { push } = useToast()
  const { user, can } = useAuth()
  const canEdit = can('purchase.edit')
  const fx = useFx()
  const [searchParams, setSearchParams] = useSearchParams()

  const [view, setView] = useState<'suppliers' | 'products' | 'analysis'>('suppliers')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [category, setCategory] = useState('')
  const [page, setPage] = useState(1)

  const [supOpen, setSupOpen] = useState(false)
  const [supForm, setSupForm] = useState<SupForm>(EMPTY_SUP)
  /** 一次编辑里可维护多个联系人 + 多款可供商品 */
  const [supContacts, setSupContacts] = useState<ContactForm[]>([])
  const [supProducts, setSupProducts] = useState<SpForm[]>([])
  const [supSaving, setSupSaving] = useState(false)
  const [spOpen, setSpOpen] = useState(false)
  const [spForm, setSpForm] = useState<SpForm>(EMPTY_SP)
  const [spSaving, setSpSaving] = useState(false)
  const [detail, setDetail] = useState<Supplier | null>(null)
  const [deletingSup, setDeletingSup] = useState<Supplier | null>(null)
  const [deletingSp, setDeletingSp] = useState<SupplierProduct | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [productSupplier, setProductSupplier] = useState('')

  const { data, loading, error, reload } = useAsync(async () => {
    const [suppliers, products, supplierProducts, contacts, pos, items, directory] = await Promise.all([
      fetchRows<Supplier>('suppliers', { order: { column: 'created_at' } }),
      fetchRows<Product>('products', { order: { column: 'created_at' } }),
      fetchRows<SupplierProduct>('supplier_products', { order: { column: 'created_at' } }).catch(
        () => [] as SupplierProduct[],
      ),
      fetchRows<SupplierContact>('supplier_contacts', { order: { column: 'created_at' } }).catch(
        () => [] as SupplierContact[],
      ),
      fetchRows<PurchaseOrder>('purchase_orders', { order: { column: 'order_date', ascending: false } }),
      fetchRows<PurchaseItem>('purchase_items'),
      callRpc<DirectoryRow[]>('team_directory').catch(() => [] as DirectoryRow[]),
    ])
    return { suppliers, products, supplierProducts, contacts, pos, items, directory }
  }, [])

  // 从采购页「完善档案」跳转过来时，数据就绪后直接打开对应供应商档案
  const openedFromQuery = useRef<string | null>(null)
  useEffect(() => {
    const id = searchParams.get('edit')
    if (!id || !data || openedFromQuery.current === id) return
    const target = data.suppliers.find((s) => s.id === id)
    if (!target) return
    openedFromQuery.current = id
    setView('suppliers')
    // 只读岗位跳过来时打开详情，不给他们展示保存不了的编辑弹窗
    if (canEdit) openEdit(target)
    else setDetail(target)
    setSearchParams({}, { replace: true })
    // openEdit 每次渲染都会重建，这里只需在参数或数据变化时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, data, canEdit])

  const supplierMap = useMemo(
    () => new Map((data?.suppliers ?? []).map((s) => [s.id, s])),
    [data],
  )
  const productMap = useMemo(
    () => new Map((data?.products ?? []).map((p) => [p.id, p])),
    [data],
  )
  const contactsBySupplier = useMemo(() => {
    const map = new Map<string, SupplierContact[]>()
    for (const c of data?.contacts ?? []) {
      const list = map.get(c.supplier_id) ?? []
      list.push(c)
      map.set(c.supplier_id, list)
    }
    return map
  }, [data])

  const memberMap = useMemo(
    () => new Map((data?.directory ?? []).map((m) => [m.id, m])),
    [data],
  )
  const memberOptions = useMemo(
    () =>
      (data?.directory ?? [])
        .filter((m) => m.status === 'active' && (m.employment_status ?? 'active') === 'active')
        .map((m) => ({ value: m.id, label: m.full_name || m.email || '未命名' })),
    [data],
  )

  const itemsByPo = useMemo(() => {
    const map = new Map<string, PurchaseItem[]>()
    for (const it of data?.items ?? []) {
      const list = map.get(it.po_id) ?? []
      list.push(it)
      map.set(it.po_id, list)
    }
    return map
  }, [data])

  /** 每个供应商的采购额 / 付款 / 到货 / 准时率 */
  const stats = useMemo(() => {
    const map = new Map<string, SupplierStat>()
    const bucket = (id: string) => {
      let s = map.get(id)
      if (!s) {
        s = {
          supplierId: id,
          orders: 0,
          amount: 0,
          paid: 0,
          unpaid: 0,
          qty: 0,
          onTime: 0,
          onTimeTotal: 0,
          lastOrderAt: null,
        }
        map.set(id, s)
      }
      return s
    }
    for (const po of data?.pos ?? []) {
      if (!po.supplier_id || po.status === 'cancelled') continue
      const s = bucket(po.supplier_id)
      const items = itemsByPo.get(po.id) ?? []
      const amount =
        items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.unit_price), 0) +
        Number(po.shipping_fee || 0) +
        Number(po.other_fee || 0)
      s.orders += 1
      s.amount += convert(amount, po.currency, 'CNY', fx)
      s.paid += convert(Number(po.paid_amount || 0), po.currency, 'CNY', fx)
      s.unpaid = Math.max(0, s.amount - s.paid)
      const received = items.reduce((sum, i) => sum + Number(i.received_qty || 0), 0)
      s.qty += received
      if (po.expected_date && po.received_at) {
        s.onTimeTotal += 1
        if (dayjs(po.received_at).isBefore(dayjs(po.expected_date).add(1, 'day'))) s.onTime += 1
      }
      if (!s.lastOrderAt || po.order_date > s.lastOrderAt) s.lastOrderAt = po.order_date
    }
    return map
  }, [data, itemsByPo, fx])

  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase()
    return (data?.suppliers ?? []).filter((s) => {
      if (status && s.status !== status) return false
      if (category && s.category !== category) return false
      if (!kw) return true
      return [
        s.name,
        s.code ?? '',
        s.contact ?? '',
        s.phone ?? '',
        s.email ?? '',
        s.category ?? '',
        ...(s.tags ?? []),
        ...(contactsBySupplier.get(s.id) ?? []).flatMap((c) => [
          c.name,
          c.title ?? '',
          c.phone ?? '',
          c.mobile ?? '',
          c.email ?? '',
          c.im ?? '',
        ]),
      ]
        .join(' ')
        .toLowerCase()
        .includes(kw)
    })
  }, [data, query, status, category, contactsBySupplier])

  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const spRows = useMemo(() => {
    const kw = query.trim().toLowerCase()
    return (data?.supplierProducts ?? []).filter((sp) => {
      if (productSupplier && sp.supplier_id !== productSupplier) return false
      if (!kw) return true
      return [sp.sku, sp.title ?? '', supplierMap.get(sp.supplier_id)?.name ?? '']
        .join(' ')
        .toLowerCase()
        .includes(kw)
    })
  }, [data, query, productSupplier, supplierMap])

  const ranked = useMemo(
    () =>
      (data?.suppliers ?? [])
        .map((s) => ({ supplier: s, stat: stats.get(s.id) }))
        .filter((x) => x.stat && x.stat.orders > 0)
        .sort((a, b) => (b.stat?.amount ?? 0) - (a.stat?.amount ?? 0)),
    [data, stats],
  )

  const totalAmount = useMemo(
    () => Array.from(stats.values()).reduce((s, x) => s + x.amount, 0),
    [stats],
  )
  const totalUnpaid = useMemo(
    () => Array.from(stats.values()).reduce((s, x) => s + x.unpaid, 0),
    [stats],
  )

  /* ---------------- 供应商档案 ---------------- */

  function openCreate() {
    setSupForm({ ...EMPTY_SUP, owner_id: user?.id ?? '' })
    setSupContacts([newContactForm(true)])
    setSupProducts([])
    setSupOpen(true)
  }

  function openEdit(s: Supplier) {
    setSupForm({
      id: s.id,
      code: s.code ?? '',
      name: s.name,
      contact: s.contact ?? '',
      contact_title: s.contact_title ?? '',
      phone: s.phone ?? '',
      fax: s.fax ?? '',
      email: s.email ?? '',
      website: s.website ?? '',
      country: s.country ?? '',
      city: s.city ?? '',
      address: s.address ?? '',
      category: s.category ?? '',
      tags: (s.tags ?? []).join('、'),
      payment_terms: s.payment_terms,
      lead_time_days: String(s.lead_time_days),
      rating: String(s.rating),
      qualification: s.qualification ?? '',
      tax_no: s.tax_no ?? '',
      bank_name: s.bank_name ?? '',
      bank_account: s.bank_account ?? '',
      owner_id: s.owner_id ?? '',
      cooperation_since: s.cooperation_since ?? '',
      status: s.status,
      note: s.note ?? '',
    })
    const saved = (data?.contacts ?? []).filter((c) => c.supplier_id === s.id).map(contactFromRow)
    // 旧库还没迁移联系人时，把主表里的单一联系人快照先显示在第一行
    setSupContacts(
      saved.length
        ? saved
        : s.contact
          ? [
              {
                ...newContactForm(true),
                name: s.contact,
                title: s.contact_title ?? '',
                phone: s.phone ?? '',
                email: s.email ?? '',
              },
            ]
          : [newContactForm(true)],
    )
    setSupProducts(
      (data?.supplierProducts ?? []).filter((sp) => sp.supplier_id === s.id).map(spFromRow),
    )
    setSupOpen(true)
  }

  /** 设为主联系人时自动取消其他行的主标记 */
  function updateContact(key: string, patch: Partial<ContactForm>) {
    setSupContacts((list) =>
      list.map((c) => {
        if (c.key !== key) return patch.is_primary ? { ...c, is_primary: false } : c
        return { ...c, ...patch }
      }),
    )
  }

  async function saveSupplier() {
    if (!supForm.name.trim()) return push('请填写供应商名称', 'error')

    // 完全空白的行直接忽略；填了联系方式却没姓名要拦住，避免脏数据
    const activeContacts = supContacts.filter((c) =>
      [c.name, c.title, c.phone, c.mobile, c.email, c.im, c.note].some((v) => v.trim()),
    )
    if (activeContacts.some((c) => !c.name.trim()))
      return push('联系人已填写联系方式，请补上姓名', 'error')
    if (activeContacts.some((c) => c.email.trim() && !/^\S+@\S+\.\S+$/.test(c.email.trim())))
      return push('联系人邮箱格式不正确', 'error')

    const activeProducts = supProducts.filter((sp) =>
      [sp.sku, sp.title, sp.unit_cost, sp.product_id].some((v) => String(v).trim()),
    )
    if (activeProducts.some((sp) => !sp.sku.trim()))
      return push('可供产品已填写内容，请补上 SKU', 'error')
    const skus = activeProducts.map((sp) => sp.sku.trim().toLowerCase())
    if (new Set(skus).size !== skus.length) return push('同一供应商下 SKU 不能重复', 'error')

    const primary = activeContacts.find((c) => c.is_primary) ?? activeContacts[0]
    const nowIso = new Date().toISOString()
    setSupSaving(true)
    try {
      const payload = {
        code: supForm.code.trim() || null,
        name: supForm.name.trim(),
        // 主联系人快照同步回主表：列表、采购简版与旧数据都按这份快速展示
        contact: primary?.name.trim() || null,
        contact_title: primary?.title.trim() || null,
        phone: primary?.mobile.trim() || primary?.phone.trim() || null,
        fax: supForm.fax.trim() || null,
        email: primary?.email.trim() || null,
        website: supForm.website.trim() || null,
        country: supForm.country.trim() || null,
        city: supForm.city.trim() || null,
        address: supForm.address.trim() || null,
        category: supForm.category.trim() || null,
        tags: supForm.tags
          .split(/[、,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
        payment_terms: supForm.payment_terms,
        lead_time_days: Math.max(0, Math.round(Number(supForm.lead_time_days) || 0)),
        rating: Math.min(5, Math.max(1, Math.round(Number(supForm.rating) || 3))),
        qualification: supForm.qualification.trim() || null,
        tax_no: supForm.tax_no.trim() || null,
        bank_name: supForm.bank_name.trim() || null,
        bank_account: supForm.bank_account.trim() || null,
        owner_id: supForm.owner_id || null,
        cooperation_since: supForm.cooperation_since || null,
        status: supForm.status,
        note: supForm.note.trim() || null,
        updated_at: nowIso,
      }
      let supplierId = supForm.id
      if (supplierId) {
        await updateRow<Supplier>('suppliers', supplierId, payload)
      } else {
        const created = await insertRow<Supplier>('suppliers', { ...payload, user_id: user?.id })
        supplierId = created.id
      }

      let warning = ''
      // 联系人：编辑时先清再插，保证删除联系人 / 换主联系人都能落库
      try {
        if (supplierId) {
          if (supForm.id) await deleteWhere('supplier_contacts', 'supplier_id', supplierId)
          const rows = activeContacts.map((c) => ({
            supplier_id: supplierId,
            user_id: user?.id,
            name: c.name.trim(),
            title: c.title.trim() || null,
            phone: c.phone.trim() || null,
            mobile: c.mobile.trim() || null,
            email: c.email.trim() || null,
            im: c.im.trim() || null,
            is_primary: primary ? c.key === primary.key : false,
            note: c.note.trim() || null,
            updated_at: nowIso,
          }))
          if (rows.length) await insertRows('supplier_contacts', rows)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        warning = /could not find the table|relation .* does not exist|column .* does not exist/i.test(msg)
          ? '联系人（系统升级中，请联系管理员）'
          : '联系人'
      }

      // 可供产品：有 id 的更新、新增的插入、被移除的删除
      try {
        if (supplierId) {
          const keep = new Set(activeProducts.filter((p) => p.id).map((p) => p.id as string))
          if (supForm.id) {
            const oldIds = (data?.supplierProducts ?? [])
              .filter((sp) => sp.supplier_id === supplierId)
              .map((sp) => sp.id)
            for (const id of oldIds) if (!keep.has(id)) await deleteRow('supplier_products', id)
          }
          const spPayload = (sp: SpForm) => ({
            supplier_id: supplierId,
            product_id: sp.product_id || null,
            sku: sp.sku.trim(),
            title: sp.title.trim() || null,
            unit: sp.unit.trim() || '件',
            currency: sp.currency,
            unit_cost: Math.max(0, Number(sp.unit_cost) || 0),
            moq: Math.max(1, Math.round(Number(sp.moq) || 1)),
            lead_time_days: Math.max(0, Math.round(Number(sp.lead_time_days) || 0)),
            status: sp.status,
            note: sp.note.trim() || null,
            updated_at: nowIso,
          })
          for (const p of activeProducts.filter((x) => x.id))
            await updateRow('supplier_products', p.id as string, spPayload(p))
          const fresh = activeProducts.filter((x) => !x.id)
          if (fresh.length)
            await insertRows(
              'supplier_products',
              fresh.map((p) => ({ ...spPayload(p), user_id: user?.id })),
            )
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        const needUpgrade = /could not find the table|relation .* does not exist|column .* does not exist/i.test(msg)
        warning = warning
          ? '联系人与可供产品'
          : needUpgrade
            ? '可供产品（系统升级中，请联系管理员）'
            : '可供产品'
      }

      if (warning) {
        push(
          `${supForm.id ? '档案已更新' : '供应商已创建'}，但${warning}未能保存，请重新打开档案重试`,
          'error',
        )
      } else {
        push(
          supForm.id
            ? '供应商档案、联系人与可供产品已更新'
            : `供应商已创建（${activeContacts.length} 位联系人 / ${activeProducts.length} 款商品）`,
        )
      }
      setSupOpen(false)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate|unique/i.test(msg) ? '名称或编码已存在' : msg, 'error')
    } finally {
      setSupSaving(false)
    }
  }

  async function removeSupplier() {
    if (!deletingSup) return
    setConfirming(true)
    try {
      await deleteRow('suppliers', deletingSup.id)
      push('供应商已删除，历史采购单保留但不再关联')
      if (detail?.id === deletingSup.id) setDetail(null)
      setDeletingSup(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirming(false)
    }
  }

  /* ---------------- 可供产品 ---------------- */

  function openSpCreate(supplierId?: string) {
    setSpForm({ ...newSpForm(), supplier_id: supplierId ?? productSupplier ?? '' })
    setSpOpen(true)
  }

  function openSpEdit(sp: SupplierProduct) {
    setSpForm(spFromRow(sp))
    setSpOpen(true)
  }

  async function saveSp() {
    if (!spForm.supplier_id) return push('请选择供应商', 'error')
    if (!spForm.sku.trim()) return push('请填写 SKU', 'error')
    setSpSaving(true)
    try {
      const payload = {
        supplier_id: spForm.supplier_id,
        product_id: spForm.product_id || null,
        sku: spForm.sku.trim(),
        title: spForm.title.trim() || null,
        unit: spForm.unit.trim() || '件',
        currency: spForm.currency,
        unit_cost: Math.max(0, Number(spForm.unit_cost) || 0),
        moq: Math.max(1, Math.round(Number(spForm.moq) || 1)),
        lead_time_days: Math.max(0, Math.round(Number(spForm.lead_time_days) || 0)),
        status: spForm.status,
        note: spForm.note.trim() || null,
        updated_at: new Date().toISOString(),
      }
      if (spForm.id) {
        await updateRow<SupplierProduct>('supplier_products', spForm.id, payload)
        push('报价已更新')
      } else {
        await insertRow<SupplierProduct>('supplier_products', { ...payload, user_id: user?.id })
        push('可供产品已添加')
      }
      setSpOpen(false)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate|unique/i.test(msg) ? '这家供应商已有相同 SKU' : msg, 'error')
    } finally {
      setSpSaving(false)
    }
  }

  async function removeSp() {
    if (!deletingSp) return
    setConfirming(true)
    try {
      await deleteRow('supplier_products', deletingSp.id)
      push('可供产品已移除')
      setDeletingSp(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirming(false)
    }
  }

  /** 选择商品档案时自动带出 SKU / 名称 / 成本 */
  function pickProduct(id: string) {
    const p = productMap.get(id)
    setSpForm((f) => ({
      ...f,
      product_id: id,
      sku: p?.sku ?? f.sku,
      title: p?.title ?? f.title,
      unit_cost: p?.cost_price !== undefined ? String(p.cost_price) : f.unit_cost,
    }))
  }

  function updateSp(key: string, patch: Partial<SpForm>) {
    setSupProducts((list) => list.map((sp) => (sp.key === key ? { ...sp, ...patch } : sp)))
  }

  /** 档案弹窗里批量录入商品时，选商品档案同样自动带出信息 */
  function pickBulkProduct(id: string, key: string) {
    const p = productMap.get(id)
    updateSp(key, {
      product_id: id,
      sku: p?.sku ?? '',
      title: p?.title ?? '',
      unit_cost: p?.cost_price !== undefined ? String(p.cost_price) : '0',
    })
  }

  /* ---------------- 导入导出 ---------------- */

  function exportSuppliers() {
    const rows = filtered.map((s) => ({
      编码: s.code ?? '',
      名称: s.name,
      联系人: s.contact ?? '',
      联系人列表: (contactsBySupplier.get(s.id) ?? [])
        .map(
          (c) =>
            `${c.name}${c.title ? `(${c.title})` : ''}${c.mobile || c.phone ? ` ${c.mobile || c.phone}` : ''}${c.email ? ` ${c.email}` : ''}${c.im ? ` ${c.im}` : ''}`,
        )
        .join(' / '),
      职务: s.contact_title ?? '',
      电话: s.phone ?? '',
      邮箱: s.email ?? '',
      品类: s.category ?? '',
      标签: (s.tags ?? []).join('、'),
      结算方式: s.payment_terms,
      交期天数: s.lead_time_days,
      评级: s.rating,
      状态: STATUS_META[s.status]?.label ?? s.status,
      负责人: (s.owner_id && memberMap.get(s.owner_id)?.full_name) || '',
      备注: s.note ?? '',
    }))
    downloadTextFile(`供应商档案_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows))
    push(`已导出 ${rows.length} 家供应商`)
  }

  async function importSuppliers(file: File) {
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter(Boolean)
    if (lines.length < 2) return push('文件里没有数据行', 'error')
    const cells = (line: string) =>
      line
        .split(',')
        .map((x) => x.trim().replace(/^"|"$/g, ''))
    const head = cells(lines[0])
    const idx = (...names: string[]) => head.findIndex((h) => names.includes(h))
    const iName = idx('名称', 'name', '供应商名称')
    if (iName < 0) return push('CSV 必须包含「名称」列', 'error')
    const iCode = idx('编码', 'code')
    const iContact = idx('联系人', 'contact')
    const iPhone = idx('电话', 'phone')
    const iEmail = idx('邮箱', 'email')
    // 额外联系人列：联系人2 / 电话2 / 邮箱2、联系人3 …… 最多再导入 3 位
    const extraColumns = [2, 3, 4].map((n) => ({
      name: idx(`联系人${n}`),
      phone: idx(`电话${n}`, `手机${n}`),
      email: idx(`邮箱${n}`),
    }))
    const iCategory = idx('品类', 'category', '主营品类')
    const iTerms = idx('结算方式', 'payment_terms')
    const iLead = idx('交期天数', 'lead_time_days')
    const iNote = idx('备注', 'note')
    const get = (c: string[], i: number) => (i >= 0 ? c[i] ?? '' : '')

    let ok = 0
    let failed = 0
    for (const line of lines.slice(1)) {
      const c = cells(line)
      const name = get(c, iName)
      if (!name) continue
      try {
        const created = await insertRow<{ id: string }>('suppliers', {
          user_id: user?.id,
          name,
          code: get(c, iCode) || null,
          contact: get(c, iContact) || null,
          phone: get(c, iPhone) || null,
          email: get(c, iEmail) || null,
          category: get(c, iCategory) || null,
          payment_terms: get(c, iTerms) || '现结',
          lead_time_days: Math.max(0, Number(get(c, iLead)) || 30),
          note: get(c, iNote) || null,
        })
        const contacts = [
          ...(get(c, iContact)
            ? [
                {
                  name: get(c, iContact),
                  phone: get(c, iPhone),
                  email: get(c, iEmail),
                  is_primary: true,
                },
              ]
            : []),
          ...extraColumns
            .map((x) => ({
              name: get(c, x.name),
              phone: get(c, x.phone),
              email: get(c, x.email),
              is_primary: false,
            }))
            .filter((x) => x.name),
        ]
        if (contacts.length) {
          try {
            await insertRows(
              'supplier_contacts',
              contacts.map((x) => ({
                user_id: user?.id,
                supplier_id: created.id,
                name: x.name,
                phone: x.phone || null,
                email: x.email || null,
                is_primary: x.is_primary,
              })),
            )
          } catch {
            // 旧库还没建联系人表：主表里的主联系人快照仍然有效
          }
        }
        ok += 1
      } catch {
        failed += 1
      }
    }
    push(`导入完成：成功 ${ok} 家${failed ? `，跳过 ${failed} 家（可能重名）` : ''}`)
    reload()
  }

  if (error) return <ErrorBlock message={error} onRetry={reload} />

  return (
    <div>
      <PageHeader
        title="供应商管理库"
        description="集中维护供应商档案、多位联系人、多款商品报价与资质结算，采购绩效自动汇总"
        actions={
          <>
            <label className="btn btn-default h-8 px-3 cursor-pointer">
              <Upload className="w-3.5 h-3.5 mr-1.5 inline" />
              导入 CSV
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void importSuppliers(f)
                  e.target.value = ''
                }}
              />
            </label>
            <Button icon={<Download className="w-3.5 h-3.5" />} onClick={exportSuppliers}>
              导出
            </Button>
            {canEdit && (
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
                新建供应商
              </Button>
            )}
          </>
        }
      />

      {/* 概览 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        {[
          {
            label: '供应商总数',
            value: num((data?.suppliers ?? []).length),
            icon: <Factory className="w-4 h-4" />,
            tone: 'bg-brand-50 text-brand-600',
          },
          {
            label: '合作中',
            value: num((data?.suppliers ?? []).filter((s) => s.status === 'active').length),
            icon: <Building2 className="w-4 h-4" />,
            tone: 'bg-emerald-50 text-emerald-600',
          },
          {
            label: '可供产品 / 报价',
            value: num((data?.supplierProducts ?? []).length),
            icon: <Receipt className="w-4 h-4" />,
            tone: 'bg-violet-50 text-violet-600',
          },
          {
            label: '累计采购额 ≈CNY',
            value: money(totalAmount, 'CNY', 0),
            icon: <TrendingUp className="w-4 h-4" />,
            tone: 'bg-amber-50 text-amber-600',
          },
        ].map((k) => (
          <div key={k.label} className="card px-3.5 py-3 flex items-center gap-3">
            <span className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', k.tone)}>
              {k.icon}
            </span>
            <div className="min-w-0">
              <p className="text-[11px] text-ink-400">{k.label}</p>
              <p className="num text-[17px] font-semibold text-ink-900 mt-0.5 truncate">{k.value}</p>
              {k.label === '累计采购额 ≈CNY' && (
                <p className="text-[10px] text-rose-500 mt-0.5 num">
                  其中未付 {money(totalUnpaid, 'CNY', 0)}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mb-3">
        <Segmented
          value={view}
          onChange={(v) => {
            setView(v as typeof view)
            setPage(1)
          }}
          size="sm"
          options={[
            { value: 'suppliers', label: `供应商档案 ${(data?.suppliers ?? []).length}` },
            { value: 'products', label: `可供产品 ${(data?.supplierProducts ?? []).length}` },
            { value: 'analysis', label: `供货绩效 ${ranked.length}` },
          ]}
        />
      </div>

      {view === 'suppliers' && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <SearchInput
              value={query}
              onChange={(v) => {
                setQuery(v)
                setPage(1)
              }}
              placeholder="名称 / 编码 / 联系人 / 电话 / 标签"
              className="w-full sm:w-72"
            />
            <Select
              className="w-full sm:w-32"
              value={status}
              onChange={(v) => {
                setStatus(v)
                setPage(1)
              }}
              placeholder="全部状态"
              options={[
                { value: 'active', label: '合作中' },
                { value: 'paused', label: '暂停合作' },
              ]}
            />
            <Select
              className="w-full sm:w-36"
              value={category}
              onChange={(v) => {
                setCategory(v)
                setPage(1)
              }}
              placeholder="全部品类"
              options={CATALOG.map((c) => ({ value: c, label: c }))}
            />
            <span className="ml-auto text-[11.5px] text-ink-400">
              共 <span className="num text-ink-700 font-medium">{filtered.length}</span> 家
            </span>
          </div>

          {loading ? (
            <LoadingBlock rows={8} />
          ) : !paged.length ? (
            <EmptyState
              icon={<Factory className="w-5 h-5" />}
              title="还没有符合条件的供应商"
              description="点右上角「新建供应商」录入档案，或先清空筛选条件。"
            />
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1120px]">
                  <thead>
                    <tr>
                      <th className="th">供应商</th>
                      <th className="th">联系人 / 方式</th>
                      <th className="th">品类 / 标签</th>
                      <th className="th text-center">评级</th>
                      <th className="th">结算 / 交期</th>
                      <th className="th">负责人</th>
                      <th className="th text-right">累计采购</th>
                      <th className="th w-24" />
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((s) => {
                      const st = stats.get(s.id)
                      const meta = STATUS_META[s.status] ?? STATUS_META.active
                      const owner = s.owner_id ? memberMap.get(s.owner_id) : null
                      const contacts = contactsBySupplier.get(s.id) ?? []
                      const pc = contacts.find((c) => c.is_primary) ?? contacts[0]
                      return (
                        <tr
                          key={s.id}
                          className="hover:bg-ink-50/60 cursor-pointer group"
                          onClick={() => setDetail(s)}
                        >
                          <td className="td">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12.5px] font-medium text-ink-800 truncate max-w-[190px]">
                                {s.name}
                              </span>
                              <span
                                className={cn(
                                  'text-[9.5px] px-1 py-0.5 rounded border whitespace-nowrap',
                                  meta.cls,
                                )}
                              >
                                {meta.label}
                              </span>
                            </div>
                            <p className="text-[10.5px] text-ink-400 font-mono">
                              {s.code || '未编号'} · {s.city || s.country || '地区未填'}
                            </p>
                          </td>
                          <td className="td">
                            <p className="text-[11.5px] text-ink-700">
                              {pc?.name || s.contact || '—'}
                              {pc?.title ? `（${pc.title}）` : ''}
                              {contacts.length > 1 && (
                                <span className="ml-1 text-[10px] text-brand-600 whitespace-nowrap">
                                  等 {contacts.length} 人
                                </span>
                              )}
                            </p>
                            <p className="text-[10.5px] text-ink-400 truncate max-w-[160px]">
                              {pc?.mobile || pc?.phone || s.phone || pc?.email || s.email || '未留联系方式'}
                            </p>
                          </td>
                          <td className="td">
                            <p className="text-[11.5px] text-ink-600 truncate max-w-[130px]">
                              {s.category || '未分类'}
                            </p>
                            {(s.tags ?? []).length > 0 && (
                              <div className="flex flex-wrap gap-0.5 mt-0.5">
                                {s.tags.slice(0, 2).map((t) => (
                                  <span
                                    key={t}
                                    className="text-[9px] px-1 py-0.5 rounded bg-brand-50 text-brand-600 whitespace-nowrap"
                                  >
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="td text-center">
                            <StarRow value={Number(s.rating)} />
                          </td>
                          <td className="td">
                            <p className="text-[11px] text-ink-600">{s.payment_terms}</p>
                            <p className="text-[10px] text-ink-400 num">{s.lead_time_days} 天交期</p>
                          </td>
                          <td className="td">
                            <span className="text-[11px] text-ink-600">
                              {owner?.full_name || owner?.email || '未指派'}
                            </span>
                          </td>
                          <td className="td text-right">
                            <p className="num text-[12px] text-ink-700">
                              {st ? money(st.amount, 'CNY', 0) : '—'}
                            </p>
                            <p className="num text-[10px] text-ink-400">{st?.orders ?? 0} 单</p>
                          </td>
                          <td className="td" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-0.5 opacity-70 group-hover:opacity-100 transition-opacity">
                              <button
                                className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-brand-50"
                                title="查看档案"
                                onClick={() => setDetail(s)}
                              >
                                <ChevronRight className="w-3.5 h-3.5" />
                              </button>
                              {canEdit && (
                                <>
                                  <button
                                    className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                                    title="编辑"
                                    onClick={() => openEdit(s)}
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    className="p-1.5 rounded-md text-ink-400 hover:text-violet-600 hover:bg-violet-50"
                                    title="添加可供产品"
                                    onClick={() => openSpCreate(s.id)}
                                  >
                                    <Plus className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    data-perm="delete"
                                    className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                                    title="删除"
                                    onClick={() => setDeletingSup(s)}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {filtered.length > PAGE_SIZE && (
                <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} />
              )}
            </div>
          )}
        </>
      )}

      {view === 'products' && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
            <div className="flex-1 min-w-[180px]">
              <p className="text-[12px] font-medium text-ink-800">一家供应商可以有多个可供 SKU 与报价</p>
              <p className="text-[11px] text-ink-400 mt-0.5">
                同一供应商下 SKU 唯一；编辑供应商档案时可一次录入多位联系人与多款商品
              </p>
            </div>
            <Select
              className="w-full sm:w-48"
              value={productSupplier}
              onChange={setProductSupplier}
              placeholder="全部供应商"
              options={(data?.suppliers ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
            {canEdit && (
              <Button icon={<Plus className="w-3.5 h-3.5" />} onClick={() => openSpCreate()}>
                添加产品
              </Button>
            )}
          </div>

          {loading ? (
            <LoadingBlock rows={8} />
          ) : !spRows.length ? (
            <EmptyState
              icon={<Receipt className="w-5 h-5" />}
              title="还没有可供产品"
              description="给供应商添加 SKU 与报价，缺货补货时就能一键带出成本价。"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[940px]">
                <thead>
                  <tr>
                    <th className="th">供应商</th>
                    <th className="th">SKU / 产品</th>
                    <th className="th text-right">报价</th>
                    <th className="th text-right">起订量</th>
                    <th className="th text-right">交期</th>
                    <th className="th">状态</th>
                    <th className="th w-20" />
                  </tr>
                </thead>
                <tbody>
                  {spRows.map((sp) => (
                    <tr key={sp.id} className="hover:bg-ink-50/60">
                      <td className="td">
                        <span className="text-[11.5px] text-ink-700 truncate max-w-[160px] block">
                          {supplierMap.get(sp.supplier_id)?.name ?? '—'}
                        </span>
                      </td>
                      <td className="td">
                        <p className="text-[12px] font-mono text-ink-800">{sp.sku}</p>
                        <p className="text-[10.5px] text-ink-400 truncate max-w-[200px]">
                          {sp.title || productMap.get(sp.product_id ?? '')?.title || '—'}
                        </p>
                      </td>
                      <td className="td text-right">
                        <span className="num text-[12px] text-ink-800">
                          {money(sp.unit_cost, sp.currency, 2)}
                        </span>
                        <span className="text-[10px] text-ink-400"> /{sp.unit}</span>
                      </td>
                      <td className="td text-right num text-[11.5px] text-ink-600">{sp.moq}</td>
                      <td className="td text-right num text-[11.5px] text-ink-600">
                        {sp.lead_time_days} 天
                      </td>
                      <td className="td">
                        <span
                          className={cn(
                            'text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap',
                            STATUS_META[sp.status]?.cls ?? STATUS_META.active.cls,
                          )}
                        >
                          {sp.status === 'active' ? '可供' : '暂停'}
                        </span>
                      </td>
                      <td className="td">
                        {canEdit && (
                          <div className="flex items-center gap-0.5">
                            <button
                              className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                              title="编辑"
                              onClick={() => openSpEdit(sp)}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              data-perm="delete"
                              className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                              title="删除"
                              onClick={() => setDeletingSp(sp)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
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

      {view === 'analysis' && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-ink-100">
            <h3 className="text-[13.5px] font-semibold text-ink-900">供应商供货绩效</h3>
            <p className="text-[11px] text-ink-400 mt-0.5">
              按采购单汇总：采购额、付款进度、到货数量与准时率；金额统一折算为 CNY
            </p>
          </div>
          {loading ? (
            <LoadingBlock rows={8} />
          ) : !ranked.length ? (
            <EmptyState
              icon={<TrendingUp className="w-5 h-5" />}
              title="还没有采购数据"
              description="在「采购管理」里建单、付款、入库后，这里会自动汇总每家供应商的绩效。"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px]">
                <thead>
                  <tr>
                    <th className="th w-10">#</th>
                    <th className="th">供应商</th>
                    <th className="th text-right">采购单</th>
                    <th className="th text-right">采购额</th>
                    <th className="th text-right">已付 / 未付</th>
                    <th className="th text-right">到货件数</th>
                    <th className="th text-right">准时率</th>
                    <th className="th">最近下单</th>
                    <th className="th w-[120px]">采购额占比</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map(({ supplier: s, stat }, i) => {
                    const share = ((stat?.amount ?? 0) / (totalAmount || 1)) * 100
                    const onTimeRate = stat?.onTimeTotal
                      ? (stat.onTime / stat.onTimeTotal) * 100
                      : null
                    return (
                      <tr
                        key={s.id}
                        className="hover:bg-ink-50/60 cursor-pointer"
                        onClick={() => setDetail(s)}
                      >
                        <td className="td num text-[11px] text-ink-400">{i + 1}</td>
                        <td className="td">
                          <p className="text-[12.5px] font-medium text-ink-800 truncate max-w-[170px]">
                            {s.name}
                          </p>
                          <StarRow value={Number(s.rating)} />
                        </td>
                        <td className="td text-right num text-[12px] text-ink-700">{stat?.orders}</td>
                        <td className="td text-right num text-[12.5px] font-semibold text-ink-800">
                          {money(stat?.amount ?? 0, 'CNY', 0)}
                        </td>
                        <td className="td text-right">
                          <span className="num text-[11.5px] text-emerald-600">
                            {money(stat?.paid ?? 0, 'CNY', 0)}
                          </span>
                          <span className="num text-[10.5px] text-rose-500 ml-1">
                            / {money(stat?.unpaid ?? 0, 'CNY', 0)}
                          </span>
                        </td>
                        <td className="td text-right num text-[12px] text-ink-600">{num(stat?.qty ?? 0)}</td>
                        <td className="td text-right">
                          <span
                            className={cn(
                              'num text-[12px]',
                              onTimeRate === null
                                ? 'text-ink-300'
                                : onTimeRate >= 80
                                  ? 'text-emerald-600'
                                  : onTimeRate >= 50
                                    ? 'text-amber-600'
                                    : 'text-rose-600',
                            )}
                          >
                            {onTimeRate === null ? '—' : `${num(onTimeRate)}%`}
                          </span>
                        </td>
                        <td className="td text-[11px] text-ink-500">
                          {stat?.lastOrderAt ? fmtDate(stat.lastOrderAt) : '—'}
                        </td>
                        <td className="td">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-brand-500"
                                style={{ width: `${Math.min(100, Math.abs(share))}%` }}
                              />
                            </div>
                            <span className="num text-[10px] text-ink-500 w-8 text-right">
                              {num(share)}%
                            </span>
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
      )}

      {/* ---------------- 供应商档案弹窗 ---------------- */}
      <Modal
        open={supOpen}
        onClose={() => setSupOpen(false)}
        title={supForm.id ? '编辑供应商档案' : '新建供应商'}
        description="带 * 为必填；可一次添加多位联系人与多款可供商品，资质会同步给采购、财务同事"
        width="max-w-3xl"
        footer={
          <>
            <Button onClick={() => setSupOpen(false)}>取消</Button>
            <Button variant="primary" onClick={saveSupplier} loading={supSaving}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <p className="text-[11px] font-semibold text-brand-600 mb-2">基础信息</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Field label="供应商名称" required>
                <input
                  className="input"
                  value={supForm.name}
                  placeholder="如：东莞恒美家居制品厂"
                  onChange={(e) => setSupForm({ ...supForm, name: e.target.value })}
                />
              </Field>
              <Field label="编码" hint="便于对账时引用">
                <input
                  className="input"
                  value={supForm.code}
                  placeholder="如：SUP-001"
                  onChange={(e) => setSupForm({ ...supForm, code: e.target.value })}
                />
              </Field>
              <Field label="主营品类">
                <Select
                  value={supForm.category}
                  onChange={(v) => setSupForm({ ...supForm, category: v })}
                  options={CATALOG.map((c) => ({ value: c, label: c }))}
                  placeholder="（未分类）"
                />
              </Field>
              <Field label="国家 / 地区">
                <input
                  className="input"
                  value={supForm.country}
                  placeholder="中国"
                  onChange={(e) => setSupForm({ ...supForm, country: e.target.value })}
                />
              </Field>
              <Field label="城市">
                <input
                  className="input"
                  value={supForm.city}
                  placeholder="如：东莞"
                  onChange={(e) => setSupForm({ ...supForm, city: e.target.value })}
                />
              </Field>
              <Field label="标签" hint="用逗号或顿号分隔">
                <input
                  className="input"
                  value={supForm.tags}
                  placeholder="快速打样、小批量"
                  onChange={(e) => setSupForm({ ...supForm, tags: e.target.value })}
                />
              </Field>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-[11px] font-semibold text-brand-600">
                联系人
                <span className="ml-1 font-normal text-ink-400">
                  可添加多位；主联系人会同步到列表与采购页
                </span>
              </p>
              <button
                type="button"
                className="text-[11px] text-brand-600 hover:text-brand-700 inline-flex items-center gap-0.5 shrink-0"
                onClick={() => setSupContacts((list) => [...list, newContactForm(list.length === 0)])}
              >
                <Plus className="w-3 h-3" /> 添加联系人
              </button>
            </div>
            {!supContacts.length ? (
              <p className="text-[11px] text-ink-400 border border-dashed border-ink-200 rounded-lg px-3 py-4 text-center">
                还没有联系人，点右上「添加联系人」录入第一位
              </p>
            ) : (
              <div className="space-y-2">
                {supContacts.map((c, i) => (
                  <div key={c.key} className="rounded-xl border border-ink-200/70 bg-ink-50/40 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[10.5px] font-medium text-ink-500">联系人 {i + 1}</span>
                        <button
                          type="button"
                          title="设为主联系人"
                          className={cn(
                            'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors',
                            c.is_primary
                              ? 'border-amber-300 bg-amber-50 text-amber-700'
                              : 'border-ink-200 text-ink-400 hover:text-amber-600 hover:border-amber-200',
                          )}
                          onClick={() => updateContact(c.key, { is_primary: true })}
                        >
                          <Star
                            className={cn('w-3 h-3', c.is_primary && 'fill-amber-400 text-amber-400')}
                          />
                          {c.is_primary ? '主联系人' : '设为主联系人'}
                        </button>
                      </div>
                      <button
                        type="button"
                        title="删除该联系人"
                        className="p-1 rounded text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                        onClick={() => setSupContacts((list) => list.filter((x) => x.key !== c.key))}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      <Field label="姓名" required>
                        <input
                          className="input"
                          value={c.name}
                          placeholder="如：张经理"
                          onChange={(e) => updateContact(c.key, { name: e.target.value })}
                        />
                      </Field>
                      <Field label="职务">
                        <input
                          className="input"
                          value={c.title}
                          placeholder="如：销售经理"
                          onChange={(e) => updateContact(c.key, { title: e.target.value })}
                        />
                      </Field>
                      <Field label="电话 / 座机">
                        <input
                          className="input"
                          value={c.phone}
                          onChange={(e) => updateContact(c.key, { phone: e.target.value })}
                        />
                      </Field>
                      <Field label="手机">
                        <input
                          className="input"
                          value={c.mobile}
                          onChange={(e) => updateContact(c.key, { mobile: e.target.value })}
                        />
                      </Field>
                      <Field label="邮箱">
                        <input
                          className="input"
                          type="email"
                          value={c.email}
                          onChange={(e) => updateContact(c.key, { email: e.target.value })}
                        />
                      </Field>
                      <Field label="微信 / WhatsApp">
                        <input
                          className="input"
                          value={c.im}
                          onChange={(e) => updateContact(c.key, { im: e.target.value })}
                        />
                      </Field>
                      <Field label="备注" className="md:col-span-3">
                        <input
                          className="input"
                          value={c.note}
                          placeholder="如：只对接样品单 / 晚间可联系"
                          onChange={(e) => updateContact(c.key, { note: e.target.value })}
                        />
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-[11px] font-semibold text-brand-600 mb-2">其他联系方式 / 地址</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Field label="传真">
                <input
                  className="input"
                  value={supForm.fax}
                  onChange={(e) => setSupForm({ ...supForm, fax: e.target.value })}
                />
              </Field>
              <Field label="官网">
                <input
                  className="input"
                  value={supForm.website}
                  placeholder="https://"
                  onChange={(e) => setSupForm({ ...supForm, website: e.target.value })}
                />
              </Field>
              <Field label="详细地址" className="md:col-span-3">
                <input
                  className="input"
                  value={supForm.address}
                  onChange={(e) => setSupForm({ ...supForm, address: e.target.value })}
                />
              </Field>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-semibold text-brand-600 mb-2">商务与资质</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Field label="结算方式">
                <Select
                  value={supForm.payment_terms}
                  onChange={(v) => setSupForm({ ...supForm, payment_terms: v })}
                  options={PAY_TERMS.map((t) => ({ value: t, label: t }))}
                />
              </Field>
              <Field label="交期（天）">
                <input
                  className="input num"
                  type="number"
                  min="0"
                  value={supForm.lead_time_days}
                  onChange={(e) => setSupForm({ ...supForm, lead_time_days: e.target.value })}
                />
              </Field>
              <Field label="综合评级">
                <Select
                  value={supForm.rating}
                  onChange={(v) => setSupForm({ ...supForm, rating: v })}
                  options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} 星` }))}
                />
              </Field>
              <Field label="税号">
                <input
                  className="input"
                  value={supForm.tax_no}
                  onChange={(e) => setSupForm({ ...supForm, tax_no: e.target.value })}
                />
              </Field>
              <Field label="开户行">
                <input
                  className="input"
                  value={supForm.bank_name}
                  onChange={(e) => setSupForm({ ...supForm, bank_name: e.target.value })}
                />
              </Field>
              <Field label="银行账号">
                <input
                  className="input num"
                  value={supForm.bank_account}
                  onChange={(e) => setSupForm({ ...supForm, bank_account: e.target.value })}
                />
              </Field>
              <Field label="资质证照" className="md:col-span-2" hint="营业执照 / ISO / 检测报告编号等">
                <input
                  className="input"
                  value={supForm.qualification}
                  onChange={(e) => setSupForm({ ...supForm, qualification: e.target.value })}
                />
              </Field>
              <Field label="合作起始日">
                <input
                  className="input"
                  type="date"
                  value={supForm.cooperation_since}
                  onChange={(e) => setSupForm({ ...supForm, cooperation_since: e.target.value })}
                />
              </Field>
              <Field label="业务负责人" hint="采购业绩归集到此人绩效">
                <Select
                  value={supForm.owner_id}
                  onChange={(v) => setSupForm({ ...supForm, owner_id: v })}
                  options={memberOptions}
                  placeholder="默认当前登录人"
                />
              </Field>
              <Field label="状态">
                <Select
                  value={supForm.status}
                  onChange={(v) => setSupForm({ ...supForm, status: v as 'active' | 'paused' })}
                  options={[
                    { value: 'active', label: '合作中' },
                    { value: 'paused', label: '暂停合作' },
                  ]}
                />
              </Field>
              <Field label="备注" className="md:col-span-2">
                <input
                  className="input"
                  value={supForm.note}
                  onChange={(e) => setSupForm({ ...supForm, note: e.target.value })}
                />
              </Field>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-[11px] font-semibold text-brand-600">
                可供产品 / 报价
                <span className="ml-1 font-normal text-ink-400">
                  一家供应商可登记多款商品，缺货补货时自动带价
                </span>
              </p>
              <button
                type="button"
                className="text-[11px] text-brand-600 hover:text-brand-700 inline-flex items-center gap-0.5 shrink-0"
                onClick={() =>
                  setSupProducts((list) => [
                    ...list,
                    { ...newSpForm(), supplier_id: supForm.id ?? '' },
                  ])
                }
              >
                <Plus className="w-3 h-3" /> 添加商品
              </button>
            </div>
            {!supProducts.length ? (
              <p className="text-[11px] text-ink-400 border border-dashed border-ink-200 rounded-lg px-3 py-4 text-center">
                还没有登记可供商品，点右上「添加商品」录入 SKU、报价与起订量
              </p>
            ) : (
              <div className="space-y-2">
                {supProducts.map((sp, i) => (
                  <div key={sp.key} className="rounded-xl border border-ink-200/70 bg-ink-50/40 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10.5px] font-medium text-ink-500">商品 {i + 1}</span>
                      <button
                        type="button"
                        title="移除该商品"
                        className="p-1 rounded text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                        onClick={() => setSupProducts((list) => list.filter((x) => x.key !== sp.key))}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      <Field label="关联商品档案" className="md:col-span-2">
                        <Select
                          value={sp.product_id}
                          onChange={(v) => pickBulkProduct(v, sp.key)}
                          options={(data?.products ?? []).map((p) => ({
                            value: p.id,
                            label: `${p.sku} · ${p.title || '未命名'}`,
                          }))}
                          placeholder="（不关联，手工填写）"
                        />
                      </Field>
                      <Field label="SKU" required>
                        <input
                          className="input font-mono"
                          value={sp.sku}
                          onChange={(e) => updateSp(sp.key, { sku: e.target.value })}
                        />
                      </Field>
                      <Field label="产品名称">
                        <input
                          className="input"
                          value={sp.title}
                          onChange={(e) => updateSp(sp.key, { title: e.target.value })}
                        />
                      </Field>
                      <Field label="报价">
                        <input
                          className="input num"
                          type="number"
                          step="0.0001"
                          value={sp.unit_cost}
                          onChange={(e) => updateSp(sp.key, { unit_cost: e.target.value })}
                        />
                      </Field>
                      <Field label="币种">
                        <Select
                          value={sp.currency}
                          onChange={(v) => updateSp(sp.key, { currency: v })}
                          options={[
                            { value: 'CNY', label: 'CNY 人民币' },
                            { value: 'USD', label: 'USD 美元' },
                          ]}
                        />
                      </Field>
                      <Field label="单位">
                        <input
                          className="input"
                          value={sp.unit}
                          onChange={(e) => updateSp(sp.key, { unit: e.target.value })}
                        />
                      </Field>
                      <Field label="起订量 MOQ">
                        <input
                          className="input num"
                          type="number"
                          min="1"
                          value={sp.moq}
                          onChange={(e) => updateSp(sp.key, { moq: e.target.value })}
                        />
                      </Field>
                      <Field label="交期（天）">
                        <input
                          className="input num"
                          type="number"
                          min="0"
                          value={sp.lead_time_days}
                          onChange={(e) => updateSp(sp.key, { lead_time_days: e.target.value })}
                        />
                      </Field>
                      <Field label="状态">
                        <Select
                          value={sp.status}
                          onChange={(v) => updateSp(sp.key, { status: v as 'active' | 'paused' })}
                          options={[
                            { value: 'active', label: '可供' },
                            { value: 'paused', label: '暂停' },
                          ]}
                        />
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* ---------------- 可供产品弹窗 ---------------- */}
      <Modal
        open={spOpen}
        onClose={() => setSpOpen(false)}
        title={spForm.id ? '编辑可供产品' : '添加可供产品'}
        description="报价会在缺货补货生成采购单时自动带入"
        footer={
          <>
            <Button onClick={() => setSpOpen(false)}>取消</Button>
            <Button variant="primary" onClick={saveSp} loading={spSaving}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="供应商" required>
            <Select
              value={spForm.supplier_id}
              onChange={(v) => setSpForm({ ...spForm, supplier_id: v })}
              options={(data?.suppliers ?? []).map((s) => ({ value: s.id, label: s.name }))}
              placeholder="请选择供应商"
            />
          </Field>
          <Field label="关联商品档案" hint="选择后自动带出 SKU、名称与成本价，可再修改">
            <Select
              value={spForm.product_id}
              onChange={pickProduct}
              options={(data?.products ?? []).map((p) => ({
                value: p.id,
                label: `${p.sku} · ${p.title || '未命名'}`,
              }))}
              placeholder="（不关联，手工填写）"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SKU" required>
              <input
                className="input font-mono"
                value={spForm.sku}
                onChange={(e) => setSpForm({ ...spForm, sku: e.target.value })}
              />
            </Field>
            <Field label="产品名称">
              <input
                className="input"
                value={spForm.title}
                onChange={(e) => setSpForm({ ...spForm, title: e.target.value })}
              />
            </Field>
            <Field label="报价">
              <input
                className="input num"
                type="number"
                step="0.0001"
                value={spForm.unit_cost}
                onChange={(e) => setSpForm({ ...spForm, unit_cost: e.target.value })}
              />
            </Field>
            <Field label="币种">
              <Select
                value={spForm.currency}
                onChange={(v) => setSpForm({ ...spForm, currency: v })}
                options={[
                  { value: 'CNY', label: 'CNY 人民币' },
                  { value: 'USD', label: 'USD 美元' },
                ]}
              />
            </Field>
            <Field label="单位">
              <input
                className="input"
                value={spForm.unit}
                onChange={(e) => setSpForm({ ...spForm, unit: e.target.value })}
              />
            </Field>
            <Field label="起订量 MOQ">
              <input
                className="input num"
                type="number"
                min="1"
                value={spForm.moq}
                onChange={(e) => setSpForm({ ...spForm, moq: e.target.value })}
              />
            </Field>
            <Field label="交期（天）">
              <input
                className="input num"
                type="number"
                min="0"
                value={spForm.lead_time_days}
                onChange={(e) => setSpForm({ ...spForm, lead_time_days: e.target.value })}
              />
            </Field>
            <Field label="状态">
              <Select
                value={spForm.status}
                onChange={(v) => setSpForm({ ...spForm, status: v as 'active' | 'paused' })}
                options={[
                  { value: 'active', label: '可供' },
                  { value: 'paused', label: '暂停' },
                ]}
              />
            </Field>
          </div>
          <Field label="备注">
            <input
              className="input"
              value={spForm.note}
              onChange={(e) => setSpForm({ ...spForm, note: e.target.value })}
            />
          </Field>
        </div>
      </Modal>

      {/* ---------------- 供应商详情 ---------------- */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.name ?? '供应商档案'}
        description={detail ? `${detail.code || '未编号'} · ${detail.category || '未分类'}` : undefined}
        width="max-w-2xl"
        footer={
          <>
            {detail && canEdit && (
              <Button
                icon={<Pencil className="w-3.5 h-3.5" />}
                onClick={() => {
                  const s = detail
                  setDetail(null)
                  openEdit(s)
                }}
              >
                编辑档案
              </Button>
            )}
            <Button onClick={() => setDetail(null)}>关闭</Button>
          </>
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={detail.status === 'active' ? 'green' : 'gray'} dot>
                {STATUS_META[detail.status]?.label ?? detail.status}
              </Badge>
              <StarRow value={Number(detail.rating)} />
              {(detail.tags ?? []).map((t) => (
                <span
                  key={t}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 text-brand-600 border border-brand-200/60"
                >
                  {t}
                </span>
              ))}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {[
                {
                  label: '累计采购额',
                  value: money(stats.get(detail.id)?.amount ?? 0, 'CNY', 0),
                  icon: <TrendingUp className="w-3.5 h-3.5" />,
                },
                {
                  label: '采购单数',
                  value: `${stats.get(detail.id)?.orders ?? 0} 单`,
                  icon: <Receipt className="w-3.5 h-3.5" />,
                },
                {
                  label: '未付金额',
                  value: money(stats.get(detail.id)?.unpaid ?? 0, 'CNY', 0),
                  icon: <Wallet className="w-3.5 h-3.5" />,
                },
                {
                  label: '结算 / 交期',
                  value: `${detail.payment_terms} · ${detail.lead_time_days} 天`,
                  icon: <Truck className="w-3.5 h-3.5" />,
                },
              ].map((x) => (
                <div
                  key={x.label}
                  className="rounded-lg border border-ink-200/70 bg-white px-3 py-2.5"
                >
                  <div className="flex items-center gap-1 text-[10.5px] text-ink-400">
                    {x.icon}
                    {x.label}
                  </div>
                  <p className="num text-[13px] font-semibold text-ink-800 mt-1 truncate">{x.value}</p>
                </div>
              ))}
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <div className="rounded-xl border border-ink-200/70 bg-ink-50/50 p-3.5">
                <p className="text-[11px] font-semibold text-ink-500 mb-2 flex items-center gap-1.5">
                  <UserRound className="w-3.5 h-3.5" /> 联系人
                  <span className="num text-ink-400 font-normal">
                    {(contactsBySupplier.get(detail.id) ?? []).length}
                  </span>
                </p>
                {(contactsBySupplier.get(detail.id) ?? []).length ? (
                  <div className="space-y-2">
                    {(contactsBySupplier.get(detail.id) ?? []).map((c) => (
                      <div key={c.id} className="rounded-lg bg-white border border-ink-200/70 px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11.5px] font-medium text-ink-800">
                            {c.name}
                            {c.title ? (
                              <span className="ml-1 text-[10px] text-ink-400">· {c.title}</span>
                            ) : null}
                          </span>
                          {c.is_primary && (
                            <span className="text-[9.5px] px-1 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200/60 whitespace-nowrap">
                              主联系人
                            </span>
                          )}
                        </div>
                        <p className="text-[10.5px] text-ink-500 mt-1 break-all">
                          {[c.mobile, c.phone, c.email, c.im].filter(Boolean).join(' · ') ||
                            '未留联系方式'}
                        </p>
                        {c.note && <p className="text-[10px] text-ink-400 mt-0.5">{c.note}</p>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-ink-400 break-all">
                    {detail.contact
                      ? `${detail.contact}${detail.contact_title ? ` · ${detail.contact_title}` : ''}${
                          detail.phone ? ` · ${detail.phone}` : ''
                        }${detail.email ? ` · ${detail.email}` : ''}`
                      : '未登记联系人'}
                  </p>
                )}
                <dl className="space-y-1 text-[11px] mt-2.5 pt-2 border-t border-ink-100">
                  {[
                    ['传真', detail.fax ?? ''],
                    ['官网', detail.website ?? ''],
                    ['地址', [detail.country, detail.city, detail.address].filter(Boolean).join(' ')],
                  ].map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <dt className="text-ink-400 w-9 shrink-0">{k}</dt>
                      <dd className="text-ink-700 break-all">{v || '—'}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="rounded-xl border border-ink-200/70 bg-ink-50/50 p-3.5">
                <p className="text-[11px] font-semibold text-ink-500 mb-2 flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5" /> 资质与结算
                </p>
                <dl className="space-y-1.5 text-[11.5px]">
                  {[
                    ['税号', detail.tax_no ?? ''],
                    ['开户行', detail.bank_name ?? ''],
                    ['银行账号', detail.bank_account ?? ''],
                    ['资质', detail.qualification ?? ''],
                    ['合作起始', detail.cooperation_since ? fmtDate(detail.cooperation_since) : ''],
                    [
                      '负责人',
                      (detail.owner_id && memberMap.get(detail.owner_id)?.full_name) || '未指派',
                    ],
                  ].map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <dt className="text-ink-400 w-14 shrink-0">{k}</dt>
                      <dd className="text-ink-700 break-all">{v || '—'}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[11px] font-semibold text-ink-500 flex items-center gap-1.5">
                  <Award className="w-3.5 h-3.5" /> 可供产品 / 报价
                  <span className="num text-ink-400 font-normal">
                    {(data?.supplierProducts ?? []).filter((sp) => sp.supplier_id === detail.id).length}
                  </span>
                </p>
                {canEdit && (
                  <button
                    className="text-[11px] text-brand-600 hover:text-brand-700 inline-flex items-center gap-0.5"
                    onClick={() => {
                      const id = detail.id
                      setDetail(null)
                      setView('products')
                      openSpCreate(id)
                    }}
                  >
                    <Plus className="w-3 h-3" /> 添加
                  </button>
                )}
              </div>
              <div className="rounded-lg border border-ink-200/70 overflow-hidden">
                {(data?.supplierProducts ?? []).filter((sp) => sp.supplier_id === detail.id).length ? (
                  <table className="w-full">
                    <tbody>
                      {(data?.supplierProducts ?? [])
                        .filter((sp) => sp.supplier_id === detail.id)
                        .map((sp) => (
                          <tr key={sp.id} className="border-b border-ink-100 last:border-0">
                            <td className="td font-mono text-[11.5px] text-ink-800">{sp.sku}</td>
                            <td className="td text-[11.5px] text-ink-500 truncate max-w-[220px]">
                              {sp.title || '—'}
                            </td>
                            <td className="td text-right num text-[11.5px] text-ink-700">
                              {money(sp.unit_cost, sp.currency, 2)}
                            </td>
                            <td className="td text-right num text-[10.5px] text-ink-400">
                              MOQ {sp.moq} · {sp.lead_time_days} 天
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-[11px] text-ink-400 px-3 py-3 text-center">
                    还没有登记可供产品，点右上「添加」录入 SKU 与报价
                  </p>
                )}
              </div>
            </div>

            {detail.note && (
              <p className="text-[11.5px] leading-relaxed text-ink-500 bg-ink-50 rounded-lg px-3 py-2">
                {detail.note}
              </p>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deletingSup}
        onClose={() => setDeletingSup(null)}
        title="删除供应商"
        message={`确认删除「${deletingSup?.name ?? ''}」？其可供产品会一并移除，历史采购单保留但不再关联。`}
        confirmText="删除"
        loading={confirming}
        onConfirm={removeSupplier}
      />
      <ConfirmDialog
        open={!!deletingSp}
        onClose={() => setDeletingSp(null)}
        title="移除可供产品"
        message={`确认移除「${deletingSp?.sku ?? ''}」的报价记录？`}
        confirmText="移除"
        loading={confirming}
        onConfirm={removeSp}
      />

      <p className="mt-4 text-[11px] leading-relaxed text-ink-400 flex items-start gap-1.5">
        <Globe2 className="w-3.5 h-3.5 text-ink-300 mt-0.5 shrink-0" />
        供应商档案与采购、库存、财务打通：一家供应商可维护多位联系人与多款商品，主联系人同步到列表和采购页；
        建采购单时选这里维护的供应商，付款与到货会自动汇总到「供货绩效」，缺货补货优先使用这里登记的可供产品报价。
      </p>
    </div>
  )
}
