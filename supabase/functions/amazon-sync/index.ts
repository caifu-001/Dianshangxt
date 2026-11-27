/**
 * 同步入口：定时（cron secret）或管理员手动（JWT）触发。
 * 单个连接加分布式锁，成功后推进 last_sync_at 增量游标。
 *
 * POST { connection_id?: string }  头：x-cron-secret 或 Authorization: Bearer <JWT>
 */
import { corsHeaders, json } from '../_shared/cors.ts'
import { checkSyncConfig, config } from '../_shared/config.ts'
import { resolveCaller, serviceClient, userClient, canManageConnections } from '../_shared/clients.ts'
import { encryptToken } from '../_shared/crypto.ts'
import { refreshAccessToken, spApiGet, type Region, type Tokens } from '../_shared/amazon.ts'
import { syncOrders, syncInventory, syncProducts, writeRunLog, type SyncCounts } from '../_shared/sync.ts'

interface Connection {
  id: string
  company_id: string
  store_id: string
  region: Region
  marketplace_ids: string[]
  token_cipher: string | null
  status: string
  last_sync_at: string | null
  connected_by: string | null
  sync_lock_until: string | null
  last_error: string | null
}

function authorizedBy(req: Request): { ok: boolean; manual: boolean; message?: string } {
  const cron = req.headers.get('x-cron-secret') ?? ''
  if (config.cronSecret && cron === config.cronSecret) return { ok: true, manual: false }
  return { ok: true, manual: true } // 进一步用 JWT 校验
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const issue = checkSyncConfig()
  if (issue.missing.length) {
    return json({
      ok: false,
      code: 'NOT_CONFIGURED',
      message: `Amazon 对接尚未配置凭证，缺少：[${issue.missing.join(', ')}]`,
      missing: issue.missing,
    }, 503)
  }

  const authMode = authorizedBy(req)
  if (!authMode.ok) return json({ ok: false, message: authMode.message }, 401)

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
    try {
      const body = await req.json()
      targetConnectionId = body.connection_id ?? null
    } catch { /* 空 body 表示同步全部 */ }
  } else {
    try {
      const body = await req.json()
      targetConnectionId = body.connection_id ?? null
    } catch { /* 全部 */ }
  }

  // 拉取待同步连接（管理员只能同步本公司；cron 同步全部 active）
  let q = db.from('platform_connections').select('*').eq('platform', 'amazon').eq('status', 'active')
  if (targetConnectionId) q = q.eq('id', targetConnectionId)
  const { data: connections, error: qErr } = await q
  if (qErr) return json({ ok: false, message: `读取连接失败：${qErr.message}` }, 500)
  if (!connections?.length) return json({ ok: true, message: '没有需要同步的连接', synced: 0 })

  const results: Array<Record<string, unknown>> = []

  for (const conn of connections as Connection[]) {
    // 管理员二次校验公司归属
    if (triggeredBy === 'manual') {
      const uc = await userClient(req)
      const { data: auth } = uc ? await uc.auth.getUser() : { data: null }
      const caller = auth?.user ? await resolveCaller(db, auth.user.id) : null
      if (!caller?.superAdmin && caller?.companyId !== conn.company_id) {
        results.push({ connection_id: conn.id, status: 'skipped', reason: '跨公司连接已跳过' })
        continue
      }
    }

    // 抢占锁：CAS RPC，失败说明另一路在跑
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
    const ctx = {
      companyId: conn.company_id,
      storeId: conn.store_id,
      userId: conn.connected_by ?? '',
      region: conn.region,
      marketplaceIds: conn.marketplace_ids,
    }

    try {
      if (!conn.token_cipher) throw new Error('该连接没有有效授权令牌，请重新授权')
      let tokens: Tokens = await refreshAccessToken(conn.token_cipher)
      // Amazon 可能轮换 refresh token：回写新密文
      if (tokens.refreshToken) {
        const rotated = await encryptToken(tokens.refreshToken)
        await db.from('platform_connections').update({ token_cipher: rotated }).eq('id', conn.id)
      }

      const cursorFrom = conn.last_sync_at
      const createdAfter = cursorFrom
        ? new Date(new Date(cursorFrom).getTime() - 5 * 60 * 1000).toISOString()
        : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

      // ---------- 订单 ----------
      const orderQuery = new URLSearchParams({
        CreatedAfter: createdAfter,
        MaxResultsPerPage: '100',
      })
      if (conn.marketplace_ids.length) orderQuery.set('MarketplaceIds', conn.marketplace_ids.join(','))
      const ordRes = await spApiGet<{ orders?: Array<Record<string, unknown>>; nextToken?: string }>(
        conn.region, tokens.accessToken, '/orders/v0/orders', orderQuery,
      )
      interface OrderItemLite { SellerSKU?: string; Title?: string; QuantityOrdered?: number; ItemPrice?: { Amount?: string }; ASIN?: string }
      const rawOrders = (ordRes.data.orders ?? []) as Array<Record<string, unknown>>
      const itemsByOrder = new Map<string, OrderItemLite[]>()
      for (const o of rawOrders) {
        const id = String(o.AmazonOrderId ?? '')
        if (!id) continue
        const itemRes = await spApiGet<{ orderItems?: OrderItemLite[] }>(
          conn.region, tokens.accessToken, `/orders/v0/orders/${encodeURIComponent(id)}/orderItems`,
        )
        itemsByOrder.set(id, itemRes.data.orderItems ?? [])
      }
      const orderCounts = await syncOrders(db, ctx, rawOrders as never, itemsByOrder)

      // ---------- 商品（按订单里的 ASIN 反查目录） ----------
      const asins = new Set<string>()
      for (const items of itemsByOrder.values()) {
        for (const it of items) if (it.ASIN) asins.add(it.ASIN)
      }
      const catalogItems: Array<Record<string, unknown>> = []
      for (const asin of [...asins].slice(0, 50)) {
        try {
          const r = await spApiGet<{ item?: Record<string, unknown> }>(
            conn.region, tokens.accessToken, `/catalog/v0/items/${encodeURIComponent(asin)}`,
            { MarketplaceId: conn.marketplace_ids[0] ?? 'ATVPDKIKX0DER' },
          )
          if (r.data.item) catalogItems.push(r.data.item)
        } catch { /* 单个 ASIN 失败不阻断整批 */ }
      }
      const productCounts = await syncProducts(db, ctx, catalogItems as Parameters<typeof syncProducts>[2])

      // ---------- FBA 库存 ----------
      const invQuery = new URLSearchParams({ details: 'true' })
      if (conn.marketplace_ids.length) invQuery.set('marketplaceIds', conn.marketplace_ids.join(','))
      const invRes = await spApiGet<{ inventorySummaries?: Array<Record<string, unknown>> }>(
        conn.region, tokens.accessToken, '/fba/inventory/v1/summaries', invQuery,
      )
      const invCounts = await syncInventory(
        db, ctx, (invRes.data.inventorySummaries ?? []) as Parameters<typeof syncInventory>[3],
      )

      const combined: SyncCounts = {
        new: orderCounts.new + productCounts.new + invCounts.new,
        updated: 0,
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

      await writeRunLog(db, {
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
        status: msg.includes('invalid_grant') ? 'error' : conn.status,
        sync_lock_until: null,
        updated_at: new Date().toISOString(),
      }).eq('id', conn.id)
      await writeRunLog(db, {
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
