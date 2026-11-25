import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'

dayjs.locale('zh-cn')

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  CNY: '¥',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CAD: 'C$',
  MXN: 'MX$',
  BRL: 'R$',
  AUD: 'A$',
  SAR: 'SAR ',
  AED: 'AED ',
}

export function currencySymbol(code = 'USD') {
  return CURRENCY_SYMBOL[code] ?? `${code} `
}

export function money(value: number | null | undefined, code = 'USD', digits?: number) {
  const n = Number(value ?? 0)
  const auto = digits ?? (Math.abs(n) >= 1000 ? 0 : 2)
  return (
    (n < 0 ? '-' : '') +
    currencySymbol(code) +
    Math.abs(n).toLocaleString('zh-CN', {
      minimumFractionDigits: auto,
      maximumFractionDigits: auto,
    })
  )
}

export function compactMoney(value: number | null | undefined, code = 'USD') {
  const n = Number(value ?? 0)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 100_000_000) return `${sign}${currencySymbol(code)}${(abs / 100_000_000).toFixed(2)}亿`
  if (abs >= 10_000) return `${sign}${currencySymbol(code)}${(abs / 10_000).toFixed(1)}万`
  return money(n, code)
}

export function num(value: number | null | undefined, digits = 0) {
  return Number(value ?? 0).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function pct(value: number | null | undefined, digits = 1) {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(digits)}%`
}

export function ratio(a: number, b: number) {
  if (!b) return 0
  return (a / b) * 100
}

export function today() {
  return dayjs().format('YYYY-MM-DD')
}

export function daysAgo(n: number) {
  return dayjs().subtract(n, 'day').format('YYYY-MM-DD')
}

export function monthStart() {
  return dayjs().startOf('month').format('YYYY-MM-DD')
}

export function fmtDate(d?: string | null, pattern = 'YYYY-MM-DD') {
  if (!d) return '—'
  return dayjs(d).format(pattern)
}

export function fmtDateTime(d?: string | null) {
  if (!d) return '—'
  return dayjs(d).format('YYYY-MM-DD HH:mm')
}

export function relativeDay(d?: string | null) {
  if (!d) return ''
  const target = dayjs(d).startOf('day')
  const diff = target.diff(dayjs().startOf('day'), 'day')
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  if (diff < 0) return `逾期 ${Math.abs(diff)} 天`
  return `${diff} 天后`
}

/** target 距 base（默认今天）的天数，正数=未来，负数=已过去 */
export function dayDiff(target?: string | null, base?: string | null) {
  if (!target) return 0
  return dayjs(target).startOf('day').diff(base ? dayjs(base).startOf('day') : dayjs().startOf('day'), 'day')
}

export function sum<T>(rows: T[], pick: (row: T) => number | null | undefined) {
  return rows.reduce((acc, row) => acc + Number(pick(row) ?? 0), 0)
}

export function groupBy<T, K extends string>(rows: T[], key: (row: T) => K) {
  return rows.reduce((acc, row) => {
    const k = key(row)
    ;(acc[k] ||= []).push(row)
    return acc
  }, {} as Record<K, T[]>)
}

export function downloadTextFile(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob(['\ufeff' + content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function toCsv(rows: Array<Record<string, unknown>>, headers?: string[]) {
  if (!rows.length) return ''
  const cols = headers ?? Object.keys(rows[0])
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => escape(r[c])).join(','))].join('\n')
}

export function initials(name?: string | null) {
  if (!name) return '?'
  return name.trim().slice(0, 1).toUpperCase()
}

export function agoDay(d?: string | null) {
  if (!d) return '未联系'
  const diff = dayjs().startOf('day').diff(dayjs(d).startOf('day'), 'day')
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  return `${diff} 天前`
}
