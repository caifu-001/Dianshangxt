import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4'

// ========== _shared/config.ts ==========
/**
 * 运行配置：全部读 Edge Function secrets，绝不写死在代码里。
 * 「资料暂时没有」时 isConfigured() 返回 false，
 * 各函数会返回明确的未配置提示，而不是崩溃或误同步。
 */

export const config = {
  supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',

  // Login with Amazon（公共应用凭证，审计通过后填入）
  lwaClientId: Deno.env.get('AMAZON_LWA_CLIENT_ID') ?? '',
  lwaClientSecret: Deno.env.get('AMAZON_LWA_CLIENT_SECRET') ?? '',
  // LWA 回调地址 = 本 callback 函数 URL，部署后填入
  redirectUri: Deno.env.get('AMAZON_REDIRECT_URI') ?? '',
  // 申请到的 scope，空格分隔（审计时按最小权限申请）
  scopes: Deno.env.get('AMAZON_SCOPES') ?? 'readorders readcatalog readinventory readfinancials',
  // AWS SigV4 签名凭证
  awsAccessKeyId: Deno.env.get('AWS_ACCESS_KEY_ID') ?? '',
  awsSecretAccessKey: Deno.env.get('AWS_SECRET_ACCESS_KEY') ?? '',
  awsSessionToken: Deno.env.get('AWS_SESSION_TOKEN') ?? '',
  awsRoleArn: Deno.env.get('AWS_ROLE_ARN') ?? '',

  // token 加密密钥（AES-GCM 256 位，base64；生成见 README）
  tokenEncryptionKey: Deno.env.get('TOKEN_ENCRYPTION_KEY') ?? '',
  // 定时任务的密钥（GitHub Actions 调 amazon-sync 时带 x-cron-secret）
  cronSecret: Deno.env.get('SYNC_CRON_SECRET') ?? '',
  // 回调后前端落地页（默认系统首页，可配自定义域名）
  frontendUrl: Deno.env.get('FRONTEND_URL') ?? 'https://kuahaishidai.dpdns.org',
}

export interface ConfigIssue {
  missing: string[]
}

/** 检查同步所需凭证是否齐备。缺哪几项一目了然。 */
export function checkSyncConfig(): ConfigIssue {
  const missing: string[] = []
  const need: Array<[string, string]> = [
    ['AMAZON_LWA_CLIENT_ID', config.lwaClientId],
    ['AMAZON_LWA_CLIENT_SECRET', config.lwaClientSecret],
    ['AMAZON_REDIRECT_URI', config.redirectUri],
    ['AWS_ACCESS_KEY_ID', config.awsAccessKeyId],
    ['AWS_SECRET_ACCESS_KEY', config.awsSecretAccessKey],
    ['AWS_ROLE_ARN', config.awsRoleArn],
    ['TOKEN_ENCRYPTION_KEY', config.tokenEncryptionKey],
  ]
  for (const [name, value] of need) if (!value) missing.push(name)
  return { missing }
}

export function isSyncConfigured(): boolean {
  return checkSyncConfig().missing.length === 0
}

// ========== _shared/cors.ts ==========
// 所有 Edge Function 共用的 CORS 头。
// 生产环境可把 '*' 收紧为白名单域名（FRONTEND_URL）。
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export function redirect(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: { ...corsHeaders, Location: url },
  })
}

// ========== _shared/crypto.ts ==========
/**
 * refresh token 加解密（AES-GCM-256），密钥只在 Edge Function secret 里。
 * 密文格式：v1:<iv-base64>:<ciphertext-base64>
 * 数据库只存这串密文，不存明文、不参与解密。
 */

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    unb64(config.tokenEncryptionKey) as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptToken(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const k = await key()
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    k,
    new TextEncoder().encode(plain) as BufferSource,
  )
  return `v1:${b64(iv)}:${b64(new Uint8Array(ct))}`
}

export async function decryptToken(cipher: string): Promise<string> {
  const parts = cipher.split(':')
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('token 密文格式无效')
  const k = await key()
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(parts[1]) as BufferSource },
    k,
    unb64(parts[2]) as BufferSource,
  )
  return new TextDecoder().decode(pt)
}

// ========== _shared/clients.ts ==========
/** Supabase 客户端工厂：service_role 用于服务端读写，user 客户端用于校验调用者身份。 */

