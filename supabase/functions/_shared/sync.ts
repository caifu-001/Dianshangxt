/**
 * 把 SP-API 数据幂等写入现有业务表。
 * 关键：不写费用字段（profit 是生成列，乱写会污染利润），
 *      不写 PII（customer_name 留空），不覆盖国内仓库存。
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4'
import type { Region } from './amazon.ts'

export interface SyncCounts {
  new: number
  updated: number
  failed: number
}

const ORDER_STATUS: Record<string, string> = {
  Pending: 'pending',
  Unshipped: 'pending',
  PartiallyShipped: 'shipped',
  Shipped: 'shipped',
  InvoiceUnconfirmed: 'shipped',
  Canceled: 'cancelled',
  Unfulfillable: 'cancelled',
}

interface RawOrder {
  AmazonOrderId: string
  PurchaseDate?: string
  OrderStatus?: string
  OrderTotal?: { Amount?: string; CurrencyCode?: string }
  ShippingAddress?: { CountryCode?: string }
  MarketplaceId?: string
}

interface RawOrderItem {
  SellerSKU?: string
  Title?: string
  QuantityOrdered?: number
  ItemPrice?: { Amount?: string }
  ASIN?: string
}

interface RawCatalogItem {
  asin?: string
  sku?: string
  itemName?: string
  images?: Array<{ link?: string }>
  productCategory?: string
}

interface RawInventorySummary {
  sellerSku?: string
  quantityAvailable?: number
  inboundQuantity?: number
  reservedQuantity?: number
  warehouseConditionCode?: string
}

/** 按 AmazonOrderId + 行序号拆单，写入 orders。返回新增/更新计数。 */
export async function syncOrders(
  db: SupabaseClient,
  ctx: { companyId: string; userId: string; storeId: string; marketplaceIds: string[] },
  rawOrders: RawOrder[],
  itemsByOrder: Map<string, RawOrderItem[]>,
): Promise<SyncCounts> {
  const counts: SyncCounts = { new: 0, updated: 0, failed: 0 }

  // 先读取本批次已存在的订单，保留用户手填的费用/成本字段（upsert 会整行覆盖）
  const allOrderNos = rawOrders.flatMap((o) => {
    const n = (itemsByOrder.get(String(o.AmazonOrderId ?? '')) ?? []).length
    return Array.from({ length: n }, (_, i) => `${o.AmazonOrderId}-${i + 1}`)
  })
  const existing = new Map<string, Record<string, unknown>>()
  if (allOrderNos.length) {
    const { data } = await db
      .from('orders')
      .select('order_no,cost_amount,platform_fee,fba_fee,shipping_fee,ad_cost,refund_amount,other_fee')
      .eq('store_id', ctx.storeId)
      .in('order_no', allOrderNos.slice(0, 1000))
    for (const r of data ?? []) existing.set(String(r.order_no), r)
  }

  for (const o of rawOrders) {
    const items = itemsByOrder.get(String(o.AmazonOrderId ?? '')) ?? []
    if (items.length === 0) continue
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const orderNo = `${o.AmazonOrderId}-${i + 1}`
      const prev = existing.get(orderNo)
      const row = {
        company_id: ctx.companyId,
        user_id: ctx.userId,
        store_id: ctx.storeId,
        order_no: orderNo,
        order_date: (o.PurchaseDate ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10),
        channel: 'amazon',
        sku: it.SellerSKU ?? it.ASIN ?? null,
        title: it.Title ?? null,
        customer_name: null, // PII 不落库
        country: o.ShippingAddress?.CountryCode ?? null,
        quantity: Math.max(1, Number(it.QuantityOrdered ?? 1)),
        unit_price: Number(it.ItemPrice?.Amount ?? 0),
        // 用户手填的费用字段一律沿用；新单才留 0（等 Financial Events 阶段回填）
        cost_amount: Number(prev?.cost_amount ?? 0),
        platform_fee: Number(prev?.platform_fee ?? 0),
        fba_fee: Number(prev?.fba_fee ?? 0),
        shipping_fee: Number(prev?.shipping_fee ?? 0),
        ad_cost: Number(prev?.ad_cost ?? 0),
        refund_amount: Number(prev?.refund_amount ?? 0),
        other_fee: Number(prev?.other_fee ?? 0),
        status: ORDER_STATUS[o.OrderStatus ?? ''] ?? 'pending',
        note: `SP-API 同步 | AmazonOrderId=${o.AmazonOrderId}${items.length > 1 ? ` | 行 ${i + 1}/${items.length}` : ''}`,
      }
      const { error } = await db
        .from('orders')
        .upsert(row, { onConflict: 'store_id,order_no', ignoreDuplicates: false })
      if (error) counts.failed++
      else if (prev) counts.updated++
      else counts.new++
    }
  }
  return counts
}

