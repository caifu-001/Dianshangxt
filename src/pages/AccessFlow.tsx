import { useMemo, useState } from 'react'
import {
  ArrowRightLeft,
  Check,
  ClipboardList,
  Clock3,
  FileText,
  Inbox,
  Send,
  ShieldCheck,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  UserX,
  X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { callRpc, fetchRows, insertRow, updateRow } from '../lib/db'
import type { AccessRequest, AccessRequestStatus, EmployeeEvent, EmployeeEventType, Profile, RoleDef } from '../lib/types'
import { ROLE_META, type Role } from '../lib/permissions'
import {
  Avatar,
  Badge,
  Button,
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
import { cn, fmtDateTime } from '../lib/utils'

/** 资源归属表里真正展示的列（其余只在移交时统计） */
const RESOURCE_COLUMNS = [
  { table: 'stores', label: '店铺' },
  { table: 'products', label: '商品' },
  { table: 'orders', label: '订单' },
  { table: 'purchase_orders', label: '采购单' },
  { table: 'competitors', label: '竞品' },
  { table: 'suppliers', label: '供应商' },
  { table: 'supplier_products', label: '供应商产品' },
  { table: 'tasks', label: '任务' },
]

const ALL_TABLES = [
  'stores',
  'products',
  'orders',
  'inventory',
  'campaigns',
  'creators',
  'tasks',
  'expenses',
  'competitors',
  'competitor_snapshots',
  'suppliers',
  'supplier_products',
  'purchase_orders',
  'purchase_items',
]

const STATUS_META: Record<AccessRequestStatus, { label: string; tone: 'amber' | 'green' | 'red' | 'gray' }> = {
  pending: { label: '待审批', tone: 'amber' },
  approved: { label: '已通过', tone: 'green' },
  rejected: { label: '已驳回', tone: 'red' },
  cancelled: { label: '已撤回', tone: 'gray' },
}

const EVENT_META: Record<EmployeeEventType, { label: string; icon: typeof Users; tone: string }> = {
  hire: { label: '入职', icon: UserPlus, tone: 'text-emerald-600 bg-emerald-50' },
  activate: { label: '转正入职', icon: UserCheck, tone: 'text-emerald-600 bg-emerald-50' },
  transfer: { label: '资源移交', icon: ArrowRightLeft, tone: 'text-blue-600 bg-blue-50' },
  permission: { label: '权限变更', icon: ShieldCheck, tone: 'text-violet-600 bg-violet-50' },
  disable: { label: '账号停用', icon: UserX, tone: 'text-rose-600 bg-rose-50' },
  enable: { label: '账号启用', icon: ShieldCheck, tone: 'text-emerald-600 bg-emerald-50' },
  offboard: { label: '离职', icon: UserMinus, tone: 'text-ink-600 bg-ink-100' },
}

export default function AccessFlow() {
  const { user, can, isStaff } = useAuth()
  const { push } = useToast()
  const manage = can('account.manage')

  const [tab, setTab] = useState<'requests' | 'events' | 'resources'>('requests')
  const [statusFilter, setStatusFilter] = useState<'all' | AccessRequestStatus>('all')

  const { data, loading, error, reload } = useAsync(async () => {
    const [requests, profiles, roles, events] = await Promise.all([
      fetchRows<AccessRequest>('access_requests', { order: { column: 'created_at', ascending: false } }),
      fetchRows<Profile>('profiles', { order: { column: 'created_at' } }),
      fetchRows<RoleDef>('roles', { order: { column: 'sort_order' } }),
      fetchRows<EmployeeEvent>('employee_events', { order: { column: 'created_at', ascending: false }, limit: 200 }),
    ])
    return { requests, profiles, roles, events }
  }, [])

  const [reqOpen, setReqOpen] = useState(false)
  const [reqSaving, setReqSaving] = useState(false)
  const [reqForm, setReqForm] = useState({
    kind: 'role' as 'role' | 'system_role',
    target_role_id: '',
    target_role: 'member' as 'admin' | 'member',
    reason: '',
    expect_scope: '',
  })

  const [deciding, setDeciding] = useState<AccessRequest | null>(null)
  const [decisionNote, setDecisionNote] = useState('')
  const [decideSaving, setDecideSaving] = useState(false)
  const [cancelling, setCancelling] = useState<string | null>(null)

  const [transferFrom, setTransferFrom] = useState<Profile | null>(null)
  const [transferTo, setTransferTo] = useState('')
  const [transferSaving, setTransferSaving] = useState(false)

  const profiles = useMemo(() => data?.profiles ?? [], [data])
  const roles = useMemo(() => data?.roles ?? [], [data])
  const requests = useMemo(() => data?.requests ?? [], [data])
  const events = useMemo(() => data?.events ?? [], [data])

  const byId = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles])
  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles])

  const filteredRequests = useMemo(
    () => (statusFilter === 'all' ? requests : requests.filter((r) => r.status === statusFilter)),
    [requests, statusFilter],
  )

  const pendingCount = requests.filter((r) => r.status === 'pending').length

  // 资源归属只在切到该页签时才算，避免每次进页面都扫 13 张表
  const resourceState = useAsync(
    async () => {
      const entries = await Promise.all(
        ALL_TABLES.map(async (table) => {
          try {
            const rows = await fetchRows<{ user_id: string }>(table, { columns: 'user_id' })
            const counts: Record<string, number> = {}
            for (const row of rows) {
              if (!row.user_id) continue
              counts[row.user_id] = (counts[row.user_id] ?? 0) + 1
            }
            return [table, counts] as const
          } catch {
            return [table, {} as Record<string, number>] as const
          }
        }),
      )
      const byUser: Record<string, Record<string, number>> = {}
      for (const [table, counts] of entries) {
        for (const [uid, n] of Object.entries(counts)) {
          byUser[uid] = byUser[uid] ?? {}
          byUser[uid][table] = n
        }
      }
      return byUser
    },
    [],
    tab === 'resources' && manage,
  )

  const resourceRows = useMemo(() => {
    if (!resourceState.data) return []
    return profiles
      .filter((p) => p.employment_status !== 'left')
      .map((p) => {
        const counts = resourceState.data?.[p.id] ?? {}
        const total = Object.values(counts).reduce((a, b) => a + b, 0)
        return { profile: p, counts, total }
      })
      .sort((a, b) => b.total - a.total)
  }, [resourceState.data, profiles])

  function openRequest() {
    setReqForm({
      kind: 'role',
      target_role_id: '',
      target_role: 'member',
      reason: '',
      expect_scope: '',
    })
    setReqOpen(true)
  }

  async function submitRequest() {
    if (!user?.id) return
    if (reqForm.kind === 'role' && !reqForm.target_role_id) return push('请选择要申请的岗位角色', 'error')
    if (!reqForm.reason.trim()) return push('请填写申请理由，方便管理员判断', 'error')
    setReqSaving(true)
    try {
      await insertRow<AccessRequest>('access_requests', {
        user_id: user.id,
        kind: reqForm.kind,
        target_role_id: reqForm.kind === 'role' ? reqForm.target_role_id : null,
        target_role: reqForm.kind === 'system_role' ? reqForm.target_role : null,
        reason: reqForm.reason.trim(),
        expect_scope: reqForm.expect_scope.trim() || null,
      })
      push('申请已提交，等待管理员审批')
      setReqOpen(false)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '提交失败', 'error')
    } finally {
      setReqSaving(false)
    }
  }

  async function decide(approve: boolean) {
    if (!deciding) return
    setDecideSaving(true)
    try {
      await callRpc('decide_access_request', {
        p_id: deciding.id,
        p_approve: approve,
        p_note: decisionNote.trim() || null,
      })
      push(approve ? '已通过，新权限立即生效' : '已驳回')
      setDeciding(null)
      setDecisionNote('')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '审批失败', 'error')
    } finally {
      setDecideSaving(false)
    }
  }

  async function cancelRequest(req: AccessRequest) {
    setCancelling(req.id)
    try {
      // 数据库策略限定了本人只能把 pending 改成 cancelled，改别的值会被拒绝
      await updateRow<AccessRequest>('access_requests', req.id, { status: 'cancelled' })
      push('已撤回申请')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '撤回失败', 'error')
    } finally {
      setCancelling(null)
    }
  }

  async function submitTransfer() {
    if (!transferFrom || !transferTo) return push('请选择接手人', 'error')
    setTransferSaving(true)
    try {
      const moved = await callRpc<Record<string, number>>('transfer_member_resources', {
        p_from: transferFrom.id,
        p_to: transferTo,
      })
      const total = Object.values(moved ?? {}).reduce((a, b) => a + b, 0)
      push(`已移交 ${total} 条记录给 ${byId.get(transferTo)?.full_name ?? '接手人'}`)
      setTransferFrom(null)
      setTransferTo('')
      resourceState.reload()
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '移交失败', 'error')
    } finally {
      setTransferSaving(false)
    }
  }

  const transferOptions = useMemo(
    () =>
      profiles
        .filter((p) => p.id !== transferFrom?.id && p.status === 'active' && p.employment_status !== 'left')
        .map((p) => ({ value: p.id, label: p.full_name || p.email || '未命名' })),
    [profiles, transferFrom],
  )

  const counts = {
    pending: requests.filter((r) => r.status === 'pending').length,
    approved: requests.filter((r) => r.status === 'approved').length,
    rejected: requests.filter((r) => r.status === 'rejected').length,
  }

  return (
    <div>
      <PageHeader
        title="权限流程"
        description="权限申请与审批、人员变动留痕、资源归属与移交。所有动作都写审计记录，可追溯到人和时间。"
        actions={
          <Button variant="primary" icon={<Send className="w-3.5 h-3.5" />} onClick={openRequest}>
            申请权限
          </Button>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-3">
        {[
          { label: '待审批', value: counts.pending, tone: counts.pending ? 'text-amber-600' : 'text-ink-400' },
          { label: '已通过', value: counts.approved, tone: counts.approved ? 'text-emerald-600' : 'text-ink-400' },
          { label: '已驳回', value: counts.rejected, tone: counts.rejected ? 'text-rose-600' : 'text-ink-400' },
          { label: '变动记录', value: events.length, tone: 'text-ink-700' },
        ].map((k) => (
          <div key={k.label} className="card px-3.5 py-3">
            <p className="text-[11px] text-ink-400">{k.label}</p>
            <p className={cn('num text-[20px] font-semibold mt-1 leading-none', k.tone)}>{k.value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Segmented
          size="sm"
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
          options={[
            { value: 'requests', label: `权限申请${pendingCount ? ` · ${pendingCount}` : ''}` },
            { value: 'events', label: '人员变动' },
            { value: 'resources', label: '资源归属' },
          ]}
        />
        {tab === 'requests' && (
          <div className="ml-auto">
            <Segmented
              size="sm"
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as typeof statusFilter)}
              options={[
                { value: 'all', label: '全部' },
                { value: 'pending', label: '待审批' },
                { value: 'approved', label: '已通过' },
                { value: 'rejected', label: '已驳回' },
              ]}
            />
          </div>
        )}
      </div>

      {tab === 'requests' && (
        <div className="card overflow-hidden">
          {loading ? (
            <LoadingBlock rows={5} />
          ) : error ? (
            <ErrorBlock message={error} onRetry={reload} />
          ) : filteredRequests.length === 0 ? (
            <EmptyState
              icon={<Inbox className="w-5 h-5" />}
              title="暂无权限申请"
              description="需要更多模块权限时，点右上角「申请权限」提交，管理员通过后立即生效"
            />
          ) : (
            <div className="divide-y divide-ink-100">
              {filteredRequests.map((r) => {
                const owner = byId.get(r.user_id)
                const targetName =
                  r.kind === 'role'
                    ? roleById.get(r.target_role_id ?? '')?.name ?? '已删除的角色'
                    : ROLE_META[(r.target_role ?? 'member') as Role]?.label ?? r.target_role
                const meta = STATUS_META[r.status]
                const mine = r.user_id === user?.id
                return (
                  <div key={r.id} className="px-4 py-3 flex items-start gap-3">
                    <Avatar name={owner?.full_name ?? owner?.email} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[12.5px] font-medium text-ink-900">
                          {owner?.full_name || owner?.email || '未知成员'}
                          {mine && <span className="ml-1 text-[10px] text-brand-600">（我）</span>}
                        </span>
                        <Badge tone="blue">{r.kind === 'role' ? '岗位角色' : '系统角色'}</Badge>
                        <span className="text-[12px] text-ink-700">→ {targetName}</span>
                        <Badge tone={meta.tone} dot>
                          {meta.label}
                        </Badge>
                        <span className="text-[10.5px] text-ink-400 num ml-auto">{fmtDateTime(r.created_at)}</span>
                      </div>
                      <p className="mt-1 text-[12px] leading-relaxed text-ink-600">{r.reason}</p>
                      {r.expect_scope && (
                        <p className="mt-0.5 text-[11px] text-ink-400">期望范围：{r.expect_scope}</p>
                      )}
                      {r.status !== 'pending' && r.decided_at && (
                        <p className="mt-1 text-[10.5px] text-ink-400">
                          由 {byId.get(r.decided_by ?? '')?.full_name ?? '管理员'} 于 {fmtDateTime(r.decided_at)}
                          {r.status === 'approved' ? ' 通过' : r.status === 'rejected' ? ' 驳回' : ' 处理'}
                          {r.decision_note ? ` · ${r.decision_note}` : ''}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 flex items-center gap-1.5">
                      {r.status === 'pending' && manage && !mine && (
                        <Button
                          size="sm"
                          icon={<ClipboardList className="w-3.5 h-3.5" />}
                          onClick={() => {
                            setDeciding(r)
                            setDecisionNote('')
                          }}
                        >
                          审批
                        </Button>
                      )}
                      {r.status === 'pending' && mine && (
                        <Button size="sm" loading={cancelling === r.id} onClick={() => cancelRequest(r)}>
                          撤回
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'events' && (
        <div className="card overflow-hidden">
          {loading ? (
            <LoadingBlock rows={6} />
          ) : error ? (
            <ErrorBlock message={error} onRetry={reload} />
          ) : events.length === 0 ? (
            <EmptyState
              icon={<Clock3 className="w-5 h-5" />}
              title="还没有变动记录"
              description="入职、调岗、权限变更、停用与离职都会自动记录在这里"
            />
          ) : (
            <div className="divide-y divide-ink-100">
              {events.map((e) => {
                const meta = EVENT_META[e.event_type]
                const owner = byId.get(e.profile_id)
                const actor = e.actor_id ? byId.get(e.actor_id) : null
                const Icon = meta.icon
                return (
                  <div key={e.id} className="px-4 py-2.5 flex items-center gap-3">
                    <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', meta.tone)}>
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[12.5px] font-medium text-ink-900">{owner?.full_name || owner?.email || '未知成员'}</span>
                        <Badge tone="gray">{meta.label}</Badge>
                        <span className="text-[12px] text-ink-600">{e.summary}</span>
                      </div>
                      <p className="text-[10.5px] text-ink-400 mt-0.5">
                        {fmtDateTime(e.created_at)}
                        {actor ? ` · 操作人 ${actor.full_name || actor.email}` : ' · 系统自动记录'}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'resources' && (
        <>
          {!manage ? (
            <div className="card p-10 text-center">
              <ShieldCheck className="w-6 h-6 text-ink-300 mx-auto" />
              <p className="mt-2 text-[13px] font-medium text-ink-700">只有管理员可以查看全团队的资源归属</p>
              <p className="mt-1 text-[12px] text-ink-500">业务数据本身是团队共享的，这里只是按录入人做归属统计与移交。</p>
            </div>
          ) : (
            <div className="card overflow-hidden">
              {resourceState.loading ? (
                <LoadingBlock rows={6} />
              ) : resourceRows.length === 0 ? (
                <EmptyState icon={<Users className="w-5 h-5" />} title="暂无资源归属数据" description="团队成员录入业务数据后，这里会按人汇总" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="bg-ink-50/70 text-ink-500">
                        <th className="text-left font-medium px-4 py-2.5">成员</th>
                        {RESOURCE_COLUMNS.map((c) => (
                          <th key={c.table} className="text-right font-medium px-3 py-2.5 w-[76px]">
                            {c.label}
                          </th>
                        ))}
                        <th className="text-right font-medium px-3 py-2.5 w-[70px]">合计</th>
                        <th className="text-right font-medium px-4 py-2.5 w-[86px]">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resourceRows.map(({ profile: p, counts: c, total }) => (
                        <tr key={p.id} className="border-t border-ink-100">
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <Avatar name={p.full_name ?? p.email} size={28} />
                              <div className="min-w-0">
                                <p className="font-medium text-ink-900 truncate">{p.full_name || '未命名'}</p>
                                <p className="text-[10.5px] text-ink-400 truncate">{p.email}</p>
                              </div>
                            </div>
                          </td>
                          {RESOURCE_COLUMNS.map((col) => (
                            <td key={col.table} className={cn('px-3 py-2.5 text-right num', (c[col.table] ?? 0) ? 'text-ink-700' : 'text-ink-300')}>
                              {c[col.table] ?? 0}
                            </td>
                          ))}
                          <td className="px-3 py-2.5 text-right num font-semibold text-ink-900">{total}</td>
                          <td className="px-4 py-2.5 text-right">
                            <button
                              className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-brand-50 disabled:opacity-40"
                              title={total ? '把名下资源移交给其他成员' : '没有资源需要移交'}
                              disabled={!total || p.id === user?.id}
                              onClick={() => {
                                setTransferFrom(p)
                                setTransferTo('')
                              }}
                            >
                              <ArrowRightLeft className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
            归属只影响「谁录入的」这一审计字段，业务数据始终团队共享。移交在数据库函数里一次事务完成，
            离职交接也会走同一条链路，避免只转了一半。
          </p>
        </>
      )}

      {/* 提交权限申请 */}
      <Modal
        open={reqOpen}
        onClose={() => setReqOpen(false)}
        title="申请权限"
        description="提交后由管理员审批，通过则立即生效"
        footer={
          <>
            <Button onClick={() => setReqOpen(false)}>取消</Button>
            <Button variant="primary" onClick={submitRequest} loading={reqSaving} icon={<Send className="w-3.5 h-3.5" />}>
              提交申请
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {isStaff ? (
            <Field label="申请类型">
              <Segmented
                size="sm"
                value={reqForm.kind}
                onChange={(v) => setReqForm({ ...reqForm, kind: v as 'role' | 'system_role' })}
                options={[
                  { value: 'role', label: '岗位角色（业务模块）' },
                  { value: 'system_role', label: '系统角色（管理级别）' },
                ]}
              />
            </Field>
          ) : (
            <div className="rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2">
              <p className="text-[11.5px] leading-relaxed text-ink-600">
                这里申请的是<b className="text-ink-800">岗位角色</b>（能看到哪些业务模块）。
                「普通管理员」这类系统角色只能由超级管理员在「人员与账号」里直接调整。
              </p>
            </div>
          )}

          {reqForm.kind === 'role' ? (
            <Field label="希望获得的岗位角色" required hint="角色包含哪些权限，可在「组织架构 → 角色」页查看">
              <Select
                value={reqForm.target_role_id}
                onChange={(v) => setReqForm({ ...reqForm, target_role_id: v })}
                options={roles.map((r) => ({ value: r.id, label: r.name }))}
                placeholder="请选择角色"
              />
            </Field>
          ) : (
            <Field label="希望获得的系统角色" required hint="管理员可管人与审批；超管权限不能通过申请获得">
              <Select
                value={reqForm.target_role}
                onChange={(v) => setReqForm({ ...reqForm, target_role: v as 'admin' | 'member' })}
                options={[
                  { value: 'member', label: ROLE_META.member.label },
                  ...(isStaff ? [{ value: 'admin', label: ROLE_META.admin.label }] : []),
                ]}
              />
            </Field>
          )}

          <Field label="期望权限范围" hint="选填，写清楚要用哪些模块，审批更快">
            <input
              className="input"
              value={reqForm.expect_scope}
              placeholder="例如：需要查看并编辑采购单与供应商"
              onChange={(e) => setReqForm({ ...reqForm, expect_scope: e.target.value })}
            />
          </Field>

          <Field label="申请理由" required>
            <textarea
              className="input min-h-[76px] resize-y"
              value={reqForm.reason}
              placeholder="例如：接手美国站的采购跟单，需要采购模块的编辑权限"
              onChange={(e) => setReqForm({ ...reqForm, reason: e.target.value })}
            />
          </Field>

          <p className="text-[11px] leading-relaxed text-ink-400">
            申请记录会保存申请人与审批人。管理员不能审批自己的申请，超管权限也不在可申请范围内。
          </p>
        </div>
      </Modal>

      {/* 审批 */}
      <Modal
        open={!!deciding}
        onClose={() => setDeciding(null)}
        title="审批权限申请"
        description={deciding ? `${byId.get(deciding.user_id)?.full_name ?? '成员'} 申请${deciding.kind === 'role' ? '岗位' : '系统'}角色` : undefined}
        footer={
          <>
            <Button onClick={() => setDeciding(null)}>取消</Button>
            <Button variant="danger" onClick={() => decide(false)} loading={decideSaving} icon={<X className="w-3.5 h-3.5" />}>
              驳回
            </Button>
            <Button variant="primary" onClick={() => decide(true)} loading={decideSaving} icon={<Check className="w-3.5 h-3.5" />}>
              通过并生效
            </Button>
          </>
        }
      >
        {deciding && (
          <div className="space-y-3">
            <div className="rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2.5 space-y-1">
              <p className="text-[11px] text-ink-400">申请内容</p>
              <p className="text-[12.5px] text-ink-800">
                {deciding.kind === 'role'
                  ? roleById.get(deciding.target_role_id ?? '')?.name ?? '角色已删除'
                  : ROLE_META[(deciding.target_role ?? 'member') as Role]?.label}
              </p>
              <p className="text-[12px] text-ink-600 leading-relaxed">{deciding.reason}</p>
              {deciding.expect_scope && <p className="text-[11px] text-ink-400">期望范围：{deciding.expect_scope}</p>}
            </div>
            <Field label="审批意见" hint="选填，会记录在申请与人员变动里">
              <textarea
                className="input min-h-[68px] resize-y"
                value={decisionNote}
                placeholder="例如：先给只读权限，两周后再评估"
                onChange={(e) => setDecisionNote(e.target.value)}
              />
            </Field>
            <p className="text-[11px] leading-relaxed text-ink-400">
              通过后立即更新该成员的{deciding.kind === 'role' ? '岗位角色' : '系统角色'}，无需再次操作。
            </p>
          </div>
        )}
      </Modal>

      {/* 资源移交 */}
      <Modal
        open={!!transferFrom}
        onClose={() => setTransferFrom(null)}
        title="移交名下资源"
        description={transferFrom ? `从 ${transferFrom.full_name || transferFrom.email} 移出` : undefined}
        footer={
          <>
            <Button onClick={() => setTransferFrom(null)}>取消</Button>
            <Button variant="primary" onClick={submitTransfer} loading={transferSaving}>
              确认移交
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="接手人" required hint="该成员名下所有模块的记录都会转到接手人名下">
            <Select value={transferTo} onChange={setTransferTo} options={transferOptions} placeholder="请选择接手人" />
          </Field>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
            <p className="text-[11.5px] leading-relaxed text-amber-800 flex items-start gap-1.5">
              <FileText className="w-3.5 h-3.5 mt-px shrink-0" />
              移交只改「录入人」这一归属字段，不会改动业务数据本身。原负责人不会因此失去账号或权限。
            </p>
          </div>
        </div>
      </Modal>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
        审批与移交都在数据库函数里执行：函数会用 <code className="text-ink-600">is_staff()</code> /{' '}
        <code className="text-ink-600">has_permission()</code> 再校验一次调用者，绕过界面直接调接口同样会被拒绝。
        {!isStaff && ' 你的角色是普通人员，可以提交申请但看不到他人的申请与全团队资源归属。'}
      </p>
    </div>
  )
}
