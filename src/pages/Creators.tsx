import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Pencil, Receipt, Trash2, TrendingUp, UserPlus, Users, Video } from 'lucide-react'
import { deleteRow, fetchRows, insertRow, updateRow } from '../lib/db'
import { CREATOR_STATUS } from '../lib/constants'
import type { Creator, Store } from '../lib/types'
import { useAsync } from '../hooks/useAsync'
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
  Pagination,
  SearchInput,
  Select,
  useToast,
} from '../components/ui'
import { agoDay, cn, money, num, pct, sum } from '../lib/utils'

const PAGE_SIZE = 15

const STATUS_ORDER = ['pending', 'contacted', 'sampling', 'cooperating', 'paused'] as const

interface FormState {
  store_id: string
  handle: string
  name: string
  region: string
  category: string
  followers: string
  email: string
  commission_rate: string
  status: Creator['status']
  gmv: string
  video_count: string
  last_contact: string
  note: string
}

const EMPTY: FormState = {
  store_id: '',
  handle: '',
  name: '',
  region: 'US',
  category: '',
  followers: '',
  email: '',
  commission_rate: '20',
  status: 'pending',
  gmv: '',
  video_count: '',
  last_contact: '',
  note: '',
}

export default function Creators() {
  const { push } = useToast()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Creator | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Creator | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)

  const { data, loading, error, reload } = useAsync(async () => {
    const [creators, stores] = await Promise.all([
      fetchRows<Creator>('creators', { order: { column: 'created_at', ascending: false } }),
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
    ])
    return { creators, stores }
  }, [])

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return (data?.creators ?? []).filter((c) => {
      if (statusFilter && c.status !== statusFilter) return false
      if (!kw) return true
      return [c.handle, c.name ?? '', c.category ?? '', c.email ?? ''].some((v) => v.toLowerCase().includes(kw))
    })
  }, [data, search, statusFilter])

  const kpi = useMemo(() => {
    const list = data?.creators ?? []
    return {
      total: list.length,
      cooperating: list.filter((c) => c.status === 'cooperating').length,
      gmv: sum(list, (c) => c.gmv),
      avgCommission: list.length ? sum(list, (c) => c.commission_rate) / list.length : 0,
      videos: sum(list, (c) => c.video_count),
      followers: sum(list, (c) => c.followers),
    }
  }, [data])

  const funnel = useMemo(
    () =>
      STATUS_ORDER.filter((s) => s !== 'paused').map((s) => ({
        status: s,
        label: CREATOR_STATUS[s].label,
        count: (data?.creators ?? []).filter((c) => c.status === s).length,
      })),
    [data],
  )

  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY, store_id: data?.stores.find((s) => s.platform === 'tiktok')?.id ?? data?.stores[0]?.id ?? '' })
    setModalOpen(true)
  }

  function openEdit(c: Creator) {
    setEditing(c)
    setForm({
      store_id: c.store_id ?? '',
      handle: c.handle,
      name: c.name ?? '',
      region: c.region ?? 'US',
      category: c.category ?? '',
      followers: String(c.followers),
      email: c.email ?? '',
      commission_rate: String(c.commission_rate),
      status: c.status,
      gmv: String(c.gmv),
      video_count: String(c.video_count),
      last_contact: c.last_contact ?? '',
      note: c.note ?? '',
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.handle.trim()) return push('请填写达人账号', 'error')
    setSaving(true)
    try {
      const payload = {
        store_id: form.store_id || null,
        handle: form.handle.trim().startsWith('@') ? form.handle.trim() : `@${form.handle.trim()}`,
        name: form.name.trim() || null,
        region: form.region || null,
        category: form.category.trim() || null,
        followers: Math.round(Number(form.followers) || 0),
        email: form.email.trim() || null,
        commission_rate: Number(form.commission_rate) || 0,
        status: form.status,
        gmv: Number(form.gmv) || 0,
        video_count: Math.round(Number(form.video_count) || 0),
        last_contact: form.last_contact || null,
        note: form.note.trim() || null,
      }
      if (editing) {
        await updateRow('creators', editing.id, payload)
        push('达人信息已更新')
      } else {
        await insertRow('creators', payload)
        push('达人已添加')
      }
      setModalOpen(false)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleting) return
    setConfirmLoading(true)
    try {
      await deleteRow('creators', deleting.id)
      push('已删除')
      setDeleting(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirmLoading(false)
    }
  }

  const maxFunnel = Math.max(1, ...funnel.map((f) => f.count))

  return (
    <>
      <PageHeader
        title="达人合作"
        description="TikTok 达人从建联到带货的全流程台账"
        actions={
          <>
            <Link to="/expenses?source=creator" className="btn btn-sm btn-default">
              <Receipt className="w-3.5 h-3.5" /> 达人费用归集
            </Link>
            <Button variant="primary" icon={<UserPlus className="w-3.5 h-3.5" />} onClick={openCreate}>
              添加达人
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        {[
          { label: '达人总数', value: num(kpi.total), sub: `合作中 ${kpi.cooperating}`, icon: <Users className="w-4 h-4" />, tone: 'bg-brand-50 text-brand-600' },
          { label: '累计带货 GMV', value: money(kpi.gmv, 'USD', 0), sub: `粉丝覆盖 ${num(kpi.followers)}`, icon: <TrendingUp className="w-4 h-4" />, tone: 'bg-emerald-50 text-emerald-600' },
          { label: '平均佣金率', value: pct(kpi.avgCommission), sub: '按达人简单平均', icon: <Users className="w-4 h-4" />, tone: 'bg-amber-50 text-amber-600' },
          { label: '产出视频数', value: num(kpi.videos), sub: '合作期内累计', icon: <Video className="w-4 h-4" />, tone: 'bg-violet-50 text-violet-600' },
        ].map((k) => (
          <div key={k.label} className="card p-4">
            <div className="flex items-start justify-between">
              <span className="text-[11px] text-ink-500">{k.label}</span>
              <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center', k.tone)}>{k.icon}</span>
            </div>
            <p className="num text-[20px] font-semibold text-ink-900 mt-1.5 leading-tight">{k.value}</p>
            <p className="text-[10.5px] text-ink-400 mt-1">{k.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-3 mb-3">
        <div className="card p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-semibold text-ink-900">建联漏斗</h3>
            <span className="text-[11px] text-ink-400">从邀约到开播的流转分布</span>
          </div>
          <div className="space-y-2.5">
            {funnel.map((f) => {
              const width = maxFunnel > 0 ? Math.max(6, Math.round((f.count / maxFunnel) * 100)) : 0
              return (
                <div key={f.status} className="flex items-center gap-3">
                  <span className="w-16 text-[11.5px] text-ink-600 shrink-0">{f.label}</span>
                  <div className="relative flex-1 h-6 rounded-md bg-ink-100/70 overflow-hidden">
                    <div className="h-full rounded-md bg-gradient-to-r from-brand-500 to-brand-400" style={{ width: `${width}%` }} />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10.5px] font-semibold text-ink-700 num">
                      {f.count}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <div className="card p-4">
          <h3 className="text-[13px] font-semibold text-ink-900 mb-2">待跟进提醒</h3>
          <div className="space-y-1">
            {(data?.creators ?? [])
              .filter((c) => c.status === 'contacted' || c.status === 'sampling' || c.status === 'pending')
              .slice(0, 4)
              .map((c) => (
                <div key={c.id} className="flex items-center gap-2 py-1.5 border-b border-ink-50 last:border-0">
                  <Avatar name={c.name ?? c.handle} url={c.avatar_url} size={24} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11.5px] text-ink-800 truncate">{c.handle}</p>
                    <p className="text-[10px] text-ink-400">{CREATOR_STATUS[c.status].label}</p>
                  </div>
                  <span className="text-[10px] text-ink-400 shrink-0">{agoDay(c.last_contact)}</span>
                </div>
              ))}
            {!(data?.creators ?? []).some((c) => c.status !== 'cooperating' && c.status !== 'paused') && (
              <p className="text-[11.5px] text-ink-400 py-6 text-center">暂无待跟进达人</p>
            )}
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="账号 / 姓名 / 类目" className="w-full sm:w-60" />
          <Select
            className="w-full sm:w-32"
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1) }}
            placeholder="全部状态"
            options={Object.entries(CREATOR_STATUS).map(([value, v]) => ({ value, label: v.label }))}
          />
          <span className="ml-auto text-[11.5px] text-ink-400">
            共 <span className="num text-ink-700 font-medium">{num(filtered.length)}</span> 位达人
          </span>
        </div>

        {error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : loading ? (
          <LoadingBlock rows={6} />
        ) : pageRows.length === 0 ? (
          <EmptyState
            icon={<Users className="w-5 h-5" />}
            title={filtered.length ? '没有匹配的达人' : '还没有达人档案'}
            description="添加你正在联系或已合作的 TikTok 达人，跟踪寄样、视频与带货 GMV。"
            action={
              <Button variant="primary" icon={<UserPlus className="w-3.5 h-3.5" />} onClick={openCreate}>
                添加达人
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px]">
              <thead>
                <tr>
                  <th className="th">达人</th>
                  <th className="th">类目 / 地区</th>
                  <th className="th text-right">粉丝数</th>
                  <th className="th text-right">佣金率</th>
                  <th className="th">状态</th>
                  <th className="th text-right">带货 GMV</th>
                  <th className="th text-right">视频</th>
                  <th className="th">最近联系</th>
                  <th className="th w-16" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((c) => {
                  const status = CREATOR_STATUS[c.status]
                  return (
                    <tr key={c.id} className="hover:bg-ink-50/60 group">
                      <td className="td">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={c.name ?? c.handle} url={c.avatar_url} size={30} />
                          <div className="min-w-0">
                            <p className="text-[12.5px] font-medium text-ink-800 truncate">{c.handle}</p>
                            <p className="text-[10.5px] text-ink-400 truncate">{c.name ?? '—'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="td">
                        <p className="text-[11.5px] text-ink-600">{c.category ?? '—'}</p>
                        <p className="text-[10.5px] text-ink-400">{c.region ?? '—'}</p>
                      </td>
                      <td className="td text-right num">{num(c.followers)}</td>
                      <td className="td text-right num">{pct(c.commission_rate, 0)}</td>
                      <td className="td">
                        <Badge tone={status?.tone ?? 'gray'}>{status?.label ?? c.status}</Badge>
                      </td>
                      <td className="td text-right num font-medium">{c.gmv ? money(c.gmv, 'USD', 0) : '—'}</td>
                      <td className="td text-right num text-ink-500">{c.video_count || '—'}</td>
                      <td className="td text-[11px] text-ink-500">{c.last_contact ?? '—'}</td>
                      <td className="td">
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100" onClick={() => openEdit(c)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <Link to={`/expenses?source=creator&source_id=${c.id}`} className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-brand-50" title="记一笔费用并归集到该达人">
                            <Receipt className="w-3.5 h-3.5" />
                          </Link>
                          <button data-perm="delete" className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50" onClick={() => setDeleting(c)}>
                            <Trash2 className="w-3.5 h-3.5" />
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

        {filtered.length > PAGE_SIZE && <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} />}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? '编辑达人' : '添加达人'}
        width="max-w-2xl"
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>取消</Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="TikTok 账号" required>
            <input className="input" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} placeholder="@handle" />
          </Field>
          <Field label="真实姓名 / 昵称">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="所属店铺">
            <Select
              value={form.store_id}
              onChange={(v) => setForm({ ...form, store_id: v })}
              placeholder="不指定"
              options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
          <Field label="类目">
            <input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="美妆 / 家居 / 3C…" />
          </Field>
          <Field label="地区">
            <input className="input" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} placeholder="US / UK" />
          </Field>
          <Field label="粉丝数">
            <input className="input num" type="number" value={form.followers} onChange={(e) => setForm({ ...form, followers: e.target.value })} />
          </Field>
          <Field label="邮箱">
            <input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="达人联系邮箱" />
          </Field>
          <Field label="佣金率 (%)">
            <input className="input num" type="number" step="0.5" value={form.commission_rate} onChange={(e) => setForm({ ...form, commission_rate: e.target.value })} />
          </Field>
          <Field label="合作状态">
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v as Creator['status'] })}
              options={Object.entries(CREATOR_STATUS).map(([value, v]) => ({ value, label: v.label }))}
            />
          </Field>
          <Field label="最近联系日期">
            <input type="date" className="input" value={form.last_contact} onChange={(e) => setForm({ ...form, last_contact: e.target.value })} />
          </Field>
          <Field label="带货 GMV">
            <input className="input num" type="number" step="0.01" value={form.gmv} onChange={(e) => setForm({ ...form, gmv: e.target.value })} />
          </Field>
          <Field label="产出视频数">
            <input className="input num" type="number" value={form.video_count} onChange={(e) => setForm({ ...form, video_count: e.target.value })} />
          </Field>
          <Field label="备注" className="sm:col-span-2">
            <textarea className="textarea" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="报价、寄样记录、沟通要点…" />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={confirmLoading}
        title="删除达人"
        message={`确定删除达人 ${deleting?.handle} 的档案吗？`}
      />
    </>
  )
}