/** 商品：sku = SellerSKU（无则回落 ASIN），asin 落到已有列；不覆盖 cost_price。 */
export async function syncProducts(
  db: SupabaseClient,
  ctx: { companyId: string; userId: string; storeId: string },
  items: RawCatalogItem[],
): Promise<SyncCounts> {
  const counts: SyncCounts = { new: 0, updated: 0, failed: 0 }
  const skus = items.map((p) => p.sku || p.asin).filter((s): s is string => !!s)
  const existing = new Map<string, Record<string, unknown>>()
  if (skus.length) {
    const { data } = await db
      .from('products')
      .select('sku,cost_price,sale_price,currency,status,tags,note')
      .eq('store_id', ctx.storeId)
      .in('sku', skus.slice(0, 1000))
    for (const r of data ?? []) existing.set(String(r.sku), r)
  }

  for (const p of items) {
    const sku = p.sku || p.asin
    if (!sku) continue
    const prev = existing.get(sku)
    const row = {
      company_id: ctx.companyId,
      user_id: ctx.userId,
      store_id: ctx.storeId,
      sku,
      asin: p.asin ?? null,
      title: p.itemName ?? sku,
      image_url: p.images?.[0]?.link ?? null,
      category: p.productCategory ?? null,
      // 用户手填字段全部沿用；新单才用默认值
      cost_price: Number(prev?.cost_price ?? 0),
      sale_price: Number(prev?.sale_price ?? 0),
      currency: String(prev?.currency ?? 'USD'),
      status: String(prev?.status ?? 'active'),
      tags: (prev?.tags as string[]) ?? [],
      note: (prev?.note as string | null) ?? null,
    }
    const { error } = await db
      .from('products')
      .upsert(row, { onConflict: 'store_id,sku', ignoreDuplicates: false })
    if (error) counts.failed++
    else if (prev) counts.updated++
    else counts.new++
  }
  return counts
}

/** FBA 库存：覆盖可供货/在途/预留；只动 FBA 仓，不动国内仓与 stock_movements。 */
export async function syncInventory(
  db: SupabaseClient,
  ctx: { companyId: string; userId: string; storeId: string; region: Region; marketplaceIds: string[] },
  summaries: RawInventorySummary[],
): Promise<SyncCounts> {
  const counts: SyncCounts = { new: 0, updated: 0, failed: 0 }
  const suffix = ctx.marketplaceIds[0] ?? ctx.region.toUpperCase()
  const warehouse = `FBA-${suffix}`
  for (const s of summaries) {
    if (!s.sellerSku) continue
    const row = {
      company_id: ctx.companyId,
      user_id: ctx.userId,
      store_id: ctx.storeId,
      sku: s.sellerSku,
      title: null,
      warehouse,
      available_qty: Math.max(0, Number(s.quantityAvailable ?? 0)),
      inbound_qty: Math.max(0, Number(s.inboundQuantity ?? 0)),
      reserved_qty: Math.max(0, Number(s.reservedQuantity ?? 0)),
      updated_at: new Date().toISOString(),
    }
    const { error } = await db
      .from('inventory')
      .upsert(row, { onConflict: 'store_id,sku,warehouse', ignoreDuplicates: false })
    if (error) counts.failed++
    else counts.new++
  }
  return counts
}

/** 写一条同步运行日志（service_role 绕过 RLS）。 */
export async function writeRunLog(
  db: SupabaseClient,
  run: {
    companyId: string
    connectionId?: string | null
    storeId?: string | null
    jobType: string
    status: string
    startedAt: string
    counts?: SyncCounts
    cursorFrom?: string | null
    cursorTo?: string | null
    error?: string | null
    triggeredBy: string
  },
): Promise<void> {
  await db.from('sync_runs').insert({
    company_id: run.companyId,
    connection_id: run.connectionId ?? null,
    store_id: run.storeId ?? null,
    platform: 'amazon',
    job_type: run.jobType,
    status: run.status,
    started_at: run.startedAt,
    finished_at: new Date().toISOString(),
    rows_new: run.counts?.new ?? 0,
    rows_updated: run.counts?.updated ?? 0,
    rows_failed: run.counts?.failed ?? 0,
    cursor_from: run.cursorFrom ?? null,
    cursor_to: run.cursorTo ?? null,
    error: run.error ?? null,
    triggered_by: run.triggeredBy,
  })
  await db.from('system_logs').insert({
    company_id: run.companyId,
    category: 'business',
    action: 'sync_completed',
    summary: `Amazon 同步 ${run.jobType} ${run.status}：新增 ${run.counts?.new ?? 0}，失败 ${run.counts?.failed ?? 0}`,
    detail: { error: run.error ?? null, triggered_by: run.triggeredBy },
    target_type: 'platform_connection',
    target_id: run.connectionId ?? null,
    severity: run.status === 'failed' ? 'error' : 'info',
  })
}
