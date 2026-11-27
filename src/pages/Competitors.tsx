import { useMemo, useState } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  ClipboardCheck,
  ClipboardList,
  ExternalLink,
  ImageOff,
  Pencil,
  Plus,
  Star,
  Telescope,
  Trash2,
} from 'lucide-react'
import { CartesianGrid, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import dayjs from 'dayjs'
import { deleteRow, fetchRows, insertRow, updateRow } from '../lib/db'
import { COMPETITOR_STATUS, MARKETPLACES, PRICE_POSITION, marketplaceMeta, platformMeta, platformOptions } from '../lib/constants'
import { useAuth } from '../context/AuthContext'
import type { Competitor, CompetitorSnapshot, Platform, Product, Store } from '../lib/types'
import { useAsync } from '../hooks/useAsync'
import { useFx, convert } from '../lib/fx'
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
import { agoDay, cn, dayDiff, fmtDate, money, num, today } from '../lib/utils'

const PAGE_SIZE = 20

/** 价差在这个区间内视为「同一价格带」，超过才算价格战 / 明显高于我方 */
const GAP_THRESHOLD = 3

interface FormState {
  store_id: string
  product_id: string
  platform: Platform
  marketplace: string
  asin: string
  title: string
  brand: string
  url: string
  image_url: string
  currency: string
  price: string
  list_price: string
  coupon: string
  rating: string
  reviews: string
  bsr: string
  est_monthly_sales: string
  seller: string
  category: string
  status: Competitor['status']
  note: string
}

const EMPTY: FormState = {
  store_id: '',
  product_id: '',
  platform: 'amazon',
  marketplace: 'US',
  asin: '',
  title: '',
  brand: '',
  url: '',
  image_url: '',
  currency: 'USD',
  price: '',
  list_price: '',
  coupon: '',
  rating: '0',
  reviews: '0',
  bsr: '',
  est_monthly_sales: '0',
  seller: '',
  category: '',
  status: 'tracking',
  note: '',
}

interface EnrichedCompetitor extends Competitor {
  myPriceCny: number | null
  compPriceCny: number
  /** 竞品相对我方售价的百分比，负数=竞品更便宜 */
  gap: number | null
  position: 'lower' | 'similar' | 'higher' | null
  product?: Product
}

function pricePosition(gap: number | null) {
  if (gap === null) return null
  if (gap <= -GAP_THRESHOLD) return 'lower' as const
  if (gap >= GAP_THRESHOLD) return 'higher' as const
  return 'similar' as const
}

/** 星级展示：4.3 → 4.3，避免 0 分显示成 0.0 的刺眼感 */
function ratingText(rating: number) {
  return Number(rating) > 0 ? Number(rating).toFixed(1) : '—'
}

export default function Competitors() {
  const { push } = useToast()
  const { enabledPlatforms } = useAuth()
  const fx = useFx()

  const [search, setSearch] = useState('')
  const [platformFilter, setPlatformFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [threatOnly, setThreatOnly] = useState('all')
  const [page, setPage] = useState(1)

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Competitor | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)

  const [detailId, setDetailId] = useState<string | null>(null)
  const [snapTarget, setSnapTarget] = useState<Competitor | null>(null)
  const [snapForm, setSnapForm] = useState({ price: '', rating: '', reviews: '', bsr: '', est_monthly_sales: '' })
  const [snapping, setSnapping] = useState(false)

  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkRows, setBulkRows] = useState<Record<string, { price: string; rating: string; reviews: string }>>({})
  const [bulkSaving, setBulkSaving] = useState(false)

  const [deleting, setDeleting] = useState<Competitor | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [taskLoading, setTaskLoading] = useState(false)

  const { data, loading, error, reload } = useAsync(async () => {
    const [competitors, snapshots, products, stores] = await Promise.all([
      fetchRows<Competitor>('competitors', { order: { column: 'created_at', ascending: false } }),
      fetchRows<CompetitorSnapshot>('competitor_snapshots', { order: { column: 'snapshot_date' } }),
      fetchRows<Product>('products'),
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
    ])
    return { competitors, snapshots, products, stores }
  }, [])

  const productMap = useMemo(() => new Map((data?.products ?? []).map((p) => [p.id, p])), [data])
  const storeMap = useMemo(() => new Map((data?.stores ?? []).map((s) => [s.id, s])), [data])

  const enriched: EnrichedCompetitor[] = useMemo(() => {
    return (data?.competitors ?? []).map((c) => {
      const product = c.product_id ? productMap.get(c.product_id) : undefined
      const compPriceCny = convert(c.price, c.currency, 'CNY', fx)
      const myPriceCny = product ? convert(product.sale_price, product.currency, 'CNY', fx) : null
      const gap = myPriceCny && myPriceCny > 0 ? ((compPriceCny - myPriceCny) / myPriceCny) * 100 : null
      return { ...c, product, compPriceCny, myPriceCny, gap, position: pricePosition(gap) }
    })
  }, [data, productMap, fx])

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return enriched.filter((c) => {
      if (platformFilter && c.platform !== platformFilter) return false
      if (statusFilter && c.status !== statusFilter) return false
      if (threatOnly === 'threat' && !(c.status === 'tracking' && c.gap !== null && c.gap <= -GAP_THRESHOLD)) return false
      if (!kw) return true
      return [c.title, c.asin ?? '', c.brand ?? '', c.seller ?? '', c.category ?? ''].some((v) =>
        v.toLowerCase().includes(kw),
      )
    })
  }, [enriched, search, platformFilter, statusFilter, threatOnly])

  const kpi = useMemo(() => {
    const tracking = enriched.filter((c) => c.status === 'tracking')
    const avgPrice = tracking.length ? tracking.reduce((s, c) => s + c.compPriceCny, 0) / tracking.length : 0
    const threats = tracking.filter((c) => c.gap !== null && c.gap <= -GAP_THRESHOLD).length
    const rated = tracking.filter((c) => Number(c.rating) > 0)
    const avgRating = rated.length ? rated.reduce((s, c) => s + Number(c.rating), 0) / rated.length : 0
    const reviewSum = tracking.reduce((s, c) => s + c.reviews, 0)
    return { tracking: tracking.length, avgPrice, threats, avgRating, reviewSum }
  }, [enriched])

  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const detail = useMemo(() => enriched.find((c) => c.id === detailId) ?? null, [enriched, detailId])

  const detailSeries = useMemo(() => {
    if (!detail) return []
    return (data?.snapshots ?? [])
      .filter((s) => s.competitor_id === detail.id)
      .slice(-60)
      .map((s) => ({
        date: s.snapshot_date,
        price: Number(s.price),
        reviews: s.reviews,
      }))
  }, [data, detail])

  const detailSnapshots = useMemo(() => {
    if (!detail) return []
    return (data?.snapshots ?? [])
      .filter((s) => s.competitor_id === detail.id)
      .sort((a, b) => (a.snapshot_date < b.snapshot_date ? 1 : -1))
      .slice(0, 12)
  }, [data, detail])

  /* ---------------- 表单 ---------------- */

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY, store_id: data?.stores[0]?.id ?? '' })
    setModalOpen(true)
  }

  function openEdit(c: Competitor) {
    setEditing(c)
    setForm({
      store_id: c.store_id ?? '',
      product_id: c.product_id ?? '',
      platform: c.platform,
      marketplace: c.marketplace,
      asin: c.asin ?? '',
      title: c.title,
      brand: c.brand ?? '',
      url: c.url ?? '',
      image_url: c.image_url ?? '',
      currency: c.currency,
      price: String(c.price),
      list_price: c.list_price ? String(c.list_price) : '',
      coupon: c.coupon ?? '',
      rating: String(c.rating),
      reviews: String(c.reviews),
      bsr: c.bsr ? String(c.bsr) : '',
      est_monthly_sales: String(c.est_monthly_sales),
      seller: c.seller ?? '',
      category: c.category ?? '',
      status: c.status,
      note: c.note ?? '',
    })
    setModalOpen(true)
  }

  function pickStore(storeId: string) {
    const store = storeMap.get(storeId)
    setForm((f) => ({
      ...f,
      store_id: storeId,
      platform: store?.platform ?? f.platform,
      marketplace: store?.marketplace ?? f.marketplace,
      currency: store?.currency ?? f.currency,
    }))
  }

  function pickProduct(productId: string) {
    const product = productMap.get(productId)
    if (!product) return setForm((f) => ({ ...f, product_id: '' }))
    const store = storeMap.get(product.store_id)
    setForm((f) => ({
      ...f,
      product_id: productId,
      store_id: product.store_id,
      platform: store?.platform ?? f.platform,
      marketplace: store?.marketplace ?? f.marketplace,
      currency: product.currency,
      category: f.category || product.category || '',
    }))
  }

  /** 同一竞品同一天只保留一条快照，重复采集就覆盖当天 */
  async function upsertSnapshot(competitorId: string, values: {
    price: number
    rating: number
    reviews: number
    bsr: number | null
    est_monthly_sales: number
  }) {
    const existing = await fetchRows<{ id: string }>('competitor_snapshots', {
      filters: [
        ['competitor_id', 'eq', competitorId],
        ['snapshot_date', 'eq', today()],
      ],
      columns: 'id',
      limit: 1,
    })
    const payload = { competitor_id: competitorId, snapshot_date: today(), ...values }
    if (existing.length) await updateRow('competitor_snapshots', existing[0].id, payload)
    else await insertRow('competitor_snapshots', payload)
  }

  async function handleSave() {
    if (!form.title.trim()) return push('请填写竞品标题', 'error')
    setSaving(true)
    try {
      const payload = {
        store_id: form.store_id || null,
        product_id: form.product_id || null,
        platform: form.platform,
        marketplace: form.marketplace,
        asin: form.asin.trim() || null,
        title: form.title.trim(),
        brand: form.brand.trim() || null,
        url: form.url.trim() || null,
        image_url: form.image_url.trim() || null,
        currency: form.currency || 'USD',
        price: Number(form.price) || 0,
        list_price: Number(form.list_price) || 0,
        coupon: form.coupon.trim() || null,
        rating: Math.min(5, Math.max(0, Number(form.rating) || 0)),
        reviews: Math.round(Number(form.reviews) || 0),
        bsr: form.bsr ? Math.round(Number(form.bsr)) : null,
        est_monthly_sales: Math.round(Number(form.est_monthly_sales) || 0),
        seller: form.seller.trim() || null,
        category: form.category.trim() || null,
        status: form.status,
        note: form.note.trim() || null,
        last_checked: today(),
      }

      let competitorId = editing?.id
      if (editing) {
        await updateRow('competitors', editing.id, payload)
      } else {
        const created = await insertRow<Competitor>('competitors', payload)
        competitorId = created.id
      }

      if (competitorId) {
        await upsertSnapshot(competitorId, {
          price: payload.price,
          rating: payload.rating,
          reviews: payload.reviews,
          bsr: payload.bsr,
          est_monthly_sales: payload.est_monthly_sales,
        })
      }

      push(editing ? '竞品已更新，今日快照已记录' : '竞品已加入跟踪，已记录今日快照')
      setModalOpen(false)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate|unique/i.test(msg) ? '该站点下已跟踪过同一个 ASIN' : msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  function openSnapshot(c: Competitor) {
    setSnapTarget(c)
    setSnapForm({
      price: String(c.price),
      rating: String(c.rating),
      reviews: String(c.reviews),
      bsr: c.bsr ? String(c.bsr) : '',
      est_monthly_sales: String(c.est_monthly_sales),
    })
  }

  async function handleSnapshot() {
    if (!snapTarget) return
    setSnapping(true)
    try {
      const values = {
        price: Number(snapForm.price) || 0,
        rating: Math.min(5, Math.max(0, Number(snapForm.rating) || 0)),
        reviews: Math.round(Number(snapForm.reviews) || 0),
        bsr: snapForm.bsr ? Math.round(Number(snapForm.bsr)) : null,
        est_monthly_sales: Math.round(Number(snapForm.est_monthly_sales) || 0),
      }
      await updateRow('competitors', snapTarget.id, { ...values, last_checked: today() })
      await upsertSnapshot(snapTarget.id, values)
      push('今日快照已记录，趋势图已刷新')
      setSnapTarget(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '记录失败', 'error')
    } finally {
      setSnapping(false)
    }
  }

  async function handleBulk() {
    const changed = enriched.filter((c) => {
      if (c.status !== 'tracking') return false
      const row = bulkRows[c.id]
      if (!row) return false
      return (
        Number(row.price) !== Number(c.price) ||
        Number(row.rating) !== Number(c.rating) ||
        Number(row.reviews) !== Number(c.reviews)
      )
    })
    if (!changed.length) return push('数值没有变化，不需要记录快照', 'info')

    setBulkSaving(true)
    let ok = 0
    for (const c of changed) {
      const row = bulkRows[c.id]
      const values = {
        price: Number(row.price) || 0,
        rating: Math.min(5, Math.max(0, Number(row.rating) || 0)),
        reviews: Math.round(Number(row.reviews) || 0),
      }
      try {
        await updateRow('competitors', c.id, { ...values, last_checked: today() })
        await upsertSnapshot(c.id, { ...values, bsr: c.bsr, est_monthly_sales: c.est_monthly_sales })
        ok += 1
      } catch {
        // 单条失败不影响其他竞品，最后统一提示
      }
    }
    setBulkSaving(false)
    setBulkOpen(false)
    reload()
    push(`已记录 ${ok} 个竞品的今日快照`, ok === changed.length ? 'success' : 'error')
  }

  function openBulk() {
    const init: Record<string, { price: string; rating: string; reviews: string }> = {}
    for (const c of enriched) {
      if (c.status !== 'tracking') continue
      init[c.id] = { price: String(c.price), rating: String(c.rating), reviews: String(c.reviews) }
    }
    if (!Object.keys(init).length) return push('还没有跟踪中的竞品', 'info')
    setBulkRows(init)
    setBulkOpen(true)
  }

  async function handleDelete() {
    if (!deleting) return
    setConfirmLoading(true)
    try {
      await deleteRow('competitors', deleting.id)
      push('竞品已删除')
      if (detailId === deleting.id) setDetailId(null)
      setDeleting(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirmLoading(false)
    }
  }

  async function createFollowUpTask(c: EnrichedCompetitor) {
    setTaskLoading(true)
    try {
      const gapText =
        c.gap === null
          ? '未关联我方商品'
          : `价差 ${c.gap > 0 ? '+' : ''}${c.gap.toFixed(1)}%（负数表示竞品更便宜）`
      await insertRow('tasks', {
        store_id: c.store_id,
        title: `竞品跟进：${c.title.slice(0, 40)}`,
        description: [
          `竞品：${c.brand ? `${c.brand} · ` : ''}${c.title}`,
          `站点：${platformMeta(c.platform).label} ${c.marketplace}${c.asin ? ` · ${c.asin}` : ''}`,
          `当前售价：${money(c.price, c.currency)}｜评分 ${ratingText(c.rating)}｜评论 ${num(c.reviews)}｜BSR ${c.bsr ? num(c.bsr) : '—'}`,
          `对接我方：${c.product ? `${c.product.sku}（售价 ${money(c.product.sale_price, c.product.currency)}）` : '未关联'}`,
          `价格位置：${gapText}`,
        ].join('\n'),
        module: 'other',
        priority: c.gap !== null && c.gap <= -5 ? 'high' : 'medium',
        status: 'todo',
        due_date: dayjs().add(3, 'day').format('YYYY-MM-DD'),
      })
      push('已生成跟进任务，可在任务看板查看')
    } catch (err) {
      push(err instanceof Error ? err.message : '生成失败', 'error')
    } finally {
      setTaskLoading(false)
    }
  }

  const currentStore = storeMap.get(form.store_id)

  return (
    <>
      <PageHeader
        title="竞品分析"
        description="盯住同站点竞品的价格、评分与排名，价差超过 3% 自动预警"
        actions={
          <>
            <Button icon={<ClipboardCheck className="w-3.5 h-3.5" />} onClick={openBulk} disabled={!kpi.tracking}>
              批量采集快照
            </Button>
            <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
              新增竞品
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        {[
          { label: '跟踪中竞品', value: num(kpi.tracking), icon: <Telescope className="w-4 h-4" />, tone: 'bg-brand-50 text-brand-600' },
          { label: '竞品均价（折 CNY）', value: money(kpi.avgPrice, 'CNY'), icon: <Star className="w-4 h-4" />, tone: 'bg-violet-50 text-violet-600' },
          { label: '价格低于我方', value: num(kpi.threats), icon: <ArrowDownRight className="w-4 h-4" />, tone: 'bg-rose-50 text-rose-600' },
          { label: '平均评分', value: ratingText(kpi.avgRating), icon: <ClipboardList className="w-4 h-4" />, tone: 'bg-amber-50 text-amber-600' },
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
            placeholder="标题 / ASIN / 品牌 / 卖家"
            className="w-full sm:w-60"
          />
          <Select
            className="w-full sm:w-36"
            value={platformFilter}
            onChange={(v) => { setPlatformFilter(v); setPage(1) }}
            placeholder="全部平台"
            options={platformOptions(enabledPlatforms).map((p) => ({ value: p.code, label: p.label }))}
          />
          <Select
            className="w-full sm:w-32"
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1) }}
            placeholder="全部状态"
            options={Object.entries(COMPETITOR_STATUS).map(([value, v]) => ({ value, label: v.label }))}
          />
          <Segmented
            size="sm"
            value={threatOnly}
            onChange={(v) => { setThreatOnly(v); setPage(1) }}
            options={[
              { value: 'all', label: '全部' },
              { value: 'threat', label: '仅看价格威胁' },
            ]}
          />
          <span className="ml-auto text-[11.5px] text-ink-400">
            共 <span className="num text-ink-700 font-medium">{num(filtered.length)}</span> 个竞品
          </span>
        </div>

        {error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : loading ? (
          <LoadingBlock rows={6} />
        ) : pageRows.length === 0 ? (
          <EmptyState
            icon={<Telescope className="w-5 h-5" />}
            title={enriched.length ? '没有匹配的竞品' : '还没有跟踪任何竞品'}
            description={
              enriched.length
                ? '换个关键词或清空筛选条件试试'
                : '把同站点卖得好的链接录进来，关联我方商品后即可自动算价差、盯价格变化。'
            }
            action={
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
                新增竞品
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px]">
              <thead>
                <tr>
                  <th className="th">竞品</th>
                  <th className="th">平台 · 站点</th>
                  <th className="th text-right">售价</th>
                  <th className="th text-right">评分 / 评论</th>
                  <th className="th text-right">BSR</th>
                  <th className="th text-right">预估月销</th>
                  <th className="th w-[164px]">对标我方</th>
                  <th className="th">状态</th>
                  <th className="th w-16" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((c) => {
                  const meta = COMPETITOR_STATUS[c.status]
                  const pos = c.position ? PRICE_POSITION[c.position] : null
                  return (
                    <tr key={c.id} className="hover:bg-ink-50/60 group cursor-pointer" onClick={() => setDetailId(c.id)}>
                      <td className="td">
                        <div className="flex items-center gap-2.5">
                          {c.image_url ? (
                            <img src={c.image_url} alt="" className="w-9 h-9 rounded-lg object-cover border border-ink-200 shrink-0" />
                          ) : (
                            <div className="w-9 h-9 rounded-lg bg-ink-100 flex items-center justify-center shrink-0">
                              <ImageOff className="w-4 h-4 text-ink-300" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="text-[12.5px] font-medium text-ink-800 truncate max-w-[260px]">{c.title}</p>
                            <p className="text-[10.5px] text-ink-400 font-mono truncate max-w-[260px]">
                              {c.brand ? `${c.brand} · ` : ''}
                              {c.asin ?? c.seller ?? '—'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              'w-4 h-4 rounded flex items-center justify-center text-[8px] font-bold text-white shrink-0',
                              platformMeta(c.platform).badge,
                            )}
                          >
                            {platformMeta(c.platform).initial}
                          </span>
                          <span className="text-[11.5px] text-ink-600">
                            {marketplaceMeta(c.marketplace).name}
                            <span className="text-ink-400"> · {c.marketplace}</span>
                          </span>
                        </div>
                      </td>
                      <td className="td text-right">
                        <p className="num font-medium text-ink-800">{money(c.price, c.currency)}</p>
                        {c.list_price > c.price && (
                          <p className="text-[10.5px] text-ink-400 num line-through">{money(c.list_price, c.currency)}</p>
                        )}
                        {c.coupon && <p className="text-[10px] text-rose-500 truncate max-w-[110px]">{c.coupon}</p>}
                      </td>
                      <td className="td text-right">
                        <p className="num text-[12.5px] text-ink-700">
                          <span className="text-amber-500">★</span> {ratingText(c.rating)}
                        </p>
                        <p className="num text-[10.5px] text-ink-400">{num(c.reviews)} 条</p>
                      </td>
                      <td className="td text-right num text-ink-600">{c.bsr ? num(c.bsr) : '—'}</td>
                      <td className="td text-right num text-ink-600">{c.est_monthly_sales ? num(c.est_monthly_sales) : '—'}</td>
                      <td className="td">
                        {c.product ? (
                          <>
                            <div className="flex items-center gap-1.5">
                              <span className={cn('num text-[12px] font-medium', c.gap !== null && c.gap < 0 ? 'text-rose-600' : 'text-emerald-600')}>
                                {c.gap !== null ? `${c.gap > 0 ? '+' : ''}${c.gap.toFixed(1)}%` : '—'}
                              </span>
                              {pos && <Badge tone={pos.tone}>{pos.label}</Badge>}
                            </div>
                            <p className="text-[10.5px] text-ink-400 font-mono truncate max-w-[140px]">{c.product.sku}</p>
                          </>
                        ) : (
                          <span className="text-[11.5px] text-ink-300">未关联</span>
                        )}
                      </td>
                      <td className="td">
                        <Badge tone={meta?.tone ?? 'gray'}>{meta?.label ?? c.status}</Badge>
                        <p className="text-[10px] text-ink-400 mt-0.5">{agoDay(c.last_checked)}采集</p>
                      </td>
                      <td className="td" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100" onClick={() => openEdit(c)} title="编辑">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            data-perm="delete"
                            className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                            onClick={() => setDeleting(c)}
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

        {filtered.length > PAGE_SIZE && (
          <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} />
        )}
      </div>

      {/* ---------------- 竞品详情 + 趋势 ---------------- */}
      <Modal
        open={!!detail}
        onClose={() => setDetailId(null)}
        title={detail?.title ?? '竞品详情'}
        description={
          detail
            ? `${platformMeta(detail.platform).label} ${detail.marketplace}${detail.asin ? ` · ${detail.asin}` : ''} · 最近采集 ${fmtDate(detail.last_checked)}`
            : undefined
        }
        width="max-w-3xl"
        footer={
          <>
            <Button onClick={() => setDetailId(null)}>关闭</Button>
            {detail && (
              <Button
                icon={<ClipboardList className="w-3.5 h-3.5" />}
                loading={taskLoading}
                onClick={() => createFollowUpTask(detail)}
              >
                生成跟进任务
              </Button>
            )}
            {detail && (
              <Button variant="primary" icon={<ClipboardCheck className="w-3.5 h-3.5" />} onClick={() => openSnapshot(detail)}>
                记录今日快照
              </Button>
            )}
          </>
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: '当前售价', value: money(detail.price, detail.currency) },
                { label: '评分 / 评论', value: `${ratingText(detail.rating)} / ${num(detail.reviews)}` },
                { label: 'BSR', value: detail.bsr ? num(detail.bsr) : '—' },
                { label: '预估月销', value: detail.est_monthly_sales ? num(detail.est_monthly_sales) : '—' },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-ink-200/70 px-3 py-2">
                  <p className="text-[10.5px] text-ink-400">{s.label}</p>
                  <p className="num text-[13.5px] font-medium text-ink-900 mt-0.5">{s.value}</p>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-ink-200/70 px-3 py-2.5">
              {detail.product ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
                  <span className="text-ink-500">
                    我方对标：
                    <span className="font-mono text-ink-800">{detail.product.sku}</span>
                  </span>
                  <span className="text-ink-500">
                    我方售价 <span className="num text-ink-800">{money(detail.product.sale_price, detail.product.currency)}</span>
                  </span>
                  <span className="text-ink-500">
                    竞品折 CNY <span className="num text-ink-800">{money(detail.compPriceCny, 'CNY')}</span>
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-0.5 num font-medium',
                      detail.gap !== null && detail.gap < 0 ? 'text-rose-600' : 'text-emerald-600',
                    )}
                  >
                    {detail.gap !== null && detail.gap < 0 ? <ArrowDownRight className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                    {detail.gap !== null ? `${detail.gap > 0 ? '+' : ''}${detail.gap.toFixed(1)}%` : '—'}
                  </span>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11.5px] text-ink-500">还没关联我方商品，关联后可以自动算价差与价格带位置。</p>
                  <Button size="sm" onClick={() => { setDetailId(null); openEdit(detail) }}>
                    去关联
                  </Button>
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[12.5px] font-medium text-ink-800">价格与评论趋势</p>
                <div className="flex items-center gap-3 text-[10.5px] text-ink-400">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-brand-500" /> 售价
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-amber-500" /> 评论数
                  </span>
                </div>
              </div>
              {detailSeries.length < 2 ? (
                <div className="rounded-lg bg-ink-50 border border-ink-100 px-3 py-6 text-center text-[11.5px] text-ink-500">
                  只有一次记录，趋势线至少要两次采集。明天再来点一次「记录快照」，或先补几条历史数据。
                </div>
              ) : (
                <div style={{ height: 220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={detailSeries} margin={{ top: 6, right: 6, left: -14, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eff1f5" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10.5, fill: '#98a2b3' }}
                        axisLine={false}
                        tickLine={false}
                        minTickGap={20}
                        tickFormatter={(v: string) => dayjs(v).format('MM/DD')}
                      />
                      <YAxis
                        yAxisId="price"
                        tick={{ fontSize: 10.5, fill: '#98a2b3' }}
                        axisLine={false}
                        tickLine={false}
                        width={54}
                        domain={['auto', 'auto']}
                        tickFormatter={(v: number) => `${v}`}
                      />
                      <YAxis
                        yAxisId="reviews"
                        orientation="right"
                        tick={{ fontSize: 10.5, fill: '#98a2b3' }}
                        axisLine={false}
                        tickLine={false}
                        width={48}
                      />
                      <Tooltip
                        contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #e6e9ef' }}
                        labelFormatter={(v) => fmtDate(String(v))}
                        formatter={(value, name) =>
                          name === '售价'
                            ? [money(Number(value), detail.currency), name]
                            : [num(Number(value)), name]
                        }
                      />
                      <Line yAxisId="price" type="monotone" dataKey="price" name="售价" stroke="#3b6ef6" strokeWidth={2} dot={false} />
                      <Line yAxisId="reviews" type="monotone" dataKey="reviews" name="评论数" stroke="#f59e0b" strokeWidth={1.6} strokeDasharray="4 3" dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div>
              <p className="text-[12.5px] font-medium text-ink-800 mb-2">最近采集记录</p>
              {detailSnapshots.length === 0 ? (
                <p className="text-[11.5px] text-ink-400">暂无历史快照</p>
              ) : (
                <div className="rounded-lg border border-ink-200/70 overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr>
                        <th className="th">日期</th>
                        <th className="th text-right">售价</th>
                        <th className="th text-right">评分</th>
                        <th className="th text-right">评论</th>
                        <th className="th text-right">BSR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailSnapshots.map((s, i) => {
                        const prev = detailSnapshots[i + 1]
                        const drop = prev ? Number(s.price) - Number(prev.price) : 0
                        return (
                          <tr key={s.id} className="hover:bg-ink-50/60">
                            <td className="td text-[12px]">
                              {fmtDate(s.snapshot_date)}
                              {dayDiff(s.snapshot_date) === 0 && (
                                <span className="ml-1.5 text-[10px] text-brand-600">今天</span>
                              )}
                            </td>
                            <td className="td text-right">
                              <span className="num text-[12.5px]">{money(s.price, detail.currency)}</span>
                              {prev && Math.abs(drop) > 0.001 && (
                                <span className={cn('ml-1.5 num text-[10.5px]', drop < 0 ? 'text-rose-500' : 'text-emerald-600')}>
                                  {drop < 0 ? '↓' : '↑'}
                                  {Math.abs(drop).toFixed(2)}
                                </span>
                              )}
                            </td>
                            <td className="td text-right num text-[12px]">{ratingText(s.rating)}</td>
                            <td className="td text-right num text-[12px] text-ink-500">{num(s.reviews)}</td>
                            <td className="td text-right num text-[12px] text-ink-500">{s.bsr ? num(s.bsr) : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {detail.url && (
              <a href={detail.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] link">
                打开竞品链接 <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        )}
      </Modal>

      {/* ---------------- 新增 / 编辑 ---------------- */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? '编辑竞品' : '新增竞品'}
        description="建议先选「对标我方商品」，站点、币种与类目会自动带出"
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
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="对标我方商品" className="sm:col-span-2" hint="关联后才能自动计算价差；同一站点建议一个竞品对一条商品">
            <Select
              value={form.product_id}
              onChange={pickProduct}
              placeholder="不关联，仅做价格监控"
              options={(data?.products ?? []).map((p) => ({
                value: p.id,
                label: `${p.sku} · ${p.title.slice(0, 34)}（${money(p.sale_price, p.currency)}）`,
              }))}
            />
          </Field>

          <Field label="所属店铺">
            <Select
              value={form.store_id}
              onChange={pickStore}
              placeholder="不指定"
              options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
          <Field label="站点">
            <Select
              value={form.marketplace}
              onChange={(v) => setForm({ ...form, marketplace: v, currency: marketplaceMeta(v).currency })}
              options={MARKETPLACES.map((m) => ({ value: m.code, label: `${m.flag} ${m.name} · ${m.code}` }))}
            />
          </Field>

          <Field label="竞品标题" required className="sm:col-span-2">
            <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Listing 标题" />
          </Field>

          <Field label="品牌">
            <input className="input" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} placeholder="如 Anker" />
          </Field>
          <Field label="ASIN / 商品 ID" hint="同站点同 ASIN 只允许跟踪一次">
            <input className="input font-mono" value={form.asin} onChange={(e) => setForm({ ...form, asin: e.target.value })} placeholder="B0XXXXXXXX" />
          </Field>

          <Field label="售价" required>
            <input className="input num" type="number" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0.00" />
          </Field>
          <Field label="划线价" hint="用于计算折扣力度，没有可留空">
            <input className="input num" type="number" step="0.01" value={form.list_price} onChange={(e) => setForm({ ...form, list_price: e.target.value })} placeholder="0.00" />
          </Field>

          <Field label="评分">
            <input className="input num" type="number" min="0" max="5" step="0.1" value={form.rating} onChange={(e) => setForm({ ...form, rating: e.target.value })} />
          </Field>
          <Field label="评论数">
            <input className="input num" type="number" value={form.reviews} onChange={(e) => setForm({ ...form, reviews: e.target.value })} />
          </Field>

          <Field label="BSR 类目排名">
            <input className="input num" type="number" value={form.bsr} onChange={(e) => setForm({ ...form, bsr: e.target.value })} placeholder="如 1280" />
          </Field>
          <Field label="预估月销">
            <input className="input num" type="number" value={form.est_monthly_sales} onChange={(e) => setForm({ ...form, est_monthly_sales: e.target.value })} />
          </Field>

          <Field label="卖家">
            <input className="input" value={form.seller} onChange={(e) => setForm({ ...form, seller: e.target.value })} placeholder="店铺 / 卖家名" />
          </Field>
          <Field label="优惠 / 促销">
            <input className="input" value={form.coupon} onChange={(e) => setForm({ ...form, coupon: e.target.value })} placeholder="如 Coupon 10% / 限时秒杀" />
          </Field>

          <Field label="类目">
            <input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="如 Home & Kitchen" />
          </Field>
          <Field label="状态">
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v as Competitor['status'] })}
              options={Object.entries(COMPETITOR_STATUS).map(([value, v]) => ({ value, label: v.label }))}
            />
          </Field>

          <Field label="竞品链接">
            <input className="input" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" />
          </Field>
          <Field label="主图链接">
            <input className="input" value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} placeholder="https://…" />
          </Field>

          <Field label="备注" className="sm:col-span-2">
            <textarea className="textarea" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="卖点差异、评论里的高频抱怨、供应链线索…" />
          </Field>

          <div className="sm:col-span-2 rounded-lg bg-ink-50 border border-ink-100 px-3 py-2 text-[11.5px] text-ink-500">
            保存时会同时写入一条「今日快照」，之后每次点「记录快照」都会留档，趋势图按快照绘制。
            {currentStore ? ` 币种跟随店铺：${currentStore.currency}。` : form.currency ? ` 当前币种：${form.currency}。` : ''}
          </div>
        </div>
      </Modal>

      {/* ---------------- 记录快照 ---------------- */}
      <Modal
        open={!!snapTarget}
        onClose={() => setSnapTarget(null)}
        title="记录今日快照"
        description={snapTarget ? `${snapTarget.title.slice(0, 50)} · ${today()}` : undefined}
        footer={
          <>
            <Button onClick={() => setSnapTarget(null)}>取消</Button>
            <Button variant="primary" onClick={handleSnapshot} loading={snapping}>
              保存快照
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="售价" required>
            <input className="input num" type="number" step="0.01" value={snapForm.price} onChange={(e) => setSnapForm({ ...snapForm, price: e.target.value })} />
          </Field>
          <Field label="评分">
            <input className="input num" type="number" min="0" max="5" step="0.1" value={snapForm.rating} onChange={(e) => setSnapForm({ ...snapForm, rating: e.target.value })} />
          </Field>
          <Field label="评论数">
            <input className="input num" type="number" value={snapForm.reviews} onChange={(e) => setSnapForm({ ...snapForm, reviews: e.target.value })} />
          </Field>
          <Field label="BSR">
            <input className="input num" type="number" value={snapForm.bsr} onChange={(e) => setSnapForm({ ...snapForm, bsr: e.target.value })} />
          </Field>
          <Field label="预估月销" className="col-span-2">
            <input className="input num" type="number" value={snapForm.est_monthly_sales} onChange={(e) => setSnapForm({ ...snapForm, est_monthly_sales: e.target.value })} />
          </Field>
          <p className="col-span-2 text-[11.5px] text-ink-500 leading-relaxed">
            同一天重复记录会覆盖当天数据（不会产生重复点）。竞品当前值也会同步更新为这次填写的数字。
          </p>
        </div>
      </Modal>

      {/* ---------------- 批量采集 ---------------- */}
      <Modal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="批量采集今日快照"
        description={`${today()} · 只填有变化的竞品，没改的不会写入`}
        width="max-w-2xl"
        footer={
          <>
            <Button onClick={() => setBulkOpen(false)}>取消</Button>
            <Button variant="primary" onClick={handleBulk} loading={bulkSaving}>
              记录快照
            </Button>
          </>
        }
      >
        <div className="rounded-lg border border-ink-200/70 overflow-hidden">
          <div className="grid grid-cols-[1fr_86px_64px_80px] gap-2 px-3 py-2 bg-ink-50/70 text-[10.5px] font-semibold uppercase tracking-wide text-ink-500">
            <span>竞品</span>
            <span className="text-right">售价</span>
            <span className="text-right">评分</span>
            <span className="text-right">评论数</span>
          </div>
          <div className="max-h-[340px] overflow-y-auto divide-y divide-ink-100">
            {enriched
              .filter((c) => c.status === 'tracking')
              .map((c) => {
                const row = bulkRows[c.id] ?? { price: '', rating: '', reviews: '' }
                const update = (patch: Partial<typeof row>) =>
                  setBulkRows((prev) => ({ ...prev, [c.id]: { ...row, ...patch } }))
                return (
                  <div key={c.id} className="grid grid-cols-[1fr_86px_64px_80px] gap-2 px-3 py-2 items-center">
                    <div className="min-w-0">
                      <p className="text-[12px] text-ink-800 truncate">{c.title}</p>
                      <p className="text-[10px] text-ink-400 font-mono truncate">
                        {c.asin ?? c.seller ?? '—'} · {c.marketplace}
                      </p>
                    </div>
                    <input
                      className="input h-8 text-right num !px-2"
                      type="number"
                      step="0.01"
                      value={row.price}
                      onChange={(e) => update({ price: e.target.value })}
                    />
                    <input
                      className="input h-8 text-right num !px-2"
                      type="number"
                      step="0.1"
                      min="0"
                      max="5"
                      value={row.rating}
                      onChange={(e) => update({ rating: e.target.value })}
                    />
                    <input
                      className="input h-8 text-right num !px-2"
                      type="number"
                      value={row.reviews}
                      onChange={(e) => update({ reviews: e.target.value })}
                    />
                  </div>
                )
              })}
          </div>
        </div>
        <p className="mt-2.5 text-[11.5px] text-ink-500 leading-relaxed">
          采集频率建议：大促前每日一次，平时每周 1–2 次。快照越密，趋势图越能反映竞品的调价节奏。
        </p>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={confirmLoading}
        title="删除竞品"
        message={`确定删除「${deleting?.title ?? ''}」吗？该竞品的全部历史快照会一起删除，不可恢复。`}
      />
    </>
  )
}
