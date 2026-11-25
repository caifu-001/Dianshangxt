/**
 * 驾驶舱的数据模型层：把各业务表揉成一块「大屏」需要的指标。
 *
 * 单独拆出来是为了让页面只负责画，计算逻辑可以独立推敲：
 *  - 所有金额统一按店铺币种折成 USD（与运营概览、利润核算保持一致）
 *  - 今日指标用「近 7 日日均」做基准，而不是昨天全天 ——
 *    今天还没过完，拿它跟昨天完整的 24 小时比必然偏低，会误导判断
 *  - 库存分档与运营概览、库存管理页共用同一套阈值
 */
import dayjs from 'dayjs'
import type {
  Campaign,
  Competitor,
  CompetitorSnapshot,
  Creator,
  InventoryItem,
  Order,
  Product,
  PurchaseItem,
  PurchaseOrder,
  Store,
  Task,
} from './types'
import { convert, type FxRates } from './fx'
import { compactMoney, sum } from './utils'

export type Tone = 'blue' | 'cyan' | 'green' | 'violet' | 'amber' | 'rose'

export type ValueFormat = 'money' | 'int' | 'pct' | 'ratio' | 'days'

export interface KpiTile {
  key: string
  label: string
  value: number
  format: ValueFormat
  /** 相对基准的变化百分比；null 表示不适用 */
  delta: number | null
  deltaLabel: string
  hint: string
  tone: Tone
  /** 迷你趋势（近 7 天，按日期升序） */
  spark: number[]
}

export interface CockpitRaw {
  stores: Store[]
  orders: Order[]
  products: Product[]
  inventory: InventoryItem[]
  campaigns: Campaign[]
  creators: Creator[]
  competitors: Competitor[]
  snapshots: CompetitorSnapshot[]
  purchaseOrders: PurchaseOrder[]
  purchaseItems: PurchaseItem[]
  tasks: Task[]
}

export interface TrendPoint {
  date: string
  sales: number
  profit: number
  orders: number
  adSpend: number
}

export interface StoreRow {
  id: string
  name: string
  platform: string
  marketplace: string
  sales: number
  profit: number
  orders: number
  margin: number
  /** 占全团队销售额比重 */
  share: number
}

export interface InventoryHealth {
  total: number
  out: number
  urgent: number
  low: number
  healthy: number
  over: number
  /** 整体可售天数（总可售 / 总日均销量） */
  coverDays: number
  /** 健康档占比 */
  healthyRate: number
  worst: Array<{ sku: string; warehouse: string; qty: number; days: number }>
}

export interface AdFunnelData {
  impressions: number
  clicks: number
  orders: number
  spend: number
  sales: number
  ctr: number
  cvr: number
  acos: number
  roas: number
  targetAcos: number
  activeCampaigns: number
  totalCampaigns: number
}

export interface CreatorFunnelData {
  pending: number
  contacted: number
  sampling: number
  cooperating: number
  paused: number
  gmv: number
  total: number
  /** 合作中达人产出的 GMV 占 TikTok 口径的全部达人 GMV */
  top: Array<{ name: string; gmv: number }>
}

export interface PurchaseGlance {
  inTransitCount: number
  inTransitAmount: number
  overdueCount: number
  received30Count: number
  spend30: number
  suppliers: number
}

export interface CompetitorMove {
  id: string
  title: string
  platform: string
  marketplace: string
  price: number
  currency: string
  /** 相对上次快照的价格变化百分比，负数为降价 */
  change: number
  rating: number
  reviews: number
  status: string
}

export interface LiveOrder {
  id: string
  orderNo: string
  storeName: string
  platform: string
  sku: string
  qty: number
  amount: number
  status: string
  /** ISO 时间戳，页面用来显示「x 分钟前」 */
  at: string
}

export interface AlertItem {
  level: 'red' | 'amber' | 'blue'
  tag: string
  text: string
}

export interface CockpitModel {
  kpis: KpiTile[]
  trend: TrendPoint[]
  platformSplit: Array<{ name: string; value: number; color: string }>
  storeRows: StoreRow[]
  productRows: Array<{ name: string; value: number; qty: number }>
  inventory: InventoryHealth
  ads: AdFunnelData
  creators: CreatorFunnelData
  purchase: PurchaseGlance
  competitorMoves: CompetitorMove[]
  liveOrders: LiveOrder[]
  alerts: AlertItem[]
  /** 今日累计（顶部第二行小字用） */
  today: { sales: number; profit: number; orders: number; adSpend: number; margin: number }
  /** 已入库的订单笔数，用于判断「今天有没有真实成交」 */
  todayOrderCount: number
  /** 团队口径的 30 天 GMV，便于与运营概览对账 */
  gmv30: number
}

