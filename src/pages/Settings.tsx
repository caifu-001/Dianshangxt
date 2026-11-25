import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Building2,
  Calculator,
  Check,
  Copy,
  Database,
  Download,
  ExternalLink,
  Info,
  Loader2,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
} from 'lucide-react'
import schemaSql from '../../supabase/schema.sql?raw'
import { useAuth } from '../context/AuthContext'
import { deleteAllRows, fetchRows, updateRow } from '../lib/db'
import { PROJECT_REF, SQL_EDITOR_URL, SUPABASE_URL } from '../lib/supabase'
import { seedDemoData } from '../lib/seed'
import { FX_DEFAULTS, FX_EDITABLE, resolveRates } from '../lib/fx'
import { Badge, Button, ConfirmDialog, Field, PageHeader, useToast } from '../components/ui'
import { PASSWORD_TONE_CLASS, checkPassword } from '../lib/password'
import { cn, downloadTextFile, fmtDateTime } from '../lib/utils'
import type { Profile } from '../lib/types'

const CLEAR_ORDER = ['orders', 'inventory', 'campaigns', 'creators', 'expenses', 'tasks', 'products', 'stores']

const COUNTS: Array<{ table: string; label: string }> = [
  { table: 'stores', label: '店铺' },
  { table: 'products', label: '商品' },
  { table: 'orders', label: '订单' },
  { table: 'inventory', label: '库存' },
  { table: 'campaigns', label: '广告' },
  { table: 'creators', label: '达人' },
  { table: 'tasks', label: '任务' },
  { table: 'expenses', label: '费用' },
]

