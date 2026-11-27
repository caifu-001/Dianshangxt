/**
 * TikTok Shop Open API 公共模块：
 *  1) 配置与凭证检查（全部读 Edge Function secrets）
 *  2) HMAC-SHA256 请求签名（v2 规范）
 *  3) auth_code / refresh_token 换取令牌
 *  4) 业务 API 调用（限流退避、错误码解析）
 *  5) 数据归一化写入现有 orders / products / inventory 表
 *
 * 重要：TikTok Shop 的 API 版本与签名字段迭代较快，本实现按 2026-11 公开的
 * v2 规范编写。首次接入时请用 Partner Center 的 API Testing Tool 验证一次签名，
 * 若官方要求增删签名字段，只需改 signRequest() 一处。
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4'
import { config } from './config.ts'
import { decryptToken, encryptToken } from './crypto.ts'

const API_BASE = 'https://open-api.tiktokglobalshop.com'
const TOKEN_BASE = 'https://auth.tiktok-shops.com/api/v2/token'

export type TiktokMarket = 'us' | 'global'

export const tiktokConfig = {
  appKey: Deno.env.get('TIKTOK_APP_KEY') ?? '',
  appSecret: Deno.env.get('TIKTOK_APP_SECRET') ?? '',
  serviceId: Deno.env.get('TIKTOK_SERVICE_ID') ?? '',
  redirectUri: Deno.env.get('TIKTOK_REDIRECT_URI') ?? '',
  scopes: Deno.env.get('TIKTOK_SCOPES') ?? '',
  // 美国站与全球站使用不同的授权域名
  market: (Deno.env.get('TIKTOK_MARKET') ?? 'global').toLowerCase() as TiktokMarket,
}

export function checkTiktokConfig(): { missing: string[] } {
  const missing: string[] = []
  const need: Array<[string, string]> = [
    ['TIKTOK_APP_KEY', tiktokConfig.appKey],
    ['TIKTOK_APP_SECRET', tiktokConfig.appSecret],
    ['TIKTOK_SERVICE_ID', tiktokConfig.serviceId],
    ['TIKTOK_REDIRECT_URI', tiktokConfig.redirectUri],
    ['TOKEN_ENCRYPTION_KEY', config.tokenEncryptionKey],
  ]
  for (const [name, value] of need) if (!value) missing.push(name)
  return { missing }
}

/** 授权页域名：美区走 services.us，其余走 services。 */
export function authorizationUrl(state: string): string {
  const host = tiktokConfig.market === 'us'
    ? 'https://services.us.tiktokshop.com/open/authorize'
    : 'https://services.tiktokshop.com/open/authorize'
  const url = new URL(host)
  url.searchParams.set('service_id', tiktokConfig.serviceId)
  url.searchParams.set('redirect_uri', tiktokConfig.redirectUri)
  url.searchParams.set('state', state)
  return url.toString()
}

/* ------------------------------ 令牌 ------------------------------ */

export interface TiktokTokens {
  accessToken: string
  refreshToken: string
  expiresIn?: number
  sellerId?: string
  shopId?: string
  shops?: Array<Record<string, unknown>>
  grantedScopes?: string[]
}

interface TokenPayload {
  code?: number
  message?: string
  data?: {
    access_token?: string
    access_token_expire_in?: number
    refresh_token?: string
    refresh_token_expire_in?: number
    seller_id?: string | number
    shop_id?: string | number
    seller_name?: string
    shops?: Array<Record<string, unknown>>
    scopes?: string[]
    granted_scopes?: string[]
  }
}

async function tokenRequest(params: Record<string, string>): Promise<TiktokTokens> {
  const url = new URL(TOKEN_BASE)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  // TikTok 的换票/刷新接口是 GET，且 app_secret 走查询参数（非常规 OAuth）
  const res = await fetch(url.toString(), { method: 'GET' })
  const payload = await res.json().catch(() => null) as TokenPayload | null
  if (!payload || payload.code !== 0 || !payload.data?.access_token || !payload.data?.refresh_token) {
    throw new Error(`TikTok 令牌接口失败 (HTTP ${res.status}, code ${payload?.code ?? '-'})：${payload?.message ?? '响应格式异常'}`)
  }
  const d = payload.data
  return {
    accessToken: d.access_token!,
    refreshToken: d.refresh_token!,
    expiresIn: d.access_token_expire_in,
    sellerId: d.seller_id != null ? String(d.seller_id) : undefined,
    shopId: d.shop_id != null ? String(d.shop_id) : undefined,
    shops: d.shops,
    grantedScopes: d.granted_scopes ?? d.scopes,
  }
}

