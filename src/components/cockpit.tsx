/**
 * 驾驶舱的大屏专用组件。
 *
 * 与普通业务页刻意分开：深色底、发光描边、等宽数字、秒级时钟。
 * 这些组件只在 /cockpit 下使用，不复用 card / btn 那套浅色样式。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { KpiTile, Tone } from '../lib/cockpitModel'
import { compactMoney, cn, num } from '../lib/utils'

export const TONE_COLOR: Record<Tone, string> = {
  blue: '#60a5fa',
  cyan: '#22d3ee',
  green: '#34d399',
  violet: '#a78bfa',
  amber: '#fbbf24',
  rose: '#fb7185',
}

export const SCREEN = {
  bg: '#070b14',
  grid: 'rgba(148,163,184,.10)',
  axis: '#5b6b85',
  panel: 'rgba(11,17,32,.72)',
  border: 'rgba(255,255,255,.07)',
}

/* ------------------------------------------------------------------ */
/*  hooks                                                              */
/* ------------------------------------------------------------------ */

/** 每秒跳一次的时钟 */
export function useClock(intervalMs = 1000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/** 数字变化时做一次缓动滚动，避免整块大屏数据「瞬移」 */
export function useCountUp(value: number, duration = 700) {
  const target = Number.isFinite(value) ? value : 0
  const [display, setDisplay] = useState(target)
  const displayRef = useRef(target)
  const raf = useRef<number | null>(null)

  useEffect(() => {
    const from = displayRef.current
    if (from === target) return
    const start = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      const next = from + (target - from) * eased
      displayRef.current = next
      setDisplay(next)
      if (p < 1) {
        raf.current = requestAnimationFrame(tick)
      } else {
        displayRef.current = target
        setDisplay(target)
      }
    }
    raf.current = requestAnimationFrame(tick)
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [target, duration])

  return display
}

export function formatValue(value: number, format: KpiTile['format']) {
  switch (format) {
    case 'money':
      return compactMoney(value, 'USD')
    case 'pct':
      return `${value.toFixed(1)}%`
    case 'ratio':
      return value.toFixed(2)
    case 'days':
      return `${Math.min(999, Math.round(value))} 天`
    default:
      return num(Math.round(value))
  }
}

/* ------------------------------------------------------------------ */
/*  面板                                                                */
/* ------------------------------------------------------------------ */

export function ScreenPanel({
  title,
  subtitle,
  right,
  children,
  className,
  bodyClassName,
  accent = '#22d3ee',
}: {
  title: string
  subtitle?: string
  right?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  accent?: string
}) {
  return (
    <section
      className={cn(
        'relative rounded-xl border border-white/[0.07] overflow-hidden flex flex-col',
        'bg-[linear-gradient(180deg,rgba(15,23,42,.86),rgba(8,13,25,.92))]',
        className,
      )}
    >
      {['left-0 top-0 border-l border-t', 'right-0 top-0 border-r border-t', 'left-0 bottom-0 border-l border-b', 'right-0 bottom-0 border-r border-b'].map(
        (pos) => (
          <span key={pos} className={cn('absolute w-2.5 h-2.5 border-cyan-400/35 pointer-events-none z-10', pos)} />
        ),
      )}
      <header className="flex items-center gap-2 px-3.5 h-9 shrink-0 border-b border-white/[0.06]">
        <span className="w-[3px] h-3 rounded-full" style={{ background: accent, boxShadow: `0 0 8px ${accent}` }} />
        <h3 className="text-[12px] font-medium text-slate-200 tracking-wide whitespace-nowrap">{title}</h3>
        {subtitle && <span className="text-[10.5px] text-slate-500 truncate">{subtitle}</span>}
        {right && <div className="ml-auto flex items-center gap-2 shrink-0">{right}</div>}
      </header>
      <div className={cn('flex-1 min-h-0 px-3.5 py-3', bodyClassName)}>{children}</div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  KPI                                                                */
/* ------------------------------------------------------------------ */

export function DeltaBadge({ delta, invert = false }: { delta: number | null; invert?: boolean }) {
  if (delta === null) return null
  const flat = Math.abs(delta) < 0.05
  const good = invert ? delta < 0 : delta > 0
  const color = flat ? 'text-slate-400' : good ? 'text-emerald-400' : 'text-rose-400'
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[10.5px] font-medium num', color)}>
      {flat ? <Minus className="w-3 h-3" /> : delta > 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
      {Math.abs(delta).toFixed(1)}%
    </span>
  )
}

export function Spark({ data, color, width = 88, height = 26 }: { data: number[]; color: string; width?: number; height?: number }) {
  if (!data || data.length < 2) return <div style={{ width, height }} />
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const stepX = width / (data.length - 1)
  const points = data.map((v, i) => `${(i * stepX).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`)
  const id = `sp-${color.replace('#', '')}-${data.length}-${Math.round(max)}`
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${points.join(' ')} ${width},${height}`} fill={`url(#${id})`} />
      <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={points[points.length - 1].split(',')[1]} r={1.8} fill={color} />
    </svg>
  )
}

export function StatTile({ kpi }: { kpi: KpiTile }) {
  const animated = useCountUp(kpi.value)
  const color = TONE_COLOR[kpi.tone]
  return (
    <div className="relative rounded-xl border border-white/[0.07] bg-[linear-gradient(160deg,rgba(17,26,45,.92),rgba(8,13,25,.86))] px-3.5 py-3 overflow-hidden group">
      <span
        className="absolute inset-x-0 top-0 h-px opacity-60"
        style={{ background: `linear-gradient(90deg,transparent,${color},transparent)` }}
      />
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] text-slate-400 tracking-wide">{kpi.label}</span>
        <span className="w-1.5 h-1.5 rounded-full mt-1 shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="mt-1.5 flex items-end gap-2">
        <span className="text-[24px] leading-none font-semibold text-white num tracking-tight">{formatValue(animated, kpi.format)}</span>
        <span className="pb-0.5">
          <DeltaBadge delta={kpi.delta} />
        </span>
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        {/* 卡片窄，基准说明放 title 里，正文只留最关键的副指标 */}
        <span
          className="text-[10.5px] text-slate-500 truncate"
          title={kpi.deltaLabel ? `${kpi.deltaLabel} · ${kpi.hint}` : kpi.hint}
        >
          {kpi.hint}
        </span>
        <Spark data={kpi.spark} color={color} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  仪表 / 漏斗 / 跑马灯                                                */
/* ------------------------------------------------------------------ */

/** 半环形仪表：用于 ACOS 这类「越低越好」的比率 */
export function Gauge({
  value,
  max,
  color = '#22d3ee',
  label,
  sub,
  size = 132,
}: {
  value: number
  max: number
  color?: string
  label: string
  sub?: string
  size?: number
}) {
  const stroke = 9
  const r = (size - stroke) / 2
  const circumference = Math.PI * r
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  return (
    <div className="relative flex flex-col items-center" style={{ width: size }}>
      <svg width={size} height={size / 2 + 6} viewBox={`0 0 ${size} ${size / 2 + 6}`}>
        <path
          d={`M ${stroke / 2} ${size / 2} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${size / 2}`}
          fill="none"
          stroke="rgba(148,163,184,.18)"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        <path
          d={`M ${stroke / 2} ${size / 2} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${size / 2}`}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          style={{ filter: `drop-shadow(0 0 6px ${color}88)`, transition: 'stroke-dasharray .6s ease' }}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
        <span className="text-[20px] leading-none font-semibold text-white num">{label}</span>
        {sub && <span className="mt-1 text-[10px] text-slate-500">{sub}</span>}
      </div>
    </div>
  )
}

export function FunnelRow({
  step,
  value,
  width,
  color,
  rate,
}: {
  step: string
  value: string
  width: number
  color: string
  rate?: string
}) {
  return (
    <div className="group">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-slate-400 w-[52px] shrink-0">{step}</span>
        <span className="ml-auto num font-medium text-slate-100">{value}</span>
        {rate && <span className="text-[10px] text-slate-500 w-[46px] text-right num">{rate}</span>}
      </div>
      <div className="mt-1 h-[7px] rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{
            width: `${Math.max(2, Math.min(100, width))}%`,
            background: `linear-gradient(90deg,${color}55,${color})`,
            boxShadow: `0 0 8px ${color}66`,
          }}
        />
      </div>
    </div>
  )
}

/** 预警跑马灯：无缝横向滚动，鼠标悬停暂停 */
export function Ticker({ items }: { items: Array<{ level: 'red' | 'amber' | 'blue'; tag: string; text: string }> }) {
  const palette: Record<string, string> = { red: '#fb7185', amber: '#fbbf24', blue: '#60a5fa' }
  const list = items.length
    ? items
    : [{ level: 'blue' as const, tag: '状态', text: '所有监控指标正常，暂无需要处理的异常' }]

  return (
    <div className="relative h-8 rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden flex items-center">
      <span className="absolute left-0 top-0 bottom-0 z-10 px-2.5 flex items-center gap-1.5 bg-[#0b1120] border-r border-white/[0.06]">
        <span className="w-1.5 h-1.5 rounded-full bg-rose-500 live-dot" />
        <span className="text-[10px] font-semibold text-slate-300 tracking-widest">ALERT</span>
      </span>
      <div className="flex-1 overflow-hidden pl-[74px] ticker-mask">
        {/* 两组等宽内容首尾相接，位移 -50% 即可无缝循环（不能在 track 上用 gap，否则会错位半个间距） */}
        <div className="flex ticker-track" style={{ animationDuration: `${Math.max(18, list.length * 9)}s` }}>
          {[0, 1].map((dup) => (
            <div key={dup} className="flex items-center gap-8 pr-8 shrink-0" aria-hidden={dup === 1}>
              {list.map((item, i) => (
                <span key={`${dup}-${i}`} className="flex items-center gap-1.5 text-[11.5px] whitespace-nowrap">
                  <span className="chip !h-[18px] !px-1.5 !text-[9.5px]" style={{ color: palette[item.level], borderColor: `${palette[item.level]}55`, background: `${palette[item.level]}14` }}>
                    {item.tag}
                  </span>
                  <span className="text-slate-400">{item.text}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 深色 tooltip，给 Recharts 用（样式与浅色页面的 TooltipBox 不同） */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function DarkTip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-white/10 bg-[#0b1120]/95 px-2.5 py-2 text-[11px] shadow-lg backdrop-blur">
      <p className="mb-1 text-[10.5px] text-slate-400">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 py-0.5">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-slate-400">{p.name}</span>
          <span className="ml-auto num font-medium text-slate-100">
            {formatter ? formatter(p.value, p.name) : p.value}
          </span>
        </div>
      ))}
    </div>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function LiveDot({ label = 'LIVE' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 live-dot" />
      <span className="text-[9.5px] font-semibold tracking-widest text-emerald-300">{label}</span>
    </span>
  )
}
