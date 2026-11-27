/**
 * TikTok 数据同步：定时（cron secret）或管理员手动（JWT）触发。
 * 拉订单 → 商品（含库存）→ 幂等写入现有业务表 → 推进增量游标。
 *
 * POST { connection_id?: string }
 * 头：x-cron-secret 或 Authorization: Bearer <JWT>
 */
import { corsHeaders, json } from '../_shared/cors.ts'
import { config } from '../_shared/config.ts'
import {
  checkTiktokConfig,
  refreshAccessToken,
  encryptRefreshToken,
  ttsApi,
  syncTiktokOrders,
  syncTiktokProducts,
  syncTiktokInventory,
  writeTiktokRunLog,
  type TiktokCtx,
  type SyncCounts,
} from '../_shared/tiktok.ts'
import { resolveCaller, serviceClient, userClient, canManageConnections } from '../_shared/clients.ts'

interface Connection {
  id: string
  company_id: string
  store_id: string
  region: string
  seller_id: string | null
  marketplace_ids: string[]
  token_cipher: string | null
  status: string
  last_sync_at: string | null
  connected_by: string | null
  sync_lock_until: string | null
}

function authorizedBy(req: Request): { manual: boolean } {
  const cron = req.headers.get('x-cron-secret') ?? ''
  if (config.cronSecret && cron === config.cronSecret) return { manual: false }
  return { manual: true }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const issue = checkTiktokConfig()
  if (issue.missing.length) {
    return json({
      ok: false,
      code: 'NOT_CONFIGURED',
      message: `TikTok 对接尚未配置凭证，缺少：[${issue.missing.join(', ')}]`,
      missing: issue.missing,
    }, 503)
  }

  const authMode = authorizedBy(req)
  const db = serviceClient()
  let targetConnectionId: string | null = null
  let triggeredBy: 'cron' | 'manual' = 'cron'

  if (authMode.manual) {
    const uc = await userClient(req)
    if (!uc) return json({ ok: false, message: '请先登录或提供有效的任务密钥' }, 401)
    const { data: auth } = await uc.auth.getUser()
    const caller = auth?.user ? await resolveCaller(db, auth.user.id) : null
    if (!caller || !canManageConnections(caller)) {
      return json({ ok: false, message: '只有公司管理员可以手动触发同步' }, 403)
    }
    triggeredBy = 'manual'
  }

  try {
    const body = await req.json()
    targetConnectionId = body.connection_id ?? null
  } catch { /* 空 body = 同步全部 */ }

  let q = db.from('platform_connections').select('*').eq('platform', 'tiktok').eq('status', 'active')
  if (targetConnectionId) q = q.eq('id', targetConnectionId)
  const { data: connections, error: qErr } = await q
  if (qErr) return json({ ok: false, message: `读取连接失败：${qErr.message}` }, 500)
  if (!connections?.length) return json({ ok: true, message: '没有需要同步的连接', synced: 0 })

  const results: Array<Record<string, unknown>> = []

  for (const conn of connections as Connection[]) {
    if (triggeredBy === 'manual') {
      const uc = await userClient(req)
      const { data: auth } = uc ? await uc.auth.getUser() : { data: null }
      const caller = auth?.user ? await resolveCaller(db, auth.user.id) : null
      if (!caller?.superAdmin && caller?.companyId !== conn.company_id) {
        results.push({ connection_id: conn.id, status: 'skipped', reason: '跨公司连接已跳过' })
        continue
      }
    }

    const lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    const { data: acquired, error: lockErr } = await db.rpc('try_acquire_sync_lock', {
      p_conn_id: conn.id,
      p_until: lockUntil,
    })
    if (lockErr || acquired !== true) {
      results.push({ connection_id: conn.id, status: 'skipped', reason: '同步正在进行中' })
      continue
    }

    const startedAt = new Date().toISOString()
    const ctx: TiktokCtx = {
      companyId: conn.company_id,
      storeId: conn.store_id,
      userId: conn.connected_by ?? '',
      market: conn.region || 'global',
      shopId: conn.marketplace_ids?.[0] ?? null,
    }

    try {
      if (!conn.token_cipher) throw new Error('该连接没有有效授权令牌，请重新授权')
      const tokens = await refreshAccessToken(conn.token_cipher)
      // refresh token 可能轮换：回写新密文
      if (tokens.refreshToken) {
        const rotated = await encryptRefreshToken(tokens.refreshToken)
        await db.from('platform_connections').update({ token_cipher: rotated }).eq('id', conn.id)
      }

      const accessToken = tokens.accessToken
      const shopId = ctx.shopId ?? tokens.shopId ?? null
      const cursorFrom = conn.last_sync_at
      const fromTs = cursorFrom
        ? Math.floor(new Date(cursorFrom).getTime() / 1000) - 300
        : Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60
      const toTs = Math.floor(Date.now() / 1000)

      // ---------- 订单（最多 5 页，避免单次超时） ----------
      const orders: Array<Record<string, unknown>> = []
      let pageToken = ''
      interface TtsOrderLite {
        order_id?: string | number
        id?: string | number
        line_items?: Array<Record<string, unknown>>
        order_items?: Array<Record<string, unknown>>
        items?: Array<Record<string, unknown>>
      }
      for (let page = 0; page < 5; page++) {
        const query: Record<string, string> = {
          create_time_from: String(fromTs),
          create_time_to: String(toTs),
          page_size: '100',
        }
        if (pageToken) query.page_token = pageToken
        const res = await ttsApi<{ orders?: TtsOrderLite[]; next_page_token?: string }>(
          '/order/202309/orders', { accessToken, shopId, query },
        )
        const batch = res.data.orders ?? []
        orders.push(...batch)
        pageToken = res.data.next_page_token ?? ''
        if (!pageToken || batch.length === 0) break
      }

      // 详情补全 line_items（列表接口通常不带商品行）
      for (const o of orders) {
        const id = String((o as TtsOrderLite).order_id ?? (o as TtsOrderLite).id ?? '')
        const hasItems = !!(o as TtsOrderLite).line_items?.length
          || !!(o as TtsOrderLite).order_items?.length
          || !!(o as TtsOrderLite).items?.length
        if (!id || hasItems) continue
        try {
          const detail = await ttsApi<{ order?: TtsOrderLite }>(
            `/order/202309/orders/${encodeURIComponent(id)}`, { accessToken, shopId },
          )
          if (detail.data.order) Object.assign(o, detail.data.order)
        } catch { /* 单单详情失败不阻断整批 */ }
      }
      const orderCounts = await syncTiktokOrders(db, ctx, orders as never)

      // ---------- 商品 + 库存（同一接口返回 SKU 库存） ----------
      const products: Array<Record<string, unknown>> = []
      let productPage = ''
      for (let page = 0; page < 5; page++) {
        const query: Record<string, string> = { page_size: '100' }
        if (productPage) query.page_token = productPage
        const res = await ttsApi<{ products?: Array<Record<string, unknown>>; next_page_token?: string }>(
          '/product/202309/products', { accessToken, shopId, query },
        )
        const batch = res.data.products ?? []
        products.push(...batch)
        productPage = res.data.next_page_token ?? ''
        if (!productPage || batch.length === 0) break
      }
      const productCounts = await syncTiktokProducts(db, ctx, products as never)
      const invCounts = await syncTiktokInventory(db, ctx, products as never)

      const combined: SyncCounts = {
        new: orderCounts.new + productCounts.new + invCounts.new,
        updated: orderCounts.updated + productCounts.updated,
        failed: orderCounts.failed + productCounts.failed + invCounts.failed,
      }
      const cursorTo = new Date().toISOString()
      await db.from('platform_connections').update({
        last_sync_at: cursorTo,
        last_error: null,
        status: 'active',
        sync_lock_until: null,
        updated_at: cursorTo,
      }).eq('id', conn.id)

      await writeTiktokRunLog(db, {
        companyId: conn.company_id,
        connectionId: conn.id,
        storeId: conn.store_id,
        jobType: 'all',
        status: combined.failed > 0 ? 'partial' : 'ok',
        startedAt,
        counts: combined,
        cursorFrom,
        cursorTo,
        triggeredBy,
      })

      results.push({ connection_id: conn.id, status: 'ok', counts: combined })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await db.from('platform_connections').update({
        last_error: msg.slice(0, 500),
        status: /invalid_grant|36004004|auth_denied|105005/.test(msg) ? 'error' : conn.status,
        sync_lock_until: null,
        updated_at: new Date().toISOString(),
      }).eq('id', conn.id)
      await writeTiktokRunLog(db, {
        companyId: conn.company_id,
        connectionId: conn.id,
        storeId: conn.store_id,
        jobType: 'all',
        status: 'failed',
        startedAt,
        error: msg.slice(0, 500),
        triggeredBy,
      })
      results.push({ connection_id: conn.id, status: 'failed', error: msg.slice(0, 200) })
    }
  }

  return json({ ok: true, synced: results.length, results })
})
