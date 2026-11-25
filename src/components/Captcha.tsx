import { useEffect, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { cn } from '../lib/utils'

// 去掉 0/O、1/I/L 这类肉眼易混字符，避免用户被验证码本身卡住
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const INK = ['#1e293b', '#2551eb', '#0f766e', '#b91c1c', '#7c3aed', '#c2410c']

export function randomCaptcha(len = 4) {
  let out = ''
  for (let i = 0; i < len; i += 1) out += CHARS[Math.floor(Math.random() * CHARS.length)]
  return out
}

export function matchCaptcha(input: string, code: string) {
  return input.trim().toUpperCase() === code.toUpperCase()
}

const W = 128
const H = 42

/** 纯 Canvas 绘制，不依赖任何第三方库，也不发起网络请求 */
export function CaptchaCanvas({ code, className }: { code: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cvs = ref.current
    if (!cvs) return
    const ctx = cvs.getContext('2d')
    if (!ctx) return

    const dpr = 2
    cvs.width = W * dpr
    cvs.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.fillStyle = '#f8fafc'
    ctx.fillRect(0, 0, W, H)

    // 干扰线
    for (let i = 0; i < 4; i += 1) {
      ctx.beginPath()
      ctx.strokeStyle = `rgba(100,116,139,${0.18 + Math.random() * 0.22})`
      ctx.lineWidth = 1
      ctx.moveTo(Math.random() * W, Math.random() * H)
      ctx.bezierCurveTo(
        Math.random() * W, Math.random() * H,
        Math.random() * W, Math.random() * H,
        Math.random() * W, Math.random() * H,
      )
      ctx.stroke()
    }

    // 噪点
    for (let i = 0; i < 55; i += 1) {
      ctx.beginPath()
      ctx.fillStyle = `rgba(71,85,105,${0.15 + Math.random() * 0.3})`
      ctx.arc(Math.random() * W, Math.random() * H, Math.random() * 1.1, 0, Math.PI * 2)
      ctx.fill()
    }

    // 字符
    const step = (W - 16) / code.length
    code.split('').forEach((ch, i) => {
      const size = 21 + Math.random() * 4
      const x = 10 + step * i + step / 2
      const y = H / 2 + size * 0.34 + (Math.random() - 0.5) * 4
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate((Math.random() - 0.5) * 0.46)
      ctx.font = `600 ${size}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`
      ctx.fillStyle = INK[Math.floor(Math.random() * INK.length)]
      ctx.textAlign = 'center'
      ctx.fillText(ch, 0, 0)
      ctx.restore()
    })
  }, [code])

  return (
    <canvas
      ref={ref}
      className={cn('rounded-lg border border-ink-200/70 select-none', className)}
      style={{ width: W, height: H }}
      aria-label="图形验证码"
    />
  )
}

export function CaptchaField({
  code,
  value,
  onChange,
  onRefresh,
  error,
  disabled,
}: {
  code: string
  value: string
  onChange: (v: string) => void
  onRefresh: () => void
  error?: string | null
  disabled?: boolean
}) {
  return (
    <div>
      <label className="label">图形验证码</label>
      <div className="flex items-stretch gap-2">
        <input
          className={cn('input flex-1 tracking-[0.25em] uppercase', error && 'border-rose-300 bg-rose-50/40')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="输入右侧 4 位"
          maxLength={6}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
        <button
          type="button"
          onClick={onRefresh}
          title="看不清？换一张"
          className="group relative shrink-0 rounded-lg overflow-hidden border border-ink-200/70 hover:border-brand-300 transition-colors"
        >
          <CaptchaCanvas code={code} />
          <span className="absolute inset-0 flex items-center justify-center bg-ink-900/0 group-hover:bg-ink-900/45 transition-colors">
            <RefreshCw className="w-4 h-4 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
          </span>
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-rose-600">{error}</p>}
    </div>
  )
}