const INK = {
  out: '#fb7185',
  urgent: '#fb923c',
  low: '#fbbf24',
  healthy: '#34d399',
  over: '#60a5fa',
}

function bucketOf(item: InventoryItem): keyof typeof INK {
  const daily = Number(item.avg_daily_sales) || 0
  const days = daily > 0 ? item.available_qty / daily : 9999
  if (item.available_qty <= 0) return 'out'
  if (days < 14) return 'urgent'
  if (days < 30) return 'low'
  if (days > 150 && item.available_qty > item.safety_stock * 4) return 'over'
  return 'healthy'
}

function coverDaysOf(item: InventoryItem) {
  const daily = Number(item.avg_daily_sales) || 0
  if (item.available_qty <= 0) return 0
  return daily > 0 ? item.available_qty / daily : 9999
}

export function buildCockpit(raw: CockpitRaw, fx: FxRates): CockpitModel {
  const today = dayjs().format('YYYY-MM-DD')
  const d7 = dayjs().subtract(7, 'day').format('YYYY-MM-DD')
  const d30 = dayjs().subtract(29, 'day').format('YYYY-MM-DD')

  const storeById = new Map(raw.stores.map((s) => [s.id, s]))
  const currencyOf = (storeId: string | null | undefined) => storeById.get(storeId ?? '')?.currency ?? 'USD'
  const usd = (value: number | string | null | undefined, storeId: string | null | undefined) =>
    convert(Number(value ?? 0), currencyOf(storeId), 'USD', fx)

  const valid = raw.orders.filter((o) => o.status !== 'cancelled')
  const salesOf = (rows: Order[]) => sum(rows, (o) => usd(o.gross_amount, o.store_id))
  const profitOf = (rows: Order[]) => sum(rows, (o) => usd(o.profit, o.store_id))
  const adOf = (rows: Order[]) => sum(rows, (o) => usd(o.ad_cost, o.store_id))

  const ordersToday = valid.filter((o) => o.order_date === today)
  const orders7 = valid.filter((o) => o.order_date >= d7 && o.order_date < today)
  const orders30 = valid.filter((o) => o.order_date >= d30)

  const todaySales = salesOf(ordersToday)
  const todayProfit = profitOf(ordersToday)
  const todayOrders = ordersToday.length
  const todayAd = adOf(ordersToday)

  // 基准：近 7 个完整日（不含今天）的日均
  const avg7Sales = salesOf(orders7) / 7
  const avg7Profit = profitOf(orders7) / 7
  const avg7Orders = orders7.length / 7
  const avg7Ad = adOf(orders7) / 7

  // 近 7 天的日序列（含今天），给迷你趋势用
  const last7Series: TrendPoint[] = []
  for (let i = 6; i >= 0; i -= 1) {
    const date = dayjs().subtract(i, 'day').format('YYYY-MM-DD')
    const rows = valid.filter((o) => o.order_date === date)
    last7Series.push({
      date,
      sales: salesOf(rows),
      profit: profitOf(rows),
      orders: rows.length,
      adSpend: adOf(rows),
    })
  }

  const delta = (a: number, base: number) => (base > 0 ? ((a - base) / base) * 100 : null)
  const marginToday = todaySales > 0 ? (todayProfit / todaySales) * 100 : 0
  const aovToday = todayOrders > 0 ? todaySales / todayOrders : 0
  const tacos = todaySales > 0 ? (todayAd / todaySales) * 100 : 0

  // ---------- 库存 ----------
  const buckets = { out: 0, urgent: 0, low: 0, healthy: 0, over: 0 }
  let totalQty = 0
  let totalDaily = 0
  const worst: InventoryHealth['worst'] = []
  for (const item of raw.inventory) {
    buckets[bucketOf(item)] += 1
    totalQty += Math.max(0, item.available_qty)
    totalDaily += Math.max(0, Number(item.avg_daily_sales) || 0)
    const days = coverDaysOf(item)
    if (days < 30) worst.push({ sku: item.sku, warehouse: item.warehouse, qty: item.available_qty, days })
  }
  worst.sort((a, b) => a.days - b.days)

  const inventoryTotal = raw.inventory.length
  const inventory: InventoryHealth = {
    total: inventoryTotal,
    ...buckets,
    coverDays: totalDaily > 0 ? totalQty / totalDaily : 0,
    healthyRate: inventoryTotal > 0 ? (buckets.healthy / inventoryTotal) * 100 : 0,
    worst: worst.slice(0, 5),
  }

  // ---------- 30 天趋势 ----------
  const byDate = new Map<string, TrendPoint>()
  for (let i = 29; i >= 0; i -= 1) {
    const date = dayjs().subtract(i, 'day').format('YYYY-MM-DD')
    byDate.set(date, { date, sales: 0, profit: 0, orders: 0, adSpend: 0 })
  }
  for (const o of orders30) {
    const row = byDate.get(o.order_date)
    if (!row) continue
    row.sales += usd(o.gross_amount, o.store_id)
    row.profit += usd(o.profit, o.store_id)
    row.orders += 1
    row.adSpend += usd(o.ad_cost, o.store_id)
  }
  const trend = Array.from(byDate.values())

  const gmv30 = salesOf(orders30)

  // ---------- 平台 ----------
  const amazonSales = sum(orders30.filter((o) => o.channel === 'amazon'), (o) => usd(o.gross_amount, o.store_id))
  const tiktokSales = sum(orders30.filter((o) => o.channel === 'tiktok'), (o) => usd(o.gross_amount, o.store_id))
  const otherSales = Math.max(0, gmv30 - amazonSales - tiktokSales)
  const platformSplit = [
    { name: 'Amazon', value: amazonSales, color: '#f59e0b' },
    { name: 'TikTok Shop', value: tiktokSales, color: '#22d3ee' },
    ...(otherSales > 1 ? [{ name: '其他渠道', value: otherSales, color: '#818cf8' }] : []),
  ].filter((p) => p.value > 0)

  // ---------- 店铺 ----------
  const storeRows: StoreRow[] = raw.stores
    .map((s) => {
      const rows = orders30.filter((o) => o.store_id === s.id)
      const sales = salesOf(rows)
      const profit = profitOf(rows)
      return {
        id: s.id,
        name: s.name,
        platform: s.platform,
        marketplace: s.marketplace,
        sales,
        profit,
        orders: rows.length,
        margin: sales > 0 ? (profit / sales) * 100 : 0,
        share: gmv30 > 0 ? (sales / gmv30) * 100 : 0,
      }
    })
    .sort((a, b) => b.sales - a.sales)

  // ---------- 商品 ----------
  const byProduct = new Map<string, { name: string; value: number; qty: number }>()
  for (const o of orders30) {
    const key = o.sku || o.title || '未知 SKU'
    const item = byProduct.get(key) ?? { name: key, value: 0, qty: 0 }
    item.value += usd(o.gross_amount, o.store_id)
    item.qty += o.quantity
    byProduct.set(key, item)
  }
  const productRows = Array.from(byProduct.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)

  // ---------- 广告 ----------
  const campaigns30 = raw.campaigns.filter((c) => c.start_date >= d30 || !c.end_date || c.end_date >= d30)
  const adSpend30 = sum(campaigns30, (c) => usd(c.spend, c.store_id))
  const adSales30 = sum(campaigns30, (c) => usd(c.sales, c.store_id))
  const impressions = sum(campaigns30, (c) => c.impressions)
  const clicks = sum(campaigns30, (c) => c.clicks)
  const adOrders = sum(campaigns30, (c) => c.orders_count)
  const targets = raw.stores.filter((s) => s.status === 'active').map((s) => Number(s.target_acos) || 0)
  const targetAcos = targets.length ? sum(targets, (t) => t) / targets.length : 0
  const ads: AdFunnelData = {
    impressions,
    clicks,
    orders: adOrders,
    spend: adSpend30,
    sales: adSales30,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cvr: clicks > 0 ? (adOrders / clicks) * 100 : 0,
    acos: adSales30 > 0 ? (adSpend30 / adSales30) * 100 : 0,
    roas: adSpend30 > 0 ? adSales30 / adSpend30 : 0,
    targetAcos,
    activeCampaigns: raw.campaigns.filter((c) => c.status === 'active').length,
    totalCampaigns: raw.campaigns.length,
  }

  // ---------- 达人 ----------
  const creatorCount = (status: string) => raw.creators.filter((c) => c.status === status).length
  const creators: CreatorFunnelData = {
    pending: creatorCount('pending'),
    contacted: creatorCount('contacted'),
    sampling: creatorCount('sampling'),
    cooperating: creatorCount('cooperating'),
    paused: creatorCount('paused'),
    gmv: sum(raw.creators, (c) => Number(c.gmv) || 0),
    total: raw.creators.length,
    top: raw.creators
      .filter((c) => Number(c.gmv) > 0)
      .sort((a, b) => Number(b.gmv) - Number(a.gmv))
      .slice(0, 3)
      .map((c) => ({ name: c.name || c.handle, gmv: Number(c.gmv) })),
  }

  // ---------- 采购 ----------
  const itemByPo = new Map<string, PurchaseItem[]>()
  for (const item of raw.purchaseItems) {
    const list = itemByPo.get(item.po_id) ?? []
    list.push(item)
    itemByPo.set(item.po_id, list)
  }
  const poAmount = (po: PurchaseOrder) => {
    const items = itemByPo.get(po.id) ?? []
    const goods = sum(items, (i) => Number(i.amount) || Number(i.quantity) * Number(i.unit_price))
    return convert(goods + Number(po.shipping_fee) + Number(po.other_fee), po.currency, 'USD', fx)
  }
  const inTransit = raw.purchaseOrders.filter((p) => p.status === 'ordered' || p.status === 'partial')
  const purchase: PurchaseGlance = {
    inTransitCount: inTransit.length,
    inTransitAmount: sum(inTransit, poAmount),
    overdueCount: inTransit.filter((p) => p.expected_date && p.expected_date < today).length,
    received30Count: raw.purchaseOrders.filter((p) => p.status === 'received' && p.order_date >= d30).length,
    spend30: sum(
      raw.purchaseOrders.filter((p) => p.order_date >= d30 && p.status !== 'cancelled' && p.status !== 'draft'),
      poAmount,
    ),
    suppliers: new Set(raw.purchaseOrders.map((p) => p.supplier_id).filter(Boolean)).size,
  }

  // ---------- 竞品价格变动 ----------
  const snapsByCompetitor = new Map<string, CompetitorSnapshot[]>()
  for (const s of raw.snapshots) {
    const list = snapsByCompetitor.get(s.competitor_id) ?? []
    list.push(s)
    snapsByCompetitor.set(s.competitor_id, list)
  }
  const competitorMoves: CompetitorMove[] = []
  for (const c of raw.competitors) {
    if (c.status !== 'tracking') continue
    const snaps = (snapsByCompetitor.get(c.id) ?? []).slice().sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
    const latest = snaps[snaps.length - 1]
    const prev = snaps[snaps.length - 2]
    const price = latest ? Number(latest.price) : Number(c.price)
    const change = prev && Number(prev.price) > 0 ? ((price - Number(prev.price)) / Number(prev.price)) * 100 : 0
    competitorMoves.push({
      id: c.id,
      title: c.title,
      platform: c.platform,
      marketplace: c.marketplace,
      price,
      currency: c.currency,
      change,
      rating: latest ? Number(latest.rating) : Number(c.rating),
      reviews: latest ? latest.reviews : c.reviews,
      status: c.status,
    })
  }
  competitorMoves.sort((a, b) => a.change - b.change)

  // ---------- 实时订单流 ----------
  const storeNameOf = (id: string) => storeById.get(id)?.name ?? '未知店铺'
  const liveOrders: LiveOrder[] = raw.orders
    .slice()
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .slice(0, 14)
    .map((o) => ({
      id: o.id,
      orderNo: o.order_no,
      storeName: storeNameOf(o.store_id),
      platform: o.channel,
      sku: o.sku || o.title || '—',
      qty: o.quantity,
      amount: usd(o.gross_amount, o.store_id),
      status: o.status,
      at: o.created_at,
    }))

  // ---------- 预警 ----------
  const alerts: AlertItem[] = []
  const outOfStock = raw.inventory.filter((i) => i.available_qty <= 0)
  const urgent = raw.inventory.filter((i) => i.available_qty > 0 && coverDaysOf(i) < 14)
  if (outOfStock.length) {
    alerts.push({
      level: 'red',
      tag: '断货',
      text: `${outOfStock.length} 个 SKU 已零库存：${outOfStock.slice(0, 3).map((i) => i.sku).join('、')}${outOfStock.length > 3 ? ' 等' : ''}`,
    })
  }
  if (urgent.length) {
    alerts.push({
      level: 'amber',
      tag: '库存紧张',
      text: `${urgent.length} 个 SKU 可售不足 14 天，最早断货：${urgent.slice().sort((a, b) => coverDaysOf(a) - coverDaysOf(b))[0].sku}`,
    })
  }
  if (purchase.overdueCount > 0) {
    alerts.push({
      level: 'amber',
      tag: '采购逾期',
      text: `${purchase.overdueCount} 张在途采购单已过预计到仓日，需跟催供应商`,
    })
  }
  const overdueTasks = raw.tasks.filter((t) => t.status !== 'done' && t.due_date && t.due_date < today)
  if (overdueTasks.length) {
    alerts.push({ level: 'blue', tag: '任务逾期', text: `${overdueTasks.length} 个运营任务已超过截止日期` })
  }
  const priceDrops = competitorMoves.filter((m) => m.change <= -3)
  if (priceDrops.length) {
    alerts.push({
      level: 'red',
      tag: '竞品降价',
      text: `${priceDrops.length} 个竞品最近一次采集降价超 3%：${priceDrops.slice(0, 2).map((m) => m.title.slice(0, 14)).join('、')}`,
    })
  }
  if (ads.acos > 0 && targetAcos > 0 && ads.acos > targetAcos) {
    alerts.push({
      level: 'amber',
      tag: 'ACOS 超标',
      text: `近 30 天 ACOS ${ads.acos.toFixed(1)}%，高于店铺目标 ${targetAcos.toFixed(0)}%`,
    })
  }
  if (todayOrders === 0 && orders7.length > 0) {
    alerts.push({ level: 'blue', tag: '今日无单', text: `今天还没有新订单，近 7 日日均 ${avg7Orders.toFixed(1)} 单` })
  }

  const kpis: KpiTile[] = [
    {
      key: 'gmv',
      label: '今日 GMV',
      value: todaySales,
      format: 'money',
      delta: delta(todaySales, avg7Sales),
      deltaLabel: 'vs 近 7 日',
      hint: `日均 ${compactMoney(avg7Sales, 'USD')}`,
      tone: 'cyan',
      spark: last7Series.map((p) => p.sales),
    },
    {
      key: 'orders',
      label: '今日订单',
      value: todayOrders,
      format: 'int',
      delta: delta(todayOrders, avg7Orders),
      deltaLabel: 'vs 近 7 日',
      hint: `日均 ${avg7Orders.toFixed(1)} 单`,
      tone: 'blue',
      spark: last7Series.map((p) => p.orders),
    },
    {
      key: 'profit',
      label: '今日净利润',
      value: todayProfit,
      format: 'money',
      delta: delta(todayProfit, avg7Profit),
      deltaLabel: 'vs 近 7 日',
      hint: `净利率 ${marginToday.toFixed(1)}%`,
      tone: 'green',
      spark: last7Series.map((p) => p.profit),
    },
    {
      key: 'aov',
      label: '客单价',
      value: aovToday,
      format: 'money',
      delta: null,
      deltaLabel: '',
      hint: `今日 ${todayOrders} 单`,
      tone: 'violet',
      spark: last7Series.map((p) => (p.orders > 0 ? p.sales / p.orders : 0)),
    },
    {
      key: 'ad',
      label: '今日广告费',
      value: todayAd,
      format: 'money',
      delta: delta(todayAd, avg7Ad),
      deltaLabel: 'vs 近 7 日',
      hint: `TACOS ${tacos.toFixed(1)}%`,
      tone: 'amber',
      spark: last7Series.map((p) => p.adSpend),
    },
    {
      key: 'stockout',
      label: '断货 SKU',
      value: buckets.out,
      format: 'int',
      delta: null,
      deltaLabel: '',
      hint: `紧张 ${buckets.urgent} · 偏低 ${buckets.low}`,
      tone: buckets.out > 0 ? 'rose' : 'green',
      spark: [],
    },
  ]

  return {
    kpis,
    trend,
    platformSplit,
    storeRows,
    productRows,
    inventory,
    ads,
    creators,
    purchase,
    competitorMoves: competitorMoves.slice(0, 7),
    liveOrders,
    alerts,
    today: {
      sales: todaySales,
      profit: todayProfit,
      orders: todayOrders,
      adSpend: todayAd,
      margin: marginToday,
    },
    todayOrderCount: todayOrders,
    gmv30,
  }
}

/** 大屏库存分档配色，图表与图例共用 */
export const INVENTORY_COLORS = INK
