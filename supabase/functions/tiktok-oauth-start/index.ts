/**
 * 发起 TikTok Shop 授权：校验管理员 → 生成 state → 302 跳官方授权页。
 * GET/POST ?store_id=<uuid>
 */
import { corsHeaders, json, redirect } from '../_shared/cors.ts'
import { checkTiktokConfig, authorizationUrl } from '../_shared/tiktok.ts'
import { resolveCaller, serviceClient, userClient, canManageConnections } from '../_shared/clients.ts'

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

  const { data: store } = await db
    .from('stores')
    .select('id, name, company_id, platform')
    .eq('id', storeId)
    .maybeSingle()
  if (!store || store.company_id !== caller.companyId) {
    return json({ ok: false, message: '店铺不存在或不属于当前公司' }, 404)
  }
  if (store.platform !== 'tiktok') {
    return json({ ok: false, message: '请选择 TikTok 店铺发起授权' }, 400)
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const state = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  await db.from('oauth_states').insert({
    state,
    company_id: caller.companyId,
    store_id: storeId,
    caller_id: caller.userId,
    platform: 'tiktok',
  })

  const authUrl = authorizationUrl(state)
  const wantsJson = (req.headers.get('accept') ?? '').includes('application/json')
  if (wantsJson) return json({ ok: true, url: authUrl })
  return redirect(authUrl)
})
