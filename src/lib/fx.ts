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

/** 未联网同步时的默认币种清单（与店铺页 CURRENCIES 保持一致） */
export const DEFAULT_FX_CODES = ['USD', ...FX_EDITABLE]

/**
 * 常见法币目录。联网更新时只把这些币种纳入可选清单，
 * 避免把 160 多种加密货币 / 小众代币混进业务下拉框。
 */
export const FX_CATALOG: Record<string, string> = {
  USD: '美元',
  CNY: '人民币',
  EUR: '欧元',
  GBP: '英镑',
  JPY: '日元',
  AUD: '澳元',
  CAD: '加元',
  CHF: '瑞士法郎',
  NZD: '新西兰元',
  HKD: '港元（中国香港）',
  TWD: '新台币（中国台湾）',
  MOP: '澳门元（中国澳门）',
  KRW: '韩元',
  SGD: '新加坡元',
  MYR: '马来西亚林吉特',
  THB: '泰铢',
  VND: '越南盾',
  IDR: '印尼盾',
  PHP: '菲律宾比索',
  INR: '印度卢比',
  PKR: '巴基斯坦卢比',
  BDT: '孟加拉塔卡',
  AED: '阿联酋迪拉姆',
  SAR: '沙特里亚尔',
  TRY: '土耳其里拉',
  ILS: '以色列新谢克尔',
  BRL: '巴西雷亚尔',
  MXN: '墨西哥比索',
  ARS: '阿根廷比索',
  CLP: '智利比索',
  COP: '哥伦比亚比索',
  PEN: '秘鲁索尔',
  ZAR: '南非兰特',
  EGP: '埃及镑',
  NGN: '尼日利亚奈拉',
  KES: '肯尼亚先令',
  PLN: '波兰兹罗提',
  CZK: '捷克克朗',
  HUF: '匈牙利福林',
  SEK: '瑞典克朗',
  NOK: '挪威克朗',
  DKK: '丹麦克朗',
  RUB: '俄罗斯卢布',
  UAH: '乌克兰格里夫纳',
}

export type FxRates = Record<string, number>

/** 联网更新时间与来源，存在 profiles.settings.fx_meta */
export interface FxMeta {
  updated_at: string
  source: string
  market_date: string | null
}

export interface FxQuote {
  rates: FxRates
  fetchedAt: string
  source: string
  marketDate: string | null
}

export function fxLabel(code: string): string {
  const name = FX_CATALOG[code]
  return name ? `${code} · ${name}` : code
}

export function resolveRates(settings?: Record<string, unknown> | null): FxRates {
  const custom = (settings?.fx ?? {}) as Record<string, number>
  const merged: FxRates = { ...FX_DEFAULTS }
  for (const [code, rate] of Object.entries(custom)) {
    const value = Number(rate)
    if (Number.isFinite(value) && value > 0) merged[code] = value
  }
  return merged
}

/** 币种清单：用户联网同步 / 手工勾选后存 settings.fx_codes，未提供时用默认值 */
export function resolveFxCodes(settings?: Record<string, unknown> | null): string[] {
  const raw = settings?.fx_codes
  if (Array.isArray(raw)) {
    const codes = raw
      .filter((c): c is string => typeof c === 'string' && /^[A-Z]{3}$/.test(c))
      .map((c) => c.toUpperCase())
    if (codes.length) return Array.from(new Set(['USD', ...codes]))
  }
  return DEFAULT_FX_CODES
}

export function resolveFxMeta(settings?: Record<string, unknown> | null): FxMeta | null {
  const raw = settings?.fx_meta
  if (!raw || typeof raw !== 'object') return null
  const meta = raw as Record<string, unknown>
  if (typeof meta.updated_at !== 'string') return null
  return {
    updated_at: meta.updated_at,
    source: typeof meta.source === 'string' ? meta.source : '未知来源',
    market_date: typeof meta.market_date === 'string' ? meta.market_date : null,
  }
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

export function useFxCodes(): string[] {
  const { profile } = useAuth()
  return useMemo(() => resolveFxCodes(profile?.settings), [profile?.settings])
}

export function useFxMeta(): FxMeta | null {
  const { profile } = useAuth()
  return useMemo(() => resolveFxMeta(profile?.settings), [profile?.settings])
}

/* ------------------------------------------------------------------ */
/*  联网汇率：免费公开接口，浏览器可直接跨域调用，无需 API Key          */
/*  依次降级，任一源可用即可；失败时保留现有汇率不变                    */
/* ------------------------------------------------------------------ */

interface FxSource {
  id: string
  label: string
  url: string
  parse: (json: Record<string, unknown>) => { rates: FxRates; marketDate: string | null } | null
}

function normalizeRates(raw: Record<string, unknown>): FxRates {
  const rates: FxRates = {}
  for (const [code, value] of Object.entries(raw)) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) rates[code.toUpperCase()] = n
  }
  return rates
}

const FX_SOURCES: FxSource[] = [
  {
    id: 'er-api',
    label: 'ExchangeRate-API',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse(json) {
      if (json.result !== 'success' || !json.rates || typeof json.rates !== 'object') return null
      const unix = Number(json.time_last_update_unix)
      const marketDate =
        Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000).toISOString().slice(0, 10) : null
      return { rates: normalizeRates(json.rates as Record<string, unknown>), marketDate }
    },
  },
  {
    id: 'currency-api',
    label: 'Currency-API',
    url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
    parse(json) {
      if (!json.usd || typeof json.usd !== 'object') return null
      return {
        rates: normalizeRates(json.usd as Record<string, unknown>),
        marketDate: typeof json.date === 'string' ? json.date : null,
      }
    },
  },
  {
    id: 'jsdelivr',
    label: 'jsDelivr 镜像',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    parse(json) {
      if (!json.usd || typeof json.usd !== 'object') return null
      return {
        rates: normalizeRates(json.usd as Record<string, unknown>),
        marketDate: typeof json.date === 'string' ? json.date : null,
      }
    },
  },
]

/** 拉取最新汇率：返回 1 USD = N 目标币种的完整表，失败时抛出最后一个错误 */
export async function fetchLatestFxRates(signal?: AbortSignal): Promise<FxQuote> {
  let lastError: unknown
  for (const source of FX_SOURCES) {
    try {
      const response = await fetch(source.url, { signal, cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = (await response.json()) as Record<string, unknown>
      const parsed = source.parse(json)
      if (!parsed || !(parsed.rates.CNY > 0) || !(parsed.rates.USD > 0)) {
        throw new Error('返回数据缺少有效汇率')
      }
      return {
        rates: parsed.rates,
        fetchedAt: new Date().toISOString(),
        source: source.label,
        marketDate: parsed.marketDate,
      }
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
  }
  const detail = lastError instanceof Error ? lastError.message : '网络不可用'
  throw new Error(`汇率源暂时不可用（${detail}）`)
}

/** 从联网结果中挑出常见法币，按目录顺序返回代码与汇率 */
export function pickCatalogRates(rates: FxRates): { codes: string[]; values: FxRates } {
  const codes = Object.keys(FX_CATALOG).filter((code) => Number.isFinite(rates[code]) && rates[code] > 0)
  const values: FxRates = {}
  for (const code of codes) values[code] = rates[code]
  return { codes, values }
}
