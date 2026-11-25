import { useMemo, useState } from 'react'
import {
  Award,
  BarChart3,
  Info,
  Lock,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Target,
  Trash2,
  TrendingUp,
  Users,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { applyPerformanceScore } from '../lib/flow'
import { callRpc, deleteRow, fetchRows, insertRow, updateRow } from '../lib/db'
import type { Department, PerformanceGrade, PerformanceReview } from '../lib/types'
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBlock,
  Field,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
  useToast,
} from '../components/ui'
import { cn, fmtDateTime, num } from '../lib/utils'

/** 通讯录（team_directory）：只含公开字段，普通成员也能读到 */
interface DirectoryRow {
  id: string
  full_name: string | null
  email: string | null
  role: string
  department_id: string | null
  position_id: string | null
  role_id: string | null
  status: string
  employment_status: string
  hire_date: string | null
  is_leader: boolean
}

const GRADE_META: Record<PerformanceGrade, { label: string; tone: 'violet' | 'green' | 'blue' | 'amber' | 'red'; ring: string }> = {
  S: { label: 'S 卓越', tone: 'violet', ring: 'bg-violet-500' },
  A: { label: 'A 优秀', tone: 'green', ring: 'bg-emerald-500' },
  B: { label: 'B 达标', tone: 'blue', ring: 'bg-brand-500' },
  C: { label: 'C 待改进', tone: 'amber', ring: 'bg-amber-500' },
  D: { label: 'D 不达标', tone: 'red', ring: 'bg-rose-500' },
}

const GRADES: PerformanceGrade[] = ['S', 'A', 'B', 'C', 'D']

const KPI_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'sales', label: '业绩达成' },
  { key: 'execution', label: '执行效率' },
  { key: 'collaboration', label: '团队协作' },
  { key: 'growth', label: '成长潜力' },
]

function gradeOf(score: number): PerformanceGrade {
  if (score >= 90) return 'S'
  if (score >= 80) return 'A'
  if (score >= 70) return 'B'
  if (score >= 60) return 'C'
  return 'D'
}

