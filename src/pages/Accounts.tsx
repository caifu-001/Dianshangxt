import { useMemo, useState } from 'react'
import {
  ArrowRightLeft,
  BadgeCheck,
  CalendarDays,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Network,
  Pencil,
  ShieldCheck,
  UserCheck,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
  UserX,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { callRpc, countRowsWhere, deleteRow, fetchRows, updateRow } from '../lib/db'
import { checkPassword } from '../lib/password'
import { createAuthAccount, randomPassword } from '../lib/provision'
import type { Department, EmploymentStatus, Position, Profile, RoleDef } from '../lib/types'
import {
  type Role,
  ROLE_META,
  assignableRoles,
  canOperateOn,
  normalizeRole,
} from '../lib/permissions'
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
  SearchInput,
  Segmented,
  Select,
  useToast,
} from '../components/ui'
import { cn, fmtDate, fmtDateTime, today } from '../lib/utils'

const TONE: Record<Role, 'violet' | 'blue' | 'gray'> = {
  super_admin: 'violet',
  admin: 'blue',
  member: 'gray',
}

/** 离职交接时要一并清点的资源（与数据库 offboard_member 里的表清单保持一致） */
const RESOURCE_TABLES: Array<{ table: string; label: string }> = [
  { table: 'stores', label: '店铺' },
  { table: 'products', label: '商品' },
  { table: 'orders', label: '订单' },
  { table: 'inventory', label: '库存' },
  { table: 'stock_movements', label: '库存流水' },
  { table: 'stock_transfers', label: '在途调拨' },
  { table: 'campaigns', label: '广告活动' },
  { table: 'creators', label: '达人' },
  { table: 'tasks', label: '任务' },
  { table: 'expenses', label: '费用' },
  { table: 'competitors', label: '竞品' },
  { table: 'competitor_snapshots', label: '竞品快照' },
  { table: 'suppliers', label: '供应商' },
  { table: 'supplier_products', label: '供应商产品' },
  { table: 'purchase_orders', label: '采购单' },
  { table: 'purchase_items', label: '采购明细' },
]

interface OrgForm {
  id: string
  full_name: string
  email: string
  employee_no: string
  phone: string
  wechat: string
  department_id: string
  position_id: string
  role_id: string
  note: string
}

interface CreateForm {
  full_name: string
  email: string
  employee_no: string
  phone: string
  wechat: string
  password: string
  showPassword: boolean
  department_id: string
  position_id: string
  role: Role
  role_id: string
  hire_date: string
  pending: boolean
  must_change: boolean
  note: string
}

function emptyCreateForm(role: Role): CreateForm {
  return {
    full_name: '',
    email: '',
    employee_no: '',
    phone: '',
    wechat: '',
    password: randomPassword(),
    showPassword: true,
    department_id: '',
    position_id: '',
    role,
    role_id: '',
    hire_date: today(),
    pending: false,
    must_change: true,
    note: '',
  }
}

function employmentOf(p: Profile): EmploymentStatus {
  // 旧库还没有 employment_status 列时，按在职处理，避免全员显示成已离职
  return p.employment_status ?? 'active'
}

