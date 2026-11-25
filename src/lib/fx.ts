import { useMemo } from 'react'
import { useAuth } from '../context/AuthContext'

/**
 * 汇率定义：1 美元 = rates[币种] 个该币种
 * 可在「系统设置 → 汇率与币种」中覆盖，保存到 profiles.settings.fx
 */
export const FX_DEFAULTS: Record<string, number> = {
  USD: 1,
  CNY: 7.15,
  GBP: 0.78,
  EUR: 0.92,
  JPY: 152,
  CAD: 1.36,
  MXN: 17.5,
  AED: 3.67,
  SAR: 3.75,
  SGD: 1.34,
  MYR: 4.7,
  THB: 36.5,
  BRL: 5.4,
  AUD: 1.52,
}

export const FX_EDITABLE = ['CNY', 'GBP', 'EUR', 'JPY', 'CAD', 'MXN', 'AED', 'SAR', 'SGD', 'MYR', 'THB', 'BRL']

export type FxRates = Record<string, number>

export function resolveRates(settings?: Record<string, unknown> | null): FxRates {
  const custom = (settings?.fx ?? {}) as Record<string, number>
  const merged: FxRates = { ...FX_DEFAULTS }
  for (const [code, rate] of Object.entries(custom)) {
    const value = Number(rate)
    if (Number.isFinite(value) && value > 0) merged[code] = value
  }
  return merged
}

/** 把 amount 从 from 币种换算到 to 币种 */
export function convert(amount: number, from: string, to: string, rates: FxRates): number {
  if (!amount || from === to) return amount || 0
  const fromRate = rates[from] ?? FX_DEFAULTS[from] ?? 1
  const toRate = rates[to] ?? FX_DEFAULTS[to] ?? 1
  return (amount / fromRate) * toRate
}

export function useFx(): FxRates {
  const { profile } = useAuth()
  return useMemo(() => resolveRates(profile?.settings), [profile?.settings])
}
