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
import { Badge, Button, ConfirmDialog, EmptyState, useToast } from './ui'
import { callRpc, fetchRows, invokeFunction } from '../lib/db'
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
  const [configMissing, setConfigMissing] = useState<string[] | null>(null)
  const [configHint, setConfigHint] = useState(false)
  const [connectingStore, setConnectingStore] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<Connection | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [conns, storeRows] = await Promise.all([
        callRpc<Connection[]>('list_platform_connections'),
        fetchRows<StoreRow>('stores', { columns: 'id,name,platform,marketplace,status' }),
      ])
      setConnections(Array.isArray(conns) ? conns : [])
      setStores(storeRows.filter((s) => s.platform === 'amazon'))
    } catch (err) {
      push(err instanceof Error ? err.message : '加载失败', 'error')
    } finally {
      setLoading(false)
    }
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
        {configHint ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11.5px] text-amber-800">
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
          <EmptyState
            title="还没有连接店铺"
            description={availableStores.length ? '从下方选择一个 Amazon 店铺开始授权' : '请先在「店铺」页面添加 Amazon 店铺'}
          />
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

        {canManage && availableStores.length > 0 && configMissing === null && (
          <div className="mt-3 pt-3 border-t border-ink-100">
            <p className="text-[11px] text-ink-500 mb-2">可连接的 Amazon 店铺：</p>
            <div className="flex flex-wrap gap-2">
              {availableStores.map((s) => (
                <Button key={s.id} size="sm" variant="default" disabled={connectingStore !== null} onClick={() => void startConnect(s.id)}>
                  {connectingStore === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                  连接 {s.name}（{s.marketplace}）
                </Button>
              ))}
            </div>
          </div>
        )}

        {canManage && connections.length > 0 && configMissing === null && (
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={syncing !== null} onClick={() => void runSync()}>
              {syncing === '__all__' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              同步全部店铺
            </Button>
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
