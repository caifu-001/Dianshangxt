import { useState } from 'react'
import { ArrowRightLeft, Building2, Check, Pencil, Plus, ShieldCheck, Users } from 'lucide-react'
import dayjs from 'dayjs'
import { useAuth } from '../context/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { callRpc } from '../lib/db'
import type { Company } from '../lib/types'
import {
  Button,
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

interface FormState {
  name: string
  code: string
  note: string
  status: string
}

interface PlatformMember {
  id: string
  email: string | null
  full_name: string | null
  employee_no: string | null
  role: string
  status: string
  company_id: string | null
  company_name: string
  created_at: string
}

const emptyForm = (): FormState => ({ name: '', code: '', note: '', status: 'active' })

/** 平台超级管理员专属：创建公司、维护公司、切换当前数据视角 */
export default function Companies() {
  const { push } = useToast()
  const { currentCompanyId, refreshProfile } = useAuth()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Company | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)

  // 成员调配
  const [moveOpen, setMoveOpen] = useState(false)
  const [targetCompany, setTargetCompany] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [memberQuery, setMemberQuery] = useState('')
  const [moving, setMoving] = useState(false)

  const { data, loading, error, reload } = useAsync<Company[]>(() => callRpc<Company[]>('list_companies'), [])
  const members = useAsync<PlatformMember[]>(() => callRpc<PlatformMember[]>('platform_members'), [])

  function openCreate() {
    setEditing(null)
    setForm(emptyForm())
    setModalOpen(true)
  }

  function openEdit(c: Company) {
    setEditing(c)
    setForm({ name: c.name, code: c.code ?? '', note: c.note ?? '', status: c.status })
    setModalOpen(true)
  }

  async function save() {
    if (!form.name.trim()) return push('请填写公司名称', 'error')
    setSaving(true)
    try {
      if (editing) {
        await callRpc('update_company', {
          p_id: editing.id,
          p_name: form.name.trim(),
          p_code: form.code.trim() || null,
          p_status: form.status,
          p_note: form.note.trim() || null,
        })
        push('公司信息已更新')
      } else {
        await callRpc('create_company', {
          p_name: form.name.trim(),
          p_code: form.code.trim() || null,
          p_note: form.note.trim() || null,
        })
        push('公司已创建')
      }
      setModalOpen(false)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  function openMove() {
    setSelected([])
    setMemberQuery('')
    setTargetCompany(currentCompanyId ?? '')
    setMoveOpen(true)
    members.reload()
  }

  async function doMove() {
    if (!targetCompany) return push('请先选择目标公司', 'error')
    if (!selected.length) return push('请先勾选要移动的成员', 'error')
    setMoving(true)
    try {
      const moved = await callRpc<number>('platform_move_members', {
        p_members: selected,
        p_company: targetCompany,
      })
      push(`已将 ${moved} 名成员移动到「${data?.find((c) => c.id === targetCompany)?.name ?? '目标公司'}」`)
      setSelected([])
      setMoveOpen(false)
      reload()
      members.reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '移动失败', 'error')
    } finally {
      setMoving(false)
    }
  }

  async function doSwitch(c: Company) {
    if (c.status !== 'active') return push('已停用的公司不能切换', 'error')
    setSwitching(c.id)
    try {
      await callRpc('switch_company', { p_company: c.id })
      await refreshProfile()
      push(`已切换到「${c.name}」的数据视角`)
    } catch (err) {
      push(err instanceof Error ? err.message : '切换失败', 'error')
    } finally {
      setSwitching(null)
    }
  }

  return (
    <>
      <PageHeader
        title="公司管理"
        description="平台超级管理员在此创建与管理公司；切换视角后，订单、库存、采购、费用与人员数据只显示该公司的记录"
        actions={
          <>
            <Button icon={<ArrowRightLeft className="w-3.5 h-3.5" />} onClick={openMove}>
              成员调配
            </Button>
            <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
              新建公司
            </Button>
          </>
        }
      />

      <div className="rounded-xl border border-brand-100 bg-brand-50/60 px-4 py-3 mb-3 flex items-start gap-2.5">
        <ShieldCheck className="w-4 h-4 text-brand-600 mt-0.5 shrink-0" />
        <div className="text-[12px] text-ink-600 leading-relaxed">
          <p className="font-medium text-ink-800">多租户隔离说明</p>
          <p>
            平台超级管理员不属于任何公司，切换视角后查看该公司数据。各公司内部最高角色为「普通管理员」，
            只能管理本公司成员；普通账号无法在通讯录或人员列表里看到平台超级管理员。
          </p>
        </div>
      </div>

      {loading ? (
        <LoadingBlock rows={4} />
      ) : error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : !data?.length ? (
        <EmptyState title="还没有公司，点击右上角新建" />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="bg-ink-50/80 text-left text-ink-500">
                <th className="px-4 py-2.5 font-medium">公司</th>
                <th className="px-4 py-2.5 font-medium">编码</th>
                <th className="px-4 py-2.5 font-medium">成员数</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">创建时间</th>
                <th className="px-4 py-2.5 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data.map((c) => {
                const active = currentCompanyId === c.id
                return (
                  <tr key={c.id} className="hover:bg-ink-50/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="w-7 h-7 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
                          <Building2 className="w-3.5 h-3.5" />
                        </span>
                        <div>
                          <p className="font-medium text-ink-800">
                            {c.name}
                            {active && (
                              <span className="ml-2 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
                                <Check className="w-3 h-3" /> 当前视角
                              </span>
                            )}
                          </p>
                          {c.note && <p className="text-[11px] text-ink-400 max-w-[260px] truncate">{c.note}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-ink-500">{c.code ?? '—'}</td>
                    <td className="px-4 py-3 text-ink-700">{c.member_count} 人</td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          c.status === 'active'
                            ? 'text-[11px] px-2 py-0.5 rounded bg-emerald-50 text-emerald-700'
                            : 'text-[11px] px-2 py-0.5 rounded bg-ink-100 text-ink-500'
                        }
                      >
                        {c.status === 'active' ? '启用中' : '已停用'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-400">{dayjs(c.created_at).format('YYYY-MM-DD')}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="text-[11px] px-2 py-1 rounded-md text-brand-600 hover:bg-brand-50 disabled:opacity-40"
                          onClick={() => doSwitch(c)}
                          disabled={active || switching === c.id || c.status !== 'active'}
                        >
                          {switching === c.id ? '切换中…' : active ? '当前' : '切换视角'}
                        </button>
                        <button
                          className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                          title="编辑"
                          onClick={() => openEdit(c)}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? '编辑公司' : '新建公司'}
        description={editing ? undefined : '新公司创建后数据为空，可通过切换视角进入管理'}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>取消</Button>
            <Button variant="primary" loading={saving} onClick={save}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="公司名称" required>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="如：某某科技有限公司"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="公司编码">
              <input
                className="input"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="如：ACME"
              />
            </Field>
            <Field label="状态">
              <Select
                value={form.status}
                onChange={(v) => setForm({ ...form, status: v })}
                options={[
                  { value: 'active', label: '启用' },
                  { value: 'disabled', label: '停用' },
                ]}
              />
            </Field>
          </div>
          <Field label="备注">
            <textarea
              className="input min-h-[72px]"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="可选"
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        title="成员归属调配"
        description="把平台内任意成员移动到目标公司，可跨公司、可批量；平台超级管理员不可被移动"
        width="max-w-2xl"
        footer={
          <>
            <Button onClick={() => setMoveOpen(false)}>取消</Button>
            <Button variant="primary" loading={moving} disabled={!selected.length || !targetCompany} onClick={doMove}>
              移动 {selected.length ? `${selected.length} 名` : ''}成员
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="目标公司" required>
            <Select
              value={targetCompany}
              onChange={setTargetCompany}
              placeholder="请选择要移入的公司"
              options={(data ?? [])
                .filter((c) => c.status === 'active')
                .map((c) => ({ value: c.id, label: c.name }))}
            />
          </Field>

          <div className="flex items-center justify-between gap-2">
            <p className="text-[11.5px] text-ink-500 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" /> 勾选要移动的成员（当前所属公司以档案为准）
            </p>
            <SearchInput
              value={memberQuery}
              onChange={setMemberQuery}
              placeholder="搜索姓名 / 邮箱 / 工号 / 公司"
              className="w-56"
            />
          </div>

          <div className="border border-ink-100 rounded-lg max-h-[340px] overflow-y-auto">
            {members.loading ? (
              <LoadingBlock rows={4} />
            ) : members.error ? (
              <ErrorBlock message={members.error} onRetry={members.reload} />
            ) : (
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 bg-ink-50/90 text-left text-ink-500">
                  <tr>
                    <th className="px-3 py-2 w-9 font-medium"></th>
                    <th className="px-2 py-2 font-medium">成员</th>
                    <th className="px-2 py-2 font-medium">工号</th>
                    <th className="px-2 py-2 font-medium">当前公司</th>
                    <th className="px-2 py-2 font-medium">角色</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {(members.data ?? [])
                    .filter((m) => {
                      const q = memberQuery.trim().toLowerCase()
                      if (!q) return true
                      return [m.full_name, m.email, m.employee_no, m.company_name]
                        .some((v) => (v ?? '').toLowerCase().includes(q))
                    })
                    .map((m) => {
                      const checked = selected.includes(m.id)
                      const inTarget = m.company_id === targetCompany
                      return (
                        <tr
                          key={m.id}
                          className={`hover:bg-ink-50/50 ${checked ? 'bg-brand-50/50' : ''}`}
                          onClick={() => {
                            if (inTarget) return
                            setSelected((s) => (checked ? s.filter((x) => x !== m.id) : [...s, m.id]))
                          }}
                        >
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              className="w-3.5 h-3.5 accent-brand-600"
                              checked={checked}
                              disabled={inTarget}
                              onChange={() => {
                                setSelected((s) => (checked ? s.filter((x) => x !== m.id) : [...s, m.id]))
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td className="px-2 py-2">
                            <p className="font-medium text-ink-800">{m.full_name || '未填姓名'}</p>
                            <p className="text-[11px] text-ink-400">{m.email}</p>
                          </td>
                          <td className="px-2 py-2 text-ink-500">{m.employee_no || '—'}</td>
                          <td className="px-2 py-2">
                            <span
                              className={
                                inTarget
                                  ? 'text-[11px] px-2 py-0.5 rounded bg-emerald-50 text-emerald-700'
                                  : 'text-[11px] px-2 py-0.5 rounded bg-ink-100 text-ink-600'
                              }
                            >
                              {inTarget ? '已在目标公司' : m.company_name}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-ink-500">
                            {m.role === 'admin' ? '普通管理员' : m.role === 'super_admin' ? '平台超管' : '普通人员'}
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-[11px] text-ink-400 leading-relaxed">
            移动只调整账号的公司归属，不影响其业务数据的原公司隔离；成员在新公司的可见范围由所属部门与岗位角色决定。
          </p>
        </div>
      </Modal>
    </>
  )
}
