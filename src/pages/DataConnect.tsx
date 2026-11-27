/**
 * 数据接入中心：给入驻跨境公司管理员使用的可视化接入向导。
 *
 * 核心原则：账号密码只在 Amazon 官方授权页输入，本系统永不接触、永不存储。
 * 这里只负责引导「去哪输、怎么输、授完回来、同步状态怎么看」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  HelpCircle,
  Info,
  KeyRound,
  Link2,
  Loader2,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Store as StoreIcon,
  Unplug,
  XCircle,
} from 'lucide-react'
import { Badge, Button, ConfirmDialog, useToast } from '../components/ui'
import { callRpc, fetchRows, invokeFunction } from '../lib/db'
import { SUPABASE_KEY, SUPABASE_URL } from '../lib/supabase'
import { fmtDateTime } from '../lib/utils'
import { useAuth } from '../context/AuthContext'
import { cn } from '../lib/utils'

/* ------------------------------ 类型 ------------------------------ */

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

interface SyncRun {
  id: string
  connection_id: string | null
  store_id: string | null
  job_type: string
  status: string
  started_at: string
  finished_at: string | null
  rows_new: number
  rows_updated: number
  rows_failed: number
  error: string | null
  triggered_by: string
}

interface SyncResult {
  ok: boolean
  code?: string
  message?: string
  missing?: string[]
  synced?: number
  results?: Array<{ connection_id: string; status: string; error?: string; reason?: string }>
}

type FnStatus = 'checking' | 'ok' | 'unconfigured' | 'missing'

const STATUS_META: Record<string, { label: string; tone: 'green' | 'red' | 'amber' | 'gray' }> = {
  active: { label: '已连接', tone: 'green' },
  paused: { label: '已暂停', tone: 'amber' },
  error: { label: '授权失效', tone: 'red' },
  revoked: { label: '已解除', tone: 'gray' },
}
const RUN_META: Record<string, { label: string; tone: 'green' | 'red' | 'amber' | 'gray' }> = {
  ok: { label: '成功', tone: 'green' },
  partial: { label: '部分成功', tone: 'amber' },
  failed: { label: '失败', tone: 'red' },
  running: { label: '进行中', tone: 'amber' },
  skipped: { label: '已跳过', tone: 'gray' },
}
const JOB_LABEL: Record<string, string> = {
  orders: '订单', products: '商品', inventory: '库存', financial: '财务', all: '全部',
}
const REGION_LABEL: Record<string, string> = { na: '北美', eu: '欧洲', fe: '远东' }

/* ------------------------------ 页面 ------------------------------ */

