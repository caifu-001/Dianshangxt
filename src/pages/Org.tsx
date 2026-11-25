import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Briefcase,
  Building2,
  ChevronRight,
  FolderPlus,
  Info,
  Layers,
  Lock,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { callRpc, deleteRow, fetchRows, insertRow, updateRow } from '../lib/db'
import type { Department, Position, Profile, RoleDef } from '../lib/types'
import {
  DEPT_GRANTS,
  DEPT_TEMPLATES,
  FUNCTION_CODES,
  FUNCTION_META,
  MODULES,
  effectivePermissions,
  normalizeRole,
  resolveDeptScope,
  type PermissionCode,
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
  Segmented,
  Select,
  useToast,
} from '../components/ui'
import { cn } from '../lib/utils'

type Tab = 'dept' | 'position' | 'role' | 'overview'

/** 通讯录（team_directory）：普通成员也能读到姓名与部门 */
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

/* ------------------------------------------------------------------ */
/*  表单类型                                                            */
/* ------------------------------------------------------------------ */
interface DeptForm {
  id?: string
  name: string
  code: string
  parent_id: string
  leader_id: string
  description: string
  scope: PermissionCode[]
  inherit_parent: boolean
  sort_order: string
}

interface PosForm {
  id?: string
  name: string
  department_id: string
  level: string
  description: string
  sort_order: string
}

interface RoleForm {
  id?: string
  name: string
  description: string
  permissions: string[]
}

const EMPTY_DEPT: DeptForm = {
  name: '',
  code: '',
  parent_id: '',
  leader_id: '',
  description: '',
  scope: [],
  inherit_parent: true,
  sort_order: '10',
}
const EMPTY_POS: PosForm = { name: '', department_id: '', level: 'P3', description: '', sort_order: '10' }
const EMPTY_ROLE: RoleForm = { name: '', description: '', permissions: [] }

function shortModule(label: string) {
  return label.replace('管理', '')
}

/** 矩阵表头用的两字简称，避免窄列里换行 */
const MODULE_SHORT: Record<string, string> = {
  stores: '店铺',
  products: '商品',
  orders: '订单',
  inventory: '库存',
  purchase: '采购',
  profit: '利润',
  ads: '广告',
  creators: '达人',
  competitors: '竞品',
  tasks: '任务',
  performance: '绩效',
}

const FUNCTION_SHORT: Record<string, string> = {
  'hr.view': '人事',
  'hr.manage': '入离职',
}

/** 权限码 → 简短中文（矩阵图例、成员卡片用） */
function toggleCode(list: PermissionCode[], code: PermissionCode, next: boolean): PermissionCode[] {
  const set = new Set(list)
  if (next) {
    set.add(code)
    // 勾了编辑必须有查看
    if (code.endsWith('.edit')) set.add(code.replace('.edit', '.view') as PermissionCode)
  } else {
    set.delete(code)
    // 取消查看连带取消编辑
    if (code.endsWith('.view')) set.delete(code.replace('.view', '.edit') as PermissionCode)
  }
  return Array.from(set)
}