export default function Settings() {
  const { user, profile, refreshProfile, schemaReady, changePassword } = useAuth()
  const { push } = useToast()
  const [fullName, setFullName] = useState('')
  const [company, setCompany] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [rates, setRates] = useState<Record<string, string>>({})
  const [savingRates, setSavingRates] = useState(false)
  const [copied, setCopied] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [savingPw, setSavingPw] = useState(false)

  const newPwCheck = checkPassword(newPw)

  useEffect(() => {
    setFullName(profile?.full_name ?? '')
    setCompany(profile?.company ?? '')
  }, [profile])

  useEffect(() => {
    const resolved = resolveRates(profile?.settings)
    const next: Record<string, string> = {}
    for (const code of FX_EDITABLE) next[code] = String(resolved[code] ?? '')
    setRates(next)
  }, [profile])

  useEffect(() => {
    if (!schemaReady) return
    let active = true
    ;(async () => {
      const next: Record<string, number> = {}
      for (const { table } of COUNTS) {
        try {
          const rows = await fetchRows<{ id: string }>(table, { columns: 'id' })
          next[table] = rows.length
        } catch {
          next[table] = 0
        }
      }
      if (active) setCounts(next)
    })()
    return () => {
      active = false
    }
  }, [schemaReady, seeding, clearing])

  async function saveProfile() {
    if (!user) return
    setSavingProfile(true)
    try {
      await updateRow<Profile>('profiles', user.id, {
        full_name: fullName.trim() || null,
        company: company.trim() || null,
      })
      await refreshProfile()
      push('资料已保存')
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSavingProfile(false)
    }
  }

  async function handleChangePassword() {
    if (!curPw) {
      push('请先填写当前密码', 'error')
      return
    }
    if (newPw !== confirmPw) {
      push('两次输入的新密码不一致', 'error')
      return
    }
    if (!newPwCheck.ok) {
      push(newPwCheck.hint, 'error')
      return
    }
    if (newPw === curPw) {
      push('新密码不能与当前密码相同', 'error')
      return
    }
    setSavingPw(true)
    try {
      await changePassword(curPw, newPw)
      setCurPw('')
      setNewPw('')
      setConfirmPw('')
      push('密码已更新，下次登录请使用新密码')
    } catch (err) {
      push(err instanceof Error ? err.message : '修改失败', 'error')
    } finally {
      setSavingPw(false)
    }
  }

  async function saveRates() {
    if (!user) return
    setSavingRates(true)
    try {
      const fx: Record<string, number> = {}
      for (const [code, value] of Object.entries(rates)) {
        const rate = Number(value)
        if (Number.isFinite(rate) && rate > 0) fx[code] = rate
      }
      await updateRow<Profile>('profiles', user.id, {
        settings: { ...(profile?.settings ?? {}), fx },
      })
      await refreshProfile()
      push('汇率已保存，报表将按新汇率折算')
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSavingRates(false)
    }
  }

  async function handleSeed() {
    setSeeding(true)
    try {
      await seedDemoData()
      push('演示数据已生成')
    } catch (err) {
      push(err instanceof Error ? err.message : '生成失败', 'error')
    } finally {
      setSeeding(false)
    }
  }

  async function handleClear() {
    if (!user) return
    setClearing(true)
    try {
      for (const table of CLEAR_ORDER) {
        await deleteAllRows(table, user.id)
      }
      push('数据已清空')
      setClearOpen(false)
      setCounts({})
    } catch (err) {
      push(err instanceof Error ? err.message : '清空失败', 'error')
    } finally {
      setClearing(false)
    }
  }

  async function copySql() {
    try {
      await navigator.clipboard.writeText(schemaSql)
      setCopied(true)
      push('脚本已复制')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      push('复制失败，请到「数据源」页面手动复制', 'error')
    }
  }

  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title="系统设置" description="账号资料、数据源与演示数据管理" />

      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-ink-100 flex items-center gap-2">
          <User className="w-4 h-4 text-ink-400" />
          <h3 className="text-[13.5px] font-semibold text-ink-900">账号资料</h3>
        </div>
        <div className="p-4 grid sm:grid-cols-2 gap-3">
          <Field label="登录邮箱">
            <input className="input bg-ink-50 text-ink-500" value={user?.email ?? ''} disabled />
          </Field>
          <Field label="注册时间">
            <input className="input bg-ink-50 text-ink-500" value={fmtDateTime(user?.created_at)} disabled />
          </Field>
          <Field label="你的称呼">
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="如：老王" />
          </Field>
          <Field label="公司 / 团队">
            <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="如：星野跨境" />
          </Field>
          <div className="sm:col-span-2 flex items-center gap-2">
            <Button variant="primary" onClick={saveProfile} loading={savingProfile}>
              保存资料
            </Button>
            <span className="text-[11px] text-ink-400">称呼会显示在左侧边栏与任务负责人推荐中</span>
          </div>
        </div>
      </div>

      <div className="card mt-3 overflow-hidden">
        <div className="px-4 py-3 border-b border-ink-100 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-ink-400" />
          <h3 className="text-[13.5px] font-semibold text-ink-900">账号安全</h3>
          <span className="text-[11px] text-ink-400">改密需先验证当前密码，防止会话被盗后直接接管账号</span>
        </div>
        <div className="p-4 grid sm:grid-cols-3 gap-3">
          <Field label="当前密码">
            <input
              className="input"
              type="password"
              value={curPw}
              onChange={(e) => setCurPw(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </Field>
          <Field label="新密码">
            <input
              className="input"
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="至少 8 位"
              autoComplete="new-password"
            />
          </Field>
          <Field label="确认新密码">
            <input
              className="input"
              type="password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              placeholder="再输一次"
              autoComplete="new-password"
            />
          </Field>

          {newPw.length > 0 && (
            <div className="sm:col-span-3">
              <div className="flex gap-1 max-w-[240px]">
                {[1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className={cn(
                      'h-1 flex-1 rounded-full transition-colors',
                      i <= newPwCheck.score ? PASSWORD_TONE_CLASS[newPwCheck.tone] : 'bg-ink-200',
                    )}
                  />
                ))}
              </div>
              <p className={cn('mt-1 text-[11px]', newPwCheck.ok ? 'text-ink-400' : 'text-rose-600')}>
                {newPwCheck.label ? `${newPwCheck.label} · ${newPwCheck.hint}` : newPwCheck.hint}
              </p>
            </div>
          )}

          <div className="sm:col-span-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={handleChangePassword} loading={savingPw}>
              更新密码
            </Button>
            <span className="text-[11px] text-ink-400">
              登录已启用图形验证码；密码连续输错 5 次锁定 15 分钟；也可切换为邮箱验证码登录
            </span>
          </div>
        </div>
      </div>

      <div className="card mt-3 overflow-hidden">
        <div className="px-4 py-3 border-b border-ink-100 flex items-center gap-2">
          <Calculator className="w-4 h-4 text-ink-400" />
          <h3 className="text-[13.5px] font-semibold text-ink-900">汇率与币种</h3>
          <span className="text-[11px] text-ink-400">用于多店铺报表折算，1 USD = ?</span>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {FX_EDITABLE.map((code) => (
              <div key={code}>
                <label className="label">{code}</label>
                <input
                  className="input num"
                  type="number"
                  step="0.0001"
                  value={rates[code] ?? ''}
                  onChange={(e) => setRates((r) => ({ ...r, [code]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={saveRates} loading={savingRates}>
              保存汇率
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const next: Record<string, string> = {}
                for (const code of FX_EDITABLE) next[code] = String(FX_DEFAULTS[code])
                setRates(next)
              }}
            >
              恢复默认
            </Button>
            <span className="text-[11px] text-ink-400">报表统一以 USD 为基准折算，可按当期实际结汇价调整</span>
          </div>
        </div>
      </div>

      <div className="card mt-3 overflow-hidden">
        <div className="px-4 py-3 border-b border-ink-100 flex items-center gap-2">
          <Database className="w-4 h-4 text-ink-400" />
          <h3 className="text-[13.5px] font-semibold text-ink-900">数据源</h3>
          <Badge tone={schemaReady ? 'green' : 'amber'} dot>
            {schemaReady ? '已连接' : '待初始化'}
          </Badge>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3 text-[12px]">
            <div className="rounded-lg bg-ink-50 border border-ink-100 px-3 py-2">
              <p className="text-[10.5px] text-ink-400">Supabase 项目</p>
              <p className="font-mono text-ink-700 mt-0.5 truncate">{PROJECT_REF}</p>
            </div>
            <div className="rounded-lg bg-ink-50 border border-ink-100 px-3 py-2">
              <p className="text-[10.5px] text-ink-400">REST Endpoint</p>
              <p className="font-mono text-ink-700 mt-0.5 truncate">{SUPABASE_URL.replace('https://', '')}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {COUNTS.map((c) => (
              <span key={c.table} className="chip bg-white text-ink-600 border-ink-200">
                {c.label}
                <span className="num font-semibold text-ink-800">{counts[c.table] ?? '—'}</span>
              </span>
            ))}
            <span className="chip bg-brand-50 text-brand-700 border-brand-200">
              合计
              <span className="num font-semibold">{totalRows}</span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} onClick={copySql}>
              {copied ? '已复制' : '复制建表脚本'}
            </Button>
            <a href={SQL_EDITOR_URL} target="_blank" rel="noreferrer" className="btn btn-sm btn-default">
              打开 SQL 编辑器
              <ExternalLink className="w-3 h-3" />
            </a>
            <Link to="/setup" className="btn btn-sm btn-ghost">
              数据源初始化向导
            </Link>
          </div>
        </div>
      </div>

      <div className="card mt-3 overflow-hidden">
        <div className="px-4 py-3 border-b border-ink-100 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-ink-400" />
          <h3 className="text-[13.5px] font-semibold text-ink-900">数据管理</h3>
        </div>
        <div className="divide-y divide-ink-100">
          <div className="p-4 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-ink-800">生成演示数据</p>
              <p className="mt-0.5 text-[11.5px] text-ink-500 leading-relaxed">
                创建 3 家店铺、11 个 SKU、近 60 天订单及广告 / 达人 / 任务数据，用于快速体验完整流程。
              </p>
            </div>
            <Button size="sm" onClick={handleSeed} loading={seeding} icon={seeding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}>
              生成
            </Button>
          </div>

          <div className="p-4 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-ink-800">导出初始化脚本</p>
              <p className="mt-0.5 text-[11.5px] text-ink-500 leading-relaxed">
                下载 schema.sql，可在新的 Supabase 项目中复用同一套表结构。
              </p>
            </div>
            <Button size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={() => downloadTextFile('schema.sql', schemaSql, 'text/plain;charset=utf-8')}>
              下载
            </Button>
          </div>

          <div className="p-4 flex flex-wrap items-center gap-3 bg-rose-50/40">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-rose-700">清空我的全部数据</p>
              <p className="mt-0.5 text-[11.5px] text-rose-600/70 leading-relaxed">
                删除当前账号下的店铺、商品、订单、库存、广告、达人、任务与费用记录，账号本身保留。不可恢复。
              </p>
            </div>
            <Button size="sm" variant="danger" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => setClearOpen(true)}>
              清空数据
            </Button>
          </div>
        </div>
      </div>

      <div className="card mt-3 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Info className="w-4 h-4 text-ink-400" />
          <h3 className="text-[13.5px] font-semibold text-ink-900">关于</h3>
        </div>
        <div className="grid sm:grid-cols-2 gap-2 text-[11.5px] text-ink-500">
          <p className="flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5 text-ink-300" />
            电商运营中台 v1.0 · Amazon & TikTok Shop
          </p>
          <p className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-ink-300" />
            React + Vite + Supabase（RLS 行级隔离）
          </p>
        </div>
        <p className="mt-2 text-[11px] text-ink-400 leading-relaxed">
          所有数据通过 Supabase 公开密钥访问，受行级权限策略保护：每个账号只能读写自己的数据。切勿在前端使用 service_role 密钥。
        </p>
      </div>

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={handleClear}
        loading={clearing}
        title="清空全部业务数据"
        confirmText="确认清空"
        message="将删除当前账号下所有店铺、商品、订单、库存、广告、达人、任务和费用记录，且无法恢复。建议先导出订单报表备份。"
      />
    </div>
  )
}
