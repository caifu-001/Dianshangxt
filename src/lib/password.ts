/**
 * 密码强度校验。
 * 底线：长度 ≥ 8，且至少包含「小写 / 大写 / 数字 / 符号」中的两类。
 * 强度分 0–4，仅用于界面提示，不作为硬性拦截条件（除 ok 之外）。
 */

export const MIN_PASSWORD_LENGTH = 8

export interface PasswordCheck {
  ok: boolean
  score: number
  label: string
  hint: string
  tone: 'rose' | 'amber' | 'emerald'
}

export function checkPassword(pw: string): PasswordCheck {
  const hasLower = /[a-z]/.test(pw)
  const hasUpper = /[A-Z]/.test(pw)
  const hasDigit = /\d/.test(pw)
  const hasSymbol = /[^A-Za-z0-9]/.test(pw)
  const kinds = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length
  const longEnough = pw.length >= MIN_PASSWORD_LENGTH

  let score = 0
  if (pw.length >= MIN_PASSWORD_LENGTH) score += 1
  if (pw.length >= 12) score += 1
  if (kinds >= 2) score += 1
  if (kinds >= 3) score += 1

  const ok = longEnough && kinds >= 2

  let hint = ''
  if (!pw) hint = `至少 ${MIN_PASSWORD_LENGTH} 位，包含字母和数字`
  else if (!longEnough) hint = `还差 ${MIN_PASSWORD_LENGTH - pw.length} 位`
  else if (kinds < 2) hint = '再混合字母、数字或符号中的一种'
  else if (pw.length < 12) hint = '可用，加到 12 位以上更安全'
  else if (kinds < 3) hint = '长度足够，混合符号会更稳妥'
  else hint = '强度良好'

  const label = !pw ? '' : score <= 1 ? '弱' : score === 2 ? '一般' : score === 3 ? '较强' : '强'
  const tone: PasswordCheck['tone'] = !pw ? 'rose' : score <= 1 ? 'rose' : score === 2 ? 'amber' : 'emerald'

  return { ok, score: Math.min(4, score), label, hint, tone }
}

export const PASSWORD_TONE_CLASS: Record<PasswordCheck['tone'], string> = {
  rose: 'bg-rose-500',
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
}
