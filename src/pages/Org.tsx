import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Briefcase,
  Building2,
  ChevronRight,
  FolderPlus,
  Info,
  Lock,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { deleteRow, fetchRows, insertRow, updateRow } from '../lib/db'
import type { Department, Position, Profile, RoleDef } from '../lib/types'
import { MODULES } from '../lib/permissions'
import {
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

type Tab = 'dept' | 'position' | 'role'

/* ------------------------------------------------------------------ */
/*  表单类型                                                            */
/* ------------------------------------------------------------------ */
interface DeptForm {
  id?: string
  name: string
  parent_id: string
  leader_id: string
  description: string
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

const EMPTY_DEPT: DeptForm = { name: '', parent_id: '', leader_id: '', description: '', sort_order: '10' }
const EMPTY_POS: PosForm = { name: '', department_id: '', level: 'P3', description: '', sort_order: '10' }
const EMPTY_ROLE: RoleForm = { name: '', description: '', permissions: [] }

function shortModule(label: string) {
  return label.replace('管理', '')
}

export default function Org() {
  const { user, profile: me, can, role } = useAuth()
  const { push } = useToast()

  const { data, loading, error, reload } = useAsync(async () => {
    const [departments, positions, roles, profiles] = await Promise.all([
      fetchRows<Department>('departments', { order: { column: 'sort_order' } }),
      fetchRows<Position>('positions', { order: { column: 'sort_order' } }),
      fetchRows<RoleDef>('roles', { order: { column: 'sort_order' } }),
      // 成员列表受 RLS 限制：只有管人或管组织的人能拿到全员
      fetchRows<Profile>('profiles', { order: { column: 'created_at' } }),
    ])
    return { departments, positions, roles, profiles }
  }, [])

  const editable = can('org.manage')
  const seeMembers = can('org.manage') || can('account.manage')

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
    setDeptForm({ ...EMPTY_DEPT, ...form })
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
        parent_id: deptForm.parent_id || null,
        leader_id: deptForm.leader_id || null,
        description: deptForm.description.trim() || null,
        sort_order: Number(deptForm.sort_order) || 0,
      }
      if (deptForm.id) await updateRow<Department>('departments', deptForm.id, payload)
      else await insertRow<Department>('departments', payload)
      push(deptForm.id ? '部门已更新' : '部门已创建')
      setDeptModal(false)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
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
              {childCount > 0 && (
                <span className="text-[10px] text-ink-400 shrink-0">含 {childCount} 个子部门</span>
              )}
            </div>
            <p className="text-[11px] text-ink-400 truncate">
              {d.description || '未填写职能说明'}
              {leader && ` · 负责人 ${leader.full_name || leader.email}`}
            </p>
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
                    parent_id: d.parent_id ?? '',
                    leader_id: d.leader_id ?? '',
                    description: d.description ?? '',
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

  return (
    <div>
      <PageHeader
        title="组织架构"
        description="维护部门层级、岗位与自定义角色。角色决定成员能看到哪些模块，可随时调整。"
        actions={
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            options={[
              { value: 'dept', label: '部门' },
              { value: 'position', label: '岗位' },
              { value: 'role', label: '角色' },
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
              description="按团队实际分工建几个部门，再把成员归入对应部门，账号管理页就能按部门筛选。"
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
              description="岗位用来描述职责与职级，例如「高级运营 P5」，成员可以在账号管理页挂上。"
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
      ) : (
        <div className="space-y-2.5">
          <div className="card px-3.5 py-2.5 flex items-start gap-2">
            <Info className="w-3.5 h-3.5 text-brand-500 mt-0.5 shrink-0" />
            <p className="text-[11.5px] leading-relaxed text-ink-600">
              角色决定成员<b className="text-ink-800">能看到哪些模块</b>，账号管理页把角色分配给成员后立即生效（成员刷新页面）。
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
                description="建一个角色，勾选它能访问的模块，然后在账号管理页分配给成员。"
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
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
        当前登录：<b className="text-ink-600">{me?.full_name || user?.email}</b>
        {me?.department_id && ` · ${deptById.get(me.department_id)?.name ?? ''}`}
        {me?.position_id && ` · ${positions.find((p) => p.id === me.position_id)?.name ?? ''}`}
        {me?.role_id && ` · ${roles.find((r) => r.id === me.role_id)?.name ?? ''}`}
        <br />
        部门与岗位只做组织描述，<b>权限始终由角色决定</b>；删除角色后成员会退回系统角色默认权限。
      </p>

      {/* ---------------- 部门弹窗 ---------------- */}
      <Modal
        open={deptModal}
        onClose={() => setDeptModal(false)}
        title={deptForm.id ? '编辑部门' : '新建部门'}
        description="部门支持多层嵌套，例如「运营部 → 亚马逊组」。"
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
          <Field label="部门名称" required>
            <input
              className="input"
              value={deptForm.name}
              placeholder="例如：亚马逊运营组"
              onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })}
            />
          </Field>
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
