/**
 * TikTok 授权回调：校验一次性 state → code 换 token → 加密落库 → 回跳前端。
 * 浏览器重定向进来（无 JWT），身份靠 state 绑定。
 */
import { corsHeaders, json, redirect } from '../_shared/cors.ts'
import { config } from '../_shared/config.ts'
import { checkTiktokConfig, exchangeCodeForToken, encryptRefreshToken, tiktokConfig } from '../_shared/tiktok.ts'
import { serviceClient } from '../_shared/clients.ts'

function front(status: 'ok' | 'error', msg: string, storeId?: string): string {
  const u = new URL(config.frontendUrl)
  u.searchParams.set('oauth', status)
  u.searchParams.set('msg', msg.slice(0, 200))
  if (storeId) u.searchParams.set('store', storeId)
  u.hash = '#/data-connect'
  return u.toString()
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const issue = checkTiktokConfig()
  if (issue.missing.length) {
    return json({ ok: false, code: 'NOT_CONFIGURED', missing: issue.missing }, 503)
  }

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errorParam = url.searchParams.get('error') ?? url.searchParams.get('error_description')
  if (errorParam) return redirect(front('error', `TikTok 授权被拒绝：${errorParam}`))
  if (!code || !state) return json({ ok: false, message: '缺少 code 或 state' }, 400)

  const db = serviceClient()

  const { data: ticket } = await db
    .from('oauth_states')
    .select('*')
    .eq('state', state)
    .eq('platform', 'tiktok')
    .maybeSingle()
  await db.from('oauth_states').delete().eq('state', state)

  if (!ticket || new Date(ticket.expires_at).getTime() < Date.now()) {
    return redirect(front('error', '授权已过期，请重新发起连接'))
  }

  try {
    const tokens = await exchangeCodeForToken(code)
    const cipher = await encryptRefreshToken(tokens.refreshToken)

    const { data: existing } = await db
      .from('platform_connections')
      .select('id')
      .eq('company_id', ticket.company_id)
      .eq('store_id', ticket.store_id)
      .eq('platform', 'tiktok')
      .maybeSingle()

    const payload = {
      company_id: ticket.company_id,
      store_id: ticket.store_id,
      platform: 'tiktok',
      seller_id: tokens.sellerId ?? null,
      marketplace_ids: tokens.shopId ? [tokens.shopId] : [],
      region: tiktokConfig.market === 'us' ? 'us' : (tokens.shopId ? 'global' : 'global'),
      token_cipher: cipher,
      token_expires_at: tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
        : null,
      scopes: tokens.grantedScopes ?? (tiktokConfig.scopes ? tiktokConfig.scopes.split(/\s+/).filter(Boolean) : []),
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
      summary: 'TikTok Shop 店铺授权成功',
      detail: { store_id: ticket.store_id, platform: 'tiktok', seller_id: tokens.sellerId ?? null },
      target_type: 'platform_connection',
      target_id: existing?.id ?? null,
      severity: 'info',
    })

    return redirect(front('ok', 'TikTok 店铺已连接，可开始同步', ticket.store_id))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return redirect(front('error', `授权失败：${msg}`))
  }
})
