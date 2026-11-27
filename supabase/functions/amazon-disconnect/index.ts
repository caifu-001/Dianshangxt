/**
 * 解除授权：清 token、停同步；保留已同步业务数据（财务凭证）。
 * POST { connection_id }
 */
import { corsHeaders, json } from '../_shared/cors.ts'
import { resolveCaller, serviceClient, userClient, canManageConnections } from '../_shared/clients.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  const uc = await userClient(req)
  if (!uc) return json({ ok: false, message: '请先登录' }, 401)
  const db = serviceClient()

  const { data: auth } = await uc.auth.getUser()
  const caller = auth?.user ? await resolveCaller(db, auth.user.id) : null
  if (!caller || !canManageConnections(caller)) {
    return json({ ok: false, message: '只有公司管理员可以解除授权' }, 403)
  }

  let connectionId: string | undefined
  try {
    const body = await req.json()
    connectionId = body.connection_id
  } catch { /* ignore */ }
  if (!connectionId) return json({ ok: false, message: '缺少 connection_id' }, 400)

  const { data: conn } = await db
    .from('platform_connections')
    .select('id, company_id')
    .eq('id', connectionId)
    .maybeSingle()
  if (!conn) return json({ ok: false, message: '连接不存在' }, 404)
  if (!caller.superAdmin && conn.company_id !== caller.companyId) {
    return json({ ok: false, message: '无权操作其他公司的连接' }, 403)
  }

  await db.from('platform_connections').update({
    token_cipher: null,
    status: 'revoked',
    last_error: null,
    sync_lock_until: null,
    updated_at: new Date().toISOString(),
  }).eq('id', connectionId)

  await db.from('system_logs').insert({
    company_id: conn.company_id,
    category: 'business',
    action: 'platform_disconnected',
    summary: 'Amazon 店铺已解除授权（历史同步数据保留）',
    detail: { connection_id: connectionId },
    target_type: 'platform_connection',
    target_id: connectionId,
    severity: 'info',
  })

  return json({ ok: true })
})