export default function DataConnect() {
  const { can } = useAuth()
  const { push } = useToast()
  const canManage = can('stores.edit')

  const [connections, setConnections] = useState<Connection[]>([])
  const [stores, setStores] = useState<StoreRow[]>([])
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [loading, setLoading] = useState(true)
  const [fnStatus, setFnStatus] = useState<FnStatus>('checking')
  const [configMissing, setConfigMissing] = useState<string[]>([])
  const [connectingStore, setConnectingStore] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<Connection | null>(null)
  const [showHelp, setShowHelp] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [connRes, storeRes, runRes] = await Promise.allSettled([
      callRpc<Connection[]>('list_platform_connections'),
      fetchRows<StoreRow>('stores', { columns: 'id,name,platform,marketplace,status' }),
      fetchRows<SyncRun>('sync_runs', {
        columns: 'id,connection_id,store_id,job_type,status,started_at,finished_at,rows_new,rows_updated,rows_failed,error,triggered_by',
        order: { column: 'started_at', ascending: false },
        limit: 30,
      }),
    ])
    if (connRes.status === 'fulfilled') setConnections(Array.isArray(connRes.value) ? connRes.value : [])
    else {
      setConnections([])
      push(`读取连接状态失败：${connRes.reason instanceof Error ? connRes.reason.message : String(connRes.reason)}`, 'error')
    }
    if (storeRes.status === 'fulfilled') setStores(storeRes.value.filter((s) => s.platform === 'amazon'))
    if (runRes.status === 'fulfilled') setRuns(runRes.value)
    setLoading(false)

    // 无副作用探测服务端函数：空 body 时 oauth-start 先校验凭证即返回。
    void (async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/amazon-oauth-start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
          body: '{}',
        })
        if (res.status === 404) { setFnStatus('missing'); return }
        if (res.status === 503) {
          setFnStatus('unconfigured')
          const body = await res.json().catch(() => null) as { missing?: string[] } | null
          if (Array.isArray(body?.missing)) setConfigMissing(body.missing)
          return
        }
        setFnStatus('ok')
      } catch { setFnStatus('missing') }
    })()
  }, [push])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oauth = params.get('oauth')
    if (!oauth) return
    push(params.get('msg') || (oauth === 'ok' ? 'Amazon 店铺已连接，正在同步' : '授权未完成'), oauth === 'ok' ? 'success' : 'error')
    window.history.replaceState({}, '', window.location.pathname)
    void load()
  }, [push, load])

  function handleFnError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    if (/NOT_CONFIGURED|尚未配置凭证|尚未配置/.test(msg)) {
      setFnStatus('unconfigured')
      const m = msg.match(/\[([^\]]+)\]/)
      if (m) setConfigMissing(m[1].split(',').map((s) => s.trim()))
      return
    }
    push(msg, 'error')
  }

  async function startConnect(storeId: string) {
    setConnectingStore(storeId)
    try {
      const res = await invokeFunction<{ ok: boolean; url?: string; message?: string }>('amazon-oauth-start', { store_id: storeId })
      if (!res.ok) throw new Error(res.message ?? '发起授权失败')
      if (!res.url) throw new Error('未返回授权地址')
      window.location.href = res.url
    } catch (err) { handleFnError(err) }
    finally { setConnectingStore(null) }
  }

  async function runSync(connectionId?: string) {
    setSyncing(connectionId ?? '__all__')
    try {
      const res = await invokeFunction<SyncResult>('amazon-sync', connectionId ? { connection_id: connectionId } : {})
      if (!res.ok) throw new Error(res.message ?? '同步失败')
      const failed = res.results?.filter((r) => r.status === 'failed') ?? []
      if (failed.length) push(`同步完成，但有 ${failed.length} 个连接失败：${failed[0].error ?? ''}`, 'error')
      else push(`同步已启动，共 ${res.synced ?? 0} 个连接`)
      await load()
    } catch (err) { handleFnError(err) }
    finally { setSyncing(null) }
  }

  async function doDisconnect() {
    if (!disconnectTarget) return
    try {
      await invokeFunction('amazon-disconnect', { connection_id: disconnectTarget.id })
      push('已解除授权，历史同步数据保留')
      setDisconnectTarget(null)
      await load()
    } catch (err) { push(err instanceof Error ? err.message : '解除失败', 'error') }
  }

  /* ------------------------ 向导进度计算 ------------------------ */
  const connectedStoreIds = useMemo(
    () => new Set(connections.filter((c) => c.status !== 'revoked').map((c) => c.store_id)),
    [connections],
  )
  const availableStores = useMemo(
    () => stores.filter((s) => s.status === 'active' && !connectedStoreIds.has(s.id)),
    [stores, connectedStoreIds],
  )
  const hasStore = stores.length > 0
  const hasConnection = connections.some((c) => c.status !== 'revoked')
  const hasSuccessRun = runs.some((r) => r.status === 'ok' || r.status === 'partial')

  const steps = [
    { done: hasStore, title: '创建店铺档案', desc: '在「店铺管理」添加您的 Amazon 店铺与站点' },
    { done: hasConnection, title: '授权连接店铺', desc: '跳转 Amazon 官方页面登录并同意授权，密码不经过本系统' },
    { done: hasConnection && hasSuccessRun, title: '首次数据同步', desc: '授权后自动拉取订单、商品与 FBA 库存' },
    { done: hasSuccessRun, title: '查看经营数据', desc: '同步数据进入订单、商品、库存，自动生成利润与绩效' },
  ]
  const completedSteps = steps.filter((s) => s.done).length

  const serviceReady = fnStatus === 'ok'
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name ?? '已解除的店铺'

  return (
    <div className="space-y-4">
      {/* 页头 */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <PlugZap className="w-5 h-5 text-brand-600" />
            <h1 className="text-[17px] font-semibold text-ink-900">数据接入中心</h1>
            <Badge tone="blue">Amazon</Badge>
            {!canManage && <Badge tone="gray">只读</Badge>}
          </div>
          <p className="text-[12px] text-ink-500 mt-1">
            连接店铺后，订单、商品、FBA 库存自动同步到系统，利润与绩效随之更新。全程无需手工导入 Excel。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" icon={<BookOpen className="w-3.5 h-3.5" />} onClick={() => setShowHelp(true)}>
            使用说明
          </Button>
          <Button variant="default" size="sm" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => void load()}>
            刷新状态
          </Button>
        </div>
      </div>

      {/* 账号密码说明：最重要的一块，放在最上面 */}
      <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center shrink-0">
            <KeyRound className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13.5px] font-semibold text-ink-900">账号密码在哪里输入？</h2>
            <p className="text-[12px] text-ink-600 mt-1 leading-relaxed">
              <strong>在本系统里不输入账号密码。</strong>Amazon 不允许第三方系统收集卖家密码。点下方「连接店铺」后，
              浏览器会跳转到 <strong>Amazon 官方授权页</strong>，您在那里登录自己的卖家账号并点击「同意授权」，
              然后自动回到本系统开始同步。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
              <span className="inline-flex items-center gap-1 rounded-md bg-white border border-brand-200 px-2 py-1 text-ink-600">
                <span className="w-4 h-4 rounded-full bg-brand-600 text-white flex items-center justify-center text-[9px] font-bold">1</span>
                点本页「连接店铺」
              </span>
              <ChevronRight className="w-3 h-3 text-ink-400" />
              <span className="inline-flex items-center gap-1 rounded-md bg-white border border-brand-200 px-2 py-1 text-ink-600">
                <span className="w-4 h-4 rounded-full bg-brand-600 text-white flex items-center justify-center text-[9px] font-bold">2</span>
                在 Amazon 页面输账号密码
              </span>
              <ChevronRight className="w-3 h-3 text-ink-400" />
              <span className="inline-flex items-center gap-1 rounded-md bg-white border border-brand-200 px-2 py-1 text-ink-600">
                <span className="w-4 h-4 rounded-full bg-brand-600 text-white flex items-center justify-center text-[9px] font-bold">3</span>
                点「同意」后自动返回
              </span>
              <ChevronRight className="w-3 h-3 text-ink-400" />
              <span className="inline-flex items-center gap-1 rounded-md bg-white border border-brand-200 px-2 py-1 text-ink-600">
                <span className="w-4 h-4 rounded-full bg-brand-600 text-white flex items-center justify-center text-[9px] font-bold">4</span>
                数据自动同步
              </span>
            </div>
            <p className="mt-2.5 inline-flex items-center gap-1.5 text-[11px] text-brand-700">
              <ShieldCheck className="w-3.5 h-3.5" />
              本系统只保存加密后的授权令牌，接触不到您的密码；令牌按公司隔离，随时可解除授权。
            </p>
          </div>
        </div>
      </div>

      {/* 服务端状态提示 */}
      {fnStatus === 'missing' && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-800">
          <div className="flex items-center gap-1.5 font-medium mb-1"><AlertTriangle className="w-4 h-4" />服务端同步服务尚未部署</div>
          <p className="leading-relaxed">
            代码已就绪，但 4 个 Edge Functions 还没部署到 Supabase，所以暂时无法连接店铺。
            请系统管理员在 Supabase 控制台 → Edge Functions 部署后刷新本页。其它功能不受影响。
          </p>
        </div>
      )}
      {fnStatus === 'unconfigured' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-800">
          <div className="flex items-center gap-1.5 font-medium mb-1"><Info className="w-4 h-4" />同步服务已部署，等待配置 Amazon 应用凭证</div>
          <p className="leading-relaxed">
            {configMissing.length > 0 && <>当前缺少：<code className="break-all">{configMissing.join('、')}</code>。</>}
            这是平台级配置，由系统管理员在 Supabase 后台填写（详见 <code>supabase/functions/manual/README.md</code>）。
            配置完成后本页会自动变为可连接状态。
          </p>
        </div>
      )}
      {fnStatus === 'ok' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-[11.5px] text-emerald-800 flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" />同步服务已就绪，可以连接店铺了。
        </div>
      )}

      {/* 接入向导 */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[13.5px] font-semibold text-ink-900">接入进度</h2>
          <span className="text-[11px] text-ink-400">{completedSteps} / {steps.length} 步已完成</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          {steps.map((step, i) => (
            <div
              key={step.title}
              className={cn(
                'rounded-lg border p-3 transition-colors',
                step.done ? 'border-emerald-200 bg-emerald-50/50' : 'border-ink-200 bg-white',
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn(
                  'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0',
                  step.done ? 'bg-emerald-600 text-white' : 'bg-ink-100 text-ink-500',
                )}>
                  {step.done ? <Check className="w-3 h-3" /> : i + 1}
                </span>
                <span className={cn('text-[12px] font-medium', step.done ? 'text-emerald-800' : 'text-ink-800')}>{step.title}</span>
              </div>
              <p className="text-[10.5px] text-ink-500 mt-1.5 leading-relaxed">{step.desc}</p>
            </div>
          ))}
        </div>
        {!hasStore && canManage && (
          <div className="mt-3 flex items-center gap-2 text-[11.5px]">
            <span className="text-ink-500">第一步：先去创建店铺档案</span>
            <Link to="/stores" className="inline-flex items-center gap-1 text-brand-600 hover:underline font-medium">
              前往店铺管理 <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        )}
      </div>

      {/* 已连接店铺 */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-ink-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-ink-400" />
            <h2 className="text-[13.5px] font-semibold text-ink-900">已连接店铺</h2>
            <Badge tone="gray">{connections.filter((c) => c.status !== 'revoked').length}</Badge>
          </div>
          {canManage && connections.length > 0 && (
            <Button size="sm" variant="primary" loading={syncing === '__all__'} disabled={!serviceReady || syncing !== null} onClick={() => void runSync()}>
              同步全部
            </Button>
          )}
        </div>
        <div className="p-4">
          {loading ? (
            <div className="flex items-center gap-2 text-[11.5px] text-ink-400 py-4"><Loader2 className="w-3.5 h-3.5 animate-spin" />加载连接状态…</div>
          ) : connections.length === 0 ? (
            <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50/40 px-4 py-7 text-center">
              <PlugZap className="w-7 h-7 mx-auto text-ink-300 mb-2" />
              <p className="text-[13px] font-medium text-ink-700">还没有连接任何店铺</p>
              <p className="text-[11.5px] text-ink-400 mt-1">连接后即可自动同步订单、商品与库存，无需手工导入</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {connections.map((c) => {
                const meta = STATUS_META[c.status] ?? STATUS_META.revoked
                const storeRuns = runs.filter((r) => r.connection_id === c.id).slice(0, 3)
                return (
                  <div key={c.id} className="rounded-lg border border-ink-200 p-3.5">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
                          <StoreIcon className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[13px] font-medium text-ink-900">{c.store_name}</span>
                            <Badge tone={meta.tone} dot>{meta.label}</Badge>
                            <span className="text-[10.5px] text-ink-400">{REGION_LABEL[c.region] ?? c.region}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-[10.5px] text-ink-400 flex-wrap">
                            {c.last_sync_at ? (
                              <span className="inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />上次同步 {fmtDateTime(c.last_sync_at)}</span>
                            ) : (
                              <span className="inline-flex items-center gap-1"><Clock3 className="w-3 h-3" />尚未同步</span>
                            )}
                            <span>授权于 {fmtDateTime(c.created_at)}</span>
                          </div>
                        </div>
                      </div>
                      {canManage && c.status !== 'revoked' && (
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="default" loading={syncing === c.id} disabled={!serviceReady || syncing !== null} onClick={() => void runSync(c.id)}>
                            <RefreshCw className="w-3.5 h-3.5" />立即同步
                          </Button>
                          <Button size="sm" variant="ghost" title="解除授权" onClick={() => setDisconnectTarget(c)}>
                            <Unplug className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                    {c.last_error && (
                      <div className="mt-2.5 rounded-md bg-rose-50 border border-rose-100 px-2.5 py-1.5 text-[10.5px] text-rose-700 flex items-start gap-1.5">
                        <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span className="break-all">{c.last_error}</span>
                      </div>
                    )}
                    {storeRuns.length > 0 && (
                      <div className="mt-2.5 pt-2.5 border-t border-ink-100 grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {storeRuns.map((r) => {
                          const rm = RUN_META[r.status] ?? RUN_META.skipped
                          return (
                            <div key={r.id} className="rounded-md bg-ink-50 px-2 py-1.5">
                              <div className="flex items-center justify-between gap-1">
                                <span className="text-[10px] text-ink-500">{JOB_LABEL[r.job_type] ?? r.job_type}</span>
                                <Badge tone={rm.tone}>{rm.label}</Badge>
                              </div>
                              <p className="text-[9.5px] text-ink-400 mt-1">新增 {r.rows_new} · 更新 {r.rows_updated} · 失败 {r.rows_failed}</p>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {canManage && availableStores.length > 0 && (
            <div className="mt-4 pt-4 border-t border-ink-100">
              <p className="text-[11.5px] font-medium text-ink-700 mb-2">可连接的 Amazon 店铺：</p>
              <div className="flex flex-wrap gap-2">
                {availableStores.map((s) => (
                  <Button
                    key={s.id}
                    size="sm"
                    variant="primary"
                    loading={connectingStore === s.id}
                    disabled={connectingStore !== null || !serviceReady}
                    title={!serviceReady ? '需先完成服务端配置' : undefined}
                    onClick={() => void startConnect(s.id)}
                  >
                    <Link2 className="w-3.5 h-3.5" />连接 {s.name}（{s.marketplace}）
                  </Button>
                ))}
              </div>
              <p className="text-[10.5px] text-ink-400 mt-2 inline-flex items-center gap-1">
                <HelpCircle className="w-3 h-3" />点击后会跳转到 Amazon 官方授权页，在那里输入账号密码
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 同步历史 */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-ink-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock3 className="w-4 h-4 text-ink-400" />
            <h2 className="text-[13.5px] font-semibold text-ink-900">最近同步记录</h2>
          </div>
          <Link to="/system-logs" className="inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline">
            全部系统日志 <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
        <div className="p-4">
          {runs.length === 0 ? (
            <p className="text-[11.5px] text-ink-400 py-3 text-center">暂无同步记录。连接店铺并首次同步后会显示在这里。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px]">
                <thead>
                  <tr className="text-left text-ink-400 border-b border-ink-100">
                    <th className="py-2 pr-3 font-medium">时间</th>
                    <th className="py-2 pr-3 font-medium">店铺 / 任务</th>
                    <th className="py-2 pr-3 font-medium">状态</th>
                    <th className="py-2 pr-3 font-medium">新增 / 更新 / 失败</th>
                    <th className="py-2 pr-3 font-medium">触发方式</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => {
                    const rm = RUN_META[r.status] ?? RUN_META.skipped
                    return (
                      <tr key={r.id} className="border-b border-ink-50 last:border-0">
                        <td className="py-2 pr-3 text-ink-500 whitespace-nowrap">{fmtDateTime(r.started_at)}</td>
                        <td className="py-2 pr-3 text-ink-700">
                          {storeName(r.store_id)} <span className="text-ink-400">· {JOB_LABEL[r.job_type] ?? r.job_type}</span>
                        </td>
                        <td className="py-2 pr-3"><Badge tone={rm.tone}>{rm.label}</Badge></td>
                        <td className="py-2 pr-3 text-ink-600 whitespace-nowrap">
                          <span className="text-emerald-700">{r.rows_new}</span> / <span className="text-ink-500">{r.rows_updated}</span> / <span className={r.rows_failed > 0 ? 'text-rose-600' : 'text-ink-400'}>{r.rows_failed}</span>
                        </td>
                        <td className="py-2 pr-3 text-ink-500">{r.triggered_by === 'cron' ? '定时自动' : r.triggered_by === 'oauth' ? '授权后' : '手动'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {runs.some((r) => r.error) && (
                <div className="mt-3 rounded-md bg-rose-50 border border-rose-100 px-3 py-2 text-[10.5px] text-rose-700">
                  <p className="font-medium mb-1">失败记录（最近一条）：</p>
                  <p className="break-all">{runs.find((r) => r.error)?.error}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 使用说明弹层 */}
      {showHelp && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowHelp(false)}>
          <div className="bg-white rounded-xl max-w-lg w-full p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[15px] font-semibold text-ink-900 flex items-center gap-2"><BookOpen className="w-4 h-4 text-brand-600" />数据接入说明</h3>
              <Button variant="ghost" size="sm" onClick={() => setShowHelp(false)}><XCircle className="w-4 h-4" /></Button>
            </div>
            <div className="space-y-3 text-[12px] text-ink-600 leading-relaxed">
              <div>
                <p className="font-medium text-ink-800 mb-1">1. 为什么要跳转授权，而不是填账号密码？</p>
                <p>Amazon 明确禁止第三方系统收集卖家密码。走官方 OAuth 授权是唯一合规方式：您在 Amazon 官方页面登录并同意，系统只拿到一个加密存储的授权令牌，永远看不到密码。</p>
              </div>
              <div>
                <p className="font-medium text-ink-800 mb-1">2. 授权后同步哪些数据？多久一次？</p>
                <p>同步订单、商品、FBA 库存（买家姓名电话地址等个人信息不落库）。默认每 30 分钟自动同步一次，也可以点「立即同步」手动触发。首次授权后会自动跑一次。</p>
              </div>
              <div>
                <p className="font-medium text-ink-800 mb-1">3. 费用字段为什么是 0？</p>
                <p>订单的佣金、FBA 费、广告费等暂时留空，避免算错利润。您手工填写的成本和费用不会被同步覆盖。后续接入财务接口再精确回填。</p>
              </div>
              <div>
                <p className="font-medium text-ink-800 mb-1">4. 店铺挂在谁名下？</p>
                <p>挂到哪家公司，数据就归哪家公司，本公司同事按权限可见。管理员可以挂自己名下的私人店铺。要改挂别家公司，先解除授权再到目标公司重新授权，历史数据不跨公司迁移。</p>
              </div>
              <div>
                <p className="font-medium text-ink-800 mb-1">5. 解除授权会删数据吗？</p>
                <p>不会。解除只清除授权令牌、停止同步，已经同步的订单商品库存作为财务凭证保留。</p>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="primary" size="sm" onClick={() => setShowHelp(false)}>知道了</Button>
            </div>
          </div>
        </div>
      )}

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
