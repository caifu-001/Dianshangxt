import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Link2,
  Loader2,
  PlugZap,
  RefreshCw,
  Unplug,
} from 'lucide-react'
import { Badge, Button, ConfirmDialog, useToast } from './ui'
import { callRpc, fetchRows, invokeFunction } from '../lib/db'
import { SUPABASE_KEY, SUPABASE_URL } from '../lib/supabase'
import { fmtDateTime } from '../lib/utils'
import { useAuth } from '../context/AuthContext'

interface Connection {
  id: string
  company_id: string
  store_id: string
  store_name: string
  platform: string
  marketplace_ids: string[]
  region: string
  status: string
  last_sync_at: string | null
  last_error: string | null
  connected_by: string | null
  created_at: string
}

interface StoreRow {
  id: string
  name: string
  platform: string
  marketplace: string
  status: string
}

interface SyncResult {
  ok: boolean
  code?: string
  message?: string
  missing?: string[]
  synced?: number
  results?: Array<{ connection_id: string; status: string; error?: string; reason?: string; counts?: { new: number; failed: number } }>
}

const STATUS_META: Record<string, { label: string; tone: 'green' | 'red' | 'amber' | 'gray' }> = {
  active: { label: '已连接', tone: 'green' },
  paused: { label: '已暂停', tone: 'amber' },
  error: { label: '授权失效', tone: 'red' },
  revoked: { label: '已解除', tone: 'gray' },
}

const REGION_LABEL: Record<string, string> = { na: '北美', eu: '欧洲', fe: '远东' }

/**
 * 平台连接卡片：Amazon 店铺 OAuth 授权 / 同步 / 解除。
 * 凭证未配置时显示明确提示，不影响其它功能。
 */
