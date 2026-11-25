import { useMemo, useState } from 'react'
import { Coins, Download, Percent, Plus, Receipt, Trash2, TrendingDown, Wallet } from 'lucide-react'
import dayjs from 'dayjs'
import { deleteRow, fetchRows, insertRow } from '../lib/db'
import { EXPENSE_CATEGORY } from '../lib/constants'
import type { Expense, Order, Store } from '../lib/types'
import { useAsync } from '../hooks/useAsync'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBlock,
  Field,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
  useToast,
} from '../components/ui'
import { DonutChart } from '../components/charts'
import { cn, daysAgo, downloadTextFile, money, monthStart, pct, sum, toCsv, today } from '../lib/utils'
import { convert, useFx } from '../lib/fx'

const PRESETS = [
  { key: 'mtd', label: '本月', from: () => monthStart(), to: () => today() },
  { key: 'last', label: '上月', from: () => dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD'), to: () => dayjs().subtract(1, 'month').endOf('month').format('YYYY-MM-DD') },
  { key: '30d', label: '近 30 天', from: () => daysAgo(29), to: () => today() },
  { key: '90d', label: '近 90 天', from: () => daysAgo(89), to: () => today() },
]

export default function Profit() {
  const { push } = useToast()
  const [preset, setPreset] = useState('mtd')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [storeFilter, setStoreFilter] = useState('')
  const fx = useFx()
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Expense | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [expenseForm, setExpenseForm] = useState({
    category: 'shipping',
    amount: '',
    currency: 'CNY',
    expense_date: today(),
    remark: '',
    store_id: '',
  })

  const { data, loading, error, reload } = useAsync(async () => {
    const [orders, expenses, stores] = await Promise.all([
      fetchRows<Order>('orders', {
        filters: [
          ['order_date', 'gte', from],
          ['order_date', 'lte', to],
        ],
      }),
      fetchRows<Expense>('expenses', {
        filters: [
          ['expense_date', 'gte', from],
          ['expense_date', 'lte', to],
        ],
        order: { column: 'expense_date', ascending: false },
      }),
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
    ])
    return { orders, expenses, stores }
  }, [from, to])

  const scopedOrders = useMemo(
    () => (data?.orders ?? []).filter((o) => (storeFilter ? o.store_id === storeFilter : true) && o.status !== 'cancelled'),
    [data, storeFilter],
  )
  const scopedExpenses = useMemo(
    () => (data?.expenses ?? []).filter((e) => (storeFilter ? e.store_id === storeFilter : true)),
    [data, storeFilter],
  )

  const pnl = useMemo(() => {
    const storeCurrency = new Map((data?.stores ?? []).map((s) => [s.id, s.currency]))
    const base = storeFilter ? (storeCurrency.get(storeFilter) ?? 'USD') : 'USD'
    const cv = (value: number | string, storeId?: string | null) =>
      convert(Number(value ?? 0), (storeId && storeCurrency.get(storeId)) || 'USD', base, fx)

    const sales = sum(scopedOrders, (o) => cv(o.gross_amount, o.store_id))
    const refund = sum(scopedOrders, (o) => cv(o.refund_amount, o.store_id))
    const cogs = sum(scopedOrders, (o) => cv(o.cost_amount, o.store_id))
    const commission = sum(scopedOrders, (o) => cv(o.platform_fee, o.store_id))
    const fba = sum(scopedOrders, (o) => cv(o.fba_fee, o.store_id))
    const shipping = sum(scopedOrders, (o) => cv(o.shipping_fee, o.store_id))
    const ad = sum(scopedOrders, (o) => cv(o.ad_cost, o.store_id))
    const other = sum(scopedOrders, (o) => cv(o.other_fee, o.store_id))
    const ledger = sum(scopedExpenses, (e) => convert(Number(e.amount), e.currency, base, fx))
    const netRevenue = sales - refund
    const grossProfit = netRevenue - cogs
    const netProfit = grossProfit - commission - fba - shipping - ad - other - ledger
    return {
      base,
      sales, refund, cogs, commission, fba, shipping, ad, other, ledger,
      netRevenue, grossProfit, netProfit,
      netMargin: sales ? (netProfit / sales) * 100 : 0,
      grossMargin: sales ? (grossProfit / sales) * 100 : 0,
      count: scopedOrders.length,
    }
  }, [scopedOrders, scopedExpenses, data, storeFilter, fx])

  const currency = pnl.base

  const rows = [
    { label: '商品销售额', value: pnl.sales, kind: 'in' as const },
    { label: '退款', value: -pnl.refund, kind: 'out' as const },
    { label: '净收入', value: pnl.netRevenue, kind: 'sub' as const },
    { label: '商品成本（含头程分摊）', value: -pnl.cogs, kind: 'out' as const },
    { label: '毛利', value: pnl.grossProfit, kind: 'sub' as const },
    { label: '平台佣金', value: -pnl.commission, kind: 'out' as const },
    { label: 'FBA / 履约费', value: -pnl.fba, kind: 'out' as const },
    { label: '头程 / 物流', value: -pnl.shipping, kind: 'out' as const },
    { label: '广告费用', value: -pnl.ad, kind: 'out' as const },
    { label: '订单其他费用', value: -pnl.other, kind: 'out' as const },
    { label: '台账费用（仓储 / 订阅 / 税费等）', value: -pnl.ledger, kind: 'out' as const },
  ]

  const feeBreakdown = [
    { name: '商品成本', value: pnl.cogs, color: '#2551eb' },
    { name: '平台佣金', value: pnl.commission, color: '#6090fa' },
    { name: '履约费', value: pnl.fba, color: '#f59e0b' },
    { name: '广告费', value: pnl.ad, color: '#10b981' },
    { name: '物流 / 台账', value: pnl.shipping + pnl.ledger, color: '#8b5cf6' },
    { name: '退款 / 其他', value: pnl.refund + pnl.other, color: '#f43f5e' },
  ].filter((d) => d.value > 0)

  function applyPreset(key: string) {
    const p = PRESETS.find((x) => x.key === key)
    if (!p) return
    setPreset(key)
    setFrom(p.from())
    setTo(p.to())
  }

  async function handleAddExpense() {
    if (!expenseForm.amount || Number(expenseForm.amount) <= 0) return push('请输入金额', 'error')
    setSaving(true)
    try {
      await insertRow('expenses', {
        store_id: expenseForm.store_id || storeFilter || null,
        category: expenseForm.category,
        amount: Number(expenseForm.amount),
        currency: expenseForm.currency,
        expense_date: expenseForm.expense_date,
        remark: expenseForm.remark.trim() || null,
      })
      push('费用已记录')
      setExpenseOpen(false)
      setExpenseForm({ category: 'shipping', amount: '', currency: 'CNY', expense_date: today(), remark: '', store_id: '' })
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteExpense() {
    if (!deleting) return
    setConfirmLoading(true)
    try {
      await deleteRow('expenses', deleting.id)
      push('已删除')
      setDeleting(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirmLoading(false)
    }
  }

  function handleExport() {
    const exportRows = rows.map((r) => ({ 项目: r.label, 金额: r.value.toFixed(2), 币种: currency }))
    exportRows.push({ 项目: '净利润率', 金额: pct(pnl.netMargin), 币种: currency })
    downloadTextFile(`利润表_${from}_${to}.csv`, toCsv(exportRows), 'text/csv;charset=utf-8')
  }

  return (
    <>
      <PageHeader
        title="利润核算"
        description="从 GMV 到净利润的完整拆解，费用台账一并计入"
        actions={
          <>
            <Button icon={<Download className="w-3.5 h-3.5" />} onClick={handleExport}>
              导出报表
            </Button>
            <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setExpenseOpen(true)}>
              记一笔费用
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-ink-100 border border-ink-200/60">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              className={cn(
                'h-7 px-3 rounded-md text-xs font-medium transition-all',
                preset === p.key ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-700',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-ink-500">
          <input
            type="date"
            className="input !w-[140px] !h-8"
            value={from}
            onChange={(e) => { setFrom(e.target.value); setPreset('') }}
          />
          <span>—</span>
          <input type="date" className="input !w-[140px] !h-8" value={to} onChange={(e) => { setTo(e.target.value); setPreset('') }} />
        </div>
        <Select
          className="w-full sm:w-44 !h-8"
          value={storeFilter}
          onChange={setStoreFilter}
          placeholder="全部店铺（多币种）"
          options={(data?.stores ?? []).map((s) => ({ value: s.id, label: `${s.name}（${s.currency}）` }))}
        />
        <span className="text-[11px] text-ink-400">
          {storeFilter ? `币种 ${currency}` : '多店铺汇总：已按设置汇率折算为 USD'}
        </span>
      </div>

      {error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            {[
              { label: '净收入', value: money(pnl.netRevenue, currency, 0), sub: `${pnl.count} 笔订单`, icon: <Coins className="w-4 h-4" />, tone: 'bg-brand-50 text-brand-600' },
              { label: '毛利', value: money(pnl.grossProfit, currency, 0), sub: `毛利率 ${pct(pnl.grossMargin)}`, icon: <Wallet className="w-4 h-4" />, tone: 'bg-blue-50 text-blue-600' },
              { label: '净利润', value: money(pnl.netProfit, currency, 0), sub: '已扣除全部费用与台账', icon: pnl.netProfit >= 0 ? <TrendingDown className="w-4 h-4 rotate-180" /> : <TrendingDown className="w-4 h-4" />, tone: pnl.netProfit >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600' },
              { label: '净利率', value: pct(pnl.netMargin), sub: pnl.netMargin >= 15 ? '高于健康线' : '低于 15% 需优化', icon: <Percent className="w-4 h-4" />, tone: 'bg-violet-50 text-violet-600' },
            ].map((k) => (
              <div key={k.label} className="card p-4">
                <div className="flex items-start justify-between">
                  <span className="text-[11px] text-ink-500">{k.label}</span>
                  <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center', k.tone)}>{k.icon}</span>
                </div>
                <p className={cn('num text-[20px] font-semibold mt-1.5 leading-tight', k.label === '净利润' ? (pnl.netProfit >= 0 ? 'text-emerald-700' : 'text-rose-600') : 'text-ink-900')}>
                  {k.value}
                </p>
                <p className="text-[10.5px] text-ink-400 mt-1">{k.sub}</p>
              </div>
            ))}
          </div>

          <div className="grid lg:grid-cols-3 gap-3">
            <div className="card lg:col-span-2 overflow-hidden">
              <div className="px-4 py-3 border-b border-ink-100 flex items-center justify-between">
                <h3 className="text-[13.5px] font-semibold text-ink-900">损益明细</h3>
                <Badge tone="gray">
                  {from} ~ {to}
                </Badge>
              </div>
              {loading ? (
                <LoadingBlock rows={8} />
              ) : (
                <table className="w-full">
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className={cn(r.kind === 'sub' ? 'bg-ink-50/70' : 'hover:bg-ink-50/40', 'border-b border-ink-100 last:border-0')}>
                        <td className={cn('px-5 py-2.5 text-[12.5px]', r.kind === 'sub' ? 'font-semibold text-ink-900' : 'text-ink-600')}>
                          {r.label}
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          <span className="text-[11px] text-ink-300 mr-1.5">{r.value < 0 ? '−' : ''}</span>
                          <span className={cn('num text-[13px]', r.kind === 'sub' ? 'font-semibold text-ink-900' : r.value < 0 ? 'text-ink-600' : 'text-emerald-700')}>
                            {money(Math.abs(r.value), currency, 0)}
                          </span>
                        </td>
                        <td className="px-5 py-2.5 text-right w-24">
                          <span className="num text-[11px] text-ink-400">{pnl.sales ? pct((Math.abs(r.value) / pnl.sales) * 100) : '—'}</span>
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-ink-900">
                      <td className="px-5 py-3 text-[13px] font-semibold text-white">净利润</td>
                      <td className="px-5 py-3 text-right">
                        <span className={cn('num text-[15px] font-semibold', pnl.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                          {money(pnl.netProfit, currency, 0)}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right w-24">
                        <span className="num text-[11px] text-white/60">{pct(pnl.netMargin)}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>

            <div className="space-y-3">
              <div className="card p-4">
                <h3 className="text-[13px] font-semibold text-ink-900">费用构成</h3>
                {feeBreakdown.length ? (
                  <>
                    <DonutChart
                      data={feeBreakdown}
                      height={170}
                      centerLabel="总支出"
                      centerValue={money(pnl.cogs + pnl.commission + pnl.fba + pnl.ad + pnl.shipping + pnl.ledger + pnl.refund + pnl.other, currency, 0)}
                    />
                    <div className="mt-2 space-y-1.5">
                      {feeBreakdown.map((f) => (
                        <div key={f.name} className="flex items-center gap-2 text-[11.5px]">
                          <span className="w-2 h-2 rounded-full" style={{ background: f.color }} />
                          <span className="text-ink-600">{f.name}</span>
                          <span className="ml-auto num text-ink-800">{money(f.value, currency, 0)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-[12px] text-ink-400 py-10 text-center">该周期暂无费用数据</p>
                )}
              </div>

              <div className="card p-4">
                <h3 className="text-[13px] font-semibold text-ink-900 mb-2.5">关键比率</h3>
                <div className="space-y-2.5">
                  {[
                    { name: '毛利率', value: pnl.grossMargin, color: 'bg-brand-500' },
                    { name: '净利率', value: pnl.netMargin, color: 'bg-emerald-500' },
                    { name: '广告占比', value: pnl.sales ? (pnl.ad / pnl.sales) * 100 : 0, color: 'bg-amber-500' },
                    { name: '平台费率', value: pnl.sales ? (pnl.commission / pnl.sales) * 100 : 0, color: 'bg-violet-500' },
                  ].map((r) => (
                    <div key={r.name}>
                      <div className="flex items-center justify-between text-[11.5px] mb-1">
                        <span className="text-ink-600">{r.name}</span>
                        <span className="num font-medium text-ink-900">{pct(r.value)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
                        <div className={cn('h-full rounded-full', r.color)} style={{ width: `${Math.min(100, Math.max(0, r.value))}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="card mt-3 overflow-hidden">
            <div className="px-4 py-3 border-b border-ink-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Receipt className="w-4 h-4 text-ink-400" />
                <h3 className="text-[13.5px] font-semibold text-ink-900">费用台账</h3>
                <Badge tone="gray">{scopedExpenses.length} 条</Badge>
              </div>
              <Button size="sm" icon={<Plus className="w-3 h-3" />} onClick={() => setExpenseOpen(true)}>
                记一笔
              </Button>
            </div>
            {loading ? (
              <LoadingBlock rows={4} />
            ) : scopedExpenses.length === 0 ? (
              <EmptyState
                icon={<Receipt className="w-5 h-5" />}
                title="该周期还没有台账费用"
                description="头程海运、仓储、软件订阅、达人佣金、税费等可在此记录，会自动计入净利润。"
              />
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">日期</th>
                    <th className="th">类别</th>
                    <th className="th">店铺</th>
                    <th className="th">说明</th>
                    <th className="th text-right">金额</th>
                    <th className="th w-12" />
                  </tr>
                </thead>
                <tbody>
                  {scopedExpenses.map((e) => (
                    <tr key={e.id} className="hover:bg-ink-50/60 group">
                      <td className="td text-[12px] text-ink-500">{e.expense_date}</td>
                      <td className="td">
                        <Badge tone="blue">{EXPENSE_CATEGORY[e.category] ?? e.category}</Badge>
                      </td>
                      <td className="td text-[12px] text-ink-600">{data?.stores.find((s) => s.id === e.store_id)?.name ?? '全店'}</td>
                      <td className="td text-[12px] text-ink-500 max-w-[280px] truncate">{e.remark ?? '—'}</td>
                      <td className="td text-right num font-medium">{money(e.amount, e.currency, 0)}</td>
                      <td className="td">
                        <button data-perm="delete"
                          className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50 opacity-0 group-hover:opacity-100"
                          onClick={() => setDeleting(e)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <Modal
        open={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        title="记一笔费用"
        description="如头程海运、FBA 仓储、ERP 订阅、达人佣金、税费"
        footer={
          <>
            <Button onClick={() => setExpenseOpen(false)}>取消</Button>
            <Button variant="primary" onClick={handleAddExpense} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="费用类别">
            <Select
              value={expenseForm.category}
              onChange={(v) => setExpenseForm({ ...expenseForm, category: v })}
              options={Object.entries(EXPENSE_CATEGORY).map(([value, label]) => ({ value, label }))}
            />
          </Field>
          <Field label="归属店铺">
            <Select
              value={expenseForm.store_id}
              onChange={(v) => setExpenseForm({ ...expenseForm, store_id: v })}
              placeholder="全店共用"
              options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
          <Field label="金额" required>
            <input className="input num" type="number" step="0.01" value={expenseForm.amount} onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })} />
          </Field>
          <Field label="币种">
            <Select
              value={expenseForm.currency}
              onChange={(v) => setExpenseForm({ ...expenseForm, currency: v })}
              options={['CNY', 'USD', 'GBP', 'EUR', 'JPY'].map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="发生日期">
            <input type="date" className="input" value={expenseForm.expense_date} onChange={(e) => setExpenseForm({ ...expenseForm, expense_date: e.target.value })} />
          </Field>
          <Field label="说明" className="sm:col-span-2">
            <input className="input" value={expenseForm.remark} onChange={(e) => setExpenseForm({ ...expenseForm, remark: e.target.value })} placeholder="如：海运头程 1 个 40HQ" />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDeleteExpense}
        loading={confirmLoading}
        title="删除费用记录"
        message="确定删除这条费用记录吗？删除后会重新计算净利润。"
      />
    </>
  )
}
