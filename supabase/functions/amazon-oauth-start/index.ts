/**
 * 发起 Amazon 授权：校验管理员身份 → 生成 state → 302 跳 LWA 授权页。
 * GET/POST ?store_id=<uuid>
 */
import { corsHeaders, json, redirect } from '../_shared/cors.ts'
import { checkSyncConfig, config } from '../_shared/config.ts'
import { resolveCaller, serviceClient, userClient, canManageConnections } from '../_shared/clients.ts'

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

  const uc = await userClient(req)
  if (!uc) return json({ ok: false, message: '请先登录' }, 401)
  const db = serviceClient()

  const url = new URL(req.url)
  const storeId = url.searchParams.get('store_id')
  if (!storeId) return json({ ok: false, message: '缺少 store_id' }, 400)

  const { data: auth } = await uc.auth.getUser()
  const caller = auth?.user ? await resolveCaller(db, auth.user.id) : null
  if (!caller || !canManageConnections(caller)) {
    return json({ ok: false, message: '只有公司管理员可以连接店铺' }, 403)
  }
  if (!caller.companyId) return json({ ok: false, message: '当前账号未归属公司' }, 400)

  // 校验店铺属于本公司
  const { data: store } = await db
    .from('stores')
    .select('id, name, company_id')
    .eq('id', storeId)
    .maybeSingle()
  if (!store || store.company_id !== caller.companyId) {
    return json({ ok: false, message: '店铺不存在或不属于当前公司' }, 404)
  }

  // 生成 state（32 字节随机，base64url）
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const state = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  await db.from('oauth_states').insert({
    state,
    company_id: caller.companyId,
    store_id: storeId,
    caller_id: caller.userId,
    platform: 'amazon',
  })

  const authUrl = new URL('https://www.amazon.com/ap/oa')
  authUrl.searchParams.set('client_id', config.lwaClientId)
  authUrl.searchParams.set('scope', config.scopes)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', config.redirectUri)
  authUrl.searchParams.set('state', state)

  // JSON 模式（前端 fetch 拿 URL 自己跳）或 302 直接跳
  const wantsJson = (req.headers.get('accept') ?? '').includes('application/json')
  if (wantsJson) return json({ ok: true, url: authUrl.toString() })
  return redirect(authUrl.toString())
})