export function serviceClient(): SupabaseClient {
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** 从请求头取 JWT，返回一个以该用户身份访问的客户端；无效则返回 null。 */
export async function userClient(req: Request): Promise<SupabaseClient | null> {
  const auth = req.headers.get('authorization') ?? ''
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!jwt || !config.anonKey) return null
  const client = createClient(config.supabaseUrl, config.anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.auth.getUser(jwt)
  if (error || !data.user) return null
  return client
}

export interface Caller {
  userId: string
  email: string
  role: string
  companyId: string | null
  superAdmin: boolean
}

/** 用 service 客户端读资料，得到调用者的公司视角与角色。 */
export async function resolveCaller(client: SupabaseClient, userId: string): Promise<Caller | null> {
  const { data } = await client
    .from('profiles')
    .select('role, company_id, active_company_id, status')
    .eq('id', userId)
    .maybeSingle()
  if (!data) return null
  const role = String(data.role ?? 'member')
  const superAdmin = role === 'super_admin'
  return {
    userId,
    email: '',
    role,
    companyId: superAdmin ? (data.active_company_id ?? null) : (data.company_id ?? null),
    superAdmin,
  }
}

/** 服务端校验：调用者必须是本公司 admin（或超管），才能挂/解店铺。 */
export function canManageConnections(caller: Caller): boolean {
  return caller.superAdmin || caller.role === 'admin'
}

// ========== _shared/amazon.ts ==========
/**
 * Amazon SP-API 调用基础：
 *  1) LWA refresh_token → access_token（1 小时有效）
 *  2) AWS SigV4 给请求签名（execute-api 服务）
 *  3) 限流退避：429/503 指数重试，读 x-amzn-ratelimit-limit
 *
 * 双认证缺一不可：x-amz-access-token + Authorization(SigV4)。
 */

export type Region = 'na' | 'eu' | 'fe'

const HOSTS: Record<Region, string> = {
  na: 'sellingpartnerapi-na.amazon.com',
  eu: 'sellingpartnerapi-eu.amazon.com',
  fe: 'sellingpartnerapi-fe.amazon.com',
}
const AWS_REGION: Record<Region, string> = {
  na: 'us-east-1',
  eu: 'eu-west-1',
  fe: 'us-west-2',
}

export interface Tokens {
  accessToken: string
  refreshToken?: string // Amazon 可能轮换 refresh token，需回写
  expiresIn?: number
}

/** 用 refresh token 换 access token。 */
export async function refreshAccessToken(cipher: string): Promise<Tokens> {
  const refreshToken = await decryptToken(cipher)
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.lwaClientId,
    client_secret: config.lwaClientSecret,
  })
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LWA 刷新令牌失败 (${res.status})：${text.slice(0, 300)}`)
  }
  const data = await res.json()
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  }
}

/** 用授权码换 token（OAuth 回调阶段）。 */
export async function exchangeCodeForToken(code: string): Promise<Tokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.lwaClientId,
    client_secret: config.lwaClientSecret,
    redirect_uri: config.redirectUri,
  })
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LWA 授权码兑换失败 (${res.status})：${text.slice(0, 300)}`)
  }
  const data = await res.json()
  if (!data.refresh_token) throw new Error('LWA 未返回 refresh_token，请检查应用类型与 scope')
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  }
}

/* --------------------------- AWS SigV4 --------------------------- */

function sha256(data: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return crypto.subtle.digest('SHA-256', bytes as BufferSource)
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmac(key: CryptoKey | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = key instanceof ArrayBuffer
    ? await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    : key
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data) as BufferSource)
}

function amzDate(d: Date) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

/** 生成 SigV4 Authorization 头所需的签名与时间戳。 */
async function signV4(
  method: string,
  host: string,
  path: string,
  query: URLSearchParams,
  accessToken: string,
  region: Region,
  payload = '',
): Promise<{ amzDate: string; dateStamp: string; signature: string }> {
  const now = new Date()
  const amzDateStr = amzDate(now)
  const dateStamp = amzDateStr.slice(0, 8)
  const service = 'execute-api'
  const awsRegion = AWS_REGION[region]

  const signedHeaders = 'host;x-amz-access-token;x-amz-date'
  const canonicalQuery = [...query.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQuery,
    `host:${host}\n`,
    `x-amz-access-token:${accessToken}\n`,
    `x-amz-date:${amzDateStr}\n`,
    '',
    signedHeaders,
    hex(await sha256(payload)),
  ].join('\n')

  const scope = `${dateStamp}/${awsRegion}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDateStr,
    scope,
    hex(await sha256(canonicalRequest)),
  ].join('\n')

  const kDate = await hmac(new TextEncoder().encode(`AWS4${config.awsSecretAccessKey}`).buffer as ArrayBuffer, dateStamp)
  const kRegion = await hmac(kDate, awsRegion)
  const kService = await hmac(kRegion, service)
  const kSigning = await hmac(kService, 'aws4_request')
  const signature = hex(await hmac(kSigning, stringToSign))

  return { amzDate: amzDateStr, dateStamp, signature }
}

export interface SpApiResult<T> {
  data: T
  nextToken?: string
  requestId?: string
}

/**
 * 调一次 SP-API GET。429/503 指数退避，最多 5 次。
 * path 以 / 开头，如 /orders/v0/orders。
 */
export async function spApiGet<T>(
  region: Region,
  accessToken: string,
  path: string,
  query: URLSearchParams = new URLSearchParams(),
): Promise<SpApiResult<T>> {
  const host = HOSTS[region]
  const url = `https://${host}${path}?${query.toString()}`
  let attempt = 0
  let lastError = ''

  while (attempt < 5) {
    const sig = await signV4('GET', host, path, query, accessToken, region)
    const awsRegion = AWS_REGION[region]
    const credential = `${config.awsAccessKeyId}/${sig.dateStamp}/${awsRegion}/execute-api/aws4_request`
    const authHeader =
      `AWS4-HMAC-SHA256 Credential=${credential}, ` +
      `SignedHeaders=host;x-amz-access-token;x-amz-date, Signature=${sig.signature}`

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        host,
        'x-amz-access-token': accessToken,
        'x-amz-date': sig.amzDate,
        Authorization: authHeader,
        'x-amz-security-token': config.awsSessionToken || undefined,
        'user-agent': 'DianshangxtSync/1.0 (SP-API)',
      } as Record<string, string>,
    })

    const requestId = res.headers.get('x-amzn-requestid') ?? undefined
    if (res.ok) {
      const data = await res.json() as T & { nextToken?: string; pagination?: { nextToken?: string } }
      return {
        data,
        nextToken: data.nextToken ?? data.pagination?.nextToken,
        requestId,
      }
    }

    const text = await res.text()
    lastError = `${res.status} ${text.slice(0, 300)} (requestId=${requestId ?? '-'})`
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      const headerLimit = Number(res.headers.get('x-amzn-ratelimit-limit') ?? 0)
      const base = headerLimit > 0 ? Math.max(250, Math.ceil(1000 / headerLimit)) : 1000
      await new Promise((r) => setTimeout(r, base * 2 ** attempt))
      attempt++
      continue
    }
    throw new Error(`SP-API ${path} 调用失败：${lastError}`)
  }
  throw new Error(`SP-API ${path} 重试耗尽：${lastError}`)
}