/** 授权码换令牌（回调阶段）。 */
export function exchangeCodeForToken(code: string): Promise<TiktokTokens> {
  return tokenRequest({
    app_key: tiktokConfig.appKey,
    app_secret: tiktokConfig.appSecret,
    auth_code: code,
    grant_type: 'authorized_code',
  })
}

/** 用加密存储的 refresh token 换新令牌。 */
export async function refreshAccessToken(cipher: string): Promise<TiktokTokens> {
  const refreshToken = await decryptToken(cipher)
  return tokenRequest({
    app_key: tiktokConfig.appKey,
    app_secret: tiktokConfig.appSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
}

/** 把令牌中的 refresh token 加密，供落库。 */
export function encryptRefreshToken(token: string): Promise<string> {
  return encryptToken(token)
}

/* ------------------------------ 签名与业务 API ------------------------------ */

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * v2 签名：string_to_sign = app_secret + path + 参数字典序拼接 + body + app_secret
 * 再用 app_secret 作 HMAC-SHA256 密钥。排除 sign / access_token。
 */
async function signRequest(
  path: string,
  query: Record<string, string>,
  body: string,
): Promise<{ sign: string; timestamp: string }> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const merged: Record<string, string> = {
    ...query,
    app_key: tiktokConfig.appKey,
    timestamp,
  }
  delete merged.sign
  delete merged.access_token
  const joined = Object.keys(merged)
    .sort()
    .map((k) => `${k}${merged[k]}`)
    .join('')
  const stringToSign = `${tiktokConfig.appSecret}${path}${joined}${body}${tiktokConfig.appSecret}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(tiktokConfig.appSecret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stringToSign) as BufferSource)
  return { sign: hex(sig), timestamp }
}

export interface TtsResult<T> {
  data: T
  requestId?: string
}

/** 调一次 TikTok Shop Open API。429/5xx 指数退避，最多 5 次。 */
export async function ttsApi<T>(
  path: string,
  opts: {
    accessToken: string
    shopId?: string | null
    query?: Record<string, string>
    body?: Record<string, unknown>
    method?: 'GET' | 'POST'
  },
): Promise<TtsResult<T>> {
  const body = opts.body ? JSON.stringify(opts.body) : ''
  const params: Record<string, string> = { ...(opts.query ?? {}) }
  if (opts.shopId) params.shop_id = opts.shopId
  const { sign, timestamp } = await signRequest(path, params, body)
  const finalQuery = new URLSearchParams({ ...params, app_key: tiktokConfig.appKey, timestamp, sign })
  const url = `${API_BASE}${path}?${finalQuery.toString()}`

  let attempt = 0
  let lastError = ''
  while (attempt < 5) {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'x-tts-access-token': opts.accessToken,
        'Content-Type': 'application/json; charset=utf-8',
        'user-agent': 'DianshangxtSync/1.0 (TikTok Shop)',
      },
      body: body && opts.method === 'POST' ? body : undefined,
    })
    const requestId = res.headers.get('x-tts-request-id') ?? undefined
    const payload = await res.json().catch(() => null) as { code?: number; message?: string; data?: T } | null

    if (res.ok && payload?.code === 0) {
      return { data: (payload.data ?? {}) as T, requestId }
    }
    lastError = `HTTP ${res.status} code ${payload?.code ?? '-'} ${payload?.message ?? ''} (requestId=${requestId ?? '-'})`
    // 限流或服务端错误才重试；授权/参数错误立即失败
    const retryable = res.status === 429 || res.status >= 500 || payload?.code === 10020
    if (retryable && attempt < 4) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt))
      attempt++
      continue
    }
    throw new Error(`TikTok API ${path} 调用失败：${lastError}`)
  }
  throw new Error(`TikTok API ${path} 重试耗尽：${lastError}`)
}

/* ------------------------------ 数据归一化写入 ------------------------------ */

export interface SyncCounts { new: number; updated: number; failed: number }

export interface TiktokCtx {
  companyId: string
  userId: string
  storeId: string
  market: string
  shopId?: string | null
}

interface TtsOrder {
  order_id?: string | number
  id?: string | number
  order_status?: string
  status?: string
  create_time?: number | string
  created_at?: number | string
  currency?: string
  currency_code?: string
  paid_amount?: string | number
  order_amount?: string | number
  total_amount?: string | number
  buyer_country_code?: string
  country_code?: string
  line_items?: TtsItem[]
  order_items?: TtsItem[]
  items?: TtsItem[]
}

interface TtsItem {
  seller_sku?: string
  sku?: string
  product_name?: string
  title?: string
  quantity?: number
  item_count?: number
  sale_price?: string | number
  price?: string | number
  unit_price?: string | number
}

const ORDER_STATUS: Record<string, string> = {
  UNPAID: 'pending',
  AWAITING_PAYMENT: 'pending',
  PAID: 'pending',
  AWAITING_SHIPMENT: 'pending',
  AWAITING_COLLECTION: 'shipped',
  IN_TRANSIT: 'shipped',
  DELIVERED: 'delivered',
  COMPLETED: 'delivered',
  CANCELLED: 'cancelled',
  CANCELED: 'cancelled',
  REFUNDED: 'refunded',
  RETURNED: 'refunded',
}

function orderId(o: TtsOrder): string {
  return String(o.order_id ?? o.id ?? '')
}
function orderItems(o: TtsOrder): TtsItem[] {
  return o.line_items ?? o.order_items ?? o.items ?? []
}

/** 订单：按 order_id + 行序号拆单写入，保留用户手填费用字段。 */
export async function syncTiktokOrders(
  db: SupabaseClient,
  ctx: TiktokCtx,
  orders: TtsOrder[],
): Promise<SyncCounts> {
  const counts: SyncCounts = { new: 0, updated: 0, failed: 0 }
  const allNos = orders.flatMap((o) => {
    const n = orderItems(o).length
    return Array.from({ length: n }, (_, i) => `${orderId(o)}-${i + 1}`)
  })
  const existing = new Map<string, Record<string, unknown>>()
  if (allNos.length) {
    const { data } = await db
      .from('orders')
      .select('order_no,cost_amount,platform_fee,fba_fee,shipping_fee,ad_cost,refund_amount,other_fee')
      .eq('user_id', ctx.userId)
      .eq('store_id', ctx.storeId)
      .in('order_no', allNos.slice(0, 1000))
    for (const r of data ?? []) existing.set(String(r.order_no), r)
  }

  for (const o of orders) {
    const id = orderId(o)
    const items = orderItems(o)
    if (!id || items.length === 0) continue
    const rawTime = o.create_time ?? o.created_at
    const date = rawTime
      ? new Date(Number(rawTime) > 0 ? Number(rawTime) * 1000 : String(rawTime)).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10)

    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const orderNo = `${id}-${i + 1}`
      const prev = existing.get(orderNo)
      const row = {
        company_id: ctx.companyId,
        user_id: ctx.userId,
        store_id: ctx.storeId,
        order_no: orderNo,
        order_date: date,
        channel: 'tiktok',
        sku: it.seller_sku ?? it.sku ?? null,
        title: it.product_name ?? it.title ?? null,
        customer_name: null, // PII 不落库
        country: o.buyer_country_code ?? o.country_code ?? null,
        quantity: Math.max(1, Number(it.quantity ?? it.item_count ?? 1)),
        unit_price: Number(it.sale_price ?? it.price ?? it.unit_price ?? 0),
        cost_amount: Number(prev?.cost_amount ?? 0),
        platform_fee: Number(prev?.platform_fee ?? 0),
        fba_fee: Number(prev?.fba_fee ?? 0),
        shipping_fee: Number(prev?.shipping_fee ?? 0),
        ad_cost: Number(prev?.ad_cost ?? 0),
        refund_amount: Number(prev?.refund_amount ?? 0),
        other_fee: Number(prev?.other_fee ?? 0),
        status: ORDER_STATUS[String(o.order_status ?? o.status ?? '').toUpperCase()] ?? 'pending',
        note: `TikTok Shop 同步 | OrderID=${id}${items.length > 1 ? ` | 行 ${i + 1}/${items.length}` : ''}`,
      }
      const { error } = await db
        .from('orders')
        .upsert(row, { onConflict: 'user_id,store_id,order_no', ignoreDuplicates: false })
      if (error) counts.failed++
      else if (prev) counts.updated++
      else counts.new++
    }
  }
  return counts
}

interface TtsProduct {
  id?: string | number
  product_id?: string | number
  title?: string
  name?: string
  description?: string
  images?: string[] | Array<{ uri?: string; url?: string }>
  skus?: Array<{
    seller_sku?: string
    sku?: string
    price?: string | number
    inventory?: number
    stock?: number
  }>
}

/** 商品：一个 TikTok 商品的多个 SKU 拆成多行，不覆盖成本价。 */
export async function syncTiktokProducts(
  db: SupabaseClient,
  ctx: TiktokCtx,
  products: TtsProduct[],
): Promise<SyncCounts> {
  const counts: SyncCounts = { new: 0, updated: 0, failed: 0 }
  const flat = products.flatMap((p) =>
    (p.skus ?? []).map((s) => ({ sku: String(s.seller_sku ?? s.sku ?? ''), product: p, skuRow: s })),
  ).filter((x) => !!x.sku)
  const skus = flat.map((x) => x.sku)
  const existing = new Map<string, Record<string, unknown>>()
  if (skus.length) {
    const { data } = await db
      .from('products')
      .select('sku,cost_price,sale_price,currency,status,tags,note')
      .eq('user_id', ctx.userId)
      .eq('store_id', ctx.storeId)
      .in('sku', skus.slice(0, 1000))
    for (const r of data ?? []) existing.set(String(r.sku), r)
  }

  for (const { sku, product, skuRow } of flat) {
    const prev = existing.get(sku)
    const images = product.images ?? []
    const firstImage = images.length
      ? (typeof images[0] === 'string' ? images[0] : (images[0] as { uri?: string; url?: string }).uri ?? (images[0] as { url?: string }).url ?? null)
      : null
    const row = {
      company_id: ctx.companyId,
      user_id: ctx.userId,
      store_id: ctx.storeId,
      sku,
      asin: null, // TikTok 没有 ASIN
      title: product.title ?? product.name ?? product.description ?? sku,
      image_url: firstImage,
      category: null,
      cost_price: Number(prev?.cost_price ?? 0),
      sale_price: Number(prev?.sale_price ?? Number(skuRow.price ?? 0)),
      currency: String(prev?.currency ?? 'USD'),
      status: String(prev?.status ?? 'active'),
      tags: (prev?.tags as string[]) ?? [],
      note: (prev?.note as string | null) ?? null,
    }
    const { error } = await db
      .from('products')
      .upsert(row, { onConflict: 'user_id,store_id,sku', ignoreDuplicates: false })
    if (error) counts.failed++
    else if (prev) counts.updated++
    else counts.new++
  }
  return counts
}

/** 库存：仓库名用 TTS-<市场>，与 FBA 仓隔离，不动国内仓与 stock_movements。 */
export async function syncTiktokInventory(
  db: SupabaseClient,
  ctx: TiktokCtx,
  products: TtsProduct[],
): Promise<SyncCounts> {
  const counts: SyncCounts = { new: 0, updated: 0, failed: 0 }
  const warehouse = `TTS-${(ctx.market || 'global').toUpperCase()}`
  const rows = products.flatMap((p) =>
    (p.skus ?? []).map((s) => ({
      sku: String(s.seller_sku ?? s.sku ?? ''),
      qty: Number(s.inventory ?? s.stock ?? 0),
    })),
  ).filter((r) => !!r.sku)

  for (const r of rows) {
    const { error } = await db
      .from('inventory')
      .upsert({
        company_id: ctx.companyId,
        user_id: ctx.userId,
        store_id: ctx.storeId,
        sku: r.sku,
        title: null,
        warehouse,
        available_qty: Math.max(0, r.qty),
        inbound_qty: 0,
        reserved_qty: 0,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,store_id,sku,warehouse', ignoreDuplicates: false })
    if (error) counts.failed++
    else counts.new++
  }
  return counts
}

/** 同步日志 + 系统日志（service_role 绕过 RLS）。 */
export async function writeTiktokRunLog(
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
    platform: 'tiktok',
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
    summary: `TikTok 同步 ${run.jobType} ${run.status}：新增 ${run.counts?.new ?? 0}，失败 ${run.counts?.failed ?? 0}`,
    detail: { error: run.error ?? null, triggered_by: run.triggeredBy },
    target_type: 'platform_connection',
    target_id: run.connectionId ?? null,
    severity: run.status === 'failed' ? 'error' : 'info',
  })
}
