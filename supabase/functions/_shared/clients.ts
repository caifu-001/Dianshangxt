/** Supabase 客户端工厂：service_role 用于服务端读写，user 客户端用于校验调用者身份。 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4'
import { config } from './config.ts'

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