// ========== _shared/sync.ts ==========
/**
 * 把 SP-API 数据幂等写入现有业务表。
 * 关键：不写费用字段（profit 是生成列，乱写会污染利润），
 *      不写 PII（customer_name 留空），不覆盖国内仓库存。
 */

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

// ========== amazon-oauth-callback/index.ts ==========
/**
 * LWA 回调：校验 state → code 换 token → 加密落库 → 回跳前端。
 * 浏览器重定向进来（无 JWT），身份靠一次性 state 绑定。
 */

function front(status: 'ok' | 'error', msg: string, storeId?: string): string {
  const u = new URL(config.frontendUrl)
  u.searchParams.set('oauth', status)
  u.searchParams.set('msg', msg.slice(0, 200))
  if (storeId) u.searchParams.set('store', storeId)
  u.hash = '#/settings'
  return u.toString()
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const issue = checkSyncConfig()
  if (issue.missing.length) {
    return json({ ok: false, code: 'NOT_CONFIGURED', missing: issue.missing }, 503)
  }

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errorParam = url.searchParams.get('error')
  if (errorParam) return redirect(front('error', `Amazon 授权被拒绝：${errorParam}`))
  if (!code || !state) return json({ ok: false, message: '缺少 code 或 state' }, 400)

  const db = serviceClient()

  // 取一次性票据并立即删除（防重放）
  const { data: ticket } = await db
    .from('oauth_states')
    .select('*')
    .eq('state', state)
    .maybeSingle()
  await db.from('oauth_states').delete().eq('state', state)

  if (!ticket || new Date(ticket.expires_at).getTime() < Date.now()) {
    return redirect(front('error', '授权已过期，请重新发起连接'))
  }

  try {
    const tokens = await exchangeCodeForToken(code)
    const cipher = await encryptToken(tokens.refreshToken!)

    // 找该店铺在 Amazon 目录下的连接：有则更新，无则新建
    const { data: existing } = await db
      .from('platform_connections')
      .select('id')
      .eq('company_id', ticket.company_id)
      .eq('store_id', ticket.store_id)
      .eq('platform', 'amazon')
      .maybeSingle()

    const payload = {
      company_id: ticket.company_id,
      store_id: ticket.store_id,
      platform: 'amazon',
      token_cipher: cipher,
      token_expires_at: tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
        : null,
      scopes: config.scopes.split(/\s+/).filter(Boolean),
      status: 'active',
      last_error: null,
      connected_by: ticket.caller_id,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      await db.from('platform_connections').update(payload).eq('id', existing.id)
    } else {
      await db.from('platform_connections').insert(payload)
    }

    await db.from('system_logs').insert({
      company_id: ticket.company_id,
      category: 'business',
      action: 'platform_connected',
      summary: 'Amazon 店铺授权成功',
      detail: { store_id: ticket.store_id, platform: 'amazon' },
      target_type: 'platform_connection',
      target_id: existing?.id ?? null,
      severity: 'info',
    })

    return redirect(front('ok', 'Amazon 店铺已连接，可开始同步', ticket.store_id))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return redirect(front('error', `授权失败：${msg}`))
  }
})