export default function Accounts() {
  const { user, profile: me, role, currentCompanyId, can } = useAuth()
  const { push } = useToast()
  const canAdmin = can('account.manage')
  const canHr = can('hr.manage')
  // 工号是人事编号，只有管理员 / 人力岗能维护；普通成员（含本人）只读
  const canEditEmployeeNo = canAdmin || canHr

  const { data, loading, error, reload } = useAsync(async () => {
    const [profiles, departments, positions, roles] = await Promise.all([
      fetchRows<Profile>('profiles', { order: { column: 'created_at' } }),
      fetchRows<Department>('departments', { order: { column: 'sort_order' } }),
      fetchRows<Position>('positions', { order: { column: 'sort_order' } }),
      fetchRows<RoleDef>('roles', { order: { column: 'sort_order' } }),
    ])
    return { profiles, departments, positions, roles }
  }, [])

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'pending' | 'left'>('all')
  const [deptFilter, setDeptFilter] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Profile | null>(null)
  const [removeLoading, setRemoveLoading] = useState(false)
  const [orgForm, setOrgForm] = useState<OrgForm | null>(null)
  const [orgSaving, setOrgSaving] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState<CreateForm>(() => emptyCreateForm('member'))
  const [createLoading, setCreateLoading] = useState(false)
  const [created, setCreated] = useState<{ email: string; password: string; name: string; needsConfirm: boolean; pending: boolean } | null>(null)

  const [offboarding, setOffboarding] = useState<Profile | null>(null)
  const [offboardCounts, setOffboardCounts] = useState<Record<string, number> | null>(null)
  const [handoverTo, setHandoverTo] = useState('')
  const [leftReason, setLeftReason] = useState('')
  const [offboardLoading, setOffboardLoading] = useState(false)

  const list = useMemo(() => data?.profiles ?? [], [data])
  const departments = useMemo(() => data?.departments ?? [], [data])
  const positions = useMemo(() => data?.positions ?? [], [data])
  const roles = useMemo(() => data?.roles ?? [], [data])

  const deptById = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments])
  const posById = useMemo(() => new Map(positions.map((p) => [p.id, p])), [positions])
  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter((p) => {
      const status = employmentOf(p)
      if (filter !== 'all' && status !== filter) return false
      if (deptFilter && (p.department_id ?? '') !== deptFilter) return false
      if (!q) return true
      const dept = p.department_id ? deptById.get(p.department_id)?.name ?? '' : ''
      const pos = p.position_id ? posById.get(p.position_id)?.name ?? '' : ''
      return (
        (p.email ?? '').toLowerCase().includes(q) ||
        (p.full_name ?? '').toLowerCase().includes(q) ||
        (p.employee_no ?? '').toLowerCase().includes(q) ||
        (p.phone ?? '').toLowerCase().includes(q) ||
        (p.wechat ?? '').toLowerCase().includes(q) ||
        dept.includes(q) ||
        pos.includes(q)
      )
    })
  }, [list, query, filter, deptFilter, deptById, posById])

  const stats = useMemo(() => {
    const byStatus = (s: EmploymentStatus) => list.filter((p) => employmentOf(p) === s).length
    return {
      total: list.length,
      active: byStatus('active'),
      pending: byStatus('pending'),
      left: byStatus('left'),
      admin: list.filter((p) => normalizeRole(p.role) !== 'member' && employmentOf(p) !== 'left').length,
      unassigned: list.filter((p) => !p.department_id && employmentOf(p) === 'active').length,
    }
  }, [list])

  const roleOptions = assignableRoles(role)

  /**
   * 人事岗（hr.manage）只能办理普通人员的人事事务：
   * 入职、离职、调部门 / 岗位、启停账号；不能调整系统角色与岗位角色。
   */
  function hrOperableOn(target: Profile) {
    return canHr && normalizeRole(target.role) === 'member' && target.id !== user?.id
  }

  async function changeRole(target: Profile, next: Role) {
    if (normalizeRole(target.role) === next) return
    setBusyId(target.id)
    try {
      await updateRow<Profile>('profiles', target.id, { role: next })
      push(`${target.full_name || target.email} 已设为${ROLE_META[next].label}`)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '角色修改失败', 'error')
    } finally {
      setBusyId(null)
    }
  }

  /** 快速切换岗位角色：不必打开弹窗 */
  async function changeCustomRole(target: Profile, roleId: string) {
    setBusyId(target.id)
    try {
      await updateRow<Profile>('profiles', target.id, { role_id: roleId || null })
      push(roleId ? `已分配角色「${roleById.get(roleId)?.name ?? ''}」` : '已取消岗位角色，按系统角色默认权限')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '角色修改失败', 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function toggleStatus(target: Profile) {
    const next = target.status === 'disabled' ? 'active' : 'disabled'
    setBusyId(target.id)
    try {
      await updateRow<Profile>('profiles', target.id, { status: next })
      push(next === 'disabled' ? '账号已停用，该用户将立即失去数据访问' : '账号已恢复启用')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '状态修改失败', 'error')
    } finally {
      setBusyId(null)
    }
  }

  /** 待入职 → 在职：开通登录权限并记下入职日期 */
  async function confirmHire(target: Profile) {
    setBusyId(target.id)
    try {
      await updateRow<Profile>('profiles', target.id, {
        status: 'active',
        employment_status: 'active',
        hire_date: target.hire_date || today(),
      })
      push(`${target.full_name || target.email} 已确认入职，可以登录了`)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '入职确认失败', 'error')
    } finally {
      setBusyId(null)
    }
  }

  /** 离职 → 在职：恢复档案与登录权限，组织归属需要重新分配 */
  async function restoreMember(target: Profile) {
    setBusyId(target.id)
    try {
      await updateRow<Profile>('profiles', target.id, {
        status: 'active',
        employment_status: 'active',
        left_at: null,
        left_reason: null,
        handover_to: null,
      })
      push(`${target.full_name || target.email} 已恢复在职，请重新分配部门与岗位角色`)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '恢复失败', 'error')
    } finally {
      setBusyId(null)
    }
  }

  function openOrg(target: Profile) {
    setOrgForm({
      id: target.id,
      full_name: target.full_name || '',
      email: target.email ?? '',
      employee_no: target.employee_no ?? '',
      phone: target.phone ?? '',
      wechat: target.wechat ?? '',
      department_id: target.department_id ?? '',
      position_id: target.position_id ?? '',
      role_id: target.role_id ?? '',
      note: target.note ?? '',
    })
  }

  async function saveOrg() {
    if (!orgForm) return
    if (!orgForm.full_name.trim()) return push('请填写成员姓名', 'error')
    const no = orgForm.employee_no.trim()
    if (
      canEditEmployeeNo &&
      no &&
      list.some(
        (p) => p.id !== orgForm.id && (p.employee_no ?? '').trim().toLowerCase() === no.toLowerCase(),
      )
    )
      return push('该工号已被其他成员使用', 'error')
    setOrgSaving(true)
    try {
      const payload: Record<string, unknown> = {
        full_name: orgForm.full_name.trim(),
        phone: orgForm.phone.trim() || null,
        wechat: orgForm.wechat.trim() || null,
        department_id: orgForm.department_id || null,
        position_id: orgForm.position_id || null,
        note: orgForm.note.trim() || null,
      }
      // 工号只有管理员 / 人力岗能改；其他人保存时不带该字段，数据库守卫也会再拦一层
      if (canEditEmployeeNo) payload.employee_no = no || null
      // 岗位角色决定业务权限，只有管理员能改；HR 调岗只动部门与岗位
      if (canAdmin) payload.role_id = orgForm.role_id || null
      await updateRow<Profile>('profiles', orgForm.id, payload)
      push(canAdmin ? '员工档案已更新' : '部门、岗位与联系方式已更新')
      setOrgForm(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setOrgSaving(false)
    }
  }

  /* ---------------- 新建账号 ---------------- */

  /** 按公司内已用工号顺延推荐；离职工号封存不复用。旧库未升级时静默跳过，仍可手工填号 */
  async function fillRecommendedNo() {
    try {
      const no = await callRpc<string>('recommend_employee_no')
      if (typeof no === 'string' && no.trim()) {
        setCreateForm((f) => ({ ...f, employee_no: no.trim() }))
      }
    } catch {
      // 数据库还没升级时保持现状，不阻断建号
    }
  }

  async function openCreate() {
    setCreateForm(emptyCreateForm(roleOptions[roleOptions.length - 1] ?? 'member'))
    setCreated(null)
    setCreateOpen(true)
    await fillRecommendedNo()
  }

  async function submitCreate() {
    const form = createForm
    if (!form.full_name.trim()) return push('请填写成员姓名', 'error')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) return push('邮箱格式不正确', 'error')
    const pw = checkPassword(form.password)
    if (!pw.ok) return push(`初始密码不达标：${pw.hint}`, 'error')
    const no = form.employee_no.trim()
    if (no && list.some((p) => (p.employee_no ?? '').trim().toLowerCase() === no.toLowerCase()))
      return push('该工号已被其他成员使用', 'error')

    setCreateLoading(true)
    let userId: string
    let needsConfirm: boolean
    try {
      const res = await createAuthAccount(form.email, form.password, form.full_name)
      userId = res.userId
      needsConfirm = res.needsConfirm
    } catch (err) {
      push(err instanceof Error ? err.message : '账号创建失败', 'error')
      setCreateLoading(false)
      return
    }

    // 多租户：新账号默认落在「默认公司」，管理员受 RLS 限制看不到也改不了，
    // 先用函数把它划进当前公司，再补组织归属与人事状态。
    if (currentCompanyId) {
      try {
        await callRpc('assign_member_company', { p_user: userId, p_company: currentCompanyId })
      } catch (err) {
        push(
          `登录账号已创建，但公司归属分配失败（${err instanceof Error ? err.message : '未知错误'}）。请联系系统管理员处理后重试。`,
          'error',
        )
        setCreateLoading(false)
        return
      }
    }

    // 这一步失败不影响账号本身，但要让管理员知道需要手工补。
    try {
      await updateRow<Profile>('profiles', userId, {
        full_name: form.full_name.trim(),
        employee_no: no || null,
        phone: form.phone.trim() || null,
        wechat: form.wechat.trim() || null,
        role: form.role,
        status: form.pending ? 'disabled' : 'active',
        employment_status: form.pending ? 'pending' : 'active',
        hire_date: form.hire_date || today(),
        department_id: form.department_id || null,
        position_id: form.position_id || null,
        role_id: form.role_id || null,
        note: form.note.trim() || null,
        settings: form.must_change ? { must_change_password: true } : {},
        provisioned_by: user?.id ?? null,
        provisioned_at: new Date().toISOString(),
      })
    } catch (err) {
      push(
        `登录账号已创建，但档案信息写入失败（${err instanceof Error ? err.message : '未知错误'}）。请刷新后在列表中手动调整。`,
        'error',
      )
    }

    setCreated({
      email: form.email.trim(),
      password: form.password,
      name: form.full_name.trim(),
      needsConfirm,
      pending: form.pending,
    })
    setCreateLoading(false)
    reload()
  }

  /* ---------------- 离职交接 ---------------- */

  async function openOffboard(target: Profile) {
    setOffboarding(target)
    setOffboardCounts(null)
    setHandoverTo('')
    setLeftReason('')
    const entries = await Promise.all(
      RESOURCE_TABLES.map(async (t) => {
        try {
          return [t.table, await countRowsWhere(t.table, 'user_id', target.id)] as const
        } catch {
          return [t.table, 0] as const
        }
      }),
    )
    setOffboardCounts(Object.fromEntries(entries))
  }

  const offboardTotal = useMemo(
    () => (offboardCounts ? Object.values(offboardCounts).reduce((a, b) => a + b, 0) : 0),
    [offboardCounts],
  )

  async function submitOffboard() {
    if (!offboarding) return
    setOffboardLoading(true)
    try {
      const result = await callRpc<{ moved: Record<string, number> }>('offboard_member', {
        p_target: offboarding.id,
        p_handover: handoverTo || null,
        p_reason: leftReason.trim() || null,
      })
      const movedTotal = Object.values(result?.moved ?? {}).reduce((a, b) => a + b, 0)
      push(
        movedTotal > 0
          ? `已办理离职，${movedTotal} 条记录转交给 ${handoverTo ? (list.find((p) => p.id === handoverTo)?.full_name ?? '接手人') : '接手人'}，权限已回收`
          : '已办理离职，权限已回收',
      )
      setOffboarding(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '离职办理失败', 'error')
    } finally {
      setOffboardLoading(false)
    }
  }

  async function handleRemove() {
    if (!removing) return
    setRemoveLoading(true)
    try {
      await deleteRow('profiles', removing.id)
      push('档案已移除')
      setRemoving(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '移除失败', 'error')
    } finally {
      setRemoveLoading(false)
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      push('已复制到剪贴板')
    } catch {
      push('复制失败，请手动选中复制', 'error')
    }
  }

  const KPI = [
    { label: '在职成员', value: stats.active, icon: Users, tone: 'text-ink-900' },
    { label: '待入职', value: stats.pending, icon: CalendarDays, tone: stats.pending ? 'text-amber-600' : 'text-ink-400' },
    { label: '已离职', value: stats.left, icon: UserMinus, tone: stats.left ? 'text-ink-500' : 'text-ink-400' },
    { label: '管理员', value: stats.admin, icon: ShieldCheck, tone: 'text-brand-600' },
    { label: '未归岗', value: stats.unassigned, icon: Network, tone: stats.unassigned ? 'text-amber-600' : 'text-ink-400' },
    { label: '账号总数', value: stats.total, icon: UserCog, tone: 'text-ink-700' },
  ]

  const posOptions = useMemo(
    () => positions.map((p) => ({ value: p.id, label: `${p.name}（${p.level}）` })),
    [positions],
  )

  const handoverOptions = useMemo(
    () =>
      list
        .filter((p) => p.id !== offboarding?.id && p.status === 'active' && employmentOf(p) !== 'left')
        .map((p) => ({ value: p.id, label: p.full_name || p.email || '未命名' })),
    [list, offboarding],
  )

  const createPwCheck = checkPassword(createForm.password)

  return (
    <div>
      <PageHeader
        title="人员与账号"
        description={
          canAdmin
            ? '开通账号、分配部门与角色，办理入职 / 离职；离职时把名下资源移交给接手人并回收权限。'
            : '人事岗可以办理入职 / 离职与调岗，系统角色与岗位角色仍由管理员分配。'
        }
        actions={
          <>
            <SearchInput value={query} onChange={setQuery} placeholder="搜索姓名 / 邮箱 / 部门" className="w-56" />
            {canAdmin && (
              <Button variant="primary" icon={<UserPlus className="w-3.5 h-3.5" />} onClick={openCreate}>
                新建账号
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 mb-3">
        {KPI.map((k) => (
          <div key={k.label} className="card px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-ink-400">
              <k.icon className="w-3.5 h-3.5" />
              <span className="text-[11px]">{k.label}</span>
            </div>
            <p className={cn('num text-[20px] font-semibold mt-1 leading-none', k.tone)}>{k.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-ink-200/70 bg-brand-50/40 px-3.5 py-2.5 mb-3 flex items-start gap-2">
        <ShieldCheck className="w-3.5 h-3.5 text-brand-600 mt-0.5 shrink-0" />
        <p className="text-[11.5px] leading-relaxed text-ink-600">
          <b className="text-ink-800">系统角色</b>决定管理级别：超管全权、管理员可管人、普通人员不可管人；
          <b className="text-ink-800 ml-1.5">部门范围</b>决定团队能看哪些模块（组织架构 → 权限总览里配）；
          <b className="text-ink-800 ml-1.5">岗位角色</b>再给个人额外的业务范围。三者叠加生效。
          <b className="text-ink-800 ml-1.5">员工工号</b>由管理员或人力岗维护，其他成员不可自行修改。
          <br />
          {canAdmin
            ? '账号由管理员在这里直接开通，不用再让同事自助注册；初始密码交给本人后，建议勾选「首次登录必须改密」。'
            : '人事岗可以确认入职、办理离职交接、调整部门与岗位；系统角色与岗位角色需要管理员分配。'}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Segmented
          value={filter}
          onChange={(v) => setFilter(v as typeof filter)}
          size="sm"
          options={[
            { value: 'all', label: `全部 ${stats.total}` },
            { value: 'active', label: `在职 ${stats.active}` },
            { value: 'pending', label: `待入职 ${stats.pending}` },
            { value: 'left', label: `已离职 ${stats.left}` },
          ]}
        />
        <Select
          value={deptFilter}
          onChange={setDeptFilter}
          options={[{ value: '', label: '全部部门' }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
          className="!h-8 w-[150px] text-[12px]"
        />
        {deptFilter && (
          <span className="text-[11px] text-ink-400">
            {deptById.get(deptFilter)?.name} · {filtered.length} 人
          </span>
        )}
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <LoadingBlock rows={6} />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={<Users className="w-5 h-5" />} title="没有匹配的账号" description="换个关键词，或点右上角「新建账号」" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="bg-ink-50/70 text-ink-500">
                  <th className="text-left font-medium px-4 py-2.5">成员 / 工号 / 联系方式</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[150px]">系统角色 / 岗位角色</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[104px]">人事状态</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[136px]">最近登录</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[112px]">入职日期</th>
                  <th className="text-right font-medium px-4 py-2.5 w-[164px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const targetRole = normalizeRole(p.role)
                  const mine = p.id === user?.id
                  const operable = canOperateOn(role, p, user?.id)
                  const hrOperable = hrOperableOn(p)
                  const canManage = operable || hrOperable
                  const status = employmentOf(p)
                  const left = status === 'left'
                  // 本人可改自己的姓名 / 电话 / 微信；工号只有管理员 / 人力岗可改
                  // （系统角色与启停仍受数据库守卫限制）
                  const canEditProfile = canManage || (mine && !left)
                  const roleEditable = operable && !left
                  const pending = status === 'pending'
                  const disabled = p.status === 'disabled'
                  const busy = busyId === p.id
                  const dept = p.department_id ? deptById.get(p.department_id) : null
                  const pos = p.position_id ? posById.get(p.position_id) : null
                  const customRole = p.role_id ? roleById.get(p.role_id) : null

                  return (
                    <tr key={p.id} className={cn('border-t border-ink-100', (left || disabled) && 'bg-ink-50/40')}>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={p.full_name ?? p.email} size={30} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={cn('font-medium truncate', left || disabled ? 'text-ink-400' : 'text-ink-900')}>
                                {p.full_name || '未命名'}
                              </span>
                              {p.employee_no && (
                                <span className="shrink-0 rounded border border-ink-200 bg-ink-50 px-1 py-px text-[10px] text-ink-500 num">
                                  {p.employee_no}
                                </span>
                              )}
                              {mine && (
                                <span className="shrink-0 rounded border border-brand-200 bg-brand-50 px-1 py-px text-[10px] text-brand-700">
                                  你
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-ink-400 truncate">{p.email ?? '—'}</p>
                            <p className="text-[10.5px] text-ink-400 truncate">
                              {dept ? dept.name : '未归岗'}
                              {pos && ` · ${pos.name}`}
                              {left && p.handover_to && ` · 已移交 ${list.find((x) => x.id === p.handover_to)?.full_name ?? ''}`}
                            </p>
                            {(p.phone || p.wechat) && (
                              <p className="text-[10.5px] text-ink-400 truncate">
                                {[p.phone ? `电话 ${p.phone}` : '', p.wechat ? `微信 ${p.wechat}` : '']
                                  .filter(Boolean)
                                  .join(' · ')}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-2.5 space-y-1">
                        {roleEditable ? (
                          <>
                            <select
                              className="input !h-7 !py-0 w-[128px] text-[12px]"
                              value={targetRole}
                              disabled={busy}
                              onChange={(e) => changeRole(p, e.target.value as Role)}
                            >
                              {roleOptions.map((r) => (
                                <option key={r} value={r}>
                                  {ROLE_META[r].label}
                                </option>
                              ))}
                              {!roleOptions.includes(targetRole) && (
                                <option value={targetRole}>{ROLE_META[targetRole].label}</option>
                              )}
                            </select>
                            <select
                              className="input !h-7 !py-0 w-[128px] text-[12px] text-ink-600"
                              value={p.role_id ?? ''}
                              disabled={busy || roles.length === 0}
                              onChange={(e) => changeCustomRole(p, e.target.value)}
                              title="岗位角色决定业务模块权限"
                            >
                              <option value="">岗位角色：默认</option>
                              {roles.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.name}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          <div className="space-y-1">
                            <Badge tone={TONE[targetRole]}>{ROLE_META[targetRole].short}</Badge>
                            <div>
                              <span className="text-[11px] text-ink-400">{customRole?.name ?? '默认权限'}</span>
                            </div>
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {left ? (
                          <Badge tone="gray" dot>已离职</Badge>
                        ) : pending ? (
                          <Badge tone="amber" dot>待入职</Badge>
                        ) : disabled ? (
                          <Badge tone="red" dot>已停用</Badge>
                        ) : (
                          <Badge tone="green" dot>在职</Badge>
                        )}
                      </td>

                      <td className="px-4 py-2.5 text-ink-500 num">
                        {p.last_sign_in_at ? fmtDateTime(p.last_sign_in_at) : '从未登录'}
                      </td>

                      <td className="px-4 py-2.5 text-ink-500 num">
                        {p.hire_date ? fmtDate(p.hire_date) : fmtDate(p.created_at)}
                        {left && p.left_at && (
                          <span className="block text-[10.5px] text-ink-400">离职 {fmtDate(p.left_at)}</span>
                        )}
                      </td>

                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-0.5 whitespace-nowrap">
                          {canEditProfile || canManage ? (
                            <>
                              {!left && (
                                <button
                                  className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-brand-50"
                                  title={mine && !canManage ? '编辑我的档案' : '编辑员工档案'}
                                  disabled={busy}
                                  onClick={() => openOrg(p)}
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {canManage && (
                                <>
                                  {pending && (
                                    <button
                                      className="p-1.5 rounded-md text-ink-400 hover:text-emerald-600 hover:bg-emerald-50"
                                      title="确认入职并开通登录"
                                      disabled={busy}
                                      onClick={() => confirmHire(p)}
                                    >
                                      <UserCheck className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                  {left ? (
                                    <button
                                      className="p-1.5 rounded-md text-ink-400 hover:text-emerald-600 hover:bg-emerald-50"
                                      title="恢复在职"
                                      disabled={busy}
                                      onClick={() => restoreMember(p)}
                                    >
                                      <BadgeCheck className="w-3.5 h-3.5" />
                                    </button>
                                  ) : (
                                    <>
                                      <button
                                        className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                                        title={disabled ? '启用账号' : '停用账号'}
                                        disabled={busy}
                                        onClick={() => toggleStatus(p)}
                                      >
                                        {disabled ? <ShieldCheck className="w-3.5 h-3.5" /> : <UserX className="w-3.5 h-3.5" />}
                                      </button>
                                      <button
                                        className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                                        title="办理离职并交接资源"
                                        disabled={busy}
                                        onClick={() => openOffboard(p)}
                                      >
                                        <ArrowRightLeft className="w-3.5 h-3.5" />
                                      </button>
                                    </>
                                  )}
                                  {operable && (
                                    <button
                                      className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                                      title="移除档案"
                                      disabled={busy}
                                      onClick={() => setRemoving(p)}
                                    >
                                      <UserMinus className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </>
                              )}
                              {mine && !canManage && <span className="ml-1 text-[11px] text-ink-300">本人</span>}
                            </>
                          ) : (
                            <span className="text-[11px] text-ink-300">{mine ? '当前登录' : '无权限'}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
        当前你的系统角色：<b className="text-ink-600">{ROLE_META[role].label}</b>（{ROLE_META[role].desc}）
        {me?.email ? ` · ${me.email}` : ''}
        <br />
        所有校验都在系统底层完成，绕过界面直接调接口同样会被拒绝；
        系统角色与岗位角色只有管理员能改，人事岗只能办理入离职与调岗，成员无法给自己提权或改回在职状态。
      </p>

      {/* ---------- 新建账号 ---------- */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={created ? '账号已创建' : '新建成员账号'}
        description={created ? undefined : '直接为同事开通登录账号，无需本人自助注册'}
        width="580px"
        footer={
          created ? (
            <Button variant="primary" onClick={() => setCreateOpen(false)}>
              完成
            </Button>
          ) : (
            <>
              <Button onClick={() => setCreateOpen(false)}>取消</Button>
              <Button variant="primary" onClick={submitCreate} loading={createLoading} icon={<UserPlus className="w-3.5 h-3.5" />}>
                创建账号
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-3.5 py-3">
              <p className="text-[12.5px] font-medium text-emerald-800 flex items-center gap-1.5">
                <Check className="w-4 h-4" />
                {created.name} 的账号已开通
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-emerald-700">
                {created.needsConfirm
                  ? '系统开启了邮箱确认：请让 TA 打开邮箱点击确认链接后才能登录。'
                  : created.pending
                    ? '账号已创建但标记为待入职，账号暂时无法登录。入职当天点一下「确认入职」即可开通。'
                    : '账号已可直接登录，请把下面的初始密码发给本人。'}
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[10.5px] text-ink-400">登录邮箱</p>
                  <p className="text-[12.5px] text-ink-800 truncate">{created.email}</p>
                </div>
                <button className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-white" onClick={() => copyText(created.email)} title="复制邮箱">
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[10.5px] text-ink-400">初始密码</p>
                  <p className="text-[12.5px] text-ink-800 font-mono truncate">{created.password}</p>
                </div>
                <button
                  className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-white"
                  onClick={() => copyText(`邮箱：${created.email}\n密码：${created.password}`)}
                  title="复制邮箱与密码"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <p className="text-[11px] leading-relaxed text-ink-400">
              密码只在这里显示一次，关闭后无法再查看（只存加密摘要）。如果丢了，让 TA 用登录页的「邮箱验证码」登录，或在系统设置里改密。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="姓名" required>
                <input
                  className="input"
                  value={createForm.full_name}
                  placeholder="张三"
                  onChange={(e) => setCreateForm({ ...createForm, full_name: e.target.value })}
                />
              </Field>
              <Field label="登录邮箱" required hint="作为登录账号，需真实可用">
                <input
                  className="input"
                  value={createForm.email}
                  placeholder="zhangsan@company.com"
                  autoComplete="off"
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                />
              </Field>
              <Field label="员工工号" hint="按公司现有工号顺延推荐；离职工号封存保留，不会重复分配">
                <div className="flex gap-1.5">
                  <input
                    className="input num flex-1 min-w-0"
                    value={createForm.employee_no}
                    placeholder="如 E1024"
                    onChange={(e) => setCreateForm({ ...createForm, employee_no: e.target.value })}
                  />
                  <Button
                    size="sm"
                    className="!h-9"
                    title="重新获取推荐工号"
                    onClick={() => void fillRecommendedNo()}
                  >
                    推荐
                  </Button>
                </div>
              </Field>
              <Field label="联系电话">
                <input
                  className="input"
                  value={createForm.phone}
                  placeholder="138…"
                  onChange={(e) => setCreateForm({ ...createForm, phone: e.target.value })}
                />
              </Field>
              <Field label="微信">
                <input
                  className="input"
                  value={createForm.wechat}
                  placeholder="微信号"
                  onChange={(e) => setCreateForm({ ...createForm, wechat: e.target.value })}
                />
              </Field>
            </div>

            <Field label="初始密码" required hint={createPwCheck.hint}>
              <div className="flex items-center gap-1.5">
                <div className="relative flex-1">
                  <input
                    className="input pr-9 font-mono text-[12.5px]"
                    type={createForm.showPassword ? 'text' : 'password'}
                    value={createForm.password}
                    onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ink-400 hover:text-ink-700"
                    onClick={() => setCreateForm({ ...createForm, showPassword: !createForm.showPassword })}
                    title={createForm.showPassword ? '隐藏' : '显示'}
                  >
                    {createForm.showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <Button
                  size="sm"
                  className="!h-9"
                  icon={<KeyRound className="w-3.5 h-3.5" />}
                  onClick={() => setCreateForm({ ...createForm, password: randomPassword(), showPassword: true })}
                >
                  随机
                </Button>
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="所属部门">
                <Select
                  value={createForm.department_id}
                  onChange={(v) => setCreateForm({ ...createForm, department_id: v })}
                  options={departments.map((d) => ({ value: d.id, label: d.name }))}
                  placeholder="未分配"
                />
              </Field>
              <Field label="岗位">
                <Select
                  value={createForm.position_id}
                  onChange={(v) => setCreateForm({ ...createForm, position_id: v })}
                  options={posOptions}
                  placeholder="未分配"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="系统角色" hint="决定能不能管人">
                <Select
                  value={createForm.role}
                  onChange={(v) => setCreateForm({ ...createForm, role: v as Role })}
                  options={roleOptions.map((r) => ({ value: r, label: ROLE_META[r].label }))}
                />
              </Field>
              <Field label="岗位角色" hint="决定能看哪些模块">
                <Select
                  value={createForm.role_id}
                  onChange={(v) => setCreateForm({ ...createForm, role_id: v })}
                  options={roles.map((r) => ({ value: r.id, label: r.name }))}
                  placeholder="默认（按系统角色）"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="入职日期">
                <input
                  type="date"
                  className="input"
                  value={createForm.hire_date}
                  onChange={(e) => setCreateForm({ ...createForm, hire_date: e.target.value })}
                />
              </Field>
              <Field label="备注">
                <input
                  className="input"
                  value={createForm.note}
                  placeholder="例如：负责美国站"
                  onChange={(e) => setCreateForm({ ...createForm, note: e.target.value })}
                />
              </Field>
            </div>

            <div className="rounded-lg border border-ink-200 bg-ink-50/50 px-3 py-2.5 space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={createForm.pending}
                  onChange={(e) => setCreateForm({ ...createForm, pending: e.target.checked })}
                />
                <span className="text-[11.5px] leading-relaxed text-ink-600">
                  还没到岗，先建「待入职」档案
                  <span className="text-ink-400">（账号暂不可登录，入职当天点「确认入职」开通）</span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={createForm.must_change}
                  onChange={(e) => setCreateForm({ ...createForm, must_change: e.target.checked })}
                />
                <span className="text-[11.5px] leading-relaxed text-ink-600">
                  首次登录必须修改初始密码
                  <span className="text-ink-400">（登录后会在顶部提示，改完自动消失）</span>
                </span>
              </label>
            </div>

            <p className="text-[11px] leading-relaxed text-ink-400">
              新账号通过系统注册接口创建，不会影响你当前登录的会话。
              若开启了邮箱确认，需要本人点邮件里的链接才能登录。
            </p>
          </div>
        )}
      </Modal>

      {/* ---------- 组织信息弹窗 ---------- */}
      <Modal
        open={!!orgForm}
        onClose={() => setOrgForm(null)}
        title="编辑员工档案"
        description={orgForm ? `成员：${orgForm.full_name || orgForm.email} · ${canEditEmployeeNo ? '姓名 / 工号 / 职位 / 部门 / 联系方式' : '姓名 / 职位 / 部门 / 联系方式（工号由人力或管理员维护）'}` : undefined}
        footer={
          <>
            <Button onClick={() => setOrgForm(null)}>取消</Button>
            <Button variant="primary" onClick={saveOrg} loading={orgSaving}>
              保存
            </Button>
          </>
        }
      >
        {orgForm && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="姓名" required>
                <input
                  className="input"
                  value={orgForm.full_name}
                  placeholder="员工姓名"
                  onChange={(e) => setOrgForm({ ...orgForm, full_name: e.target.value })}
                />
              </Field>
              <Field label="登录邮箱" hint="登录邮箱在认证服务中维护，此处只读">
                <p className="text-[12px] text-ink-500 h-9 flex items-center truncate">{orgForm.email || '—'}</p>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="所属部门">
                <Select
                  value={orgForm.department_id}
                  onChange={(v) => setOrgForm({ ...orgForm, department_id: v })}
                  options={departments.map((d) => ({ value: d.id, label: d.name }))}
                  placeholder="未分配"
                />
              </Field>
              <Field label="岗位">
                <Select
                  value={orgForm.position_id}
                  onChange={(v) => setOrgForm({ ...orgForm, position_id: v })}
                  options={posOptions}
                  placeholder="未分配"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="员工工号"
                hint={canEditEmployeeNo ? '全公司唯一，可留空' : '工号由人力或管理员维护，个人不可修改'}
              >
                <input
                  className="input num disabled:bg-ink-50 disabled:text-ink-400"
                  value={orgForm.employee_no}
                  placeholder="如 E1024"
                  disabled={!canEditEmployeeNo}
                  onChange={(e) => setOrgForm({ ...orgForm, employee_no: e.target.value })}
                />
              </Field>
              <Field label="联系电话">
                <input
                  className="input"
                  value={orgForm.phone}
                  placeholder="138…"
                  onChange={(e) => setOrgForm({ ...orgForm, phone: e.target.value })}
                />
              </Field>
              <Field label="微信" className="col-span-2">
                <input
                  className="input"
                  value={orgForm.wechat}
                  placeholder="微信号"
                  onChange={(e) => setOrgForm({ ...orgForm, wechat: e.target.value })}
                />
              </Field>
            </div>
            <Field
              label="岗位角色"
              hint={canAdmin ? '决定该成员能看到哪些业务模块；留空则按系统角色默认权限' : '岗位角色由管理员分配，人事岗只能调整部门与岗位'}
            >
              <Select
                value={orgForm.role_id}
                onChange={(v) => setOrgForm({ ...orgForm, role_id: v })}
                options={roles.map((r) => ({ value: r.id, label: r.name }))}
                placeholder="默认（按系统角色）"
                disabled={!canAdmin}
              />
            </Field>
            <Field label="备注">
              <input
                className="input"
                value={orgForm.note}
                placeholder="例如：负责美国站，2026 年 3 月入职"
                onChange={(e) => setOrgForm({ ...orgForm, note: e.target.value })}
              />
            </Field>
            <p className="text-[11px] leading-relaxed text-ink-400">
              组织架构可在「组织架构」页维护部门与岗位清单；岗位角色在「组织架构 → 角色」页配置权限。
            </p>
          </div>
        )}
      </Modal>

      {/* ---------- 离职交接 ---------- */}
      <Modal
        open={!!offboarding}
        onClose={() => setOffboarding(null)}
        title="办理离职与资源交接"
        description={offboarding ? `成员：${offboarding.full_name || offboarding.email}` : undefined}
        width="600px"
        footer={
          <>
            <Button onClick={() => setOffboarding(null)}>取消</Button>
            <Button variant="danger" onClick={submitOffboard} loading={offboardLoading}>
              确认离职
            </Button>
          </>
        }
      >
        {offboarding && (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
              <p className="text-[11.5px] leading-relaxed text-amber-800">
                确认后该成员<strong>立即失去登录权限</strong>，部门 / 岗位 / 岗位角色被清空，系统角色降为普通人员。
                名下资源会转给接手人；不选接手人则保留原归属，作为团队公共数据。
                员工工号随档案封存保留，不会分配给新入职成员。
              </p>
            </div>

            <div>
              <p className="text-[11.5px] font-medium text-ink-700 mb-1.5">
                名下资源 {offboardCounts ? `共 ${offboardTotal} 条` : '统计中…'}
              </p>
              {offboardCounts ? (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                  {RESOURCE_TABLES.filter((t) => (offboardCounts[t.table] ?? 0) > 0).map((t) => (
                    <div key={t.table} className="rounded-md border border-ink-200 bg-white px-2 py-1.5">
                      <p className="text-[10px] text-ink-400">{t.label}</p>
                      <p className="num text-[13px] font-semibold text-ink-800">{offboardCounts[t.table]}</p>
                    </div>
                  ))}
                  {offboardTotal === 0 && (
                    <p className="col-span-full text-[11.5px] text-ink-400">没有登记在该成员名下的资源，可以直接办理离职。</p>
                  )}
                </div>
              ) : (
                <div className="h-12 rounded-md bg-ink-50 animate-pulse" />
              )}
            </div>

            <Field label="交接人" hint={offboardTotal > 0 ? '把上面这些资源整体转到他名下' : '没有资源需要移交，可不选'}>
              <Select
                value={handoverTo}
                onChange={setHandoverTo}
                options={handoverOptions}
                placeholder="不移交（保留原归属）"
              />
            </Field>

            <Field label="离职原因 / 备注">
              <input
                className="input"
                value={leftReason}
                placeholder="例如：2026-11-30 主动离职，已完成交接"
                onChange={(e) => setLeftReason(e.target.value)}
              />
            </Field>

            <p className="text-[11px] leading-relaxed text-ink-400">
              整个交接在数据库函数里一次事务完成：要么资源和权限都处理干净，要么都不变。
              办理记录会写进「权限流程 → 人员变动」。
            </p>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={handleRemove}
        loading={removeLoading}
        title="移除账号档案"
        confirmText="确认移除"
        message={
          removing
            ? `将移除 ${removing.full_name || removing.email} 的档案，该账号会立刻失去系统访问权限，其录入的业务数据保留。日常离职请用「办理离职」保留审计记录；登录凭据不会被删除。`
            : ''
        }
      />
    </div>
  )
}
