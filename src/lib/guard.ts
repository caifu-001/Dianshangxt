/**
 * 登录失败次数限制。
 * 纯前端实现，用于挡住「同一浏览器反复试密码」这类最廉价的手工爆破。
 * 真正的服务端防线是 Supabase Auth 自带的 rate limit，这里只是补一层体验层的拦截。
 */

const PREFIX = 'ds.guard.'

export const MAX_FAILS = 5
export const LOCK_MS = 15 * 60 * 1000

interface GuardRecord {
  fails: number
  lockedUntil: number
}

function key(email: string) {
  return PREFIX + email.trim().toLowerCase()
}

function read(email: string): GuardRecord {
  try {
    const raw = localStorage.getItem(key(email))
    if (!raw) return { fails: 0, lockedUntil: 0 }
    const parsed = JSON.parse(raw) as Partial<GuardRecord>
    return { fails: Number(parsed.fails) || 0, lockedUntil: Number(parsed.lockedUntil) || 0 }
  } catch {
    return { fails: 0, lockedUntil: 0 }
  }
}

function write(email: string, rec: GuardRecord) {
  try {
    localStorage.setItem(key(email), JSON.stringify(rec))
  } catch {
    /* 隐私模式下不可写，忽略即可，不阻断登录 */
  }
}

/** 剩余锁定秒数，0 表示未被锁 */
export function lockedSeconds(email: string): number {
  if (!email.trim()) return 0
  const rec = read(email)
  if (!rec.lockedUntil) return 0
  const left = rec.lockedUntil - Date.now()
  if (left <= 0) {
    clearGuard(email)
    return 0
  }
  return Math.ceil(left / 1000)
}

/** 记录一次失败，返回是否已触发锁定 */
export function recordFailure(email: string): { locked: boolean; left: number; remaining: number } {
  const rec = read(email)
  const fails = rec.fails + 1
  if (fails >= MAX_FAILS) {
    write(email, { fails: 0, lockedUntil: Date.now() + LOCK_MS })
    return { locked: true, left: Math.ceil(LOCK_MS / 1000), remaining: 0 }
  }
  write(email, { fails, lockedUntil: 0 })
  return { locked: false, left: 0, remaining: MAX_FAILS - fails }
}

export function clearGuard(email: string) {
  try {
    localStorage.removeItem(key(email))
  } catch {
    /* ignore */
  }
}

export function formatCountdown(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
