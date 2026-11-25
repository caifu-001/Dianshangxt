import { useMemo, useState } from 'react'
import { CalendarClock, Check, CheckSquare, GripVertical, Pencil, Plus, RotateCcw, Trash2, User } from 'lucide-react'
import dayjs from 'dayjs'
import { deleteRow, fetchRows, insertRow, updateRow } from '../lib/db'
import { PRIORITY, TASK_MODULE, TASK_STATUS } from '../lib/constants'
import type { Store, Task } from '../lib/types'
import { useAsync } from '../hooks/useAsync'
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
  SearchInput,
  Select,
  useToast,
} from '../components/ui'
import { cn, relativeDay, today } from '../lib/utils'

const COLUMNS: Array<{ key: Task['status']; label: string; accent: string }> = [
  { key: 'todo', label: '待处理', accent: 'bg-ink-400' },
  { key: 'doing', label: '进行中', accent: 'bg-brand-500' },
  { key: 'done', label: '已完成', accent: 'bg-emerald-500' },
]

interface FormState {
  title: string
  description: string
  module: Task['module']
  priority: Task['priority']
  status: Task['status']
  due_date: string
  assignee: string
  store_id: string
}

const EMPTY: FormState = {
  title: '',
  description: '',
  module: 'listing',
  priority: 'medium',
  status: 'todo',
  due_date: today(),
  assignee: '',
  store_id: '',
}