export default function PlatformConnections() {
  const { can } = useAuth()
  const { push } = useToast()
  const canManage = can('stores.edit')

  const [connections, setConnections] = useState<Connection[]>([])
  const [stores, setStores] = useState<StoreRow[]>([])
  const [loading, setLoading] = useState(true)
  const [schemaReady, setSchemaReady] = useState(false)
  const [functionStatus, setFunctionStatus] = useState<'checking' | 'ok' | 'unconfigured' | 'missing'>('checking')
  const [configMissing, setConfigMissing] = useState<string[] | null>(null)
  const [configHint, setConfigHint] = useState(false)
  const [connectingStore, setConnectingStore] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<Connection | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    // 两个数据源独立加载：连接表 RPC 失败时也要把店铺列表显示出来，否则页面看起来是空的
    const [connResult, storeResult] = await Promise.allSettled([
      callRpc<Connection[]>('list_platform_connections'),
      fetchRows<StoreRow>('stores', { columns: 'id,name,platform,marketplace,status' }),
    ])
    if (connResult.status === 'fulfilled') {
      setConnections(Array.isArray(connResult.value) ? connResult.value : [])
      setSchemaReady(true)
    } else {
      setConnections([])
      const msg = connResult.reason instanceof Error ? connResult.reason.message : String(connResult.reason)
      push(`读取店铺连接失败：${msg}`, 'error')
    }
    if (storeResult.status === 'fulfilled') {
      setStores(storeResult.value.filter((s) => s.platform === 'amazon'))
    } else {
      const msg = storeResult.reason instanceof Error ? storeResult.reason.message : String(storeResult.reason)
      push(`读取店铺列表失败：${msg}`, 'error')
    }
    setLoading(false)

    // 主动探测服务端函数：oauth-start 在最前面校验凭证，空 body 不会产生任何副作用。
    void (async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/amazon-oauth-start`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
          body: '{}',
        })
        if (res.status === 404) setFunctionStatus('missing')
        else if (res.status === 503) setFunctionStatus('unconfigured')
        else setFunctionStatus('ok')
      } catch {
        setFunctionStatus('missing')
      }
    })()
  }, [push])

  useEffect(() => { void load() }, [load])

  // OAuth 回调落地后读取 ?oauth=ok/error 提示
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oauth = params.get('oauth')
    if (!oauth) return
    const msg = params.get('msg') ?? ''
    push(msg || (oauth === 'ok' ? 'Amazon 店铺已连接' : '授权未完成'), oauth === 'ok' ? 'success' : 'error')
    window.history.replaceState({}, '', window.location.pathname)
    void load()
  }, [push, load])

  /** Edge Function 未配置凭证时，error.message 里带约定文案；抽出缺失项展示。 */
  function handleFunctionError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    if (/NOT_CONFIGURED|尚未配置凭证|尚未配置/.test(msg)) {
      setConfigHint(true)
      // functions.invoke 的 error.message 只带 message，尝试从括号内容解析缺失项
      const match = msg.match(/\[([^\]]+)\]/)
      if (match) setConfigMissing(match[1].split(',').map((s) => s.trim()))
      return
    }
    push(msg, 'error')
  }

  async function startConnect(storeId: string) {
    setConnectingStore(storeId)
    try {
      const res = await invokeFunction<{ ok: boolean; url?: string; message?: string; missing?: string[] }>(
        'amazon-oauth-start', { store_id: storeId },
      )
      if (!res.ok) throw new Error(res.message ?? '发起授权失败')
      if (!res.url) throw new Error('未返回授权地址')
      window.location.href = res.url
    } catch (err) {
      handleFunctionError(err)
    } finally {
      setConnectingStore(null)
    }
  }

  async function runSync(connectionId?: string) {
    setSyncing(connectionId ?? '__all__')
    try {
      const res = await invokeFunction<SyncResult>('amazon-sync', connectionId ? { connection_id: connectionId } : {})
      if (!res.ok) throw new Error(res.message ?? '同步失败')
      const failed = res.results?.filter((r) => r.status === 'failed') ?? []
      if (failed.length) push(`同步完成，但有 ${failed.length} 个连接失败：${failed[0].error ?? ''}`, 'error')
      else push(`同步完成，共 ${res.synced ?? 0} 个连接`)
      await load()
    } catch (err) {
      handleFunctionError(err)
    } finally {
      setSyncing(null)
    }
  }

  async function doDisconnect() {
    if (!disconnectTarget) return
    try {
      await invokeFunction('amazon-disconnect', { connection_id: disconnectTarget.id })
      push('已解除授权，历史同步数据保留')
      setDisconnectTarget(null)
      await load()
    } catch (err) {
      push(err instanceof Error ? err.message : '解除失败', 'error')
    }
  }

  const connectedStoreIds = new Set(connections.filter((c) => c.status !== 'revoked').map((c) => c.store_id))
  const availableStores = stores.filter((s) => s.status === 'active' && !connectedStoreIds.has(s.id))

  return (
    <div className="card mt-3 overflow-hidden">
      <div className="px-4 py-3 border-b border-ink-100 flex items-center gap-2">
        <PlugZap className="w-4 h-4 text-ink-400" />
        <h3 className="text-[13.5px] font-semibold text-ink-900">平台账号连接</h3>
        <Badge tone="gray">Amazon</Badge>
        {!canManage && <Badge tone="gray">只读</Badge>}
      </div>
      <div className="p-4">
        {functionStatus === 'missing' ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-[11.5px] text-rose-800 mb-3">
            <div className="flex items-center gap-1.5 font-medium mb-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              服务端同步函数尚未部署
            </div>
            <p className="leading-relaxed">
              代码已就绪，但 4 个 Edge Functions 还没部署到 Supabase，所以现在无法连接店铺或自动同步。
              请在 Supabase 控制台 → Edge Functions 部署 <code>supabase/functions</code> 下的函数后刷新本页。其余功能不受影响。
            </p>
          </div>
        ) : configHint || functionStatus === 'unconfigured' ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11.5px] text-amber-800 mb-3">
            <div className="flex items-center gap-1.5 font-medium mb-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              自动同步尚未启用
            </div>
            <p className="leading-relaxed">
              管理员需在 Supabase 后台填入 Amazon 应用凭证后才能连接店铺。
              {configMissing && configMissing.length > 0 && (
                <>当前缺少：<code className="mx-1 break-all">{configMissing.join('、')}</code>。</>
              )}
              配置方法见仓库 <code>supabase/functions/README.md</code>。其余功能不受影响。
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-ink-400 mb-3 leading-relaxed">
            连接后订单、商品与 FBA 库存会自动同步到系统（不采集买家个人信息）。只有公司管理员可以连接或解除店铺。
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-[11px] text-ink-400 py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载连接状态…
          </div>
        ) : connections.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50/40 px-4 py-5 text-center">
            <PlugZap className="w-6 h-6 mx-auto text-ink-300 mb-2" />
            <p className="text-[12.5px] font-medium text-ink-700">还没有连接任何店铺</p>
            <p className="text-[11px] text-ink-400 mt-1 leading-relaxed">
              {availableStores.length
                ? '从下方选择 Amazon 店铺发起授权，首次使用需先完成服务端配置。'
                : '请先在「店铺管理」添加一个 Amazon 店铺，并完成下方的启用步骤。'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {connections.map((c) => {
              const meta = STATUS_META[c.status] ?? STATUS_META.revoked
              return (
                <div key={c.id} className="flex items-center gap-3 rounded-lg border border-ink-200 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] font-medium text-ink-900 truncate">{c.store_name}</span>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      <span className="text-[10px] text-ink-400">{REGION_LABEL[c.region] ?? c.region}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[10.5px] text-ink-400">
                      {c.last_sync_at ? (
                        <span className="inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />上次同步 {fmtDateTime(c.last_sync_at)}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1"><Clock3 className="w-3 h-3" />尚未同步</span>
                      )}
                      {c.last_error && <span className="text-rose-600 truncate" title={c.last_error}>{c.last_error.slice(0, 60)}</span>}
                    </div>
                  </div>
                  {canManage && c.status !== 'revoked' && (
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="default" disabled={syncing !== null || configMissing !== null} onClick={() => void runSync(c.id)}>
                        {syncing === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                        立即同步
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDisconnectTarget(c)} title="解除授权">
                        <Unplug className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {canManage && availableStores.length > 0 && (
          <div className="mt-3 pt-3 border-t border-ink-100">
            <p className="text-[11px] text-ink-500 mb-2">可连接的 Amazon 店铺：</p>
            <div className="flex flex-wrap gap-2">
              {availableStores.map((s) => (
                <Button
                  key={s.id}
                  size="sm"
                  variant="default"
                  disabled={connectingStore !== null || functionStatus !== 'ok' || configMissing !== null}
                  title={
                    functionStatus === 'missing'
                      ? '需先在 Supabase 部署 Edge Functions'
                      : functionStatus === 'unconfigured'
                        ? '需先在 Supabase 配置 Amazon 应用凭证'
                        : undefined
                  }
                  onClick={() => void startConnect(s.id)}
                >
                  {connectingStore === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                  连接 {s.name}（{s.marketplace}）
                </Button>
              ))}
            </div>
            {functionStatus !== 'ok' && (
              <p className="text-[10.5px] text-amber-600 mt-1.5">
                {functionStatus === 'missing' ? '部署服务端函数后即可点击连接' : '完成服务端配置后即可点击连接'}
              </p>
            )}
          </div>
        )}

        {canManage && connections.length === 0 && (
          <div className="mt-3 pt-3 border-t border-ink-100">
            <p className="text-[11px] font-medium text-ink-600 mb-1.5">首次启用步骤（管理员）</p>
            <ol className="text-[10.5px] text-ink-400 space-y-1.5 list-decimal list-inside leading-relaxed">
              <li>
                在 Supabase SQL Editor 执行 <code className="text-ink-500">supabase/platform_sync_schema.sql</code>
                {schemaReady && <span className="ml-1 text-emerald-600">（已就绪）</span>}
              </li>
              <li>
                部署服务端函数 <code className="text-ink-500">amazon-oauth-start / callback / sync / disconnect</code>
                {functionStatus !== 'missing' && functionStatus !== 'checking' && <span className="ml-1 text-emerald-600">（已部署）</span>}
              </li>
              <li>
                在 Supabase Secrets 填入 Amazon 应用凭证（LWA Client ID/Secret、AWS Key/Secret、Role ARN）
                {functionStatus === 'ok' && <span className="ml-1 text-emerald-600">（已配置）</span>}
              </li>
              <li>在「店铺管理」添加 Amazon 店铺，回到这里点「连接」完成授权</li>
            </ol>
            <p className="text-[10px] text-ink-400 mt-2">
              配置清单见仓库 <code>supabase/functions/README.md</code>；未完成配置前其它模块不受影响。
            </p>
          </div>
        )}

        {canManage && (
          <div className="mt-3 flex items-center gap-2">
            {connections.length > 0 && (
              <Button size="sm" variant="primary" disabled={syncing !== null || configMissing !== null} onClick={() => void runSync()}>
                {syncing === '__all__' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                同步全部店铺
              </Button>
            )}
            <Link to="/system-logs" className="inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline">
              查看同步日志 <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!disconnectTarget}
        title="解除 Amazon 店铺授权"
        message="解除后将停止自动同步并清除授权令牌。已同步的订单、商品、库存数据会保留（属于财务凭证）。确认继续？"
        confirmText="确认解除"
        onClose={() => setDisconnectTarget(null)}
        onConfirm={() => void doDisconnect()}
      />
    </div>
  )
}
