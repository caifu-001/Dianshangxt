import { useState } from 'react'
import dayjs from 'dayjs'
import { Activity, RefreshCw, ScrollText } from 'lucide-react'
import { useAsync, useDebounced } from '../hooks/useAsync'
import { callRpc } from '../lib/db'
import {
  Badge,
  Button,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Modal,
  PageHeader,
  SearchInput,
  Select,
} from '../components/ui'

interface SystemLog {
  id: string
  created_at: string
  company_id: string | null
  actor_id: string | null
  actor_email: string | null
  actor_name: string | null
  category: string
  action: string
  summary: string
  detail: Record<string, unknown>
  target_type: string | null
  target_id: string | null
  severity: string
}

const CATEGORY_META: Record<string, { label: string; tone: 'gray' | 'blue' | 'amber' | 'red' | 'green' }> = {
  auth: { label: '登录', tone: 'blue' },
  security: { label: '安全', tone: 'red' },
  account: { label: '账号', tone: 'amber' },
  company: { label: '公司', tone: 'green' },
  business: { label: '业务', tone: 'gray' },
  system: { label: '系统', tone: 'gray' },
  error: { label: '错误', tone: 'red' },
}

const ACTION_LABELS: Record<string, string> = {
  login: '账号登录',
  otp_login: '验证码登录',
  logout: '退出登录',
  signup: '新账号注册',
  role_change: '系统角色变更',
  status_change: '账号状态变更',
  company_change: '公司归属变更',
  company_create: '创建公司',
  company_update: '更新公司',
  company_switch: '切换管理视角',
  member_move: '成员跨公司调配',
  registration_approve: '公司入驻通过',
  registration_reject: '公司入驻驳回',
}

const CATEGORY_OPTIONS = [
  { value: 'auth', label: '登录' },
  { value: 'security', label: '安全' },
  { value: 'account', label: '账号' },
  { value: 'company', label: '公司' },
  { value: 'business', label: '业务' },
  { value: 'system', label: '系统' },
  { value: 'error', label: '错误' },
]

const SEVERITY_OPTIONS = [
  { value: 'info', label: '常规' },
  { value: 'warning', label: '关注' },
  { value: 'error', label: '异常' },
]

function severityTone(severity: string): 'gray' | 'amber' | 'red' {
  if (severity === 'error') return 'red'
  if (severity === 'warning') return 'amber'
  return 'gray'
}

/** 平台超级管理员专属：全站审计日志，只读 */
export default function SystemLogs() {
  const [category, setCategory] = useState('')
  const [severity, setSeverity] = useState('')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState('100')
  const [detail, setDetail] = useState<SystemLog | null>(null)
  const search = useDebounced(query, 350)

  const { data, loading, error, reload } = useAsync<SystemLog[]>(
    () =>
      callRpc<SystemLog[]>('list_system_logs', {
        p_limit: Number(limit) || 100,
        p_category: category || null,
        p_severity: severity || null,
        p_search: search.trim() || null,
      }),
    [category, severity, search, limit],
  )

  const rows = data ?? []

  return (
    <>
      <PageHeader
        title="系统日志"
        description="全站关键操作的只读审计轨迹，仅平台超级管理员可见"
        actions={
          <Button size="sm" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={reload}>
            刷新
          </Button>
        }
      />

      <div className="card">
        <div className="flex flex-wrap items-center gap-2.5 px-4 py-3 border-b border-ink-100">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="搜索操作 / 姓名 / 邮箱…"
            className="w-56"
          />
          <Select value={category} onChange={setCategory} options={CATEGORY_OPTIONS} placeholder="全部类别" className="w-28" />
          <Select value={severity} onChange={setSeverity} options={SEVERITY_OPTIONS} placeholder="全部级别" className="w-28" />
          <Select
            value={limit}
            onChange={setLimit}
            options={[
              { value: '50', label: '最近 50 条' },
              { value: '100', label: '最近 100 条' },
              { value: '200', label: '最近 200 条' },
              { value: '500', label: '最近 500 条' },
            ]}
            className="w-32"
          />
          <span className="ml-auto text-[11.5px] text-ink-400">共 {rows.length} 条</span>
        </div>

        {loading ? (
          <LoadingBlock rows={8} />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<ScrollText className="w-5 h-5" />} title="暂无日志" description="发生登录、角色变更等关键操作后会在这里留痕。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-ink-400 text-[11px] uppercase tracking-wide border-b border-ink-100">
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">时间</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">类别</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">操作人</th>
                  <th className="px-4 py-2.5 font-medium">事件</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">级别</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-50">
                {rows.map((row) => {
                  const meta = CATEGORY_META[row.category] ?? CATEGORY_META.system
                  return (
                    <tr
                      key={row.id}
                      className="hover:bg-ink-50/70 cursor-pointer align-top"
                      onClick={() => setDetail(row)}
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap text-ink-500 tabular-nums">
                        {dayjs(row.created_at).format('MM-DD HH:mm:ss')}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <p className="text-ink-700">{row.actor_name || '系统'}</p>
                        {row.actor_email && <p className="text-[11px] text-ink-400">{row.actor_email}</p>}
                      </td>
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-ink-800">
                          {ACTION_LABELS[row.action] || row.action}
                        </p>
                        <p className="mt-0.5 text-ink-500 max-w-lg">{row.summary}</p>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <Badge tone={severityTone(row.severity)} dot>
                          {row.severity === 'error' ? '异常' : row.severity === 'warning' ? '关注' : '常规'}
                        </Badge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-ink-400">
        <Activity className="w-3.5 h-3.5" />
        登录与安全类事件自动留痕；日志只读，任何账号都无法修改或删除。
      </p>

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title="日志详情"
        description={detail ? dayjs(detail.created_at).format('YYYY-MM-DD HH:mm:ss') : undefined}
      >
        {detail && (
          <div className="space-y-3 text-[13px]">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[11px] text-ink-400">类别</p>
                <p className="mt-0.5 text-ink-800">{CATEGORY_META[detail.category]?.label ?? detail.category}</p>
              </div>
              <div>
                <p className="text-[11px] text-ink-400">级别</p>
                <p className="mt-0.5 text-ink-800">{detail.severity}</p>
              </div>
              <div>
                <p className="text-[11px] text-ink-400">操作人</p>
                <p className="mt-0.5 text-ink-800">{detail.actor_name || '系统'}</p>
              </div>
              <div>
                <p className="text-[11px] text-ink-400">邮箱</p>
                <p className="mt-0.5 text-ink-800 break-all">{detail.actor_email || '—'}</p>
              </div>
              <div>
                <p className="text-[11px] text-ink-400">对象类型</p>
                <p className="mt-0.5 text-ink-800">{detail.target_type || '—'}</p>
              </div>
              <div>
                <p className="text-[11px] text-ink-400">对象 ID</p>
                <p className="mt-0.5 text-ink-800 break-all">{detail.target_id || '—'}</p>
              </div>
            </div>
            <div>
              <p className="text-[11px] text-ink-400">摘要</p>
              <p className="mt-0.5 text-ink-800 leading-relaxed">{detail.summary}</p>
            </div>
            <div>
              <p className="text-[11px] text-ink-400">附加信息</p>
              <pre className="mt-1 p-3 rounded-lg bg-ink-50 text-[11.5px] text-ink-600 overflow-auto max-h-64">
                {JSON.stringify(detail.detail ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
