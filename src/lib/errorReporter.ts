import { supabase } from './supabase'

/**
 * 前端异常自动上报：把运行时错误、接口失败写入系统日志（error 类），
 * 供平台超管在「系统日志」页排查故障。
 *
 * 设计原则：
 * - 完全副作用隔离：上报失败静默，绝不抛出，绝不递归。
 * - 节流：同类错误 30 秒内只记一条，避免异常循环把日志刷爆。
 * - 未登录时不产生有效记录（数据库函数会因 auth.uid() 为空而直接返回）。
 */

const THROTTLE_MS = 30_000
const lastSent = new Map<string, number>()

export function reportClientError(
  action: string,
  summary: string,
  detail: Record<string, unknown> = {},
): void {
  try {
    const key = `${action}:${summary}`.slice(0, 200)
    const now = Date.now()
    if (now - (lastSent.get(key) ?? 0) < THROTTLE_MS) return
    lastSent.set(key, now)

    // fire-and-forget：上报本身失败不能影响业务，也不能再次触发上报
    void supabase
      .rpc('log_system_event', {
        p_category: 'error',
        p_action: action.slice(0, 80),
        p_summary: summary.slice(0, 500),
        p_detail: detail,
        p_severity: 'error',
      })
      .then(
        () => undefined,
        () => undefined,
      )
  } catch {
    /* 上报失败一律静默 */
  }
}

let installed = false

/** 挂载全局错误监听，只调用一次 */
export function installGlobalErrorReporter(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  // 未捕获的脚本异常（资源加载失败等非 ErrorEvent 不记录，避免噪音）
  window.addEventListener('error', (event) => {
    if (!(event instanceof ErrorEvent)) return
    const msg = event.message || '未知脚本错误'
    const loc = event.filename
      ? ` @ ${event.filename}:${event.lineno}:${event.colno}`
      : ''
    reportClientError('client_error', `前端异常：${msg}${loc}`, {
      source: 'window.onerror',
      message: msg,
      filename: event.filename || null,
      line: event.lineno || null,
      column: event.colno || null,
      href: window.location.href,
      stack: (event.error instanceof Error ? event.error.stack : null)?.slice(0, 2000) ?? null,
    })
  })

  // 未处理的 Promise 拒绝
  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason
    const msg = reason instanceof Error ? reason.message : String(reason)
    reportClientError('client_error', `未处理的异步异常：${msg}`, {
      source: 'unhandledrejection',
      message: msg,
      stack: reason instanceof Error ? (reason.stack ?? '').slice(0, 2000) : null,
      href: window.location.href,
    })
  })
}