export default function Org() {
  const { user, profile: me, can, role } = useAuth()
  const { push } = useToast()

  const { data, loading, error, reload } = useAsync(async () => {
    const [departments, positions, roles, profiles, directory] = await Promise.all([
      fetchRows<Department>('departments', { order: { column: 'sort_order' } }),
      fetchRows<Position>('positions', { order: { column: 'sort_order' } }),
      fetchRows<RoleDef>('roles', { order: { column: 'sort_order' } }),
      // 成员列表受 RLS 限制：只有管人或管组织的人能拿到全员
      fetchRows<Profile>('profiles', { order: { column: 'created_at' } }),
      // 通讯录：普通成员也能读到姓名 / 部门 / 岗位，用于权限总览
      callRpc<DirectoryRow[]>('team_directory').catch(() => [] as DirectoryRow[]),
    ])
    return { departments, positions, roles, profiles, directory }
  }, [])

  const editable = can('org.manage')
  const seeMembers = can('org.manage') || can('account.manage') || can('hr.view')

  const [tab, setTab] = useState<Tab>('dept')
  const [saving, setSaving] = useState(false)

  /* 部门 */
  const [deptModal, setDeptModal] = useState(false)
  const [deptForm, setDeptForm] = useState<DeptForm>(EMPTY_DEPT)
  const [deptToDelete, setDeptToDelete] = useState<Department | null>(null)

  /* 岗位 */
  const [posModal, setPosModal] = useState(false)
  const [posForm, setPosForm] = useState<PosForm>(EMPTY_POS)
  const [posToDelete, setPosToDelete] = useState<Position | null>(null)

  /* 角色 */
  const [roleModal, setRoleModal] = useState(false)
  const [roleForm, setRoleForm] = useState<RoleForm>(EMPTY_ROLE)
  const [roleToDelete, setRoleToDelete] = useState<RoleDef | null>(null)

  const departments = useMemo(() => data?.departments ?? [], [data])
  const positions = useMemo(() => data?.positions ?? [], [data])
  const roles = useMemo(() => data?.roles ?? [], [data])
  const profiles = useMemo(() => data?.profiles ?? [], [data])
  const directory = useMemo(() => data?.directory ?? [], [data])

  const deptById = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments])
  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles])

  const memberCount = useMemo(() => {
    const dept = new Map<string, number>()
    const pos = new Map<string, number>()
    const roleMap = new Map<string, number>()
    for (const p of profiles) {
      if (p.department_id) dept.set(p.department_id, (dept.get(p.department_id) ?? 0) + 1)
      if (p.position_id) pos.set(p.position_id, (pos.get(p.position_id) ?? 0) + 1)
      if (p.role_id) roleMap.set(p.role_id, (roleMap.get(p.role_id) ?? 0) + 1)
    }
    return { dept, pos, roleMap }
  }, [profiles])

  const tree = useMemo(() => {
    const map = new Map<string | null, Department[]>()
    for (const d of departments) {
      const key = d.parent_id && deptById.has(d.parent_id) ? d.parent_id : null
      const arr = map.get(key) ?? []
      arr.push(d)
      map.set(key, arr)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh'))
    }
    return map
  }, [departments, deptById])

  const deptOptions = useMemo(
    () => departments.map((d) => ({ value: d.id, label: d.name })),
    [departments],
  )

  const memberOptions = useMemo(
    () => [
      { value: '', label: '未指定' },
      ...profiles.map((p) => ({ value: p.id, label: p.full_name || p.email || '未命名' })),
    ],
    [profiles],
  )

  /* ---------------- 部门操作 ---------------- */
  function openDept(form: Partial<DeptForm>) {
    setDeptForm({ ...EMPTY_DEPT, ...form, scope: form.scope ?? [] })
    setDeptModal(true)
  }

  async function saveDept() {
    if (!deptForm.name.trim()) {
      push('请填写部门名称', 'error')
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: deptForm.name.trim(),
        code: deptForm.code.trim().toUpperCase() || null,
        parent_id: deptForm.parent_id || null,
        leader_id: deptForm.leader_id || null,
        description: deptForm.description.trim() || null,
        scope: deptForm.scope,
        inherit_parent: deptForm.inherit_parent,
        sort_order: Number(deptForm.sort_order) || 0,
      }
      if (deptForm.id) await updateRow<Department>('departments', deptForm.id, payload)
      else await insertRow<Department>('departments', payload)
      push(deptForm.id ? '部门已更新，成员权限刷新后生效' : '部门已创建')
      setDeptModal(false)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate key|uq_departments_code/i.test(msg) ? '部门编码已被占用，请换一个' : msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function removeDept() {
    if (!deptToDelete) return
    setSaving(true)
    try {
      await deleteRow('departments', deptToDelete.id)
      push('部门已删除，下属成员已变为「未分配」')
      setDeptToDelete(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  /* ---------------- 岗位操作 ---------------- */
  function openPos(form: Partial<PosForm>) {
    setPosForm({ ...EMPTY_POS, ...form })
    setPosModal(true)
  }

  async function savePos() {
    if (!posForm.name.trim()) {
      push('请填写岗位名称', 'error')
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: posForm.name.trim(),
        department_id: posForm.department_id || null,
        level: posForm.level.trim() || 'P1',
        description: posForm.description.trim() || null,
        sort_order: Number(posForm.sort_order) || 0,
      }
      if (posForm.id) await updateRow<Position>('positions', posForm.id, payload)
      else await insertRow<Position>('positions', payload)
      push(posForm.id ? '岗位已更新' : '岗位已创建')
      setPosModal(false)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function removePos() {
    if (!posToDelete) return
    setSaving(true)
    try {
      await deleteRow('positions', posToDelete.id)
      push('岗位已删除')
      setPosToDelete(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  /* ---------------- 角色操作 ---------------- */
  function openRole(form: Partial<RoleForm>) {
    setRoleForm({ ...EMPTY_ROLE, ...form })
    setRoleModal(true)
  }

  function togglePerm(code: string, next: boolean) {
    setRoleForm((prev) => {
      const set = new Set(prev.permissions)
      if (next) set.add(code)
      else set.delete(code)
      // 勾了「编辑」就必须有「查看」；取消「查看」时连带取消「编辑」
      if (next && code.endsWith('.edit')) set.add(code.replace('.edit', '.view'))
      if (!next && code.endsWith('.view')) set.delete(code.replace('.view', '.edit'))
      return { ...prev, permissions: Array.from(set) }
    })
  }

  async function saveRole() {
    if (!roleForm.name.trim()) {
      push('请填写角色名称', 'error')
      return
    }
    if (roleForm.permissions.length === 0) {
      push('至少要勾选一个权限，否则该角色看不到任何模块', 'error')
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: roleForm.name.trim(),
        description: roleForm.description.trim() || null,
        permissions: roleForm.permissions,
      }
      if (roleForm.id) await updateRow<RoleDef>('roles', roleForm.id, payload)
      else await insertRow<RoleDef>('roles', { ...payload, is_system: false, sort_order: 50 })
      push(roleForm.id ? '角色已更新，相关成员下次刷新即生效' : '角色已创建')
      setRoleModal(false)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate key|uq_roles_name/i.test(msg) ? '已有同名角色，请换一个名称' : msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function removeRole() {
    if (!roleToDelete) return
    setSaving(true)
    try {
      await deleteRow('roles', roleToDelete.id)
      push('角色已删除，原使用该角色的成员将按系统角色默认权限处理')
      setRoleToDelete(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  /* ---------------- 部门树渲染 ---------------- */
  const deptRows: ReactNode[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const d of tree.get(parentId) ?? []) {
      const count = memberCount.dept.get(d.id) ?? 0
      const leader = d.leader_id ? profileById.get(d.leader_id) : null
      const childCount = (tree.get(d.id) ?? []).length
      deptRows.push(
        <div
          key={d.id}
          className="group flex items-center gap-2 px-3 py-2.5 border-b border-ink-100 hover:bg-ink-50/60"
          style={{ paddingLeft: 12 + depth * 20 }}
        >
          {depth > 0 && <ChevronRight className="w-3 h-3 text-ink-300 shrink-0" />}
          <div
            className={cn(
              'w-6 h-6 rounded-md flex items-center justify-center shrink-0',
              depth === 0 ? 'bg-brand-50 text-brand-600' : 'bg-ink-100 text-ink-500',
            )}
          >
            <Building2 className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[12.5px] font-medium text-ink-900 truncate">{d.name}</span>
              {d.code && (
                <span className="text-[9.5px] text-ink-400 border border-ink-200 rounded px-1 shrink-0">
                  {d.code}
                </span>
              )}
              {childCount > 0 && (
                <span className="text-[10px] text-ink-400 shrink-0">含 {childCount} 个子部门</span>
              )}
            </div>
            <p className="text-[11px] text-ink-400 truncate">
              {d.description || '未填写职能说明'}
              {leader && ` · 负责人 ${leader.full_name || leader.email}`}
            </p>
          </div>
          <div className="hidden sm:flex items-center gap-1 shrink-0">
            {MODULES.filter((m) => (d.scope ?? []).includes(m.view)).slice(0, 3).map((m) => (
              <span key={m.key} className="chip bg-brand-50 text-brand-700 border-brand-200/60 !text-[10px] !py-0">
                {shortModule(m.label)}
              </span>
            ))}
            {(d.scope ?? []).length > 0 ? (
              <span className="text-[10px] text-ink-400 num">
                共 {MODULES.filter((m) => (d.scope ?? []).includes(m.view)).length} 个模块
              </span>
            ) : (
              <span className="text-[10px] text-ink-300">未配可见范围</span>
            )}
            {FUNCTION_CODES.filter((c) => (d.scope ?? []).includes(c)).map((c) => (
              <span key={c} className="chip bg-violet-50 text-violet-700 border-violet-200/60 !text-[10px] !py-0">
                {FUNCTION_META[c].label}
              </span>
            ))}
            {d.inherit_parent === false && (
              <span className="text-[10px] text-amber-600">不继承上级</span>
            )}
          </div>
          {seeMembers && (
            <span className="text-[11px] text-ink-500 num shrink-0 mr-1">{count} 人</span>
          )}
          {editable && (
            <div className="flex items-center gap-0.5 opacity-70 group-hover:opacity-100 transition-opacity">
              <button
                className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-brand-50"
                title="添加子部门"
                onClick={() => openDept({ parent_id: d.id })}
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
              <button
                className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                title="编辑"
                onClick={() =>
                  openDept({
                    id: d.id,
                    name: d.name,
                    code: d.code ?? '',
                    parent_id: d.parent_id ?? '',
                    leader_id: d.leader_id ?? '',
                    description: d.description ?? '',
                    scope: (d.scope ?? []) as PermissionCode[],
                    inherit_parent: d.inherit_parent !== false,
                    sort_order: String(d.sort_order),
                  })
                }
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                title="删除"
                onClick={() => setDeptToDelete(d)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>,
      )
      walk(d.id, depth + 1)
    }
  }
  walk(null, 0)

  /* ---------------- 权限总览：部门矩阵 + 成员归属 ---------------- */
  const deptMap = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments])

  const scopeByDept = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveDeptScope>>()
    for (const d of departments) map.set(d.id, resolveDeptScope(d.id, deptMap))
    return map
  }, [departments, deptMap])

  const matrixRows = useMemo(() => {
    const rows: Array<{ dept: Department; depth: number }> = []
    const walkAll = (parentId: string | null, depth: number) => {
      for (const d of tree.get(parentId) ?? []) {
        rows.push({ dept: d, depth })
        walkAll(d.id, depth + 1)
      }
    }
    walkAll(null, 0)
    return rows
  }, [tree])

  const memberRows = useMemo(() => {
    const roleById = new Map(roles.map((r) => [r.id, r]))
    return directory.map((p) => {
      const customRole = p.role_id ? roleById.get(p.role_id) ?? null : null
      const deptScope = p.department_id ? scopeByDept.get(p.department_id)?.all ?? [] : []
      const rolePerms = p.role_id ? customRole?.permissions ?? [] : null
      const perms = effectivePermissions(p.role, rolePerms, deptScope)
      const modules = MODULES.filter((m) => perms.includes(m.view))
      const functions = FUNCTION_CODES.filter((c) => perms.includes(c))
      const deptGranted = perms.filter((c) => deptScope.includes(c))
      const roleGranted = rolePerms ? perms.filter((c) => rolePerms.includes(c)) : []
      const source =
        normalizeRole(p.role) === 'super_admin'
          ? '系统角色'
          : deptGranted.length > 0 && roleGranted.length > 0
            ? '部门+角色'
            : deptGranted.length > 0
              ? '部门'
              : roleGranted.length > 0
                ? '岗位角色'
                : '系统默认'
      return { person: p, customRole, perms, modules, functions, source }
    })
  }, [directory, roles, scopeByDept])

  const KPI = [
    { label: '部门', value: departments.length, icon: Building2, tone: 'text-brand-600' },
    { label: '岗位', value: positions.length, icon: Briefcase, tone: 'text-ink-700' },
    { label: '自定义角色', value: roles.length, icon: ShieldCheck, tone: 'text-violet-600' },
    // 无权读取全员档案时（RLS 只返回自己），这个数字会失真，直接不展示
    ...(seeMembers
      ? [{
          label: '已归岗成员',
          value: profiles.filter((p) => p.department_id).length,
          icon: Users,
          tone: 'text-emerald-600',
        }]
      : []),
  ]

  /* ---------------- 部门范围快捷操作 ---------------- */
  async function toggleDeptScope(dept: Department, code: PermissionCode) {
    if (!editable) return
    const current = new Set(dept.scope ?? [])
    if (current.has(code)) {
      current.delete(code)
      if (code.endsWith('.view')) current.delete(code.replace('.view', '.edit'))
    } else {
      current.add(code)
      if (code.endsWith('.edit')) current.add(code.replace('.edit', '.view'))
    }
    try {
      await updateRow<Department>('departments', dept.id, { scope: Array.from(current) })
      push(`「${dept.name}」可见范围已更新`)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '更新失败', 'error')
    }
  }

  /** 模块格子三态循环：无 → 只读 → 可编辑 → 无 */
  function cycleModule(dept: Department, mod: (typeof MODULES)[number]) {
    if (!editable || !mod.edit) return
    const own = dept.scope ?? []
    const code = own.includes(mod.edit) ? mod.edit : own.includes(mod.view) ? mod.view : null
    if (code === mod.edit) void toggleDeptScope(dept, mod.edit)
    else if (code === mod.view) void toggleDeptScope(dept, mod.edit)
    else void toggleDeptScope(dept, mod.view)
  }

  function scopeCellClass(state: 'edit' | 'view' | 'inherit-edit' | 'inherit-view' | 'none') {
    return {
      edit: 'bg-brand-600 text-white border border-brand-600',
      view: 'bg-brand-100 text-brand-700 border border-brand-200',
      'inherit-edit': 'bg-white text-brand-500 border border-dashed border-brand-400',
      'inherit-view': 'bg-white text-ink-400 border border-dashed border-ink-300',
      none: 'bg-ink-50 text-ink-300 border border-transparent',
    }[state]
  }

  return (
    <div>
      <PageHeader
        title="组织架构"
        description="部门决定「这个团队能看哪些模块」，岗位角色决定「这个人额外能做什么」，两者叠加生效。"
        actions={
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            options={[
              { value: 'dept', label: '部门' },
              { value: 'position', label: '岗位' },
              { value: 'role', label: '角色' },
              { value: 'overview', label: '权限总览' },
            ]}
          />
        }
      />

      <div className={cn('grid grid-cols-2 gap-2.5 mb-3', seeMembers ? 'sm:grid-cols-4' : 'sm:grid-cols-3')}>
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

      {!editable && (
        <div className="rounded-xl border border-ink-200/70 bg-ink-50 px-3.5 py-2.5 mb-3 flex items-start gap-2">
          <Lock className="w-3.5 h-3.5 text-ink-400 mt-0.5 shrink-0" />
          <p className="text-[11.5px] leading-relaxed text-ink-500">
            你当前是「{role === 'member' ? '普通人员' : '管理员'}」，可以查看组织架构但不能修改。
            如需调整部门、岗位或角色，请联系管理员。
          </p>
        </div>
      )}

      {loading ? (
        <div className="card">
          <LoadingBlock rows={6} />
        </div>
      ) : error ? (
        <div className="card">
          <ErrorBlock message={error} onRetry={reload} />
        </div>
      ) : tab === 'dept' ? (
        <div className="card overflow-hidden">
          <div className="px-3.5 py-2.5 border-b border-ink-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-ink-400" />
              <h3 className="text-[13px] font-semibold text-ink-900">部门层级</h3>
              <span className="text-[11px] text-ink-400">支持多层嵌套，删除部门不会删除成员</span>
            </div>
            {editable && (
              <Button size="sm" variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => openDept({})}>
                新建部门
              </Button>
            )}
          </div>
          {departments.length === 0 ? (
            <EmptyState
              icon={<Building2 className="w-5 h-5" />}
              title="还没有部门"
              description="按团队实际分工建几个部门，再把成员归入对应部门，人员与账号页就能按部门筛选。"
              action={
                editable ? (
                  <Button size="sm" variant="primary" onClick={() => openDept({})}>
                    创建第一个部门
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div>{deptRows}</div>
          )}
        </div>
      ) : tab === 'position' ? (
        <div className="card overflow-hidden">
          <div className="px-3.5 py-2.5 border-b border-ink-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Briefcase className="w-4 h-4 text-ink-400" />
              <h3 className="text-[13px] font-semibold text-ink-900">岗位</h3>
              <span className="text-[11px] text-ink-400">岗位描述职责，与「角色」的权限相互独立</span>
            </div>
            {editable && (
              <Button size="sm" variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => openPos({})}>
                新建岗位
              </Button>
            )}
          </div>
          {positions.length === 0 ? (
            <EmptyState
              icon={<Briefcase className="w-5 h-5" />}
              title="还没有岗位"
              description="岗位用来描述职责与职级，例如「高级运营 P5」，成员可以在人员与账号页挂上。"
              action={
                editable ? (
                  <Button size="sm" variant="primary" onClick={() => openPos({})}>
                    创建第一个岗位
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="bg-ink-50/70 text-ink-500">
                    <th className="text-left font-medium px-4 py-2.5">岗位</th>
                    <th className="text-left font-medium px-4 py-2.5 w-[90px]">职级</th>
                    <th className="text-left font-medium px-4 py-2.5 w-[160px]">所属部门</th>
                    <th className="text-left font-medium px-4 py-2.5 w-[80px]">在岗</th>
                    <th className="text-left font-medium px-4 py-2.5">职责说明</th>
                    {editable && <th className="text-right font-medium px-4 py-2.5 w-[90px]">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.id} className="border-t border-ink-100 hover:bg-ink-50/60">
                      <td className="px-4 py-2.5 font-medium text-ink-900">{p.name}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone="blue">{p.level}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-ink-600">
                        {p.department_id ? deptById.get(p.department_id)?.name ?? '—' : '—'}
                      </td>
                      <td className="px-4 py-2.5 num text-ink-600">{memberCount.pos.get(p.id) ?? 0}</td>
                      <td className="px-4 py-2.5 text-ink-500 max-w-[240px] truncate">{p.description || '—'}</td>
                      {editable && (
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-0.5">
                            <button
                              className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                              title="编辑"
                              onClick={() =>
                                openPos({
                                  id: p.id,
                                  name: p.name,
                                  department_id: p.department_id ?? '',
                                  level: p.level,
                                  description: p.description ?? '',
                                  sort_order: String(p.sort_order),
                                })
                              }
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                              title="删除"
                              onClick={() => setPosToDelete(p)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : tab === 'role' ? (
        <div className="space-y-2.5">
          <div className="card px-3.5 py-2.5 flex items-start gap-2">
            <Info className="w-3.5 h-3.5 text-brand-500 mt-0.5 shrink-0" />
            <p className="text-[11.5px] leading-relaxed text-ink-600">
              角色决定成员<b className="text-ink-800">能看到哪些模块</b>，人员与账号页把角色分配给成员后立即生效（成员刷新页面）。
              内置角色可以改权限、不能删除；「管理账号」「管理组织架构」「系统配置」三项由系统角色决定，不需要在角色里配置。
            </p>
          </div>

          {editable && (
            <div className="flex justify-end">
              <Button size="sm" variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => openRole({})}>
                新建角色
              </Button>
            </div>
          )}

          {roles.length === 0 ? (
            <div className="card">
              <EmptyState
                icon={<ShieldCheck className="w-5 h-5" />}
                title="还没有自定义角色"
                description="建一个角色，勾选它能访问的模块，然后在人员与账号页分配给成员。"
                action={
                  editable ? (
                    <Button size="sm" variant="primary" onClick={() => openRole({})}>
                      创建第一个角色
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {roles.map((r) => {
                const used = memberCount.roleMap.get(r.id) ?? 0
                const has = (code: string) => r.permissions.includes(code)
                return (
                  <div key={r.id} className="card p-3.5 flex flex-col">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h3 className="text-[13px] font-semibold text-ink-900 truncate">{r.name}</h3>
                          {r.is_system && <Badge tone="gray">内置</Badge>}
                        </div>
                        <p className="mt-0.5 text-[11px] text-ink-400 line-clamp-2">
                          {r.description || '未填写说明'}
                        </p>
                      </div>
                      {editable && (
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                            title="编辑"
                            onClick={() =>
                              openRole({
                                id: r.id,
                                name: r.name,
                                description: r.description ?? '',
                                permissions: r.permissions,
                              })
                            }
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {!r.is_system && (
                            <button
                              className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                              title="删除"
                              onClick={() => setRoleToDelete(r)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="mt-2.5 flex flex-wrap gap-1">
                      {MODULES.filter((m) => has(m.view)).map((m) => (
                        <span
                          key={m.key}
                          className={cn(
                            'chip',
                            m.edit && has(m.edit)
                              ? 'bg-brand-50 text-brand-700 border-brand-200/60'
                              : 'bg-ink-100 text-ink-600 border-ink-200/60',
                          )}
                        >
                          {shortModule(m.label)}
                          {m.edit && has(m.edit) ? '·编辑' : ''}
                        </span>
                      ))}
                      {has('data.delete') && (
                        <span className="chip bg-rose-50 text-rose-700 border-rose-200/60">可删除</span>
                      )}
                      {r.permissions.length === 0 && (
                        <span className="text-[11px] text-ink-300">未配置任何权限</span>
                      )}
                    </div>

                    <div className="mt-auto pt-2.5 flex items-center justify-between text-[11px] text-ink-400">
                      <span className="num">{used} 人在用</span>
                      <span className="num">{r.permissions.length} 项权限</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="card px-3.5 py-2.5 flex items-start gap-2">
            <Layers className="w-3.5 h-3.5 text-brand-500 mt-0.5 shrink-0" />
            <p className="text-[11.5px] leading-relaxed text-ink-600">
              每一行是一个部门，格子表示该部门的<b className="text-ink-800">可见范围</b>。
              部门内成员自动获得，子部门默认继承上级（可单独关闭）；最终权限 = 部门范围 ∪ 岗位角色。
              {editable ? '点格子可切换：无 → 只读 → 可编辑 → 无。' : '只有管理员可以调整部门范围。'}
            </p>
          </div>

          <div className="card overflow-hidden">
            <div className="px-3.5 py-2.5 border-b border-ink-100 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Building2 className="w-4 h-4 text-ink-400 shrink-0" />
                <h3 className="text-[13px] font-semibold text-ink-900 shrink-0">部门可见范围</h3>
                <span className="text-[11px] text-ink-400 truncate">
                  信息中心管全部模块 · 人力资源部管人事与绩效
                </span>
              </div>
              {editable && (
                <Button size="sm" variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => openDept({})}>
                  新建部门
                </Button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="text-[11.5px] border-collapse">
                <thead>
                  <tr className="bg-ink-50/70 text-ink-500">
                    <th className="sticky left-0 z-10 bg-[#fafbfc] text-left font-medium px-3 py-2 min-w-[190px]">
                      部门 / 可见模块
                    </th>
                    {MODULES.map((m) => (
                      <th key={m.key} className="font-medium px-0.5 py-2 w-[44px] min-w-[44px] text-center whitespace-nowrap" title={m.label}>
                        {MODULE_SHORT[m.key] ?? shortModule(m.label)}
                      </th>
                    ))}
                    {FUNCTION_CODES.map((c) => (
                      <th key={c} className="font-medium px-0.5 py-2 w-[52px] min-w-[52px] text-center whitespace-nowrap" title={FUNCTION_META[c].desc}>
                        {FUNCTION_SHORT[c] ?? FUNCTION_META[c].label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixRows.map(({ dept, depth }) => {
                    const scope = scopeByDept.get(dept.id)
                    const own = dept.scope ?? []
                    const inherited = scope?.inherited ?? []
                    return (
                      <tr key={dept.id} className="border-t border-ink-100 hover:bg-ink-50/40">
                        <td className="sticky left-0 z-10 bg-white px-3 py-1.5">
                          <div style={{ paddingLeft: depth * 14 }} className="flex items-center gap-1.5">
                            <span className="text-[12px] font-medium text-ink-800 truncate">{dept.name}</span>
                            {dept.code && (
                              <span className="text-[9px] text-ink-400 border border-ink-200 rounded px-1 py-px shrink-0">
                                {dept.code}
                              </span>
                            )}
                            {dept.inherit_parent === false && (
                              <span className="text-[9px] text-amber-600 shrink-0">不继承</span>
                            )}
                            <span className="ml-auto text-[10px] text-ink-400 num shrink-0">
                              {memberCount.dept.get(dept.id) ?? 0} 人
                            </span>
                          </div>
                        </td>
                        {MODULES.map((m) => {
                          const state = own.includes(m.edit as PermissionCode)
                            ? 'edit'
                            : own.includes(m.view)
                              ? 'view'
                              : inherited.includes(m.edit as PermissionCode)
                                ? 'inherit-edit'
                                : inherited.includes(m.view)
                                  ? 'inherit-view'
                                  : 'none'
                          return (
                            <td key={m.key} className="px-0.5 py-1.5 text-center">
                              <button
                                className={cn(
                                  'w-6 h-5 rounded text-[9px] leading-none grid place-items-center mx-auto transition-colors',
                                  scopeCellClass(state),
                                  editable ? 'hover:opacity-80 cursor-pointer' : 'cursor-default',
                                )}
                                title={`${dept.name} · ${m.label}：${
                                  state === 'edit'
                                    ? '本部门可编辑'
                                    : state === 'view'
                                      ? '本部门只读'
                                      : state === 'inherit-edit' || state === 'inherit-view'
                                        ? '继承自上级'
                                        : '不可见'
                                }`}
                                onClick={() => cycleModule(dept, m)}
                                disabled={!editable}
                              >
                                {state === 'edit' ? '写' : state === 'view' ? '读' : state === 'none' ? '·' : '继'}
                              </button>
                            </td>
                          )
                        })}
                        {FUNCTION_CODES.map((c) => {
                          const state = own.includes(c)
                            ? 'edit'
                            : inherited.includes(c)
                              ? 'inherit-edit'
                              : 'none'
                          return (
                            <td key={c} className="px-0.5 py-1.5 text-center">
                              <button
                                className={cn(
                                  'w-6 h-5 rounded text-[9px] leading-none grid place-items-center mx-auto transition-colors',
                                  scopeCellClass(state),
                                  editable ? 'hover:opacity-80 cursor-pointer' : 'cursor-default',
                                )}
                                title={`${dept.name} · ${FUNCTION_META[c].label}：${state === 'none' ? '未授予' : state === 'edit' ? '本部门已授予' : '继承自上级'}`}
                                onClick={() => void toggleDeptScope(dept, c)}
                                disabled={!editable}
                              >
                                {state === 'none' ? '·' : state === 'edit' ? '✓' : '继'}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-3.5 py-2 border-t border-ink-100 flex flex-wrap items-center gap-3 text-[10.5px] text-ink-500">
              <span className="inline-flex items-center gap-1">
                <span className="w-3.5 h-3 rounded bg-brand-600" />本部门可编辑
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-3.5 h-3 rounded bg-brand-100 border border-brand-200" />本部门只读
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-3.5 h-3 rounded bg-white border border-dashed border-brand-400" />继承上级
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-3.5 h-3 rounded bg-ink-50 border border-ink-200" />不可见
              </span>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="px-3.5 py-2.5 border-b border-ink-100 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-ink-400" />
                <h3 className="text-[13px] font-semibold text-ink-900">成员归属与有效权限</h3>
                <span className="text-[11px] text-ink-400">谁在哪个部门、能看哪些模块，一屏看完</span>
              </div>
              <span className="text-[11px] text-ink-400 num">{memberRows.length} 人</span>
            </div>
            {memberRows.length === 0 ? (
              <EmptyState
                icon={<Users className="w-5 h-5" />}
                title="还没有成员"
                description="在「人员与账号」里新建账号并指定部门后，这里会显示每个人的权限来源。"
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-ink-50/70 text-ink-500">
                      <th className="text-left font-medium px-4 py-2.5 min-w-[180px]">成员</th>
                      <th className="text-left font-medium px-4 py-2.5 w-[120px]">部门</th>
                      <th className="text-left font-medium px-4 py-2.5 w-[110px]">岗位</th>
                      <th className="text-left font-medium px-4 py-2.5 w-[100px]">系统角色</th>
                      <th className="text-left font-medium px-4 py-2.5 w-[110px]">岗位角色</th>
                      <th className="text-left font-medium px-4 py-2.5">可见模块</th>
                      <th className="text-left font-medium px-4 py-2.5 w-[110px]">来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memberRows.map(({ person, customRole, modules, functions, source }) => {
                      const dept = person.department_id ? deptMap.get(person.department_id) : null
                      const pos = person.position_id ? positions.find((x) => x.id === person.position_id) : null
                      const left = person.employment_status === 'left'
                      return (
                        <tr key={person.id} className={cn('border-t border-ink-100', left && 'bg-ink-50/40')}>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <Avatar name={person.full_name ?? person.email} size={26} />
                              <div className="min-w-0">
                                <p className={cn('font-medium truncate', left ? 'text-ink-400' : 'text-ink-900')}>
                                  {person.full_name || '未命名'}
                                  {person.is_leader && (
                                    <span className="ml-1.5 text-[9.5px] text-brand-600 border border-brand-200 rounded px-1">
                                      负责人
                                    </span>
                                  )}
                                </p>
                                <p className="text-[10.5px] text-ink-400 truncate">{person.email ?? '—'}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            {dept ? (
                              <span className="text-ink-700">{dept.name}</span>
                            ) : (
                              <span className="text-amber-600">未归岗</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-ink-600">{pos?.name ?? '—'}</td>
                          <td className="px-4 py-2.5">
                            <Badge tone={normalizeRole(person.role) === 'member' ? 'gray' : normalizeRole(person.role) === 'admin' ? 'blue' : 'violet'}>
                              {normalizeRole(person.role) === 'super_admin' ? '超管' : normalizeRole(person.role) === 'admin' ? '管理员' : '成员'}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5 text-ink-600">{customRole?.name ?? '默认'}</td>
                          <td className="px-4 py-2.5">
                            <div className="flex flex-wrap items-center gap-1">
                              {modules.slice(0, 5).map((m) => (
                                <span key={m.key} className="chip bg-ink-100 text-ink-600 border-ink-200/60 !text-[10px] !py-0">
                                  {shortModule(m.label)}
                                </span>
                              ))}
                              {modules.length > 5 && (
                                <span className="text-[10px] text-ink-400">+{modules.length - 5}</span>
                              )}
                              {functions.map((c) => (
                                <span key={c} className="chip bg-violet-50 text-violet-700 border-violet-200/60 !text-[10px] !py-0">
                                  {FUNCTION_META[c].label}
                                </span>
                              ))}
                              {modules.length === 0 && functions.length === 0 && (
                                <span className="text-[10.5px] text-ink-300">无业务模块</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={cn(
                                'text-[10.5px] px-1.5 py-0.5 rounded border whitespace-nowrap',
                                source === '部门+角色'
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200/60'
                                  : source === '部门'
                                    ? 'bg-brand-50 text-brand-700 border-brand-200/60'
                                    : 'bg-ink-100 text-ink-600 border-ink-200/60',
                              )}
                            >
                              {source}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
        当前登录：<b className="text-ink-600">{me?.full_name || user?.email}</b>
        {me?.department_id && ` · ${deptById.get(me.department_id)?.name ?? ''}`}
        {me?.position_id && ` · ${positions.find((p) => p.id === me.position_id)?.name ?? ''}`}
        {me?.role_id && ` · ${roles.find((r) => r.id === me.role_id)?.name ?? ''}`}
        <br />
        部门范围决定团队的可见模块，岗位角色决定个人额外的业务范围；两者取并集后，仍受系统角色上限约束。
        删除部门或岗位不会删除账号，成员会变成「未归岗」，权限随之收缩。
      </p>

      {/* ---------------- 部门弹窗 ---------------- */}
      <Modal
        open={deptModal}
        onClose={() => setDeptModal(false)}
        title={deptForm.id ? '编辑部门' : '新建部门'}
        description="部门支持多层嵌套；这里的「可见范围」会对部门内所有成员生效。"
        width="max-w-2xl"
        footer={
          <>
            <Button onClick={() => setDeptModal(false)}>取消</Button>
            <Button variant="primary" onClick={saveDept} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field label="部门名称" required>
              <input
                className="input"
                value={deptForm.name}
                placeholder="例如：亚马逊运营组"
                onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })}
              />
            </Field>
            <Field label="部门编码" hint="如 IT / HR">
              <input
                className="input uppercase"
                value={deptForm.code}
                placeholder="OPS"
                onChange={(e) => setDeptForm({ ...deptForm, code: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="上级部门">
              <Select
                value={deptForm.parent_id}
                onChange={(v) => setDeptForm({ ...deptForm, parent_id: v })}
                options={deptOptions.filter((o) => o.value !== deptForm.id)}
                placeholder="（作为顶级部门）"
              />
            </Field>
            <Field label="负责人">
              <Select
                value={deptForm.leader_id}
                onChange={(v) => setDeptForm({ ...deptForm, leader_id: v })}
                options={memberOptions}
                disabled={!seeMembers}
              />
            </Field>
          </div>
          <Field label="职能说明">
            <input
              className="input"
              value={deptForm.description}
              placeholder="这个部门负责什么"
              onChange={(e) => setDeptForm({ ...deptForm, description: e.target.value })}
            />
          </Field>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="label !mb-0">部门可见范围</label>
              <div className="flex items-center gap-1.5">
                <span className="text-[10.5px] text-ink-400">
                  已选 <b className="text-ink-700 num">{deptForm.scope.length}</b> 项
                </span>
                <button
                  className="text-[10.5px] text-brand-600 hover:underline"
                  onClick={() =>
                    setDeptForm({ ...deptForm, scope: DEPT_GRANTS })
                  }
                >
                  全选
                </button>
                <button
                  className="text-[10.5px] text-ink-400 hover:underline"
                  onClick={() => setDeptForm({ ...deptForm, scope: [] })}
                >
                  清空
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-ink-200/70 overflow-hidden">
              <div className="px-2.5 py-2 bg-ink-50/70 border-b border-ink-100 flex flex-wrap items-center gap-1">
                <span className="text-[10.5px] text-ink-500 flex items-center gap-1 mr-1">
                  <Sparkles className="w-3 h-3 text-brand-500" />
                  套用模板
                </span>
                {DEPT_TEMPLATES.map((t) => (
                  <button
                    key={t.key}
                    className="chip bg-white text-ink-600 border-ink-200 hover:border-brand-300 hover:text-brand-700 !text-[10.5px]"
                    title={t.desc}
                    onClick={() =>
                      setDeptForm((prev) => ({
                        ...prev,
                        code: prev.code || t.code,
                        description: prev.description || t.desc,
                        scope: t.scope,
                      }))
                    }
                  >
                    {t.name}
                  </button>
                ))}
              </div>

              <div className="max-h-[360px] overflow-y-auto no-scrollbar">
                {MODULES.map((m) => {
                  const hasView = deptForm.scope.includes(m.view)
                  const hasEdit = !!m.edit && deptForm.scope.includes(m.edit)
                  return (
                    <div key={m.key} className="px-2.5 py-1.5 border-b border-ink-100/70 flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] text-ink-800">{m.label}</p>
                      </div>
                      <label className="flex items-center gap-1 text-[10.5px] text-ink-500 cursor-pointer">
                        <input
                          type="checkbox"
                          className="w-3.5 h-3.5 accent-brand-600"
                          checked={hasView}
                          onChange={(e) => setDeptForm({ ...deptForm, scope: toggleCode(deptForm.scope, m.view, e.target.checked) })}
                        />
                        查看
                      </label>
                      <label className="flex items-center gap-1 text-[10.5px] text-ink-500 cursor-pointer w-[46px]">
                        {m.edit ? (
                          <>
                            <input
                              type="checkbox"
                              className="w-3.5 h-3.5 accent-brand-600"
                              checked={hasEdit}
                              onChange={(e) =>
                                setDeptForm({ ...deptForm, scope: toggleCode(deptForm.scope, m.edit as PermissionCode, e.target.checked) })
                              }
                            />
                            编辑
                          </>
                        ) : (
                          <span className="text-ink-300">—</span>
                        )}
                      </label>
                    </div>
                  )
                })}
                {FUNCTION_CODES.map((c) => {
                  const on = deptForm.scope.includes(c)
                  return (
                    <div key={c} className="px-2.5 py-1.5 bg-violet-50/30 flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] text-ink-800">{FUNCTION_META[c].label}</p>
                        <p className="text-[10px] text-ink-400 truncate">{FUNCTION_META[c].desc}</p>
                      </div>
                      <input
                        type="checkbox"
                        className="w-3.5 h-3.5 accent-violet-600"
                        checked={on}
                        onChange={(e) => setDeptForm({ ...deptForm, scope: toggleCode(deptForm.scope, c, e.target.checked) })}
                      />
                    </div>
                  )
                })}
              </div>
              <div className="px-2.5 py-1 text-[10px] text-ink-400 bg-ink-50/60 border-t border-ink-100">
                共 {MODULES.length + FUNCTION_CODES.length} 项，列表可滚动
              </div>
            </div>

            <label className="mt-2 flex items-start gap-2 text-[11.5px] text-ink-600 cursor-pointer">
              <input
                type="checkbox"
                className="w-3.5 h-3.5 mt-0.5 accent-brand-600"
                checked={deptForm.inherit_parent}
                onChange={(e) => setDeptForm({ ...deptForm, inherit_parent: e.target.checked })}
              />
              <span>
                继承上级部门的可见范围
                <span className="block text-[10.5px] text-ink-400">
                  关闭后，本部门只保留自己勾选的模块（适合保密团队）
                </span>
              </span>
            </label>
          </div>

          <Field label="排序" hint="数字越小越靠前">
            <input
              className="input"
              type="number"
              value={deptForm.sort_order}
              onChange={(e) => setDeptForm({ ...deptForm, sort_order: e.target.value })}
            />
          </Field>
        </div>
      </Modal>

      {/* ---------------- 岗位弹窗 ---------------- */}
      <Modal
        open={posModal}
        onClose={() => setPosModal(false)}
        title={posForm.id ? '编辑岗位' : '新建岗位'}
        description="岗位描述职责与职级，不直接决定权限。"
        footer={
          <>
            <Button onClick={() => setPosModal(false)}>取消</Button>
            <Button variant="primary" onClick={savePos} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="岗位名称" required>
              <input
                className="input"
                value={posForm.name}
                placeholder="例如：高级运营"
                onChange={(e) => setPosForm({ ...posForm, name: e.target.value })}
              />
            </Field>
            <Field label="职级" hint="可自定义，如 P5 / M2">
              <input
                className="input"
                value={posForm.level}
                onChange={(e) => setPosForm({ ...posForm, level: e.target.value })}
              />
            </Field>
          </div>
          <Field label="所属部门">
            <Select
              value={posForm.department_id}
              onChange={(v) => setPosForm({ ...posForm, department_id: v })}
              options={deptOptions}
              placeholder="（通用岗位，不绑定部门）"
            />
          </Field>
          <Field label="职责说明">
            <input
              className="input"
              value={posForm.description}
              placeholder="这个岗位主要做什么"
              onChange={(e) => setPosForm({ ...posForm, description: e.target.value })}
            />
          </Field>
          <Field label="排序" hint="数字越小越靠前">
            <input
              className="input"
              type="number"
              value={posForm.sort_order}
              onChange={(e) => setPosForm({ ...posForm, sort_order: e.target.value })}
            />
          </Field>
        </div>
      </Modal>

      {/* ---------------- 角色弹窗 ---------------- */}
      <Modal
        open={roleModal}
        onClose={() => setRoleModal(false)}
        title={roleForm.id ? '编辑角色' : '新建角色'}
        description="勾选该角色可以访问的模块。勾了「编辑」会自动带上「查看」。"
        width="max-w-2xl"
        footer={
          <>
            <Button onClick={() => setRoleModal(false)}>取消</Button>
            <Button variant="primary" onClick={saveRole} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="角色名称" required>
              <input
                className="input"
                value={roleForm.name}
                placeholder="例如：广告投手"
                onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
              />
            </Field>
            <Field label="说明">
              <input
                className="input"
                value={roleForm.description}
                placeholder="这个角色负责什么"
                onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })}
              />
            </Field>
          </div>

          <div className="rounded-lg border border-ink-200/70 overflow-hidden">
            <div className="px-3 py-2 bg-ink-50/70 text-[11px] text-ink-500 flex items-center justify-between">
              <span>模块权限</span>
              <div className="flex items-center gap-4 pr-1">
                <span className="w-10 text-center">查看</span>
                <span className="w-10 text-center">编辑</span>
              </div>
            </div>
            {MODULES.map((m) => {
              const canView = roleForm.permissions.includes(m.view)
              const canEdit = !!m.edit && roleForm.permissions.includes(m.edit)
              return (
                <div
                  key={m.key}
                  className="px-3 py-2 border-t border-ink-100 flex items-center gap-2 hover:bg-ink-50/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] text-ink-800">{m.label}</p>
                    <p className="text-[10.5px] text-ink-400 truncate">{m.desc}</p>
                  </div>
                  <div className="flex items-center gap-4 pr-1 shrink-0">
                    <div className="w-10 flex justify-center">
                      <input
                        type="checkbox"
                        className="w-3.5 h-3.5 accent-brand-600 cursor-pointer"
                        checked={canView}
                        onChange={(e) => togglePerm(m.view, e.target.checked)}
                      />
                    </div>
                    <div className="w-10 flex justify-center">
                      {m.edit ? (
                        <input
                          type="checkbox"
                          className="w-3.5 h-3.5 accent-brand-600 cursor-pointer"
                          checked={canEdit}
                          onChange={(e) => togglePerm(m.edit as string, e.target.checked)}
                        />
                      ) : (
                        <span className="text-[11px] text-ink-300">—</span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {FUNCTION_CODES.map((c) => (
              <div key={c} className="px-3 py-2 border-t border-ink-100 flex items-center gap-2 bg-violet-50/30">
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] text-ink-800">{FUNCTION_META[c].label}</p>
                  <p className="text-[10.5px] text-ink-400">{FUNCTION_META[c].desc}</p>
                </div>
                <input
                  type="checkbox"
                  className="w-3.5 h-3.5 accent-violet-600 cursor-pointer shrink-0"
                  checked={roleForm.permissions.includes(c)}
                  onChange={(e) => togglePerm(c, e.target.checked)}
                />
              </div>
            ))}
            <div className="px-3 py-2 border-t border-ink-100 flex items-center gap-2 bg-rose-50/30">
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] text-ink-800">删除业务数据</p>
                <p className="text-[10.5px] text-ink-400">
                  删除订单、商品、店铺等记录。开启后该角色可执行不可恢复操作。
                </p>
              </div>
              <input
                type="checkbox"
                className="w-3.5 h-3.5 accent-rose-600 cursor-pointer shrink-0"
                checked={roleForm.permissions.includes('data.delete')}
                onChange={(e) => togglePerm('data.delete', e.target.checked)}
              />
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-ink-400">
            已选 <b className="text-ink-700 num">{roleForm.permissions.length}</b> 项。
            「管理账号」「管理组织架构」「系统配置」不由角色控制，只有管理员及以上才具备；
            普通人员即使角色里勾了删除权限也不会生效。
          </p>
        </div>
      </Modal>

      {/* ---------------- 删除确认 ---------------- */}
      <ConfirmDialog
        open={!!deptToDelete}
        onClose={() => setDeptToDelete(null)}
        onConfirm={removeDept}
        loading={saving}
        title="删除部门"
        confirmText="确认删除"
        message={
          deptToDelete
            ? `将删除「${deptToDelete.name}」。其子部门会变成顶级部门，${memberCount.dept.get(deptToDelete.id) ?? 0} 名成员的部门归属会变为「未分配」，成员账号本身不受影响。`
            : ''
        }
      />
      <ConfirmDialog
        open={!!posToDelete}
        onClose={() => setPosToDelete(null)}
        onConfirm={removePos}
        loading={saving}
        title="删除岗位"
        confirmText="确认删除"
        message={
          posToDelete
            ? `将删除岗位「${posToDelete.name}」，${memberCount.pos.get(posToDelete.id) ?? 0} 名成员的岗位会变为「未分配」。`
            : ''
        }
      />
      <ConfirmDialog
        open={!!roleToDelete}
        onClose={() => setRoleToDelete(null)}
        onConfirm={removeRole}
        loading={saving}
        title="删除角色"
        confirmText="确认删除"
        message={
          roleToDelete
            ? `将删除角色「${roleToDelete.name}」，${memberCount.roleMap.get(roleToDelete.id) ?? 0} 名成员会退回系统角色默认权限（普通人员可读写全部业务数据），请确认不会再放大权限。`
            : ''
        }
      />
    </div>
  )
}
