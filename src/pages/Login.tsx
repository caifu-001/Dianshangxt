import { useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, BarChart3, Boxes, Loader2, Megaphone, ShieldCheck, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { cn } from '../lib/utils'

const FEATURES = [
  { icon: BarChart3, title: '利润核算', desc: '佣金、FBA、广告、退款逐笔拆解' },
  { icon: Boxes, title: '库存预警', desc: '可售天数与智能补货建议' },
  { icon: Megaphone, title: '广告监控', desc: 'ACOS / ROAS / 转化率实时看板' },
  { icon: Users, title: '达人合作', desc: 'TikTok 达人漏斗与带货 GMV' },
]

export default function Login() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setLoading(true)
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password)
      } else {
        if (!fullName.trim()) throw new Error('请填写你的称呼')
        if (password.length < 6) throw new Error('密码长度至少 6 位')
        const { needsConfirm } = await signUp(email.trim(), password, fullName.trim())
        if (needsConfirm) {
          setInfo('注册成功！请前往邮箱点击确认链接，然后回到这里登录。')
          setMode('signin')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      setLoading(false)
    }
  }

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
            数据存储于 Supabase，行级权限隔离，团队外不可见
          </div>
        </div>
      </div>

      {/* 右侧表单 */}
      <div className="flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-[360px]">
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center">
              <span className="text-white font-bold text-[13px]">DS</span>
            </div>
            <span className="font-semibold text-ink-900">电商运营中台</span>
          </div>

          <h2 className="text-[22px] font-semibold text-ink-900 tracking-tight">
            {mode === 'signin' ? '登录工作台' : '创建运营账号'}
          </h2>
          <p className="mt-1 text-[13px] text-ink-500">
            {mode === 'signin' ? '用邮箱登录，继续今天的运营工作' : '注册后即可建立店铺与商品档案'}
          </p>

          <div className="mt-6 flex p-0.5 rounded-lg bg-ink-100 border border-ink-200/60">
            {(['signin', 'signup'] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m)
                  setError(null)
                  setInfo(null)
                }}
                className={cn(
                  'flex-1 h-8 rounded-md text-[13px] font-medium transition-all',
                  mode === m ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-700',
                )}
              >
                {m === 'signin' ? '登录' : '注册'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-3.5">
            {mode === 'signup' && (
              <div>
                <label className="label">你的称呼</label>
                <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="如：老王" autoComplete="name" />
              </div>
            )}
            <div>
              <label className="label">邮箱</label>
              <input
                className="input"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
              />
            </div>
            <div>
              <label className="label">密码</label>
              <input
                className="input"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? '至少 6 位' : '••••••••'}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              />
            </div>

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

            <button type="submit" className="btn btn-md btn-primary w-full !h-10 mt-1" disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {mode === 'signin' ? '登录' : '注册并登录'}
              {!loading && <ArrowRight className="w-4 h-4 ml-0.5" />}
            </button>
          </form>

          <p className="mt-5 text-[11px] leading-relaxed text-ink-400">
            首次使用请在 Supabase 中执行建表脚本，登录后系统会自动检测并提供一键复制。
          </p>
        </div>
      </div>
    </div>
  )
}
