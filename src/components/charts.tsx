import {
  Area,
  Bar,
  BarChart,
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
import dayjs from 'dayjs'
import { compactMoney, money, num } from '../lib/utils'

const AXIS = { fontSize: 11, fill: '#98a2b3' }
const GRID = '#eff1f5'

/* eslint-disable @typescript-eslint/no-explicit-any */
function TooltipBox({ active, payload, label, currency }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg bg-white border border-ink-200 shadow-pop px-3 py-2 text-[11px]">
      <p className="font-medium text-ink-700 mb-1">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 py-0.5">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-ink-500">{p.name}</span>
          <span className="ml-auto num font-medium text-ink-800">
            {typeof p.value === 'number' ? money(p.value, currency) : p.value}
          </span>
        </div>
      ))}
    </div>
  )
}

export function TrendChart({
  data,
  currency = 'USD',
  height = 260,
}: {
  data: Array<{ date: string; sales: number; profit: number; orders?: number }>
  currency?: string
  height?: number
}) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b6ef6" stopOpacity={0.22} />
              <stop offset="100%" stopColor="#3b6ef6" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis
            dataKey="date"
            tick={AXIS}
            axisLine={false}
            tickLine={false}
            minTickGap={24}
            tickFormatter={(v: string) => dayjs(v).format('MM/DD')}
          />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v: number) => compactMoney(v, currency)} width={62} />
          <Tooltip content={<TooltipBox currency={currency} />} cursor={{ stroke: '#cbd2dd', strokeDasharray: '3 3' }} />
          <Area type="monotone" dataKey="sales" name="销售额" stroke="#3b6ef6" strokeWidth={2} fill="url(#gSales)" dot={false} activeDot={{ r: 3 }} />
          <Line type="monotone" dataKey="profit" name="净利润" stroke="#10b981" strokeWidth={1.8} dot={false} activeDot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

export function DonutChart({
  data,
  height = 180,
  centerLabel,
  centerValue,
}: {
  data: Array<{ name: string; value: number; color: string }>
  height?: number
  centerLabel?: string
  centerValue?: string
}) {
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="88%" paddingAngle={2} stroke="none">
            {data.map((d) => (
              <Cell key={d.name} fill={d.color} />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }: any) =>
              active && payload?.length ? (
                <div className="rounded-lg bg-white border border-ink-200 shadow-pop px-3 py-2 text-[11px]">
                  <span className="text-ink-500">{payload[0].name}：</span>
                  <span className="num font-medium">{num(payload[0].value)}</span>
                  <span className="text-ink-400">
                    {' '}
                    ({total ? ((payload[0].value / total) * 100).toFixed(1) : 0}%)
                  </span>
                </div>
              ) : null
            }
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-[11px] text-ink-400">{centerLabel}</span>
        <span className="text-[17px] font-semibold text-ink-900 num">{centerValue}</span>
      </div>
    </div>
  )
}

export function RankBars({
  data,
  currency = 'USD',
  height = 240,
  name = '销售额',
  labelWidth = 110,
}: {
  data: Array<{ name: string; value: number; extra?: string }>
  currency?: string
  height?: number
  name?: string
  labelWidth?: number
}) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v: number) => compactMoney(v, currency)} />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ ...AXIS, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={labelWidth}
            tickFormatter={(v: string) => (v.length > 12 ? `${v.slice(0, 12)}…` : v)}
          />
          <Tooltip content={<TooltipBox currency={currency} />} cursor={{ fill: '#f7f8fa' }} />
          <Bar dataKey="value" name={name} fill="#3b6ef6" radius={[0, 4, 4, 0]} barSize={14} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function SimpleBars({
  data,
  height = 220,
  currency = 'USD',
}: {
  data: Array<{ name: string; value: number; color?: string }>
  height?: number
  currency?: string
}) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="name" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v: number) => compactMoney(v, currency)} width={62} />
          <Tooltip content={<TooltipBox currency={currency} />} cursor={{ fill: '#f7f8fa' }} />
          <Bar dataKey="value" name="金额" radius={[4, 4, 0, 0]} barSize={34}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.color ?? '#3b6ef6'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
