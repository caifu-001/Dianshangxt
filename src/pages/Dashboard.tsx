import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CircleDollarSign,
  Megaphone,
  MonitorPlay,
  Package,
  RefreshCw,
  ShoppingCart,
  Sparkles,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import dayjs from 'dayjs'
import { fetchRows } from '../lib/db'
import type { Campaign, InventoryItem, Order, Store, Task } from '../lib/types'
import { useAsync } from '../hooks/useAsync'
import { KpiCard } from '../components/KpiCard'
import { DonutChart, RankBars, TrendChart } from '../components/charts'
import { Badge, Button, EmptyState, ErrorBlock, PageHeader, Segmented, useToast } from '../components/ui'
import { PLATFORM_LABEL, TASK_MODULE } from '../lib/constants'
import { compactMoney, daysAgo, money, num, pct, relativeDay, sum } from '../lib/utils'
import { convert, useFx } from '../lib/fx'
import { seedDemoData } from '../lib/seed'

type RangeKey = '7d' | '30d' | '90d' | 'mtd'

const RANGE_OPTIONS = [
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: '90d', label: '近 90 天' },
  { value: 'mtd', label: '本月' },
]

function resolveRange(key: RangeKey) {
  if (key === 'mtd') {
    const from = dayjs().startOf('month')
    const days = dayjs().diff(from, 'day') + 1
    return { from: from.format('YYYY-MM-DD'), to: dayjs().format('YYYY-MM-DD'), prevFrom: from.subtract(days, 'day').format('YYYY-MM-DD'), prevTo: from.subtract(1, 'day').format('YYYY-MM-DD') }
  }
  const days = key === '7d' ? 7 : key === '30d' ? 30 : 90
  return {
    from: daysAgo(days - 1),
    to: dayjs().format('YYYY-MM-DD'),
    prevFrom: daysAgo(days * 2 - 1),
    prevTo: daysAgo(days),
  }
}

