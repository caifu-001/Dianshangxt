import { useMemo, useState } from 'react'
import {
  ShieldCheck,
  UserCog,
  UserMinus,
  UserX,
  Users,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { deleteRow, fetchRows, updateRow } from '../lib/db'
import type { Profile } from '../lib/types'
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
  LoadingBlock,
  PageHeader,
  SearchInput,
  useToast,
} from '../components/ui'
import { cn, fmtDateTime } from '../lib/utils'

const TONE: Record<Role, 'violet' | 'blue' | 'gray'> = {
  super_admin: 'violet',
  admin: 'blue',
  member: 'gray',
}

export default function Accounts() {
  const { user, profile: me, role, isSuperAdmin } = useAuth()
  const { push } = useToast()
  const { data, loading, error, reload } = useAsync(
    async () => fetchRows<Profile>('profiles', { order: { column: 'created_at', ascending: true } }),
    [],
  )

  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Profile | null>(null)
  const [removeLoading, setRemoveLoading] = useState(false)

  const list = useMemo(() => data ?? [], [data])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (p) => (p.email ?? '').toLowerCase().includes(q) || (p.full_name ?? '').toLowerCase().includes(q),
    )
  }, [list, query])

  const stats = useMemo(
    () => ({
      total: list.length,
      superAdmin: list.filter((p) => normalizeRole(p.role) === 'super_admin').length,
      admin: list.filter((p) => normalizeRole(p.role) === 'admin').length,
      member: list.filter((p) => normalizeRole(p.role) === 'member').length,
      disabled: list.filter((p) => p.status === 'disabled').length,
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
    { label: '已禁用', value: stats.disabled, icon: UserX, tone: stats.disabled ? 'text-rose-600' : 'text-ink-400' },
  ]

  return (
    <div>
      <PageHeader
        title="账号管理"
        description="分配角色、启用或禁用成员。团队成员共享同一套业务数据，权限决定能做什么。"
        actions={<SearchInput value={query} onChange={setQuery} placeholder="搜索邮箱或称呼" className="w-56" />}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 mb-3">
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
          <b className="text-ink-800">{ROLE_META.super_admin.label}</b>：全部权限，可移除账号；
          <b className="text-ink-800 ml-1.5">{ROLE_META.admin.label}</b>：可删业务数据，只能管普通人员；
          <b className="text-ink-800 ml-1.5">{ROLE_META.member.label}</b>：可读写业务数据，不能删除、不能管人。
          <br />
          新同事请先让他在登录页自助注册，注册后默认是普通人员，再回到这里调整角色。
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
                  <th className="text-left font-medium px-4 py-2.5 w-[150px]">角色</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[104px]">状态</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[150px]">最近登录</th>
                  <th className="text-left font-medium px-4 py-2.5 w-[150px]">加入时间</th>
                  <th className="text-right font-medium px-4 py-2.5 w-[160px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const targetRole = normalizeRole(p.role)
                  const mine = p.id === user?.id
                  const operable = canOperateOn(role, p, user?.id)
                  const disabled = p.status === 'disabled'
                  const busy = busyId === p.id

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
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-2.5">
                        {operable ? (
                          <select
                            className="input !h-7 !py-0 w-[112px] text-[12px]"
                            value={targetRole}
                            disabled={busy}
                            onChange={(e) => changeRole(p, e.target.value as Role)}
                          >
                            {roleOptions.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_META[r].label}
                              </option>
                            ))}
                            {/* 目标角色不在可授予范围时（例如管理员看另一个管理员），补一个只读项 */}
                            {!roleOptions.includes(targetRole) && (
                              <option value={targetRole}>{ROLE_META[targetRole].label}</option>
                            )}
                          </select>
                        ) : (
                          <Badge tone={TONE[targetRole]}>{ROLE_META[targetRole].short}</Badge>
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
                        <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                          {operable ? (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={busy}
                                onClick={() => toggleStatus(p)}
                                icon={disabled ? <ShieldCheck className="w-3.5 h-3.5" /> : <UserX className="w-3.5 h-3.5" />}
                              >
                                {disabled ? '启用' : '禁用'}
                              </Button>
                              {isSuperAdmin && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="!text-rose-600 hover:!bg-rose-50"
                                  onClick={() => setRemoving(p)}
                                  icon={<UserMinus className="w-3.5 h-3.5" />}
                                >
                                  移除
                                </Button>
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
        当前你的角色：<b className="text-ink-600">{ROLE_META[role].label}</b>（{ROLE_META[role].desc}）
        {me?.email ? ` · ${me.email}` : ''}
        <br />
        所有校验都在数据库层完成（RLS + 触发器），绕过界面直接调接口同样会被拒绝。
      </p>

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
