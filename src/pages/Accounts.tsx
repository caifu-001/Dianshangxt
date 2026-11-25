import { useMemo, useState } from 'react'
import {
  Network,
  ShieldCheck,
  UserCog,
  UserMinus,
  UserX,
  Users,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { deleteRow, fetchRows, updateRow } from '../lib/db'
import type { Department, Position, Profile, RoleDef } from '../lib/types'
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
  Select,
  useToast,
} from '../components/ui'
import { cn, fmtDateTime } from '../lib/utils'

const TONE: Record<Role, 'violet' | 'blue' | 'gray'> = {
  super_admin: 'violet',
  admin: 'blue',
  member: 'gray',
}

interface OrgForm {
  id: string
  name: string
  department_id: string
  position_id: string
  role_id: string
  note: string
}

export default function Accounts() {
  const { user, profile: me, role, isSuperAdmin } = useAuth()
  const { push } = useToast()

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
  const [busyId, setBusyId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Profile | null>(null)
  const [removeLoading, setRemoveLoading] = useState(false)
  const [orgForm, setOrgForm] = useState<OrgForm | null>(null)
  const [orgSaving, setOrgSaving] = useState(false)

  const list = useMemo(() => data?.profiles ?? [], [data])
  const departments = useMemo(() => data?.departments ?? [], [data])
  const positions = useMemo(() => data?.positions ?? [], [data])
  const roles = useMemo(() => data?.roles ?? [], [data])

  const deptById = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments])
  const posById = useMemo(() => new Map(positions.map((p) => [p.id, p])), [positions])
  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((p) => {
      const dept = p.department_id ? deptById.get(p.department_id)?.name ?? '' : ''
      const pos = p.position_id ? posById.get(p.position_id)?.name ?? '' : ''
      return (
        (p.email ?? '').toLowerCase().includes(q) ||
        (p.full_name ?? '').toLowerCase().includes(q) ||
        dept.includes(q) ||
        pos.includes(q)
      )
    })
  }, [list, query, deptById, posById])

  const stats = useMemo(
    () => ({
      total: list.length,
      superAdmin: list.filter((p) => normalizeRole(p.role) === 'super_admin').length,
      admin: list.filter((p) => normalizeRole(p.role) === 'admin').length,
      member: list.filter((p) => normalizeRole(p.role) === 'member').length,
      disabled: list.filter((p) => p.status === 'disabled').length,
      unassigned: list.filter((p) => !p.department_id).length,
    }),
    [list],
  )

  const roleOptions = assignableRoles(role)

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
      push(next === 'disabled' ? '账号已禁用，该用户将立即失去数据访问' : '账号已恢复启用')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '状态修改失败', 'error')
    } finally {
      setBusyId(null)
    }
  }

  function openOrg(target: Profile) {
    setOrgForm({
      id: target.id,
      name: target.full_name || target.email || '未命名',
      department_id: target.department_id ?? '',
      position_id: target.position_id ?? '',
      role_id: target.role_id ?? '',
      note: target.note ?? '',
    })
  }

  async function saveOrg() {
    if (!orgForm) return
    setOrgSaving(true)
    try {
      await updateRow<Profile>('profiles', orgForm.id, {
        department_id: orgForm.department_id || null,
        position_id: orgForm.position_id || null,
        role_id: orgForm.role_id || null,
        note: orgForm.note.trim() || null,
      })
      push('组织信息已更新')
      setOrgForm(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setOrgSaving(false)
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

  const KPI = [
    { label: '账号总数', value: stats.total, icon: Users, tone: 'text-ink-900' },
    { label: '超级管理员', value: stats.superAdmin, icon: ShieldCheck, tone: 'text-violet-600' },
    { label: '普通管理员', value: stats.admin, icon: UserCog, tone: 'text-brand-600' },
    { label: '普通人员', value: stats.member, icon: Users, tone: 'text-ink-700' },
    { label: '未归岗', value: stats.unassigned, icon: Network, tone: stats.unassigned ? 'text-amber-600' : 'text-ink-400' },
    { label: '已禁用', value: stats.disabled, icon: UserX, tone: stats.disabled ? 'text-rose-600' : 'text-ink-400' },
  ]

  const posOptions = useMemo(
    () => positions.map((p) => ({ value: p.id, label: `${p.name}（${p.level}）` })),
    [positions],
  )

  return (
    <div>
      <PageHeader
        title="账号管理"
        description="分配系统角色与岗位角色、归属部门岗位。团队成员共享同一套业务数据，权限决定能做什么。"
        actions={<SearchInput value={query} onChange={setQuery} placeholder="搜索姓名 / 邮箱 / 部门" className="w-60" />}
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
          <b className="text-ink-800 ml-1.5">岗位角色</b>决定业务范围：能看到哪些模块、能不能删数据。
          两者叠加生效，普通人员永远拿不到管理类权限。
          <br />
          新同事先让他在登录页自助注册（默认普通人员），再回到这里调整角色与组织归属。
        </p>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <LoadingBlock rows={6} />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={<Users className="w-5 h-5" />} title="没有匹配的账号" description="换个关键词试试" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="bg-ink-50/70 text-ink-500">
                  <th className="text-left font-medium px-4 py-2.5">成员</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[150px]">系统角色 / 岗位角色</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[96px]">状态</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[142px]">最近登录</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[142px]">加入时间</th>
                  <th className="text-right font-medium px-4 py-2.5 w-[124px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const targetRole = normalizeRole(p.role)
                  const mine = p.id === user?.id
                  const operable = canOperateOn(role, p, user?.id)
                  const disabled = p.status === 'disabled'
                  const busy = busyId === p.id
                  const dept = p.department_id ? deptById.get(p.department_id) : null
                  const pos = p.position_id ? posById.get(p.position_id) : null
                  const customRole = p.role_id ? roleById.get(p.role_id) : null

                  return (
                    <tr key={p.id} className={cn('border-t border-ink-100', disabled && 'bg-ink-50/40')}>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={p.full_name ?? p.email} size={30} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={cn('font-medium truncate', disabled ? 'text-ink-400' : 'text-ink-900')}>
                                {p.full_name || '未命名'}
                              </span>
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
                            </p>
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-2.5 space-y-1">
                        {operable ? (
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
                        {disabled ? <Badge tone="red" dot>已禁用</Badge> : <Badge tone="green" dot>正常</Badge>}
                      </td>

                      <td className="px-4 py-2.5 text-ink-500 num">
                        {p.last_sign_in_at ? fmtDateTime(p.last_sign_in_at) : '从未登录'}
                      </td>

                      <td className="px-4 py-2.5 text-ink-500 num">{fmtDateTime(p.created_at)}</td>

                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-0.5 whitespace-nowrap">
                          {operable ? (
                            <>
                              <button
                                className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-brand-50"
                                title="部门 / 岗位 / 角色"
                                disabled={busy}
                                onClick={() => openOrg(p)}
                              >
                                <Network className="w-3.5 h-3.5" />
                              </button>
                              <button
                                className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                                title={disabled ? '启用账号' : '禁用账号'}
                                disabled={busy}
                                onClick={() => toggleStatus(p)}
                              >
                                {disabled ? <ShieldCheck className="w-3.5 h-3.5" /> : <UserX className="w-3.5 h-3.5" />}
                              </button>
                              {isSuperAdmin && (
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
        所有校验都在数据库层完成（RLS + 触发器），绕过界面直接调接口同样会被拒绝；
        部门 / 岗位 / 岗位角色只能由管理员修改，防止成员给自己提权。
      </p>

      {/* 组织信息弹窗 */}
      <Modal
        open={!!orgForm}
        onClose={() => setOrgForm(null)}
        title="调整组织信息"
        description={orgForm ? `成员：${orgForm.name}` : undefined}
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
            <Field label="岗位角色" hint="决定该成员能看到哪些业务模块；留空则按系统角色默认权限">
              <Select
                value={orgForm.role_id}
                onChange={(v) => setOrgForm({ ...orgForm, role_id: v })}
                options={roles.map((r) => ({ value: r.id, label: r.name }))}
                placeholder="默认（按系统角色）"
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

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={handleRemove}
        loading={removeLoading}
        title="移除账号档案"
        confirmText="确认移除"
        message={
          removing
            ? `将移除 ${removing.full_name || removing.email} 的档案，该账号会立刻失去系统访问权限，其录入的业务数据保留。注意：Supabase Auth 里的登录凭据不会被删除，如需彻底删除请到 Supabase 控制台操作。`
            : ''
        }
      />
    </div>
  )
}