function currentPeriod() {
  const d = new Date()
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`
}

interface ReviewForm {
  id?: string
  profile_id: string
  period: string
  score: string
  grade: PerformanceGrade
  kpi: Record<string, string>
  summary: string
  improvement: string
  status: 'draft' | 'published'
}

function emptyForm(period: string): ReviewForm {
  return {
    profile_id: '',
    period,
    score: '80',
    grade: 'A',
    kpi: { sales: '80', execution: '80', collaboration: '80', growth: '80' },
    summary: '',
    improvement: '',
    status: 'published',
  }
}

export default function Performance() {
  const { user, profile: me, can } = useAuth()
  const { push } = useToast()
  const canView = can('performance.view')
  const canEdit = can('performance.edit')

  const { data, loading, error, reload } = useAsync(async () => {
    const [reviews, directory, departments] = await Promise.all([
      fetchRows<PerformanceReview>('performance_reviews', { order: { column: 'updated_at', ascending: false } }),
      callRpc<DirectoryRow[]>('team_directory'),
      fetchRows<Department>('departments', { order: { column: 'sort_order' } }),
    ])
    return { reviews, directory, departments }
  }, [])

  const reviews = useMemo(() => data?.reviews ?? [], [data])
  const directory = useMemo(() => data?.directory ?? [], [data])
  const departments = useMemo(() => data?.departments ?? [], [data])

  const personById = useMemo(() => new Map(directory.map((p) => [p.id, p])), [directory])
  const deptById = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments])

  const periods = useMemo(() => {
    const set = new Set<string>([currentPeriod(), ...reviews.map((r) => r.period)])
    return Array.from(set).sort((a, b) => b.localeCompare(a))
  }, [reviews])

  const [period, setPeriod] = useState(currentPeriod())
  const [query, setQuery] = useState('')
  const [deptFilter, setDeptFilter] = useState('')
  const [modal, setModal] = useState(false)
  const [form, setForm] = useState<ReviewForm>(() => emptyForm(currentPeriod()))
  const [saving, setSaving] = useState(false)
  const [toDelete, setToDelete] = useState<PerformanceReview | null>(null)
  const [scoring, setScoring] = useState(false)
  const [scoringId, setScoringId] = useState('')

  const periodReviews = useMemo(() => reviews.filter((r) => r.period === period), [reviews, period])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return periodReviews
      .map((r) => {
        const person = personById.get(r.profile_id)
        return { review: r, person, deptId: r.department_id ?? person?.department_id ?? null }
      })
      .filter((row) => {
        if (deptFilter && row.deptId !== deptFilter) return false
        if (!q) return true
        const name = row.person?.full_name ?? ''
        const email = row.person?.email ?? ''
        const dept = row.deptId ? deptById.get(row.deptId)?.name ?? '' : ''
        return name.toLowerCase().includes(q) || email.toLowerCase().includes(q) || dept.includes(q)
      })
      .sort((a, b) => b.review.score - a.review.score)
  }, [periodReviews, personById, query, deptFilter, deptById])

  const stats = useMemo(() => {
    const active = directory.filter((p) => p.employment_status === 'active' && p.status === 'active')
    const scored = new Set(periodReviews.map((r) => r.profile_id))
    const avg = periodReviews.length
      ? periodReviews.reduce((sum, r) => sum + Number(r.score), 0) / periodReviews.length
      : 0
    const high = periodReviews.filter((r) => r.grade === 'S' || r.grade === 'A').length
    return {
      scored: periodReviews.length,
      avg,
      high,
      highRate: periodReviews.length ? (high / periodReviews.length) * 100 : 0,
      pending: active.filter((p) => !scored.has(p.id)).length,
      active: active.length,
    }
  }, [periodReviews, directory])

  const deptStats = useMemo(() => {
    const map = new Map<string, { name: string; total: number; sum: number; people: number }>()
    for (const r of periodReviews) {
      const deptId = r.department_id ?? personById.get(r.profile_id)?.department_id
      const name = deptId ? deptById.get(deptId)?.name : '未归岗'
      const key = deptId ?? 'none'
      const cur = map.get(key) ?? { name: name ?? '未归岗', total: 0, sum: 0, people: 0 }
      cur.total += 1
      cur.sum += Number(r.score)
      map.set(key, cur)
    }
    for (const p of directory) {
      if (p.employment_status !== 'active' || p.status !== 'active') continue
      const key = p.department_id ?? 'none'
      const name = p.department_id ? deptById.get(p.department_id)?.name ?? '未归岗' : '未归岗'
      const cur = map.get(key) ?? { name, total: 0, sum: 0, people: 0 }
      cur.people += 1
      map.set(key, cur)
    }
    return Array.from(map.entries())
      .map(([id, v]) => ({ id, name: v.name, people: v.people, avg: v.total ? v.sum / v.total : 0, scored: v.total }))
      .filter((d) => d.people > 0 || d.scored > 0)
      .sort((a, b) => b.avg - a.avg)
  }, [periodReviews, personById, deptById, directory])

  const mine = useMemo(
    () => reviews.find((r) => r.profile_id === me?.id && r.period === period) ?? null,
    [reviews, me?.id, period],
  )

  function openCreate() {
    setForm({ ...emptyForm(period), period })
    setModal(true)
  }

  function openEdit(r: PerformanceReview) {
    setForm({
      id: r.id,
      profile_id: r.profile_id,
      period: r.period,
      score: String(r.score),
      grade: r.grade,
      kpi: Object.fromEntries(KPI_FIELDS.map((f) => [f.key, String(r.kpi?.[f.key] ?? '')])) as Record<string, string>,
      summary: r.summary ?? '',
      improvement: r.improvement ?? '',
      status: r.status,
    })
    setModal(true)
  }

  async function save() {
    if (!form.profile_id) return push('请选择被评成员', 'error')
    if (!form.period.trim()) return push('请填写考核周期', 'error')
    const score = Number(form.score)
    if (!Number.isFinite(score) || score < 0 || score > 100) return push('分数需在 0 - 100 之间', 'error')

    setSaving(true)
    try {
      const kpi: Record<string, number> = {}
      for (const f of KPI_FIELDS) {
        const v = Number(form.kpi[f.key])
        if (Number.isFinite(v) && v > 0) kpi[f.key] = Math.min(100, v)
      }
      const payload = {
        profile_id: form.profile_id,
        period: form.period.trim(),
        department_id: personById.get(form.profile_id)?.department_id ?? null,
        reviewer_id: user?.id ?? null,
        score,
        grade: form.grade,
        kpi,
        summary: form.summary.trim() || null,
        improvement: form.improvement.trim() || null,
        status: form.status,
        updated_at: new Date().toISOString(),
      }
      if (form.id) await updateRow<PerformanceReview>('performance_reviews', form.id, payload)
      else await insertRow<PerformanceReview>('performance_reviews', payload)
      push(form.id ? '绩效已更新' : '绩效已录入')
      setModal(false)
      setPeriod(payload.period)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate key|unique/i.test(msg) ? '该成员在这个周期已有绩效记录，请在列表里直接编辑' : msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  /** 按订单 / 采购 / 任务的真实数据重算一个人 */
  async function scoreOne(person: DirectoryRow) {
    setScoringId(person.id)
    try {
      const m = await applyPerformanceScore(person.id, period)
      push(`${person.full_name || person.email} 已按数据算分：${m.score} 分（${m.grade}）`)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '算分失败', 'error')
    } finally {
      setScoringId('')
    }
  }

  /** 批量：本期所有在职成员按数据算分 */
  async function scoreAll() {
    const targets = directory.filter(
      (p) => p.status === 'active' && (p.employment_status ?? 'active') === 'active',
    )
    if (!targets.length) return push('没有可算分的在职成员', 'error')
    setScoring(true)
    let ok = 0
    let failed = 0
    try {
      for (const p of targets) {
        try {
          await applyPerformanceScore(p.id, period)
          ok += 1
        } catch {
          failed += 1
        }
      }
      push(`已按真实数据重算 ${ok} 人的绩效${failed ? `，${failed} 人失败` : ''}`)
      reload()
    } finally {
      setScoring(false)
    }
  }

  async function remove() {
    if (!toDelete) return
    setSaving(true)
    try {
      await deleteRow('performance_reviews', toDelete.id)
      push('绩效记录已删除')
      setToDelete(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  /** 未评成员：方便 HR 一眼看到还差谁 */
  const pendingPeople = useMemo(() => {
    const scored = new Set(periodReviews.map((r) => r.profile_id))
    return directory.filter(
      (p) =>
        p.employment_status === 'active' &&
        p.status === 'active' &&
        !scored.has(p.id) &&
        (!deptFilter || p.department_id === deptFilter),
    )
  }, [directory, periodReviews, deptFilter])

  const memberOptions = useMemo(
    () =>
      directory
        .filter((p) => p.employment_status === 'active')
        .map((p) => ({
          value: p.id,
          label: `${p.full_name || p.email || '未命名'}${p.department_id ? ` · ${deptById.get(p.department_id)?.name ?? ''}` : ' · 未归岗'}`,
        })),
    [directory, deptById],
  )

  return (
    <div>
      <PageHeader
        title="绩效管理"
        description="按考核周期记录评分与评语。人力资源部可录入与查看，成员本人只能看到自己的结果。"
        actions={
          <>
            <Select
              value={period}
              onChange={setPeriod}
              options={periods.map((p) => ({ value: p, label: p }))}
              className="w-[120px]"
            />
            {canEdit && (
              <Button icon={<Sparkles className="w-3.5 h-3.5" />} onClick={scoreAll} loading={scoring}>
                按数据算分
              </Button>
            )}
            {canEdit && (
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
                录入绩效
              </Button>
            )}
          </>
        }
      />

      {!canView && (
        <div className="rounded-xl border border-ink-200/70 bg-ink-50 px-3.5 py-2.5 mb-3 flex items-start gap-2">
          <Lock className="w-3.5 h-3.5 text-ink-400 mt-0.5 shrink-0" />
          <p className="text-[11.5px] leading-relaxed text-ink-500">
            你当前只能查看自己的绩效结果。团队评分与排名仅对人力资源部、你的部门负责人以及具备
            「绩效管理 · 查看」权限的角色开放。
          </p>
        </div>
      )}
      {!canEdit && canView && (
        <div className="rounded-xl border border-ink-200/70 bg-ink-50 px-3.5 py-2.5 mb-3 flex items-start gap-2">
          <Lock className="w-3.5 h-3.5 text-ink-400 mt-0.5 shrink-0" />
          <p className="text-[11.5px] leading-relaxed text-ink-500">
            你可以查看团队绩效，但录入与评定由人力资源部（或具备「绩效管理 · 编辑」的角色）完成。
          </p>
        </div>
      )}

      {canView && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-3">
        {[
          { label: '本期已评', value: `${stats.scored}`, sub: `/ ${stats.active} 在职`, icon: Users, tone: 'text-ink-900' },
          { label: '平均分', value: stats.avg ? num(stats.avg, 1) : '—', sub: period, icon: BarChart3, tone: 'text-brand-600' },
          {
            label: '高绩效占比',
            value: stats.scored ? `${num(stats.highRate, 0)}%` : '—',
            sub: `S/A 共 ${stats.high} 人`,
            icon: TrendingUp,
            tone: 'text-emerald-600',
          },
          {
            label: '待评人数',
            value: `${stats.pending}`,
            sub: stats.pending ? '需要补录' : '全部完成',
            icon: Target,
            tone: stats.pending ? 'text-amber-600' : 'text-ink-400',
          },
        ].map((k) => (
          <div key={k.label} className="card px-3.5 py-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-ink-400">{k.label}</span>
              <k.icon className="w-3.5 h-3.5 text-ink-300" />
            </div>
            <p className={cn('num text-[22px] font-semibold mt-1 leading-none', k.tone)}>{k.value}</p>
            <p className="mt-1 text-[10.5px] text-ink-400 truncate">{k.sub}</p>
          </div>
        ))}
        </div>
      )}

      <div className={cn('grid gap-3 mb-3', canView && 'lg:grid-cols-[1fr_320px]')}>
        {/* 我的绩效 */}
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Award className="w-4 h-4 text-amber-500" />
            <h3 className="text-[13px] font-semibold text-ink-900">我的绩效 · {period}</h3>
            {mine && <Badge tone={GRADE_META[mine.grade].tone}>{GRADE_META[mine.grade].label}</Badge>}
          </div>
          {mine ? (
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex items-center gap-3 sm:w-[190px] shrink-0">
                <div className="relative w-16 h-16 rounded-full grid place-items-center bg-ink-50">
                  <svg className="absolute inset-0 -rotate-90" viewBox="0 0 64 64">
                    <circle cx="32" cy="32" r="28" fill="none" stroke="#eceff4" strokeWidth="6" />
                    <circle
                      cx="32"
                      cy="32"
                      r="28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="6"
                      strokeLinecap="round"
                      strokeDasharray={`${(Number(mine.score) / 100) * 176} 176`}
                      className={cn(
                        mine.grade === 'S' || mine.grade === 'A'
                          ? 'text-emerald-500'
                          : mine.grade === 'B'
                            ? 'text-brand-500'
                            : 'text-amber-500',
                      )}
                    />
                  </svg>
                  <span className="num text-[17px] font-semibold text-ink-900">{num(mine.score, 0)}</span>
                </div>
                <div className="min-w-0">
                  <p className="text-[12px] text-ink-500">评价人</p>
                  <p className="text-[12.5px] text-ink-800 truncate">
                    {mine.reviewer_id ? personById.get(mine.reviewer_id)?.full_name ?? '—' : '—'}
                  </p>
                  <p className="mt-1 text-[10.5px] text-ink-400">{fmtDateTime(mine.updated_at)}</p>
                </div>
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {KPI_FIELDS.map((f) => (
                    <div key={f.key} className="flex items-center gap-2">
                      <span className="text-[11px] text-ink-500 w-[52px] shrink-0">{f.label}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                        <div
                          className={cn('h-full rounded-full', GRADE_META[mine.grade].ring)}
                          style={{ width: `${Math.min(100, Number(mine.kpi?.[f.key] ?? 0))}%` }}
                        />
                      </div>
                      <span className="num text-[10.5px] text-ink-500 w-6 text-right">
                        {mine.kpi?.[f.key] ? num(mine.kpi[f.key], 0) : '—'}
                      </span>
                    </div>
                  ))}
                </div>
                {mine.summary && <p className="text-[11.5px] text-ink-600 leading-relaxed">评语：{mine.summary}</p>}
                {mine.improvement && (
                  <p className="text-[11.5px] text-ink-500 leading-relaxed">改进建议：{mine.improvement}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="py-6 text-center">
              <p className="text-[12.5px] text-ink-500">{period} 还没有你的绩效记录</p>
              <p className="mt-1 text-[11px] text-ink-400">评定完成后，结果会在这里显示</p>
            </div>
          )}
        </div>

        {/* 部门分布 */}
        {canView && (
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3">
            <BarChart3 className="w-4 h-4 text-brand-500" />
            <h3 className="text-[13px] font-semibold text-ink-900">部门平均分</h3>
          </div>
          {deptStats.length === 0 ? (
            <p className="py-6 text-center text-[11.5px] text-ink-400">本期还没有数据</p>
          ) : (
            <div className="space-y-2">
              {deptStats.slice(0, 7).map((d) => (
                <div key={d.id}>
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="text-ink-600 truncate">{d.name}</span>
                    <span className="num text-ink-800 font-medium">{d.scored ? num(d.avg, 1) : '—'}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
                    <div
                      className={cn('h-full rounded-full', d.avg >= 85 ? 'bg-emerald-500' : d.avg >= 70 ? 'bg-brand-500' : 'bg-amber-500')}
                      style={{ width: `${Math.min(100, d.avg)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        )}
      </div>

      {canView && (
        <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-ink-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            className="input !h-8 !pl-8 w-52 text-[12px]"
            placeholder="搜索姓名 / 邮箱 / 部门"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select
          value={deptFilter}
          onChange={setDeptFilter}
          options={[{ value: '', label: '全部部门' }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
          className="!h-8 w-[150px] text-[12px]"
        />
        <span className="text-[11px] text-ink-400">
          {rows.length} 条记录 · 平均 <b className="text-ink-700 num">{stats.avg ? num(stats.avg, 1) : '—'}</b>
        </span>
        {pendingPeople.length > 0 && canEdit && (
          <span className="chip bg-amber-50 text-amber-700 border-amber-200/60">还有 {pendingPeople.length} 人未评</span>
        )}
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <LoadingBlock rows={6} />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Target className="w-5 h-5" />}
            title={`${period} 还没有绩效记录`}
            description={
              canEdit
                ? '点右上角「录入绩效」，先给团队打一轮分。绩效会按部门汇总，并同步给成员本人查看。'
                : '本期还没有你的绩效记录，评定完成后会在这里出现。'
            }
            action={
              canEdit ? (
                <Button size="sm" variant="primary" onClick={openCreate}>
                  录入第一条
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="bg-ink-50/70 text-ink-500">
                  <th className="text-left font-medium px-4 py-2.5">成员</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[130px]">部门</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[120px]">分数</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[96px]">等级</th>
                  <th className="text-left font-medium px-4 py-2.5">分项</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[130px]">评价人</th>
                  <th className="text-right font-medium px-4 py-2.5 w-[90px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ review, person, deptId }) => {
                  const dept = deptId ? deptById.get(deptId) : null
                  return (
                    <tr key={review.id} className="border-t border-ink-100 hover:bg-ink-50/50">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={person?.full_name ?? person?.email} size={28} />
                          <div className="min-w-0">
                            <p className="font-medium text-ink-900 truncate">
                              {person?.full_name || '未命名'}
                              {review.profile_id === me?.id && (
                                <span className="ml-1.5 text-[10px] text-brand-600">你</span>
                              )}
                            </p>
                            <p className="text-[10.5px] text-ink-400 truncate">{person?.email ?? '—'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-ink-600">{dept?.name ?? '未归岗'}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="num text-[13px] font-semibold text-ink-900">{num(review.score, 1)}</span>
                          <div className="w-14 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                            <div
                              className={cn('h-full rounded-full', GRADE_META[review.grade].ring)}
                              style={{ width: `${Math.min(100, Number(review.score))}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={GRADE_META[review.grade].tone}>{review.grade}</Badge>
                        {review.status === 'draft' && <span className="ml-1 text-[10px] text-ink-400">草稿</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {KPI_FIELDS.filter((f) => review.kpi?.[f.key]).map((f) => (
                            <span key={f.key} className="text-[10.5px] text-ink-500 whitespace-nowrap">
                              {f.label} <b className="num text-ink-700">{num(review.kpi[f.key], 0)}</b>
                            </span>
                          ))}
                          {!review.kpi || Object.keys(review.kpi).length === 0 ? (
                            <span className="text-[10.5px] text-ink-300">未填分项</span>
                          ) : review.auto_score !== null && review.auto_score !== undefined ? (
                            <span className="ml-1 text-[9.5px] px-1 py-0.5 rounded bg-brand-50 text-brand-600 border border-brand-200/60 whitespace-nowrap">
                              数据算分
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-ink-500">
                        {review.reviewer_id ? personById.get(review.reviewer_id)?.full_name ?? '—' : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        {canEdit ? (
                          <div className="flex items-center justify-end gap-0.5">
                            <button
                              className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-brand-50 disabled:opacity-40"
                              title="按订单 / 采购 / 任务数据重算"
                              disabled={scoringId === review.profile_id}
                              onClick={() => {
                                const person = personById.get(review.profile_id)
                                if (person) scoreOne(person)
                              }}
                            >
                              <Sparkles className="w-3.5 h-3.5" />
                            </button>
                            <button
                              className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                              title="编辑"
                              onClick={() => openEdit(review)}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                              title="删除"
                              onClick={() => setToDelete(review)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <span className="block text-right text-[11px] text-ink-300">只读</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
        </>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-ink-400 flex items-start gap-1.5">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          绩效按「一人一周期」记录，重新评定会覆盖原分数并留下更新时间。
          成员本人无论有没有绩效模块权限，都能在「我的绩效」里看到自己的结果；
          部门平均分按评定时的部门快照统计，调岗不会改写历史。
        </span>
      </p>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={form.id ? '编辑绩效' : '录入绩效'}
        description="分数 0-100，等级默认按分数自动推荐，也可以手动调整。"
        width="max-w-xl"
        footer={
          <>
            <Button onClick={() => setModal(false)}>取消</Button>
            <Button variant="primary" onClick={save} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="被评成员" required>
              <Select
                value={form.profile_id}
                onChange={(v) => setForm({ ...form, profile_id: v })}
                options={memberOptions}
                placeholder="选择成员"
              />
            </Field>
            <Field label="考核周期" required hint="例如 2026-Q4 / 2026-11">
              <input
                className="input"
                value={form.period}
                onChange={(e) => setForm({ ...form, period: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-[1fr_140px] gap-3">
            <Field label="总分" required>
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                value={form.score}
                onChange={(e) => {
                  const v = e.target.value
                  const n = Number(v)
                  setForm({
                    ...form,
                    score: v,
                    grade: Number.isFinite(n) ? gradeOf(n) : form.grade,
                  })
                }}
              />
            </Field>
            <Field label="等级">
              <Select
                value={form.grade}
                onChange={(v) => setForm({ ...form, grade: v as PerformanceGrade })}
                options={GRADES.map((g) => ({ value: g, label: GRADE_META[g].label }))}
              />
            </Field>
          </div>

          <div>
            <p className="label">分项评分</p>
            <div className="grid grid-cols-2 gap-2">
              {KPI_FIELDS.map((f) => (
                <div key={f.key} className="flex items-center gap-2 rounded-lg border border-ink-200/70 px-2.5 py-1.5">
                  <span className="text-[11.5px] text-ink-600 w-[56px] shrink-0">{f.label}</span>
                  <input
                    className="w-full bg-transparent text-[12px] num text-ink-900 outline-none"
                    type="number"
                    min={0}
                    max={100}
                    value={form.kpi[f.key] ?? ''}
                    onChange={(e) => setForm({ ...form, kpi: { ...form.kpi, [f.key]: e.target.value } })}
                  />
                </div>
              ))}
            </div>
          </div>

          <Field label="评语">
            <textarea
              className="input min-h-[64px] py-2"
              value={form.summary}
              placeholder="本期主要贡献、亮点"
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
            />
          </Field>
          <Field label="改进建议">
            <textarea
              className="input min-h-[52px] py-2"
              value={form.improvement}
              placeholder="下一周期需要提升的方向"
              onChange={(e) => setForm({ ...form, improvement: e.target.value })}
            />
          </Field>

          <div className="flex items-center gap-2">
            <label className="text-[12px] text-ink-600">发布状态</label>
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v as 'draft' | 'published' })}
              options={[
                { value: 'published', label: '已发布（本人可见）' },
                { value: 'draft', label: '草稿（仅 HR 可见）' },
              ]}
              className="w-[200px]"
            />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={remove}
        loading={saving}
        title="删除绩效记录"
        confirmText="确认删除"
        message={
          toDelete
            ? `将删除 ${personById.get(toDelete.profile_id)?.full_name ?? '该成员'} 在 ${toDelete.period} 的绩效记录，删除后不可恢复。`
            : ''
        }
      />
    </div>
  )
}
