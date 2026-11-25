import { useEffect, useRef, useState } from 'react'
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
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  Eraser,
} from 'lucide-react'
import schemaSql from '../../supabase/schema.sql?raw'
import { useAuth } from '../context/AuthContext'
import { callRpc, deleteAllRows, fetchRows, updateRow } from '../lib/db'
import { PROJECT_REF, SQL_EDITOR_URL, SUPABASE_URL } from '../lib/supabase'
import { seedDemoData } from '../lib/seed'
import {
  DEFAULT_FX_CODES,
  FX_CATALOG,
  FX_DEFAULTS,
  fetchLatestFxRates,
  fxLabel,
  pickCatalogRates,
  resolveFxCodes,
  resolveFxMeta,
  resolveRates,
  type FxMeta,
} from '../lib/fx'
import { Badge, Button, ConfirmDialog, Field, Modal, PageHeader, useToast } from '../components/ui'
import { PASSWORD_TONE_CLASS, checkPassword } from '../lib/password'
import { cn, downloadTextFile, fmtDateTime } from '../lib/utils'
import type { Profile } from '../lib/types'

interface DemoStat {
  module: string
  table_name: string
  row_count: number
}

// 清空顺序按外键依赖排：子表在前、主表在后（级联删除也会兜底）
const CLEAR_ORDER = [
  'purchase_payments',
  'stock_movements',
  'orders',
  'inventory',
  'purchase_items',
  'supplier_products',
  'purchase_orders',
  'suppliers',
  'campaigns',
  'creators',
  'competitors',
  'expenses',
  'tasks',
  'products',
  'stores',
]

const COUNTS: Array<{ table: string; label: string }> = [
  { table: 'stores', label: '店铺' },
  { table: 'products', label: '商品' },
  { table: 'orders', label: '订单' },
  { table: 'inventory', label: '库存' },
  { table: 'purchase_orders', label: '采购单' },
  { table: 'supplier_products', label: '供应商产品' },
  { table: 'stock_movements', label: '库存流水' },
  { table: 'purchase_payments', label: '采购付款' },
  { table: 'suppliers', label: '供应商' },
  { table: 'campaigns', label: '广告' },
  { table: 'creators', label: '达人' },
  { table: 'competitors', label: '竞品' },
  { table: 'tasks', label: '任务' },
  { table: 'expenses', label: '费用' },
]

