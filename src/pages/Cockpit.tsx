/**
 * 运营数据驾驶舱（大屏）
 *
 * 与「运营概览」的区别：
 *  - 运营概览是后台页面，用于日常查数、下钻、录入
 *  - 驾驶舱是投屏/盯盘用：深色、无侧边栏、秒级时钟、自动轮询、异常跑马灯
 *
 * 实时性说明：数据来自 Supabase 表，采用「可见性感知的轮询」——
 * 页面切到后台时暂停请求，切回来立即补一次，避免大屏长期挂着空耗配额。
 * 各表独立容错：某个模块没有权限（RLS 拒绝）只会让对应面板空着，不会白屏。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import dayjs from 'dayjs'
import { useAuth } from '../context/AuthContext'
import {
  AlertTriangle,
  ArrowLeft,
  Maximize2,
  Minimize2,
  Radio,
  RefreshCw,
  Store as StoreIcon,
} from 'lucide-react'
import {
  Area,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { fetchRows, type QueryOptions } from '../lib/db'
import { useFx } from '../lib/fx'
import { buildCockpit, INVENTORY_COLORS, type CockpitRaw } from '../lib/cockpitModel'
import {
  DarkTip,
  FunnelRow,
  Gauge,
  LiveDot,
  SCREEN,
  ScreenPanel,
  Spark,
  StatTile,
  Ticker,
  TONE_COLOR,
  useClock,
} from '../components/cockpit'
import { compactMoney, cn, daysAgo, money, num } from '../lib/utils'
import type {
  Campaign,
  Competitor,
  CompetitorSnapshot,
  Creator,
  InventoryItem,
  Order,
  Product,
  PurchaseItem,
  PurchaseOrder,
  Store,
  Task,
} from '../lib/types'

const INTERVALS = [
  { value: 15_000, label: '15s' },
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '60s' },
  { value: 0, label: '暂停' },
]

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const INVENTORY_LABELS: Array<[keyof typeof INVENTORY_COLORS, string]> = [
  ['out', '已断货'],
  ['urgent', '紧急'],
  ['low', '偏低'],
  ['healthy', '健康'],
  ['over', '过剩'],
]

function axisMoney(v: number) {
  const abs = Math.abs(v)
  if (abs >= 10_000) return `$${(v / 1000).toFixed(0)}k`
  if (abs >= 1000) return `$${(v / 1000).toFixed(1)}k`
  return `$${Math.round(v)}`
}

function agoText(iso: string) {
  const diff = dayjs().diff(dayjs(iso), 'second')
  if (!Number.isFinite(diff)) return '—'
  if (diff < 5) return '刚刚'
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86_400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86_400)} 天前`
}

export default function Cockpit() {
  const { isSuperAdmin } = useAuth()
  const fx = useFx()
  const clock = useClock()
  const rootRef = useRef<HTMLDivElement>(null)

  const [raw, setRaw] = useState<CockpitRaw | null>(null)
  const [firstLoad, setFirstLoad] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [storeId, setStoreId] = useState<string>('')
  const [intervalMs, setIntervalMs] = useState(() => {
    // localStorage 里存的是字符串 "0" 表示暂停，读不到才是 null
    // 直接 Number(null) 会得到 0，把默认值误判成「暂停」
    const saved = localStorage.getItem('cockpit:interval')
    if (saved === null) return 30_000
    const parsed = Number(saved)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000
  })
  const [remaining, setRemaining] = useState(Math.round(intervalMs / 1000))
  const [refreshing, setRefreshing] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const load = useCallback(async () => {
    setRefreshing(true)
    // 单表失败（无权限 / 旧库缺表）降级为空数组，不拖垮整块大屏
    const safe = async <T,>(table: string, options?: QueryOptions): Promise<T[]> => {
      try {
        return await fetchRows<T>(table, options)
      } catch {
        return []
      }
    }

    try {
      const [
        stores,
        orders,
        products,
        inventory,
        campaigns,
        creators,
        competitors,
        snapshots,
        purchaseOrders,
        purchaseItems,
        tasks,
      ] = await Promise.all([
        safe<Store>('stores', { order: { column: 'created_at' } }),
        safe<Order>('orders', {
          filters: [
            ['order_date', 'gte', daysAgo(44)],
            ['order_date', 'lte', dayjs().format('YYYY-MM-DD')],
          ],
          order: { column: 'order_date' },
        }),
        safe<Product>('products'),
        safe<InventoryItem>('inventory'),
        safe<Campaign>('campaigns'),
        safe<Creator>('creators'),
        safe<Competitor>('competitors'),
        safe<CompetitorSnapshot>('competitor_snapshots', {
          filters: [['snapshot_date', 'gte', daysAgo(30)]],
          order: { column: 'snapshot_date' },
        }),
        safe<PurchaseOrder>('purchase_orders'),
        safe<PurchaseItem>('purchase_items'),
        safe<Task>('tasks'),
      ])

      setRaw({ stores, orders, products, inventory, campaigns, creators, competitors, snapshots, purchaseOrders, purchaseItems, tasks })
      setLastUpdated(new Date())
      setLoadError(stores.length === 0 && orders.length === 0 && inventory.length === 0 ? 'empty' : null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '数据加载失败')
    } finally {
      setRefreshing(false)
      setFirstLoad(false)
    }
  }, [])

  const loadRef = useRef(load)
  loadRef.current = load

  // 首屏
  useEffect(() => {
    void load()
  }, [load])

  // 轮询：页面在后台时冻结倒计时，切回前台立刻补一次
  useEffect(() => {
    localStorage.setItem('cockpit:interval', String(intervalMs))
    if (!intervalMs) {
      setRemaining(0)
      return
    }
    setRemaining(Math.round(intervalMs / 1000))
    const id = window.setInterval(() => {
      if (document.hidden) return
      setRemaining((prev) => {
        if (prev <= 1) {
          void loadRef.current()
          return Math.round(intervalMs / 1000)
        }
        return prev - 1
      })
    }, 1000)
    return () => window.clearInterval(id)
  }, [intervalMs])

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void loadRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }
    void rootRef.current?.requestFullscreen?.().catch(() => {
      /* 某些浏览器/iframe 环境不允许全屏，静默忽略 */
    })
  }

  // 店铺筛选：只影响展示范围，不改动数据库
  const scoped = useMemo<CockpitRaw | null>(() => {
    if (!raw) return null
    if (!storeId) return raw
    const keep = <T extends { store_id?: string | null }>(rows: T[]) => rows.filter((r) => r.store_id === storeId)
    return {
      ...raw,
      stores: raw.stores.filter((s) => s.id === storeId),
      orders: keep(raw.orders),
      products: keep(raw.products),
      inventory: keep(raw.inventory),
      campaigns: keep(raw.campaigns),
      creators: keep(raw.creators),
      competitors: keep(raw.competitors),
      purchaseOrders: keep(raw.purchaseOrders),
      tasks: keep(raw.tasks),
    }
  }, [raw, storeId])

  const model = useMemo(() => (scoped ? buildCockpit(scoped, fx) : null), [scoped, fx])

  // 新订单高亮：轮询拿到新数据时闪一下，让「实时」可见
  const seenRef = useRef<Set<string>>(new Set())
  const [flashIds, setFlashIds] = useState<string[]>([])
  useEffect(() => {
    if (!model) return
    const ids = model.liveOrders.map((o) => o.id)
    if (seenRef.current.size === 0) {
      seenRef.current = new Set(ids)
      return
    }
    const fresh = ids.filter((id) => !seenRef.current.has(id))
    for (const id of ids) seenRef.current.add(id)
    if (!fresh.length) return
    setFlashIds(fresh)
    const timer = window.setTimeout(() => setFlashIds([]), 2500)
    return () => window.clearTimeout(timer)
  }, [model])

  const inventoryBars = model
    ? INVENTORY_LABELS.map(([key, label]) => ({
        key,
        label,
        value: model.inventory[key] as number,
        color: INVENTORY_COLORS[key],
        pct: model.inventory.total > 0 ? ((model.inventory[key] as number) / model.inventory.total) * 100 : 0,
      }))
    : []

  return (
    <div
      ref={rootRef}
      className="min-h-screen text-slate-200 bg-[#070b14] relative"
      style={{
        backgroundImage:
          'radial-gradient(1100px 520px at 12% -8%, rgba(34,211,238,.10), transparent 62%),' +
          'radial-gradient(900px 480px at 88% -4%, rgba(139,92,246,.10), transparent 58%),' +
          'linear-gradient(rgba(148,163,184,.045) 1px, transparent 1px),' +
          'linear-gradient(90deg, rgba(148,163,184,.045) 1px, transparent 1px)',
        backgroundSize: 'auto, auto, 44px 44px, 44px 44px',
      }}
    >
      <div className="relative max-w-[1840px] mx-auto px-4 sm:px-5 py-3">
        {/* ---------------- 顶栏 ---------------- */}
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center shadow-[0_0_18px_rgba(34,211,238,.45)]">
              <span className="text-[#06121f] font-bold text-[13px] tracking-tight">DS</span>
            </div>
            <div className="leading-tight">
              <h1 className="text-[15px] font-semibold text-white tracking-wide flex items-center gap-2">
                运营数据驾驶舱
                <LiveDot />
              </h1>
              <p className="text-[10px] text-slate-500 tracking-[.16em]">AMAZON · TIKTOK SHOP 全域实时监控</p>
            </div>
          </div>

          <div className="order-last sm:order-none w-full sm:w-auto sm:ml-6 flex items-center gap-5">
            <div className="leading-none">
              <p className="text-[22px] font-semibold text-white num tracking-tight">
                {dayjs(clock).format('HH:mm:ss')}
              </p>
              <p className="mt-1 text-[10.5px] text-slate-500">
                {dayjs(clock).format('YYYY-MM-DD')} {WEEKDAY[clock.getDay()]}
              </p>
            </div>
            <div className="hidden md:block h-9 w-px bg-white/10" />
            <div className="hidden md:block leading-none">
              {/* 顶栏放 30 天口径，与下面 KPI 的「今日」错开，避免同一数字显示两遍 */}
              <p className="text-[10.5px] text-slate-500">近 30 天 GMV</p>
              <p className="mt-1.5 text-[15px] font-semibold text-cyan-300 num">
                {model ? compactMoney(model.gmv30, 'USD') : '—'}
              </p>
              <p className="mt-1 text-[10px] text-slate-500">
                {model
                  ? `净利率 ${
                      model.gmv30 > 0
                        ? ((model.trend.reduce((s, p) => s + p.profit, 0) / model.gmv30) * 100).toFixed(1)
                        : '0.0'
                    }%`
                  : '加载中'}
              </p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="hidden lg:flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 h-8">
              <StoreIcon className="w-3.5 h-3.5 text-slate-500" />
              <select
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                className="bg-transparent text-[11.5px] text-slate-300 outline-none max-w-[130px] cursor-pointer"
              >
                <option value="" className="bg-[#0b1120]">
                  全部店铺
                </option>
                {(raw?.stores ?? []).map((s) => (
                  <option key={s.id} value={s.id} className="bg-[#0b1120]">
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center rounded-lg border border-white/[0.08] bg-white/[0.03] p-0.5 h-8">
              {INTERVALS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setIntervalMs(opt.value)}
                  className={cn(
                    'h-7 px-2 rounded-md text-[10.5px] transition-colors',
                    intervalMs === opt.value
                      ? 'bg-cyan-400/15 text-cyan-300 font-medium'
                      : 'text-slate-500 hover:text-slate-300',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="hidden sm:flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-white/[0.08] bg-white/[0.03]">
              <Radio className={cn('w-3 h-3', intervalMs ? 'text-emerald-400 live-dot' : 'text-slate-500')} />
              <span className="text-[10.5px] text-slate-400 num">
                {intervalMs ? (refreshing ? '刷新中' : `${remaining}s 后刷新`) : '已暂停'}
              </span>
            </div>

            <button
              onClick={() => void load()}
              className="w-8 h-8 rounded-lg border border-white/[0.08] bg-white/[0.03] flex items-center justify-center text-slate-400 hover:text-cyan-300 hover:border-cyan-400/30 transition-colors"
              title="立即刷新"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
            </button>
            <button
              onClick={toggleFullscreen}
              className="w-8 h-8 rounded-lg border border-white/[0.08] bg-white/[0.03] flex items-center justify-center text-slate-400 hover:text-cyan-300 hover:border-cyan-400/30 transition-colors"
              title={isFullscreen ? '退出全屏' : '全屏投屏'}
            >
              {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
            <Link
              to="/"
              className="h-8 px-2.5 rounded-lg border border-white/[0.08] bg-white/[0.03] flex items-center gap-1.5 text-[11.5px] text-slate-400 hover:text-slate-100 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              返回后台
            </Link>
          </div>
        </header>

        {/* ---------------- 异常跑马灯 ---------------- */}
        {model && <Ticker items={model.alerts} />}

        {firstLoad && (
          <div className="mt-4 flex flex-col items-center justify-center gap-3 py-24">
            <div className="w-9 h-9 rounded-full border-2 border-cyan-400/30 border-t-cyan-400 animate-spin" />
            <p className="text-[12px] text-slate-500 tracking-widest">正在接入运营数据…</p>
          </div>
        )}

        {!firstLoad && model && (
          // 高度跟着视口走：1080p 全屏时刚好铺满一屏，更高的屏会等比拉开图表，
          // 矮屏（笔记本）则保住 min-h 后允许页面滚动，不会把内容压扁
          <div className="mt-2.5 flex flex-col gap-2.5 min-h-[calc(100vh-124px)]">
            {loadError === 'empty' && (
              <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3.5 py-2.5 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-[11.5px] text-amber-200/90 leading-relaxed">
                  还没有可用的运营数据。到
                  <Link to="/" className="underline mx-1 text-amber-200">
                    运营概览
                  </Link>
                  点「生成演示数据」可以先看效果，或在订单 / 库存 / 广告等页面录入真实数据。
                </p>
              </div>
            )}
            {loadError && loadError !== 'empty' && (
              <div className="rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-3.5 py-2.5 text-[11.5px] text-rose-200/90">
                {loadError}
              </div>
            )}

            {/* ---------------- KPI ---------------- */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 shrink-0">
              {model.kpis.map((kpi) => (
                <StatTile key={kpi.key} kpi={kpi} />
              ))}
            </div>

            {/* ---------------- 趋势 + 平台 ---------------- */}
            <div className="grid grid-cols-12 gap-2.5 xl:grid-rows-1 xl:h-[220px]">
              <ScreenPanel
                className="col-span-12 xl:col-span-8 h-[250px] xl:h-auto"
                title="销售与利润趋势"
                subtitle="近 30 天 · 按店铺币种折算 USD"
                accent="#22d3ee"
                right={
                  <div className="flex items-center gap-3 text-[10px]">
                    {[
                      { label: '销售额', color: '#22d3ee', dash: false },
                      { label: '净利润', color: '#34d399', dash: false },
                      { label: '订单量', color: '#a78bfa', dash: true },
                    ].map((s) => (
                      <span key={s.label} className="flex items-center gap-1.5 text-slate-500">
                        <span
                          className="w-2 h-[2px] rounded"
                          style={{ background: s.color, opacity: s.dash ? 0.7 : 1 }}
                        />
                        {s.label}
                      </span>
                    ))}
                  </div>
                }
                bodyClassName="pb-1.5"
              >
                <div className="h-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={model.trend} margin={{ top: 6, right: 4, left: -16, bottom: 0 }}>
                      <defs>
                        <linearGradient id="ckSalesFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.34} />
                          <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.01} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={SCREEN.grid} vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: SCREEN.axis }}
                        axisLine={false}
                        tickLine={false}
                        minTickGap={26}
                        tickFormatter={(v: string) => dayjs(v).format('MM/DD')}
                      />
                      <YAxis
                        yAxisId="money"
                        tick={{ fontSize: 10, fill: SCREEN.axis }}
                        axisLine={false}
                        tickLine={false}
                        width={58}
                        tickFormatter={axisMoney}
                      />
                      <YAxis
                        yAxisId="qty"
                        orientation="right"
                        tick={{ fontSize: 10, fill: SCREEN.axis }}
                        axisLine={false}
                        tickLine={false}
                        width={30}
                      />
                      <Tooltip
                        content={<DarkTip formatter={(v: number, name: string) => (name === '订单量' ? `${num(v)} 单` : money(v, 'USD', 0))} />}
                        cursor={{ stroke: 'rgba(148,163,184,.35)', strokeDasharray: '3 3' }}
                      />
                      <Area
                        yAxisId="money"
                        type="monotone"
                        dataKey="sales"
                        name="销售额"
                        stroke="#22d3ee"
                        strokeWidth={2}
                        fill="url(#ckSalesFill)"
                        dot={false}
                        activeDot={{ r: 3, strokeWidth: 0 }}
                      />
                      <Line
                        yAxisId="money"
                        type="monotone"
                        dataKey="profit"
                        name="净利润"
                        stroke="#34d399"
                        strokeWidth={1.6}
                        dot={false}
                        activeDot={{ r: 3, strokeWidth: 0 }}
                      />
                      <Line
                        yAxisId="qty"
                        type="monotone"
                        dataKey="orders"
                        name="订单量"
                        stroke="#a78bfa"
                        strokeWidth={1.2}
                        strokeDasharray="4 3"
                        dot={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </ScreenPanel>

              <ScreenPanel
                className="col-span-12 xl:col-span-4 h-[250px] xl:h-auto"
                title="平台销售结构"
                subtitle="近 30 天"
                accent="#f59e0b"
              >
                <div className="h-full flex flex-col">
                  <div className="flex items-center gap-1">
                    <div className="relative w-[150px] h-[150px] shrink-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={model.platformSplit}
                            dataKey="value"
                            nameKey="name"
                            innerRadius="66%"
                            outerRadius="94%"
                            paddingAngle={2}
                            stroke="none"
                          >
                            {model.platformSplit.map((p) => (
                              <Cell key={p.name} fill={p.color} />
                            ))}
                          </Pie>
                          <Tooltip content={<DarkTip formatter={(v: number) => compactMoney(v, 'USD')} />} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                        <span className="text-[10px] text-slate-500">30 天 GMV</span>
                        <span className="text-[16px] font-semibold text-white num">
                          {compactMoney(model.gmv30, 'USD')}
                        </span>
                      </div>
                    </div>
                    <div className="flex-1 min-w-0 space-y-2.5">
                      {model.platformSplit.length === 0 && (
                        <p className="text-[11px] text-slate-500">暂无成交</p>
                      )}
                      {model.platformSplit.map((p) => (
                        <div key={p.name}>
                          <div className="flex items-center gap-1.5 text-[11px]">
                            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: p.color }} />
                            <span className="text-slate-400 truncate">{p.name}</span>
                            <span className="ml-auto num text-slate-200">
                              {model.gmv30 > 0 ? `${((p.value / model.gmv30) * 100).toFixed(1)}%` : '0%'}
                            </span>
                          </div>
                          <p className="mt-0.5 pl-3.5 text-[10.5px] text-slate-500 num">{compactMoney(p.value, 'USD')}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-auto pt-2 border-t border-white/[0.06] grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-[10px] text-slate-500">在营店铺</p>
                      <p className="text-[13px] font-medium text-slate-100 num">
                        {num(model.storeRows.length)}
                        <span className="text-[10px] text-slate-500 ml-1">家</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500">30 天净利率</p>
                      <p className="text-[13px] font-medium text-emerald-300 num">
                        {model.gmv30 > 0
                          ? `${((model.trend.reduce((s, p) => s + p.profit, 0) / model.gmv30) * 100).toFixed(1)}%`
                          : '—'}
                      </p>
                    </div>
                  </div>
                </div>
              </ScreenPanel>
            </div>

            {/* ---------------- 店铺 / 商品 / 库存 / 竞品 ---------------- */}
            <div className="grid grid-cols-12 gap-2.5 xl:grid-rows-1 xl:h-[184px]">
              <ScreenPanel className="col-span-12 md:col-span-6 xl:col-span-3 h-[216px] xl:h-auto" title="店铺贡献" subtitle="近 30 天 GMV" accent="#60a5fa">
                <div className="h-full flex flex-col justify-between gap-[6px] overflow-y-auto no-scrollbar">
                  {model.storeRows.length === 0 ? (
                    <p className="text-[11px] text-slate-500">暂无店铺数据</p>
                  ) : (
                    model.storeRows.slice(0, 5).map((row) => (
                      <div key={row.id}>
                        <div className="flex items-center gap-1.5 text-[11px]">
                          <span
                            className={cn(
                              'w-4 h-4 rounded flex items-center justify-center text-[8px] font-bold text-white shrink-0',
                              row.platform === 'amazon' ? 'bg-amazon' : 'bg-cyan-500',
                            )}
                          >
                            {row.platform === 'amazon' ? 'a' : 't'}
                          </span>
                          <span className="text-slate-300 truncate max-w-[104px]" title={row.name}>
                            {row.name}
                          </span>
                          <span className="ml-auto num text-slate-100">{compactMoney(row.sales, 'USD')}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <div className="flex-1 h-[5px] rounded-full bg-white/[0.06] overflow-hidden">
                            <div
                              className="h-full rounded-full transition-[width] duration-700"
                              style={{
                                width: `${Math.max(2, row.share)}%`,
                                background: 'linear-gradient(90deg,#3b82f655,#60a5fa)',
                              }}
                            />
                          </div>
                          <span className="w-10 text-right text-[9.5px] text-slate-500 num">{row.share.toFixed(1)}%</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScreenPanel>

              <ScreenPanel className="col-span-12 md:col-span-6 xl:col-span-3 h-[216px] xl:h-auto" title="热销 SKU" subtitle="近 30 天销售额 Top 5" accent="#a78bfa">
                <div className="h-full flex flex-col justify-between gap-1">
                  {model.productRows.length === 0 ? (
                    <p className="text-[11px] text-slate-500">暂无成交商品</p>
                  ) : (
                    (() => {
                      const rows = model.productRows.slice(0, 5)
                      const max = rows[0]?.value || 1
                      return rows.map((row, i) => (
                        <div key={row.name} className="flex items-center gap-2">
                          <span
                            className={cn(
                              'w-4 text-[9.5px] num text-center rounded',
                              i < 3 ? 'text-cyan-300 bg-cyan-400/10' : 'text-slate-500',
                            )}
                          >
                            {i + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] text-slate-300 truncate" title={row.name}>
                                {row.name}
                              </span>
                              <span className="ml-auto text-[10.5px] num text-slate-100 shrink-0">
                                {compactMoney(row.value, 'USD')}
                              </span>
                            </div>
                            <div className="mt-0.5 h-[4px] rounded-full bg-white/[0.06] overflow-hidden">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${Math.max(3, (row.value / max) * 100)}%`,
                                  background: 'linear-gradient(90deg,#a78bfa44,#a78bfa)',
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      ))
                    })()
                  )}
                </div>
              </ScreenPanel>

              <ScreenPanel className="col-span-12 md:col-span-6 xl:col-span-3 h-[216px] xl:h-auto" title="库存健康度" subtitle="按可售天数分档" accent="#34d399">
                <div className="h-full flex flex-col">
                  <div className="flex items-center gap-2">
                    <Gauge
                      size={112}
                      value={model.inventory.healthyRate}
                      max={100}
                      color={model.inventory.out > 0 ? '#fb923c' : '#34d399'}
                      label={`${model.inventory.healthyRate.toFixed(0)}%`}
                      sub="健康档占比"
                    />
                    <div className="flex-1 space-y-1">
                      {inventoryBars.map((b) => (
                        <div key={b.key} className="flex items-center gap-1.5 text-[10.5px]">
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: b.color }} />
                          <span className="text-slate-400">{b.label}</span>
                          <span className="ml-auto num text-slate-200">{b.value}</span>
                          <span className="w-8 text-right text-[9.5px] text-slate-600 num">{b.pct.toFixed(0)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-auto pt-1.5 border-t border-white/[0.06] flex items-center justify-between text-[10.5px]">
                    <span className="text-slate-500">
                      整体可售{' '}
                      <span className="num font-medium text-slate-100">
                        {model.inventory.coverDays > 900 ? '>900' : Math.round(model.inventory.coverDays)} 天
                      </span>
                    </span>
                    <span className="text-slate-500">
                      在库 <span className="num font-medium text-slate-100">{num(model.inventory.total)}</span>
                    </span>
                  </div>
                </div>
              </ScreenPanel>

              <ScreenPanel className="col-span-12 md:col-span-6 xl:col-span-3 h-[216px] xl:h-auto" title="竞品价格监控" subtitle="较上次采集变动" accent="#fb7185">
                <div className="h-full flex flex-col justify-between gap-1 overflow-y-auto no-scrollbar">
                  {model.competitorMoves.length === 0 ? (
                    <p className="text-[11px] text-slate-500">还没有在跟踪的竞品，到「竞品分析」添加</p>
                  ) : (
                    model.competitorMoves.slice(0, 5).map((m) => (
                      <div key={m.id} className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'w-1 h-1 rounded-full shrink-0',
                            m.change <= -3 ? 'bg-rose-400' : m.change >= 3 ? 'bg-emerald-400' : 'bg-slate-600',
                          )}
                        />
                        <span className="text-[11px] text-slate-300 truncate flex-1" title={m.title}>
                          {m.title}
                        </span>
                        <span className="text-[10.5px] num text-slate-100 shrink-0">{money(m.price, m.currency)}</span>
                        <span
                          className={cn(
                            'w-11 text-right text-[10px] num shrink-0',
                            m.change <= -0.05 ? 'text-rose-400' : m.change >= 0.05 ? 'text-emerald-400' : 'text-slate-600',
                          )}
                        >
                          {Math.abs(m.change) < 0.05 ? '持平' : `${m.change > 0 ? '+' : ''}${m.change.toFixed(1)}%`}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </ScreenPanel>
            </div>

            {/* ---------------- 广告 / 达人 / 采购 ---------------- */}
            <div className="grid grid-cols-12 gap-2.5 xl:grid-rows-1 xl:h-[180px]">
              <ScreenPanel className="col-span-12 md:col-span-6 xl:col-span-4 h-[196px] xl:h-auto" title="广告转化漏斗" subtitle="近 30 天投放合计" accent="#fbbf24">
                <div className="h-full flex items-center gap-3">
                  <div className="flex-1 space-y-2">
                    <FunnelRow
                      step="曝光"
                      value={num(model.ads.impressions)}
                      width={100}
                      color="#fbbf24"
                    />
                    <FunnelRow
                      step="点击"
                      value={num(model.ads.clicks)}
                      width={model.ads.impressions > 0 ? Math.max(3, (model.ads.clicks / model.ads.impressions) * 100 * 12) : 3}
                      color="#f59e0b"
                      rate={`CTR ${model.ads.ctr.toFixed(2)}%`}
                    />
                    <FunnelRow
                      step="下单"
                      value={num(model.ads.orders)}
                      width={model.ads.impressions > 0 ? Math.max(2, (model.ads.orders / model.ads.impressions) * 100 * 12) : 2}
                      color="#34d399"
                      rate={`CVR ${model.ads.cvr.toFixed(2)}%`}
                    />
                    <div className="flex items-center justify-between pt-1 border-t border-white/[0.06] text-[10.5px]">
                      <span className="text-slate-500">
                        花费 <span className="num text-slate-300">{compactMoney(model.ads.spend, 'USD')}</span>
                      </span>
                      <span className="text-slate-500">
                        ROAS <span className="num text-cyan-300">{model.ads.roas.toFixed(2)}</span>
                      </span>
                      <span className="text-slate-500">
                        在投 <span className="num text-slate-300">{model.ads.activeCampaigns}</span>
                      </span>
                    </div>
                  </div>
                  <Gauge
                    size={104}
                    value={model.ads.acos}
                    max={Math.max(model.ads.targetAcos * 2, model.ads.acos * 1.15, 10)}
                    color={model.ads.acos > model.ads.targetAcos && model.ads.targetAcos > 0 ? TONE_COLOR.rose : TONE_COLOR.green}
                    label={`${model.ads.acos.toFixed(1)}%`}
                    sub={`目标 ${model.ads.targetAcos.toFixed(0)}%`}
                  />
                </div>
              </ScreenPanel>

              <ScreenPanel className="col-span-12 md:col-span-6 xl:col-span-4 h-[196px] xl:h-auto" title="达人合作漏斗" subtitle="TikTok 建联进度" accent="#a78bfa">
                <div className="h-full flex flex-col">
                  <div className="space-y-2">
                    <FunnelRow step="待联系" value={num(model.creators.pending)} width={100} color="#a78bfa" />
                    <FunnelRow
                      step="已联系"
                      value={num(model.creators.contacted)}
                      width={model.creators.total > 0 ? Math.max(3, (model.creators.contacted / Math.max(1, model.creators.total)) * 100) : 3}
                      color="#818cf8"
                    />
                    <FunnelRow
                      step="已寄样"
                      value={num(model.creators.sampling)}
                      width={model.creators.total > 0 ? Math.max(3, (model.creators.sampling / Math.max(1, model.creators.total)) * 100) : 3}
                      color="#60a5fa"
                    />
                    <FunnelRow
                      step="合作中"
                      value={num(model.creators.cooperating)}
                      width={model.creators.total > 0 ? Math.max(3, (model.creators.cooperating / Math.max(1, model.creators.total)) * 100) : 3}
                      color="#22d3ee"
                    />
                  </div>
                  <div className="mt-auto pt-1.5 border-t border-white/[0.06] flex items-center justify-between text-[10.5px]">
                    <span className="text-slate-500">
                      达人 GMV <span className="num text-cyan-300">{compactMoney(model.creators.gmv, 'USD')}</span>
                    </span>
                    <span className="text-slate-500 truncate">
                      {model.creators.top[0] ? `Top1 ${model.creators.top[0].name}` : `共 ${model.creators.total} 位达人`}
                    </span>
                  </div>
                </div>
              </ScreenPanel>

              <ScreenPanel className="col-span-12 md:col-span-6 xl:col-span-4 h-[196px] xl:h-auto" title="采购与供应" subtitle="在途与近 30 天采购" accent="#60a5fa">
                <div className="h-full flex flex-col">
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: '在途采购单', value: num(model.purchase.inTransitCount), unit: '张', color: 'text-cyan-300' },
                      { label: '在途金额', value: compactMoney(model.purchase.inTransitAmount, 'USD'), unit: '', color: 'text-slate-100' },
                      { label: '逾期未到', value: num(model.purchase.overdueCount), unit: '张', color: model.purchase.overdueCount > 0 ? 'text-rose-400' : 'text-emerald-400' },
                    ].map((s) => (
                      <div key={s.label} className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2 py-1.5">
                        <p className="text-[9.5px] text-slate-500 truncate">{s.label}</p>
                        <p className={cn('mt-0.5 text-[14px] font-semibold num truncate', s.color)}>
                          {s.value}
                          {s.unit && <span className="text-[9.5px] text-slate-500 ml-0.5">{s.unit}</span>}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-center justify-between text-[10.5px]">
                      <span className="text-slate-500">30 天采购额</span>
                      <span className="num text-slate-200">{compactMoney(model.purchase.spend30, 'USD')}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10.5px]">
                      <span className="text-slate-500">已入库单数</span>
                      <span className="num text-slate-200">{num(model.purchase.received30Count)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10.5px]">
                      <span className="text-slate-500">合作供应商</span>
                      <span className="num text-slate-200">{num(model.purchase.suppliers)}</span>
                    </div>
                  </div>

                  <div className="mt-auto pt-1.5 border-t border-white/[0.06] text-[10px] text-slate-500">
                    采购额 / 30 天 GMV ={' '}
                    <span className="num text-slate-300">
                      {model.gmv30 > 0 ? `${((model.purchase.spend30 / model.gmv30) * 100).toFixed(1)}%` : '—'}
                    </span>
                  </div>
                </div>
              </ScreenPanel>
            </div>

            {/* ---------------- 实时订单流 + 异常 ---------------- */}
            <div className="grid grid-cols-12 gap-2.5 xl:grid-rows-1 xl:h-[190px]">
              <ScreenPanel
                className="col-span-12 xl:col-span-8 h-[220px] xl:h-auto"
                title="实时订单流"
                subtitle="按写入时间倒序，新订单会高亮"
                accent="#22d3ee"
                right={<LiveDot label="STREAM" />}
                bodyClassName="px-0 py-0"
              >
                <div className="h-full overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="text-[10px] text-slate-500">
                        <th className="text-left font-normal px-3.5 py-1.5">时间</th>
                        <th className="text-left font-normal px-2 py-1.5">店铺</th>
                        <th className="text-left font-normal px-2 py-1.5">SKU</th>
                        <th className="text-right font-normal px-2 py-1.5">数量</th>
                        <th className="text-right font-normal px-2 py-1.5">金额</th>
                        <th className="text-right font-normal px-3.5 py-1.5">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.liveOrders.slice(0, 6).map((o) => (
                        <tr
                          key={o.id}
                          className={cn(
                            'border-t border-white/[0.04] text-[11px]',
                            flashIds.includes(o.id) && 'row-flash',
                          )}
                        >
                          <td className="px-3.5 py-[5px] text-slate-500 num whitespace-nowrap">{agoText(o.at)}</td>
                          <td className="px-2 py-[5px] text-slate-300 truncate max-w-[150px]">{o.storeName}</td>
                          <td className="px-2 py-[5px] text-slate-400 truncate max-w-[190px] font-mono text-[10.5px]">{o.sku}</td>
                          <td className="px-2 py-[5px] text-right num text-slate-400">{o.qty}</td>
                          <td className="px-2 py-[5px] text-right num text-slate-100">{money(o.amount, 'USD', 0)}</td>
                          <td className="px-3.5 py-[5px] text-right">
                            <span
                              className={cn(
                                'inline-block rounded px-1.5 py-[1px] text-[9.5px]',
                                o.status === 'cancelled'
                                  ? 'bg-white/[0.06] text-slate-500'
                                  : o.status === 'refunded'
                                    ? 'bg-rose-400/10 text-rose-300'
                                    : o.status === 'pending'
                                      ? 'bg-amber-400/10 text-amber-300'
                                      : 'bg-emerald-400/10 text-emerald-300',
                              )}
                            >
                              {o.status === 'pending' ? '待处理' : o.status === 'shipped' ? '已发货' : o.status === 'delivered' ? '已签收' : o.status === 'refunded' ? '已退款' : '已取消'}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {model.liveOrders.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-3.5 py-10 text-center text-[11px] text-slate-500">
                            还没有订单数据
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </ScreenPanel>

              <ScreenPanel
                className="col-span-12 xl:col-span-4 h-[220px] xl:h-auto"
                title="异常与待办"
                subtitle={model.alerts.length ? `${model.alerts.length} 项需要关注` : '全部正常'}
                accent="#fb7185"
                bodyClassName="py-2"
              >
                <div className="h-full overflow-y-auto no-scrollbar space-y-1.5">
                  {model.alerts.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center gap-1.5 text-slate-500">
                      <span className="w-8 h-8 rounded-full bg-emerald-400/10 flex items-center justify-center text-emerald-400 text-[13px]">✓</span>
                      <p className="text-[11px]">没有异常，继续保持</p>
                    </div>
                  ) : (
                    model.alerts.map((a, i) => (
                      <div key={i} className="flex items-start gap-2 rounded-lg bg-white/[0.03] border border-white/[0.05] px-2 py-1.5">
                        <span
                          className={cn(
                            'mt-1 w-1.5 h-1.5 rounded-full shrink-0',
                            a.level === 'red' ? 'bg-rose-400' : a.level === 'amber' ? 'bg-amber-400' : 'bg-blue-400',
                          )}
                        />
                        <div className="min-w-0">
                          <p className="text-[10px] font-medium text-slate-300">{a.tag}</p>
                          <p className="text-[10.5px] text-slate-500 leading-snug">{a.text}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScreenPanel>
            </div>

            {/* ---------------- 页脚 ---------------- */}
            <footer className="mt-auto shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 pb-2 text-[10px] text-slate-600">
              <span className="flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-emerald-400" />
                {isSuperAdmin && '数据源 Supabase · '}每 {intervalMs ? `${intervalMs / 1000}` : '—'} 秒自动刷新
              </span>
              <span>最后更新 {lastUpdated ? dayjs(lastUpdated).format('HH:mm:ss') : '—'}</span>
              <span className="hidden sm:inline">金额统一折算 USD，汇率可在系统设置调整</span>
              <span className="ml-auto flex items-center gap-1.5">
                <Spark data={model.kpis[0]?.spark ?? []} color={TONE_COLOR.cyan} width={54} height={14} />
                今日 GMV 走势
              </span>
            </footer>
          </div>
        )}
      </div>
    </div>
  )
}