export default function Dashboard() {
  const [range, setRange] = useState<RangeKey>('30d')
  const { push } = useToast()
  const [seeding, setSeeding] = useState(false)
  const fx = useFx()
  const rangeValue = useMemo(() => resolveRange(range), [range])

  const { data, loading, error, reload } = useAsync(async () => {
    const [stores, orders, campaigns, inventory, tasks] = await Promise.all([
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
      fetchRows<Order>('orders', {
        filters: [
          ['order_date', 'gte', rangeValue.prevFrom],
          ['order_date', 'lte', rangeValue.to],
        ],
        order: { column: 'order_date' },
      }),
      fetchRows<Campaign>('campaigns'),
      fetchRows<InventoryItem>('inventory'),
      fetchRows<Task>('tasks', { order: { column: 'due_date', ascending: true } }),
    ])
    return { stores, orders, campaigns, inventory, tasks }
  }, [rangeValue.from, rangeValue.to])

  const metrics = useMemo(() => {
    if (!data) return null
    const { stores, orders, campaigns, inventory, tasks } = data
    const current = orders.filter((o) => o.order_date >= rangeValue.from)
    const previous = orders.filter((o) => o.order_date < rangeValue.from)

    const valid = (rows: Order[]) => rows.filter((o) => o.status !== 'cancelled')
    const cur = valid(current)
    const prev = valid(previous)

    // 多币种统一折算为 USD 再汇总
    const storeCurrency = new Map(stores.map((s) => [s.id, s.currency]))
    const usd = (value: number | string, storeId: string) =>
      convert(Number(value ?? 0), storeCurrency.get(storeId) ?? 'USD', 'USD', fx)

    const sales = sum(cur, (o) => usd(o.gross_amount, o.store_id))
    const prevSales = sum(prev, (o) => usd(o.gross_amount, o.store_id))
    const profit = sum(cur, (o) => usd(o.profit, o.store_id))
    const prevProfit = sum(prev, (o) => usd(o.profit, o.store_id))
    const adSpend = sum(cur, (o) => usd(o.ad_cost, o.store_id))
    const campaignSpend = sum(campaigns, (c) => convert(Number(c.spend), storeCurrency.get(c.store_id) ?? 'USD', 'USD', fx))
    const campaignSales = sum(campaigns, (c) => convert(Number(c.sales), storeCurrency.get(c.store_id) ?? 'USD', 'USD', fx))
    const ordersCount = cur.length
    const prevOrders = prev.length
    const aov = ordersCount ? sales / ordersCount : 0
    const margin = sales ? (profit / sales) * 100 : 0
    const roas = campaignSpend ? campaignSales / campaignSpend : 0
    const acos = campaignSales ? (campaignSpend / campaignSales) * 100 : 0

    const delta = (a: number, b: number) => (b ? ((a - b) / b) * 100 : null)

    // 趋势
    const byDate = new Map<string, { sales: number; profit: number; orders: number }>()
    let cursor = dayjs(rangeValue.from)
    const end = dayjs(rangeValue.to)
    while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
      byDate.set(cursor.format('YYYY-MM-DD'), { sales: 0, profit: 0, orders: 0 })
      cursor = cursor.add(1, 'day')
    }
    for (const o of cur) {
      const row = byDate.get(o.order_date)
      if (row) {
        row.sales += usd(o.gross_amount, o.store_id)
        row.profit += usd(o.profit, o.store_id)
        row.orders += 1
      }
    }
    const trend = Array.from(byDate.entries()).map(([date, v]) => ({ date, ...v }))

    // 平台
    const amazonSales = sum(cur.filter((o) => o.channel === 'amazon'), (o) => usd(o.gross_amount, o.store_id))
    const tiktokSales = sum(cur.filter((o) => o.channel === 'tiktok'), (o) => usd(o.gross_amount, o.store_id))

    // Top 商品
    const byProduct = new Map<string, { name: string; value: number; qty: number }>()
    for (const o of cur) {
      const key = o.sku || o.title || '未知'
      const item = byProduct.get(key) ?? { name: key, value: 0, qty: 0 }
      item.value += usd(o.gross_amount, o.store_id)
      item.qty += o.quantity
      byProduct.set(key, item)
    }
    const topProducts = Array.from(byProduct.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)

    // 库存预警
    const alerts = inventory
      .map((item) => {
        const daily = Number(item.avg_daily_sales)
        const days = daily > 0 ? item.available_qty / daily : 999
        let level: 'out' | 'urgent' | 'low' | 'over' | 'ok' = 'ok'
        if (item.available_qty <= 0) level = 'out'
        else if (days < 14) level = 'urgent'
        else if (days < 30) level = 'low'
        else if (days > 150 && item.available_qty > item.safety_stock * 4) level = 'over'
        return { ...item, days, level }
      })
      .filter((i) => i.level !== 'ok')
      .sort((a, b) => a.days - b.days)
      .slice(0, 6)

    // 店铺表现
    const storeRows = stores.map((s) => {
      const rows = cur.filter((o) => o.store_id === s.id)
      const storeSales = sum(rows, (o) => o.gross_amount)
      const storeProfit = sum(rows, (o) => o.profit)
      return {
        store: s,
        sales: storeSales,
        profit: storeProfit,
        orders: rows.length,
        margin: storeSales ? (storeProfit / storeSales) * 100 : 0,
        spend: sum(rows, (o) => o.ad_cost),
      }
    }).sort((a, b) => b.sales - a.sales)

    const openTasks = tasks.filter((t) => t.status !== 'done').slice(0, 5)

    return {
      stores, cur, prev,
      sales, profit, ordersCount, adSpend, aov, margin, roas, acos, campaignSpend, campaignSales,
      dSales: delta(sales, prevSales),
      dProfit: delta(profit, prevProfit),
      dOrders: delta(ordersCount, prevOrders),
      trend, amazonSales, tiktokSales, topProducts, alerts, storeRows, openTasks,
      creators: 0,
    }
  }, [data, rangeValue.from, rangeValue.to, fx])

  async function handleSeed() {
    setSeeding(true)
    try {
      await seedDemoData()
      push('演示数据已生成')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '生成失败', 'error')
    } finally {
      setSeeding(false)
    }
  }

  if (error) return <ErrorBlock message={error} onRetry={reload} />

  if (!loading && data && data.stores.length === 0) {
    return (
      <div className="max-w-3xl mx-auto">
        <PageHeader title="运营概览" description="还没有店铺数据，先建立第一家店铺" />
        <div className="card overflow-hidden">
          <div className="bg-gradient-to-br from-brand-600 to-brand-800 px-7 py-8 text-white relative overflow-hidden">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_-20%,rgba(255,255,255,.25),transparent_50%)]" />
            <div className="relative">
              <Badge tone="gray" className="!bg-white/15 !text-white !border-white/20 mb-3">
                开始使用
              </Badge>
              <h2 className="text-[22px] font-semibold tracking-tight">先把数据灌进来，报表自然就有了</h2>
              <p className="mt-1.5 text-[13px] text-white/70 max-w-lg leading-relaxed">
                你可以直接添加真实店铺与商品，也可以一键生成一套演示数据，先体验完整的运营流程。
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Link to="/stores" className="btn btn-md bg-white text-brand-700 hover:bg-white/90">
                  创建店铺
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
                <Button variant="ghost" className="!text-white hover:!bg-white/15" loading={seeding} onClick={handleSeed} icon={<Sparkles className="w-3.5 h-3.5" />}>
                  生成演示数据
                </Button>
              </div>
            </div>
          </div>
          <div className="grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-ink-100">
            {[
              { icon: Wallet, title: '逐单利润', desc: '佣金 / FBA / 广告 / 退款自动拆解' },
              { icon: Package, title: '库存健康度', desc: '可售天数与补货建议' },
              { icon: Megaphone, title: '广告效率', desc: 'ACOS、ROAS、转化漏斗' },
            ].map((f) => (
              <div key={f.title} className="p-5">
                <f.icon className="w-4 h-4 text-brand-600 mb-2" />
                <p className="text-[13px] font-medium text-ink-900">{f.title}</p>
                <p className="mt-0.5 text-[11.5px] text-ink-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <PageHeader
        title="运营概览"
        description={`${rangeValue.from} 至 ${rangeValue.to} · 全部店铺汇总`}
        actions={
          <>
            <Link to="/cockpit">
              <Button size="md" icon={<MonitorPlay className="w-3.5 h-3.5" />} title="投屏用的实时大屏">
                数据驾驶舱
              </Button>
            </Link>
            <Segmented value={range} onChange={(v) => setRange(v as RangeKey)} options={RANGE_OPTIONS} />
            <Button size="md" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={reload}>
              刷新
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="销售额（GMV）"
          value={metrics ? compactMoney(metrics.sales) : '—'}
          delta={metrics?.dSales}
          deltaLabel="较上一周期"
          icon={<CircleDollarSign className="w-4 h-4" />}
          tone="brand"
        />
        <KpiCard
          label="订单量"
          value={metrics ? num(metrics.ordersCount) : '—'}
          delta={metrics?.dOrders}
          deltaLabel="较上一周期"
          icon={<ShoppingCart className="w-4 h-4" />}
          tone="violet"
        />
        <KpiCard
          label="净利润"
          value={metrics ? compactMoney(metrics.profit) : '—'}
          delta={metrics?.dProfit}
          deltaLabel="较上一周期"
          icon={<TrendingUp className="w-4 h-4" />}
          tone="green"
        />
        <KpiCard
          label="广告 ACOS"
          value={metrics ? pct(metrics.acos) : '—'}
          sub={metrics ? `ROAS ${metrics.roas.toFixed(2)} · 花费 ${compactMoney(metrics.campaignSpend)}` : ''}
          icon={<Megaphone className="w-4 h-4" />}
          tone="amber"
          invertDelta
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-3 mt-3">
        <div className="card p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-1">
            <div>
              <h3 className="text-[13.5px] font-semibold text-ink-900">销售与利润趋势</h3>
              <p className="text-[11px] text-ink-400 mt-0.5">多店铺按设置汇率折算为 USD 汇总</p>
            </div>
            <div className="flex items-center gap-3 text-[11px]">
              <span className="flex items-center gap-1.5 text-ink-500">
                <span className="w-2 h-2 rounded-sm bg-brand-500" />
                销售额
              </span>
              <span className="flex items-center gap-1.5 text-ink-500">
                <span className="w-2 h-2 rounded-sm bg-emerald-500" />
                净利润
              </span>
            </div>
          </div>
          {loading || !metrics ? (
            <div className="skeleton h-[260px] w-full mt-3" />
          ) : (
            <TrendChart data={metrics.trend} />
          )}
        </div>

        <div className="card p-4">
          <h3 className="text-[13.5px] font-semibold text-ink-900">平台销售占比</h3>
          <p className="text-[11px] text-ink-400 mt-0.5">Amazon vs TikTok Shop</p>
          {loading || !metrics ? (
            <div className="skeleton h-[180px] w-full mt-3 rounded-full" />
          ) : (
            <>
              <DonutChart
                data={[
                  { name: 'Amazon', value: metrics.amazonSales, color: '#f59e0b' },
                  { name: 'TikTok Shop', value: metrics.tiktokSales, color: '#161823' },
                ]}
                centerLabel="总销售额"
                centerValue={compactMoney(metrics.sales)}
              />
              <div className="mt-2 space-y-2">
                {[
                  { name: 'Amazon', value: metrics.amazonSales, color: '#f59e0b' },
                  { name: 'TikTok Shop', value: metrics.tiktokSales, color: '#161823' },
                ].map((p) => (
                  <div key={p.name} className="flex items-center gap-2 text-[12px]">
                    <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
                    <span className="text-ink-600">{p.name}</span>
                    <span className="ml-auto num font-medium text-ink-900">{compactMoney(p.value)}</span>
                    <span className="w-11 text-right text-[11px] text-ink-400">
                      {metrics.sales ? pct((p.value / metrics.sales) * 100, 0) : '0%'}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-3 mt-3">
        <div className="card p-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[13.5px] font-semibold text-ink-900">热销商品 Top 5</h3>
            <Link to="/products" className="text-[11.5px] link">
              全部商品
            </Link>
          </div>
          {loading || !metrics ? (
            <div className="skeleton h-[240px] w-full mt-3" />
          ) : metrics.topProducts.length === 0 ? (
            <EmptyState title="该周期内还没有成交" description="录入订单或导入平台报表后即可看到商品排行" />
          ) : (
            <RankBars data={metrics.topProducts.map((p) => ({ name: p.name, value: p.value }))} />
          )}
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[13.5px] font-semibold text-ink-900">库存预警</h3>
            <Link to="/inventory" className="text-[11.5px] link">
              库存管理
            </Link>
          </div>
          <div className="mt-2 space-y-2">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-11 w-full" />)
            ) : metrics && metrics.alerts.length > 0 ? (
              metrics.alerts.map((a) => (
                <div key={a.id} className="flex items-center gap-2 py-1.5 border-b border-ink-50 last:border-0">
                  <span
                    className={
                      'w-1.5 h-1.5 rounded-full shrink-0 ' +
                      (a.level === 'out' ? 'bg-rose-500' : a.level === 'urgent' ? 'bg-orange-500' : a.level === 'low' ? 'bg-amber-400' : 'bg-slate-400')
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium text-ink-800 truncate">{a.sku}</p>
                    <p className="text-[10.5px] text-ink-400 truncate">{a.warehouse}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={'num text-[12px] font-medium ' + (a.level === 'out' || a.level === 'urgent' ? 'text-rose-600' : 'text-ink-700')}>
                      {a.available_qty}
                    </p>
                    <p className="text-[10px] text-ink-400">
                      {a.level === 'out' ? '已断货' : Number(a.avg_daily_sales) <= 0 ? '无销量' : a.days > 300 ? '库存过剩' : `可售 ${Math.floor(a.days)} 天`}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <div className="flex items-center gap-2 py-6 justify-center text-[12px] text-ink-400">
                <Package className="w-4 h-4" />
                库存健康，暂无预警
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-3 mt-3">
        <div className="card lg:col-span-2 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-ink-100">
            <h3 className="text-[13.5px] font-semibold text-ink-900">店铺表现</h3>
            <Link to="/stores" className="text-[11.5px] link">
              店铺管理
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">店铺</th>
                  <th className="th text-right">销售额</th>
                  <th className="th text-right">订单</th>
                  <th className="th text-right">净利润</th>
                  <th className="th text-right">净利率</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 3 }).map((_, i) => (
                      <tr key={i}>
                        <td className="td" colSpan={5}>
                          <div className="skeleton h-4 w-full" />
                        </td>
                      </tr>
                    ))
                  : metrics?.storeRows.map((row) => (
                      <tr key={row.store.id} className="hover:bg-ink-50/60">
                        <td className="td">
                          <div className="flex items-center gap-2">
                            <span
                              className={
                                'w-6 h-6 rounded-md flex items-center justify-center text-[9px] font-bold text-white ' +
                                (row.store.platform === 'amazon' ? 'bg-amazon' : 'bg-tiktok')
                              }
                            >
                              {row.store.platform === 'amazon' ? 'a' : 't'}
                            </span>
                            <div className="min-w-0">
                              <p className="text-[12.5px] font-medium text-ink-800 truncate max-w-[160px]">{row.store.name}</p>
                              <p className="text-[10.5px] text-ink-400">
                                {PLATFORM_LABEL[row.store.platform]} · {row.store.marketplace}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="td text-right num">{money(row.sales, row.store.currency, 0)}</td>
                        <td className="td text-right num text-ink-500">{num(row.orders)}</td>
                        <td className={'td text-right num font-medium ' + (row.profit >= 0 ? 'text-emerald-700' : 'text-rose-600')}>
                          {money(row.profit, row.store.currency, 0)}
                        </td>
                        <td className="td text-right">
                          <Badge tone={row.margin >= 20 ? 'green' : row.margin >= 8 ? 'amber' : 'red'}>{pct(row.margin)}</Badge>
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[13.5px] font-semibold text-ink-900">待办事项</h3>
            <Link to="/tasks" className="text-[11.5px] link">
              任务看板
            </Link>
          </div>
          <div className="mt-2.5 space-y-1">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-10 w-full" />)
            ) : metrics && metrics.openTasks.length > 0 ? (
              metrics.openTasks.map((t) => (
                <div key={t.id} className="flex items-start gap-2 py-2 border-b border-ink-50 last:border-0">
                  <CalendarClock className="w-3.5 h-3.5 text-ink-300 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] text-ink-800 leading-snug line-clamp-2">{t.title}</p>
                    <p className="mt-0.5 text-[10.5px] text-ink-400">
                      {TASK_MODULE[t.module]}
                      {t.due_date && (
                        <span className={t.due_date < dayjs().format('YYYY-MM-DD') ? ' text-rose-500 ml-1.5' : ' ml-1.5'}>
                          {relativeDay(t.due_date)}
                        </span>
                      )}
                    </p>
                  </div>
                  <Badge tone={t.priority === 'high' ? 'red' : t.priority === 'medium' ? 'amber' : 'gray'}>
                    {t.priority === 'high' ? '高' : t.priority === 'medium' ? '中' : '低'}
                  </Badge>
                </div>
              ))
            ) : (
              <div className="flex items-center gap-2 py-6 justify-center text-[12px] text-ink-400">
                <Sparkles className="w-4 h-4" />
                没有待办，今天很轻松
              </div>
            )}
          </div>
        </div>
      </div>

      {metrics && metrics.sales === 0 && (
        <div className="card mt-3 p-4 flex items-center gap-3 border-amber-200 bg-amber-50/50">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          <p className="text-[12px] text-ink-600">
            当前周期内没有订单数据。可以切换时间范围，或到
            <Link to="/orders" className="link mx-1">
              订单管理
            </Link>
            录入 / 导入订单。
          </p>
        </div>
      )}
    </>
  )
}
