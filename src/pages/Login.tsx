import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Boxes,
  Building2,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  Megaphone,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { CaptchaField, matchCaptcha, randomCaptcha } from '../components/Captcha'
import { PASSWORD_TONE_CLASS, checkPassword } from '../lib/password'
import { MAX_FAILS, clearGuard, formatCountdown, lockedSeconds, recordFailure } from '../lib/guard'
import { cn } from '../lib/utils'

const FEATURES = [
  { icon: BarChart3, title: '利润核算', desc: '佣金、FBA、广告、退款逐笔拆解' },
  { icon: Boxes, title: '库存预警', desc: '可售天数与智能补货建议' },
  { icon: Megaphone, title: '站内广告', desc: 'ACOS / ROAS / 转化率实时看板' },
  { icon: Users, title: '达人营销', desc: 'TikTok 达人漏斗与带货 GMV' },
]

const OTP_COOLDOWN_SEC = 60

export default function Login() {
  const { signIn, signUp, sendOtp, verifyOtp } = useAuth()

  const [mode, setMode] = useState<'signin' | 'signup' | 'company'>('signin')
  const [method, setMethod] = useState<'password' | 'otp'>('password')

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [companyCode, setCompanyCode] = useState('')

  const [captchaCode, setCaptchaCode] = useState(() => randomCaptcha())
  const [captchaInput, setCaptchaInput] = useState('')
  const [captchaError, setCaptchaError] = useState<string | null>(null)

  const [otpSentAt, setOtpSentAt] = useState(0)
  const [otpToken, setOtpToken] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [, setTick] = useState(0)

  // 每秒重算一次倒计时（锁定剩余、验证码重发冷却）
  useEffect(() => {
    const id = window.setInterval(() => setTick((v) => (v + 1) % 100000), 1000)
    return () => window.clearInterval(id)
  }, [])

  const otpSent = otpSentAt > 0
  const otpCooldown = otpSentAt ? Math.max(0, Math.ceil((otpSentAt + OTP_COOLDOWN_SEC * 1000 - Date.now()) / 1000)) : 0
  const lockLeft = email.trim() ? lockedSeconds(email) : 0
  const pwCheck = checkPassword(password)

  function refreshCaptcha() {
    setCaptchaCode(randomCaptcha())
    setCaptchaInput('')
    setCaptchaError(null)
  }

  function switchMode(next: 'signin' | 'signup' | 'company') {
    setMode(next)
    setError(null)
    setInfo(null)
    setMethod('password')
    setOtpSentAt(0)
    setOtpToken('')
    setPassword('')
  }

  function switchMethod(next: 'password' | 'otp') {
    setMethod(next)
    setError(null)
    setInfo(null)
    setOtpSentAt(0)
    setOtpToken('')
  }

  /** 图形验证码校验，失败时自动换一张 */
  function ensureCaptcha() {
    if (matchCaptcha(captchaInput, captchaCode)) return true
    setCaptchaError('验证码不正确，请重新输入')
    setCaptchaCode(randomCaptcha())
    setCaptchaInput('')
    return false
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)

    if (lockLeft > 0) {
      setError(`尝试次数过多，请在 ${formatCountdown(lockLeft)} 后重试`)
      return
    }

    setLoading(true)
    try {
      // ---- 注册 ----
      if (mode === 'signup' || mode === 'company') {
        if (!fullName.trim()) throw new Error('请填写你的称呼')
        if (!pwCheck.ok) throw new Error(pwCheck.hint)
        if (mode === 'company' && !companyName.trim()) throw new Error('请填写公司名称')
        if (!ensureCaptcha()) return

        const { needsConfirm } = await signUp(
          email.trim(),
          password,
          fullName.trim(),
          mode === 'company'
            ? { name: companyName.trim(), code: companyCode.trim() || undefined }
            : undefined,
        )
        if (mode === 'company') {
          setInfo(
            needsConfirm
              ? '入驻申请已提交。请先到邮箱点击确认链接完成验证，审核通过后即可登录工作台。'
              : '入驻申请已提交，等待平台超级管理员审核。审核期间无法访问业务数据。',
          )
          setMode('signin')
          setMethod('password')
          setCompanyName('')
          setCompanyCode('')
        } else if (needsConfirm) {
          setInfo('注册成功。请到邮箱点击确认链接完成验证，然后回来登录。')
          setMode('signin')
          setMethod('password')
        }
        return
      }

      // ---- 验证码登录：发送 ----
      if (method === 'otp' && !otpSent) {
        if (!email.trim()) throw new Error('请先填写邮箱')
        if (!ensureCaptcha()) return
        await sendOtp(email.trim())
        setOtpSentAt(Date.now())
        setOtpToken('')
        setCaptchaInput('')
        setInfo(`验证码已发送至 ${email.trim()}，10 分钟内有效。`)
        return
      }

      // ---- 验证码登录：校验 ----
      if (method === 'otp' && otpSent) {
        if (!/^\d{6}$/.test(otpToken.trim())) throw new Error('请输入邮件里的 6 位数字验证码')
        await verifyOtp(email.trim(), otpToken.trim())
        clearGuard(email)
        return
      }

      // ---- 密码登录 ----
      if (!ensureCaptcha()) return
      try {
        await signIn(email.trim(), password)
        clearGuard(email)
      } catch (err) {
        const result = recordFailure(email.trim())
        if (result.locked) {
          throw new Error(`连续 ${MAX_FAILS} 次密码错误，账号已锁定 ${formatCountdown(result.left)}`)
        }
        const msg = err instanceof Error ? err.message : '登录失败'
        throw new Error(`${msg}（还可尝试 ${result.remaining} 次）`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试')
      if (mode === 'signup' || !otpSent) refreshCaptcha()
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    if (otpCooldown > 0) return
    setError(null)
    setInfo(null)
    setLoading(true)
    try {
      await sendOtp(email.trim())
      setOtpSentAt(Date.now())
      setInfo('验证码已重新发送，请注意查收。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  const otpStageVisible = mode === 'signin' && method === 'otp'
  const showCaptcha = !(otpStageVisible && otpSent)

  return (
    <div className="min-h-screen flex bg-white">
      {/* 左侧品牌区 */}
      <div className="hidden lg:flex w-[46%] relative overflow-hidden bg-ink-900 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(59,110,246,.45),transparent_45%),radial-gradient(circle_at_85%_80%,rgba(16,185,129,.28),transparent_45%)]" />
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)',
            backgroundSize: '44px 44px',
          }}
        />
        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-white/10 backdrop-blur flex items-center justify-center border border-white/15">
              <span className="text-white font-bold text-sm">DS</span>
            </div>
            <div>
              <p className="text-[14px] font-semibold">电商运营中台</p>
              <p className="text-[10px] text-white/50 tracking-[0.18em]">CROSS-BORDER OPS</p>
            </div>
          </div>

          <div className="max-w-md">
            <p className="text-[11px] tracking-[0.2em] text-white/50 mb-3">AMAZON · TIKTOK SHOP</p>
            <h1 className="text-[34px] leading-[1.25] font-semibold tracking-tight">
              把两个平台的数据
              <br />
              放在同一张运营报表里
            </h1>
            <p className="mt-4 text-[13px] leading-relaxed text-white/60">
              多店铺、多站点统一管理。订单、库存、广告、达人、利润一张表看清，每天少开五个后台。
            </p>

            <div className="mt-8 grid grid-cols-2 gap-3">
              {FEATURES.map((f) => (
                <div key={f.title} className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                  <f.icon className="w-4 h-4 text-brand-300 mb-2" />
                  <p className="text-[12.5px] font-medium">{f.title}</p>
                  <p className="text-[11px] text-white/45 mt-0.5 leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-white/40">
            <ShieldCheck className="w-3.5 h-3.5" />
            图形验证码 + 失败锁定 + 权限隔离，团队外不可见
          </div>
        </div>
      </div>

      {/* 右侧表单 */}
      <div className="flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-[368px]">
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center">
              <span className="text-white font-bold text-[13px]">DS</span>
            </div>
            <span className="font-semibold text-ink-900">电商运营中台</span>
          </div>

          <h2 className="text-[22px] font-semibold text-ink-900 tracking-tight">
            {mode === 'signin' ? '登录工作台' : mode === 'signup' ? '创建运营账号' : '申请入驻公司'}
          </h2>
          <p className="mt-1 text-[13px] text-ink-500">
            {mode === 'signin'
              ? method === 'password'
                ? '用邮箱密码登录，继续今天的运营工作'
                : '用邮箱接收一次性验证码，无需记密码'
              : mode === 'signup'
                ? '注册后即可建立店铺与商品档案'
                : '填写公司信息并提交，平台超级管理员审核通过后即可开通'}
          </p>

          <div className="mt-6 flex p-0.5 rounded-lg bg-ink-100 border border-ink-200/60">
            {([
              { key: 'signin', label: '登录' },
              { key: 'signup', label: '注册' },
              { key: 'company', label: '注册公司' },
            ] as const).map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => switchMode(m.key)}
                className={cn(
                  'flex-1 h-8 rounded-md text-[13px] font-medium transition-all',
                  mode === m.key ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-700',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'company' && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200/70 px-3 py-2 text-[11.5px] text-amber-800 leading-relaxed">
              你会成为该公司的<strong>普通管理员</strong>，可自行开通同事账号。提交后需平台超管审核，审核前无法访问业务数据。
            </div>
          )}

          {mode === 'signin' && (
            <div className="mt-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11.5px] text-ink-400">
                {method === 'password' ? <Lock className="w-3 h-3" /> : <Mail className="w-3 h-3" />}
                {method === 'password' ? '账号密码登录' : '邮箱验证码登录'}
              </span>
              <button
                type="button"
                onClick={() => switchMethod(method === 'password' ? 'otp' : 'password')}
                className="text-[11.5px] font-medium text-brand-600 hover:text-brand-700 hover:underline"
              >
                {method === 'password' ? '改用验证码登录' : '改用密码登录'}
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-4 space-y-3.5">
            {(mode === 'signup' || mode === 'company') && (
              <div>
                <label className="label">{mode === 'company' ? '负责人称呼' : '你的称呼'}</label>
                <input
                  className="input"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="如：老王"
                  autoComplete="name"
                />
              </div>
            )}

            {mode === 'company' && (
              <>
                <div>
                  <label className="label">公司名称</label>
                  <div className="relative">
                    <Building2 className="w-3.5 h-3.5 text-ink-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      className="input pl-9"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      placeholder="如：某某科技有限公司"
                      autoComplete="organization"
                    />
                  </div>
                </div>
                <div>
                  <label className="label">公司编码 <span className="text-ink-400">（选填）</span></label>
                  <input
                    className="input"
                    value={companyCode}
                    onChange={(e) => setCompanyCode(e.target.value)}
                    placeholder="如：ACME，便于平台识别"
                  />
                </div>
              </>
            )}

            <div>
              <label className="label">邮箱</label>
              <div className="relative">
                <Mail className="w-3.5 h-3.5 text-ink-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  className="input pl-9"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                  readOnly={otpStageVisible && otpSent}
                />
              </div>
            </div>

            {(mode === 'signup' || method === 'password') && (
              <div>
                <label className="label">密码</label>
                <div className="relative">
                  <KeyRound className="w-3.5 h-3.5 text-ink-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    className="input pl-9"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'signup' ? '至少 8 位，字母 + 数字' : '••••••••'}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  />
                </div>
                {mode === 'signup' && password.length > 0 && (
                  <div className="mt-1.5">
                    <div className="flex gap-1">
                      {[1, 2, 3, 4].map((i) => (
                        <span
                          key={i}
                          className={cn(
                            'h-1 flex-1 rounded-full transition-colors',
                            i <= pwCheck.score ? PASSWORD_TONE_CLASS[pwCheck.tone] : 'bg-ink-200',
                          )}
                        />
                      ))}
                    </div>
                    <p className={cn('mt-1 text-[11px]', pwCheck.ok ? 'text-ink-400' : 'text-rose-600')}>
                      {pwCheck.label ? `${pwCheck.label} · ${pwCheck.hint}` : pwCheck.hint}
                    </p>
                  </div>
                )}
              </div>
            )}

            {otpStageVisible && otpSent && (
              <div>
                <label className="label">邮箱验证码</label>
                <input
                  className="input tracking-[0.5em] text-center text-[16px] font-semibold num"
                  inputMode="numeric"
                  maxLength={6}
                  value={otpToken}
                  onChange={(e) => setOtpToken(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  autoComplete="one-time-code"
                />
                <div className="mt-1.5 flex items-center justify-between text-[11px]">
                  <span className="text-ink-400">10 分钟内有效</span>
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={otpCooldown > 0 || loading}
                    className={cn(
                      'font-medium transition-colors',
                      otpCooldown > 0 ? 'text-ink-300 cursor-not-allowed' : 'text-brand-600 hover:text-brand-700',
                    )}
                  >
                    {otpCooldown > 0 ? `重新发送（${otpCooldown}s）` : '重新发送验证码'}
                  </button>
                </div>
              </div>
            )}

            {showCaptcha && (
              <CaptchaField
                code={captchaCode}
                value={captchaInput}
                onChange={(v) => {
                  setCaptchaInput(v)
                  setCaptchaError(null)
                }}
                onRefresh={refreshCaptcha}
                error={captchaError}
                disabled={loading}
              />
            )}

            {lockLeft > 0 && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200/70 px-3 py-2 text-[12px] text-amber-800 leading-relaxed">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  连续输错 {MAX_FAILS} 次，账号已临时锁定，请在 <b className="num">{formatCountdown(lockLeft)}</b> 后重试。
                </span>
              </div>
            )}

            {error && (
              <div className="rounded-lg bg-rose-50 border border-rose-200/70 px-3 py-2 text-[12px] text-rose-700 leading-relaxed">
                {error}
              </div>
            )}
            {info && (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200/70 px-3 py-2 text-[12px] text-emerald-700 leading-relaxed">
                {info}
              </div>
            )}

            <button
              type="submit"
              className="btn btn-md btn-primary w-full !h-10 mt-1"
              disabled={loading || lockLeft > 0}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {mode === 'signup' ? '注册并登录' : mode === 'company' ? '提交入驻申请' : method === 'otp' ? (otpSent ? '验证并登录' : '发送验证码') : '登录'}
              {!loading && <ArrowRight className="w-4 h-4 ml-0.5" />}
            </button>
          </form>

          {otpStageVisible && otpSent && (
            <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
              邮件里若是 6 位数字，填到上方即可；若是登录链接，直接点它也能完成登录。
              收不到请先看垃圾箱；如需长期使用，可联系管理员配置企业邮件服务。
            </p>
          )}

          <p className="mt-5 text-[11px] leading-relaxed text-ink-400">
            密码登录连续失败 {MAX_FAILS} 次将锁定 15 分钟；验证码登录需先切换到「注册」创建账号。公司负责人请用「注册公司」提交入驻申请。
          </p>
        </div>
      </div>
    </div>
  )
}