export default function Settings() {
  const { user, profile, refreshProfile, schemaReady, changePassword, can, currentCompany, isSuperAdmin } = useAuth()
  // 汇率、演示数据、清空数据属于系统级操作，由 system.manage 权限决定
  const canManageSystem = can('system.manage')
  const { push } = useToast()
  const [fullName, setFullName] = useState('')
  const [company, setCompany] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [rates, setRates] = useState<Record<string, string>>({})
  const [savingRates, setSavingRates] = useState(false)
  const [fxCodes, setFxCodes] = useState<string[]>(DEFAULT_FX_CODES)
  const [fxMeta, setFxMeta] = useState<FxMeta | null>(null)
  const [updatingFx, setUpdatingFx] = useState(false)
  const [showCodePicker, setShowCodePicker] = useState(false)
  const [selectedCodes, setSelectedCodes] = useState<string[]>(DEFAULT_FX_CODES)
  const [codeQuery, setCodeQuery] = useState('')
  const [catalogCodes, setCatalogCodes] = useState<string[]>([])
  const autoFxDone = useRef(false)
  const [copied, setCopied] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [counts, setCounts] = useState<Record<string, number>>({})
  // 演示数据清理（仅超管）
  const [demoOpen, setDemoOpen] = useState(false)
  const [demoStats, setDemoStats] = useState<DemoStat[]>([])
  const [demoLoading, setDemoLoading] = useState(false)
  const [demoPurging, setDemoPurging] = useState(false)
  const [demoConfirm, setDemoConfirm] = useState('')
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
    const codes = resolveFxCodes(profile?.settings)
    const resolved = resolveRates(profile?.settings)
    const next: Record<string, string> = {}
    for (const code of codes) next[code] = String(resolved[code] ?? '')
    setRates(next)
    setFxCodes(codes)
    setSelectedCodes(codes)
    setFxMeta(resolveFxMeta(profile?.settings))
  }, [profile])

  // 距上次联网更新超过 24 小时则在后台静默拉一次；失败不打扰用户
  useEffect(() => {
    if (!canManageSystem || !user || autoFxDone.current) return
    const meta = resolveFxMeta(profile?.settings)
    if (meta?.updated_at && Date.now() - new Date(meta.updated_at).getTime() < 24 * 60 * 60 * 1000) return
    autoFxDone.current = true
    void handleFetchFx(true)
  }, [canManageSystem, user, profile?.settings])

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

  /** 统一写入汇率 / 币种清单 / 更新来源；quiet 用于后台静默更新 */
  async function persistFx(
    nextRates: Record<string, string>,
    nextCodes: string[],
    meta: FxMeta | null,
    quiet = false,
  ): Promise<boolean> {
    if (!user) return false
    const fx: Record<string, number> = {}
    for (const [code, value] of Object.entries(nextRates)) {
      const rate = Number(value)
      if (Number.isFinite(rate) && rate > 0) fx[code] = rate
    }
    try {
      await updateRow<Profile>('profiles', user.id, {
        settings: {
          ...(profile?.settings ?? {}),
          fx,
          fx_codes: nextCodes,
          fx_meta: meta ?? null,
        },
      })
      await refreshProfile()
      if (!quiet) push('汇率已保存，报表将按新汇率折算')
      return true
    } catch (err) {
      if (!quiet) push(err instanceof Error ? err.message : '保存失败', 'error')
      return false
    }
  }

  async function saveRates() {
    setSavingRates(true)
    try {
      await persistFx(rates, fxCodes, fxMeta)
    } finally {
      setSavingRates(false)
    }
  }

  /** 联网拉取：依次尝试多个免费源，成功后直接保存并刷新全局汇率 */
  async function handleFetchFx(quiet = false) {
    if (!user) return
    setUpdatingFx(true)
    try {
      const quote = await fetchLatestFxRates()
      const picked = pickCatalogRates(quote.rates)
      if (picked.codes.length < 5) throw new Error('有效币种过少')
      const nextCodes = Array.from(new Set(['USD', ...picked.codes]))
      const resolved = { ...FX_DEFAULTS, ...quote.rates }
      const nextRates: Record<string, string> = {}
      for (const code of nextCodes) nextRates[code] = String(resolved[code] ?? '')
      const meta: FxMeta = {
        updated_at: quote.fetchedAt,
        source: quote.source,
        market_date: quote.marketDate,
      }
      const ok = await persistFx(nextRates, nextCodes, meta, quiet)
      if (!ok) return
      setCatalogCodes(nextCodes)
      setFxCodes(nextCodes)
      setSelectedCodes(nextCodes)
      setRates(nextRates)
      setFxMeta(meta)
      if (!quiet) push(`已联网更新 ${nextCodes.length} 个币种汇率（${quote.source}）`)
    } catch (err) {
      if (!quiet) push(err instanceof Error ? err.message : '联网更新失败，原有汇率未改动', 'error')
    } finally {
      setUpdatingFx(false)
    }
  }

  /** 应用勾选的币种到设置页与全部业务下拉 */
  async function applyFxCodes() {
    if (selectedCodes.length === 0) {
      push('至少保留一个币种', 'error')
      return
    }
    const codes = Array.from(new Set(['USD', ...selectedCodes]))
    const resolved = resolveRates(profile?.settings)
    const nextRates: Record<string, string> = {}
    for (const code of codes) nextRates[code] = String(resolved[code] ?? FX_DEFAULTS[code] ?? '')
    setSavingRates(true)
    try {
      const ok = await persistFx(nextRates, codes, fxMeta)
      if (!ok) return
      setFxCodes(codes)
      setRates(nextRates)
      setShowCodePicker(false)
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

  async function openDemoPurge() {
    setDemoConfirm('')
    setDemoOpen(true)
    setDemoLoading(true)
    try {
      setDemoStats(await callRpc<DemoStat[]>('demo_data_stats'))
    } catch (err) {
      push(err instanceof Error ? err.message : '读取统计失败', 'error')
    } finally {
      setDemoLoading(false)
    }
  }

  async function handlePurgeDemo() {
    if (demoConfirm !== 'PURGE DEMO') return
    setDemoPurging(true)
    try {
      const result = await callRpc<Record<string, number>>('purge_demo_data', { p_confirm: 'PURGE DEMO' })
      const total = Object.values(result ?? {}).reduce((a, b) => a + Number(b || 0), 0)
      push(`已清理演示数据，共删除 ${total} 条`)
      setDemoOpen(false)
      setDemoStats([])
      setDemoConfirm('')
    } catch (err) {
      push(err instanceof Error ? err.message : '清理失败', 'error')
    } finally {
      setDemoPurging(false)
    }
  }

  async function handleClear() {
    if (!user) return
    setClearing(true)
    try {
      for (const table of CLEAR_ORDER) {
        try {
          await deleteAllRows(table)
        } catch (err) {
          // 旧库还没跑过新版脚本时，新表不存在；跳过即可，不影响清空已有业务数据
          const msg = err instanceof Error ? err.message : ''
          if (!/数据表还没创建/.test(msg)) throw err
        }
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
      push('复制失败，请联系系统管理员', 'error')
    }
  }

  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title="系统设置" description="账号资料、所属公司与偏好设置" />

      {!canManageSystem && (
        <div className="rounded-xl border border-amber-200/70 bg-amber-50 px-3.5 py-2.5 mb-3 flex items-start gap-2">
          <Info className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-[11.5px] leading-relaxed text-amber-800">
            你的角色没有<b>系统配置</b>权限：可以维护自己的资料与密码，汇率、演示数据、清空数据等操作需要管理员权限。
            如需调整，请让管理员在「人员与账号」中为你调整系统角色。
          </p>
        </div>
      )}

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
          <Field label="公司 / 团队（资料备注）" hint="可填写部门或团队名；系统归属公司以「所属公司」卡片为准">
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
          <Building2 className="w-4 h-4 text-ink-400" />
          <h3 className="text-[13.5px] font-semibold text-ink-900">所属公司</h3>
          {isSuperAdmin && <Badge tone="gray">当前管理视角</Badge>}
        </div>
        <div className="p-4">
          {currentCompany ? (
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="公司名称">
                <input className="input bg-ink-50 text-ink-500" value={currentCompany.name} disabled />
              </Field>
              <Field label="公司编码">
                <input className="input bg-ink-50 text-ink-500" value={currentCompany.code || '—'} disabled />
              </Field>
              <Field label="公司状态">
                <input
                  className="input bg-ink-50 text-ink-500"
                  value={currentCompany.status === 'active' ? '正常启用' : '已停用'}
                  disabled
                />
              </Field>
              <Field label="成员数量">
                <input className="input bg-ink-50 text-ink-500" value={`${currentCompany.member_count ?? 0} 人`} disabled />
              </Field>
              <div className="sm:col-span-2">
                <Field label="创建时间">
                  <input className="input bg-ink-50 text-ink-500" value={fmtDateTime(currentCompany.created_at)} disabled />
                </Field>
              </div>
              <p className="sm:col-span-2 text-[11px] text-ink-400 leading-relaxed">
                这是你的账号在公司体系中的真实归属，右上角也同步显示。公司信息由平台统一管理，如需修改请联系超级管理员。
              </p>
            </div>
          ) : (
            <p className="text-[12px] text-ink-500 leading-relaxed">
              当前账号未归属任何公司，或系统尚未完成升级。请联系系统管理员处理后查看。
            </p>
          )}
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
        <div className="px-4 py-3 border-b border-ink-100 flex flex-wrap items-center gap-2">
          <Calculator className="w-4 h-4 text-ink-400" />
          <h3 className="text-[13.5px] font-semibold text-ink-900">汇率与币种</h3>
          <span className="text-[11px] text-ink-400">用于多店铺报表折算，1 USD = ?</span>
          <div className="ml-auto flex items-center gap-2">
            {fxMeta && (
              <span
                className="text-[10.5px] text-ink-400 num"
                title={fxMeta.market_date ? `行情日期 ${fxMeta.market_date}` : undefined}
              >
                {fmtDateTime(fxMeta.updated_at)} · {fxMeta.source}
              </span>
            )}
            <Button
              size="sm"
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              onClick={() => void handleFetchFx()}
              loading={updatingFx}
              disabled={!canManageSystem}
            >
              联网更新
            </Button>
          </div>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
            {fxCodes.map((code) => (
              <div key={code}>
                <label className="label">{fxLabel(code)}</label>
                <input
                  className="input num"
                  type="number"
                  step="0.0001"
                  value={rates[code] ?? ''}
                  disabled={!canManageSystem}
                  onChange={(e) => setRates((r) => ({ ...r, [code]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={saveRates} loading={savingRates} disabled={!canManageSystem}>
              保存汇率
            </Button>
            <Button
              size="sm"
              disabled={!canManageSystem}
              onClick={() => {
                const next: Record<string, string> = {}
                for (const code of fxCodes) next[code] = String(FX_DEFAULTS[code] ?? '')
                setRates(next)
                setFxMeta(null)
              }}
            >
              恢复默认
            </Button>
            <Button size="sm" disabled={!canManageSystem} onClick={() => setShowCodePicker((v) => !v)}>
              管理币种
            </Button>
            <span className="text-[11px] text-ink-400">
              公开汇率源每日更新，超过 24 小时自动同步；也可按实际结汇价手改后保存
            </span>
          </div>

          {showCodePicker && (
            <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50/40 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input !h-8 !w-52"
                  placeholder="搜索代码或名称"
                  value={codeQuery}
                  onChange={(e) => setCodeQuery(e.target.value)}
                />
                <span className="text-[11px] text-ink-400">已选 {selectedCodes.length} 个 · 修改后点「应用币种」</span>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5 max-h-56 overflow-y-auto pr-1">
                {Array.from(new Set([...Object.keys(FX_CATALOG), ...catalogCodes, ...fxCodes]))
                  .filter((code) => {
                    const q = codeQuery.trim().toLowerCase()
                    return !q || code.toLowerCase().includes(q) || fxLabel(code).toLowerCase().includes(q)
                  })
                  .map((code) => (
                    <label
                      key={code}
                      className="flex items-center gap-1.5 rounded-md border border-ink-200 bg-white px-2 py-1.5 text-[11px] text-ink-700 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="accent-brand-600"
                        checked={selectedCodes.includes(code)}
                        onChange={(e) =>
                          setSelectedCodes((prev) =>
                            e.target.checked
                              ? Array.from(new Set([...prev, code]))
                              : prev.filter((c) => c !== code),
                          )
                        }
                      />
                      <span className="truncate">{fxLabel(code)}</span>
                    </label>
                  ))}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" onClick={applyFxCodes} loading={savingRates}>
                  应用币种
                </Button>
                <Button size="sm" onClick={() => setShowCodePicker(false)}>收起</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {isSuperAdmin && (
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
      )}

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
            <Button size="sm" onClick={handleSeed} loading={seeding} disabled={!canManageSystem} icon={seeding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}>
              生成
            </Button>
          </div>

          {isSuperAdmin && (
            <div className="p-4 flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink-800">清理演示数据</p>
                <p className="mt-0.5 text-[11.5px] text-ink-500 leading-relaxed">
                  仅删除「生成演示数据」产生的记录，按固定店铺 / SKU / 编号特征识别，不影响真实录入的数据。按当前管理视角公司清理。
                </p>
              </div>
              <Button size="sm" variant="danger" onClick={openDemoPurge} icon={<Eraser className="w-3.5 h-3.5" />}>
                清理
              </Button>
            </div>
          )}

          {isSuperAdmin && (
            <div className="p-4 flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink-800">导出初始化脚本</p>
                <p className="mt-0.5 text-[11.5px] text-ink-500 leading-relaxed">
                  下载 schema.sql，可在新项目中复用同一套表结构。
                </p>
              </div>
              <Button size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={() => downloadTextFile('schema.sql', schemaSql, 'text/plain;charset=utf-8')}>
                下载
              </Button>
            </div>
          )}

          <div className="p-4 flex flex-wrap items-center gap-3 bg-rose-50/40">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-rose-700">清空我的全部数据</p>
              <p className="mt-0.5 text-[11.5px] text-rose-600/70 leading-relaxed">
                删除店铺、商品、订单、库存、采购、广告、达人、竞品、任务与费用记录，账号本身保留。不可恢复。
              </p>
            </div>
            <Button size="sm" variant="danger" disabled={!canManageSystem} icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => setClearOpen(true)}>
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
          {isSuperAdmin && (
            <p className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-ink-300" />
              React + Vite + Supabase（RLS 行级隔离）
            </p>
          )}
        </div>
        {isSuperAdmin && (
          <p className="mt-2 text-[11px] text-ink-400 leading-relaxed">
            所有数据通过 Supabase 公开密钥访问，受行级权限策略保护：每个账号只能读写自己的数据。切勿在前端使用 service_role 密钥。
          </p>
        )}
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

      <Modal
        open={demoOpen}
        onClose={() => setDemoOpen(false)}
        title="清理演示数据"
        width="max-w-lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setDemoOpen(false)}>取消</Button>
            <Button
              size="sm"
              variant="danger"
              loading={demoPurging}
              disabled={demoConfirm !== 'PURGE DEMO'}
              onClick={handlePurgeDemo}
            >
              确认清理
            </Button>
          </div>
        }
      >
        <p className="text-[12px] text-ink-500 leading-relaxed">
          仅清理「生成演示数据」产生的记录：按演示店铺的 Seller ID、SKU 前缀（AH-/LB-/GL-）、固定供应商与档案编号识别，<b className="text-ink-700">不会删除真实录入的数据</b>。当前管理视角公司以外的记录不受影响。此操作不可恢复。
        </p>
        <div className="mt-3 rounded-lg border border-ink-100 bg-ink-50/50 max-h-48 overflow-auto">
          {demoLoading ? (
            <p className="p-3 text-[12px] text-ink-400">正在统计…</p>
          ) : demoStats.length === 0 ? (
            <p className="p-3 text-[12px] text-ink-500">当前公司视角下未检测到演示数据。</p>
          ) : (
            <div className="divide-y divide-ink-100">
              {demoStats.map((s) => (
                <div key={s.table_name} className="flex items-center justify-between px-3 py-1.5 text-[12px]">
                  <span className="text-ink-600">{s.module}</span>
                  <span className="tabular-nums font-medium text-ink-800">{s.row_count} 条</span>
                </div>
              ))}
              <div className="flex items-center justify-between px-3 py-2 text-[12px] font-semibold bg-white">
                <span className="text-ink-800">合计</span>
                <span className="tabular-nums text-rose-600">
                  {demoStats.reduce((a, s) => a + Number(s.row_count || 0), 0)} 条
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="mt-4">
          <Field label="请输入 PURGE DEMO 以确认">
            <input
              value={demoConfirm}
              onChange={(e) => setDemoConfirm(e.target.value)}
              placeholder="PURGE DEMO"
              className="input"
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