export default function Tasks() {
  const { push } = useToast()
  const [search, setSearch] = useState('')
  const [storeFilter, setStoreFilter] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Task | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [quickTitle, setQuickTitle] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const [moving, setMoving] = useState<string | null>(null)

  const { data, loading, error, reload } = useAsync(async () => {
    const [tasks, stores] = await Promise.all([
      fetchRows<Task>('tasks', { order: { column: 'created_at', ascending: false } }),
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
    ])
    return { tasks, stores }
  }, [])

  const storeMap = useMemo(() => new Map((data?.stores ?? []).map((s) => [s.id, s])), [data])

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return (data?.tasks ?? []).filter((t) => {
      if (storeFilter && t.store_id !== storeFilter) return false
      if (!kw) return true
      return [t.title, t.description ?? '', t.assignee ?? ''].some((v) => v.toLowerCase().includes(kw))
    })
  }, [data, search, storeFilter])

  const grouped = useMemo(() => {
    const g: Record<string, Task[]> = { todo: [], doing: [], done: [] }
    for (const t of filtered) (g[t.status] ||= []).push(t)
    const rank = { high: 0, medium: 1, low: 2 }
    for (const key of Object.keys(g)) {
      g[key].sort((a, b) => {
        const byPriority = rank[a.priority] - rank[b.priority]
        if (byPriority !== 0) return byPriority
        return (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
      })
    }
    return g
  }, [filtered])

  const overdue = filtered.filter((t) => t.status !== 'done' && t.due_date && t.due_date < dayjs().format('YYYY-MM-DD')).length

  function openCreate(status: Task['status'] = 'todo') {
    setEditing(null)
    setForm({ ...EMPTY, status })
    setModalOpen(true)
  }

  function openEdit(task: Task) {
    setEditing(task)
    setForm({
      title: task.title,
      description: task.description ?? '',
      module: task.module,
      priority: task.priority,
      status: task.status,
      due_date: task.due_date ?? '',
      assignee: task.assignee ?? '',
      store_id: task.store_id ?? '',
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.title.trim()) return push('请填写任务标题', 'error')
    setSaving(true)
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        module: form.module,
        priority: form.priority,
        status: form.status,
        due_date: form.due_date || null,
        assignee: form.assignee.trim() || null,
        store_id: form.store_id || null,
        completed_at: form.status === 'done' ? new Date().toISOString() : null,
      }
      if (editing) {
        await updateRow('tasks', editing.id, payload)
        push('任务已更新')
      } else {
        await insertRow('tasks', payload)
        push('任务已创建')
      }
      setModalOpen(false)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function moveTask(task: Task, status: Task['status']) {
    setMoving(task.id)
    try {
      await updateRow('tasks', task.id, {
        status,
        completed_at: status === 'done' ? new Date().toISOString() : null,
      })
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setMoving(null)
    }
  }

  async function quickAdd() {
    if (!quickTitle.trim()) return
    setQuickBusy(true)
    try {
      await insertRow('tasks', {
        title: quickTitle.trim(),
        module: 'other',
        priority: 'medium',
        status: 'todo',
        due_date: dayjs().add(3, 'day').format('YYYY-MM-DD'),
        store_id: storeFilter || null,
      })
      setQuickTitle('')
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '创建失败', 'error')
    } finally {
      setQuickBusy(false)
    }
  }

  async function handleDelete() {
    if (!deleting) return
    setConfirmLoading(true)
    try {
      await deleteRow('tasks', deleting.id)
      push('任务已删除')
      setDeleting(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirmLoading(false)
    }
  }

  return (
    <>
      <PageHeader
        title="任务看板"
        description="运营待办按状态流转，逾期自动标红"
        actions={
          <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => openCreate('todo')}>
            新建任务
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <SearchInput value={search} onChange={setSearch} placeholder="搜索任务 / 负责人" className="w-full sm:w-60" />
        <Select
          className="w-full sm:w-44"
          value={storeFilter}
          onChange={setStoreFilter}
          placeholder="全部店铺"
          options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
        {overdue > 0 && (
          <Badge tone="red" dot>
            {overdue} 项已逾期
          </Badge>
        )}
        <span className="ml-auto text-[11.5px] text-ink-400">
          共 <span className="num font-medium text-ink-700">{filtered.length}</span> 项任务
        </span>
      </div>

      {error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : loading ? (
        <div className="grid lg:grid-cols-3 gap-3">
          {COLUMNS.map((c) => (
            <div key={c.key} className="card p-3">
              <LoadingBlock rows={3} />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid lg:grid-cols-3 gap-3 items-start">
          {COLUMNS.map((col) => (
            <div key={col.key} className="card bg-ink-50/60">
              <div className="flex items-center gap-2 px-3.5 py-3">
                <span className={cn('w-1.5 h-1.5 rounded-full', col.accent)} />
                <h3 className="text-[13px] font-semibold text-ink-900">{col.label}</h3>
                <span className="num text-[11px] text-ink-400">{grouped[col.key]?.length ?? 0}</span>
                <button className="ml-auto p-1 rounded text-ink-400 hover:bg-ink-100 hover:text-ink-700" onClick={() => openCreate(col.key)}>
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              {col.key === 'todo' && (
                <div className="px-3 pb-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      className="input !h-8 text-[12px]"
                      placeholder="快速添加任务…"
                      value={quickTitle}
                      onChange={(e) => setQuickTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') quickAdd()
                      }}
                    />
                    <Button size="sm" variant="default" className="!px-2" onClick={quickAdd} loading={quickBusy} disabled={!quickTitle.trim()}>
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              )}

              <div className="px-2.5 pb-3 space-y-2 min-h-[80px]">
                {(grouped[col.key] ?? []).length === 0 ? (
                  <div className="py-8 text-center text-[11.5px] text-ink-400">
                    {col.key === 'done' ? '还没有完成的任务' : '暂无任务'}
                  </div>
                ) : (
                  (grouped[col.key] ?? []).map((task) => {
                    const isOverdue = task.status !== 'done' && task.due_date && task.due_date < dayjs().format('YYYY-MM-DD')
                    const priority = PRIORITY[task.priority]
                    return (
                      <div
                        key={task.id}
                        className={cn(
                          'group relative bg-white rounded-lg border p-2.5 hover:shadow-card transition-all cursor-pointer',
                          isOverdue ? 'border-rose-200' : 'border-ink-200/70',
                          moving === task.id && 'opacity-60',
                        )}
                        onClick={() => openEdit(task)}
                      >
                        <div className="flex items-start gap-2">
                          <span
                            className={cn(
                              'w-1 self-stretch rounded-full shrink-0',
                              task.priority === 'high' ? 'bg-rose-400' : task.priority === 'medium' ? 'bg-amber-400' : 'bg-ink-200',
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <p className={cn('text-[12.5px] leading-snug', task.status === 'done' ? 'text-ink-400 line-through' : 'text-ink-800 font-medium')}>
                              {task.title}
                            </p>
                            {task.description && (
                              <p className="mt-1 text-[10.5px] text-ink-400 line-clamp-2 leading-relaxed">{task.description}</p>
                            )}
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <Badge tone="gray">{TASK_MODULE[task.module]}</Badge>
                              <Badge tone={priority.tone}>{priority.label}</Badge>
                              {task.due_date && (
                                <span className={cn('inline-flex items-center gap-0.5 text-[10px]', isOverdue ? 'text-rose-600 font-medium' : 'text-ink-400')}>
                                  <CalendarClock className="w-3 h-3" />
                                  {relativeDay(task.due_date)}
                                </span>
                              )}
                            </div>
                            <div className="mt-1.5 flex items-center gap-2 text-[10px] text-ink-400">
                              {task.assignee && (
                                <span className="inline-flex items-center gap-0.5">
                                  <User className="w-2.5 h-2.5" />
                                  {task.assignee}
                                </span>
                              )}
                              {task.store_id && storeMap.get(task.store_id) && (
                                <span className="truncate max-w-[120px]">· {storeMap.get(task.store_id)?.name}</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-white/90 rounded">
                          {task.status === 'todo' && (
                            <button
                              className="p-1 rounded text-ink-400 hover:text-brand-600 hover:bg-brand-50"
                              title="开始处理"
                              onClick={(e) => { e.stopPropagation(); moveTask(task, 'doing') }}
                            >
                              <GripVertical className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {task.status === 'doing' && (
                            <button
                              className="p-1 rounded text-ink-400 hover:text-emerald-600 hover:bg-emerald-50"
                              title="标记完成"
                              onClick={(e) => { e.stopPropagation(); moveTask(task, 'done') }}
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {task.status === 'done' && (
                            <button
                              className="p-1 rounded text-ink-400 hover:text-amber-600 hover:bg-amber-50"
                              title="重新打开"
                              onClick={(e) => { e.stopPropagation(); moveTask(task, 'todo') }}
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            className="p-1 rounded text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                            onClick={(e) => { e.stopPropagation(); openEdit(task) }}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button data-perm="delete"
                            className="p-1 rounded text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                            onClick={(e) => { e.stopPropagation(); setDeleting(task) }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (data?.tasks.length ?? 0) === 0 && (
        <div className="card mt-3">
          <EmptyState
            icon={<CheckSquare className="w-5 h-5" />}
            title="还没有任务"
            description="把 listing 优化、补货、达人跟进等运营动作拆成任务，团队协作不遗漏。"
            action={
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => openCreate('todo')}>
                新建任务
              </Button>
            }
          />
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? '编辑任务' : '新建任务'}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>取消</Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="任务标题" required>
            <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="如：AH-BAMBOO-TRAY 主图 A/B 测试" />
          </Field>
          <Field label="描述">
            <textarea className="textarea" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="验收标准、参考资料…" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="业务模块">
              <Select
                value={form.module}
                onChange={(v) => setForm({ ...form, module: v as Task['module'] })}
                options={Object.entries(TASK_MODULE).map(([value, label]) => ({ value, label }))}
              />
            </Field>
            <Field label="优先级">
              <Select
                value={form.priority}
                onChange={(v) => setForm({ ...form, priority: v as Task['priority'] })}
                options={Object.entries(PRIORITY).map(([value, v]) => ({ value, label: v.label }))}
              />
            </Field>
            <Field label="状态">
              <Select
                value={form.status}
                onChange={(v) => setForm({ ...form, status: v as Task['status'] })}
                options={Object.entries(TASK_STATUS).map(([value, v]) => ({ value, label: v.label }))}
              />
            </Field>
            <Field label="截止日期">
              <input type="date" className="input" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
            </Field>
            <Field label="负责人">
              <input className="input" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} placeholder="如：视觉组 / 小王" />
            </Field>
            <Field label="关联店铺">
              <Select
                value={form.store_id}
                onChange={(v) => setForm({ ...form, store_id: v })}
                placeholder="不关联"
                options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
              />
            </Field>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={confirmLoading}
        title="删除任务"
        message={`确定删除「${deleting?.title}」吗？`}
      />
    </>
  )
}
