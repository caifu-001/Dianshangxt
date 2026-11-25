import type { ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { cn } from '../lib/utils'

export function KpiCard({
  label,
  value,
  sub,
  delta,
  deltaLabel,
  icon,
  tone = 'brand',
  invertDelta = false,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  delta?: number | null
  deltaLabel?: string
  icon?: ReactNode
  tone?: 'brand' | 'green' | 'amber' | 'rose' | 'violet' | 'slate'
  invertDelta?: boolean
}) {
  const toneMap = {
    brand: 'bg-brand-50 text-brand-600',
    green: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
    rose: 'bg-rose-50 text-rose-600',
    violet: 'bg-violet-50 text-violet-600',
    slate: 'bg-ink-100 text-ink-600',
  }

  const good = delta === undefined || delta === null ? null : invertDelta ? delta < 0 : delta > 0
  const neutral = delta === 0

  return (
    <div className="card p-4 hover:shadow-pop transition-shadow duration-200">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-ink-500">{label}</span>
        {icon && <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center', toneMap[tone])}>{icon}</span>}
      </div>
      <div className="mt-2 text-[22px] leading-tight font-semibold text-ink-900 num tracking-tight">{value}</div>
      <div className="mt-1.5 flex items-center gap-1.5 min-h-[18px]">
        {delta !== undefined && delta !== null && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-[11px] font-medium px-1.5 py-0.5 rounded',
              neutral
                ? 'text-ink-500 bg-ink-100'
                : good
                  ? 'text-emerald-700 bg-emerald-50'
                  : 'text-rose-700 bg-rose-50',
            )}
          >
            {neutral ? (
              <Minus className="w-3 h-3" />
            ) : delta > 0 ? (
              <ArrowUpRight className="w-3 h-3" />
            ) : (
              <ArrowDownRight className="w-3 h-3" />
            )}
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
        {(deltaLabel || sub) && <span className="text-[11px] text-ink-400 truncate">{deltaLabel ?? sub}</span>}
      </div>
    </div>
  )
}
