/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  ExternalLink,
  Globe2,
  Heart,
  Megaphone,
  Pencil,
  Plus,
  Receipt,
  Trash2,
  TrendingUp,
  Users,
} from 'lucide-react'
import dayjs from 'dayjs'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { callRpc, deleteRow, fetchRows, insertRow, updateRow } from '../lib/db'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../context/AuthContext'
import { cn, fmtDate, money, num } from '../lib/utils'
import type {
  BrandInfluencer,
  BrandMetric,
  BrandPrContact,
  BrandSocialAccount,
} from '../lib/types'
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
  Pagination,
  SearchInput,
  Segmented,
  Select,
  useToast,
} from '../components/ui'

/* ------------------------------------------------------------------ */
/*  配置：四个板块共用一套增删改表单与列表                                */
/* ------------------------------------------------------------------ */

type Kind = 'social' | 'influencer' | 'pr' | 'metric'
type AnyRow = Record<string, any>

interface FieldCfg {
  key: string
  label: string
  type?: 'text' | 'number' | 'date' | 'select' | 'textarea' | 'owner'
  options?: Array<{ value: string; label: string }>
  placeholder?: string
  required?: boolean
  hint?: string
  full?: boolean
}

interface ColumnCfg {
  key: string
  label: string
  type?: 'number' | 'money' | 'date' | 'status' | 'link' | 'owner'
}

interface KindCfg {
  label: string
  table: string
  fields: FieldCfg[]
  columns: ColumnCfg[]
  fromRow: (r: AnyRow) => Record<string, string>
  toPayload: (f: Record<string, string>) => Record<string, unknown>
}

const PAGE_SIZE = 10

const PLATFORMS = ['YouTube', 'Instagram', 'TikTok', 'X / Twitter', 'Facebook', 'Pinterest', 'LinkedIn', '其他']
const ACTIVE_STATUS = [
  { value: 'active', label: '合作中' },
  { value: 'paused', label: '暂停' },
]
const INFLUENCER_STATUS = [
  { value: 'contacting', label: '待建联' },
  { value: 'negotiating', label: '洽谈中' },
  { value: 'active', label: '合作中' },
  { value: 'done', label: '已合作' },
  { value: 'paused', label: '暂停' },
]
const PR_TYPES = [
  { value: 'media', label: '媒体报道' },
  { value: 'blog', label: '博客 / KOL' },
  { value: 'forum', label: '论坛 / 社区' },
  { value: 'agency', label: '公关公司' },
]
const METRIC_CHANNELS = [
  { value: 'overall', label: '整体' },
  { value: 'google', label: 'Google 搜索' },
  { value: 'social', label: '社媒' },
  { value: 'pr', label: '公关 / 外链' },
]
const STATUS_TEXT: Record<string, string> = {
  active: '合作中',
  paused: '暂停',
  contacting: '待建联',
  negotiating: '洽谈中',
  done: '已合作',
}
const PR_TYPE_TEXT: Record<string, string> = Object.fromEntries(PR_TYPES.map((x) => [x.value, x.label]))
const CHANNEL_TEXT: Record<string, string> = Object.fromEntries(METRIC_CHANNELS.map((x) => [x.value, x.label]))

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const n = (v: string) => Math.max(0, Number(v) || 0)
const nullable = (v: string) => v.trim() || null

interface DirectoryRow {
  id: string
  full_name: string | null
  email: string | null
}

export default function Brand() {
  const { push } = useToast()
  const { user, can } = useAuth()
  const canEdit = can('brand.edit')

  const [kind, setKind] = useState<Kind>('social')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<AnyRow | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<AnyRow | null>(null)
  const [confirming, setConfirming] = useState(false)

  const { data, loading, error, reload } = useAsync(async () => {
    const [social, influencers, pr, metrics, directory] = await Promise.all([
      fetchRows<BrandSocialAccount>('brand_social_accounts', { order: { column: 'followers', ascending: false } }).catch(
        () => [] as BrandSocialAccount[],
      ),
      fetchRows<BrandInfluencer>('brand_influencers', { order: { column: 'created_at' } }).catch(
        () => [] as BrandInfluencer[],
      ),
      fetchRows<BrandPrContact>('brand_pr_contacts', { order: { column: 'created_at' } }).catch(
        () => [] as BrandPrContact[],
      ),
      fetchRows<BrandMetric>('brand_metrics', { order: { column: 'metric_date', ascending: false } }).catch(
        () => [] as BrandMetric[],
      ),
      callRpc<DirectoryRow[]>('team_directory').catch(() => [] as DirectoryRow[]),
    ])
    return { social, influencers, pr, metrics, directory }
  }, [])

  const memberMap = useMemo(
    () => new Map((data?.directory ?? []).map((m) => [m.id, m.full_name || m.email || '未命名'])),
    [data],
  )
  const memberOptions = useMemo(
    () => (data?.directory ?? []).map((m) => ({ value: m.id, label: m.full_name || m.email || '未命名' })),
    [data],
  )

  const CONFIG: Record<Kind, KindCfg> = useMemo(
    () => ({
      social: {
        label: '社媒账号',
        table: 'brand_social_accounts',
        fields: [
          { key: 'platform', label: '平台', type: 'select', options: PLATFORMS.map((x) => ({ value: x, label: x })), required: true },
          { key: 'account_name', label: '账号名称', required: true },
          { key: 'account_url', label: '主页链接', full: true, placeholder: 'https://' },
          { key: 'followers', label: '粉丝数', type: 'number' },
          { key: 'posts_count', label: '已发内容数', type: 'number' },
          { key: 'owner_id', label: '负责人', type: 'owner' },
          { key: 'status', label: '状态', type: 'select', options: ACTIVE_STATUS },
          { key: 'note', label: '备注', type: 'textarea', full: true, placeholder: '内容方向、更新频率…' },
        ],
        columns: [
          { key: 'platform', label: '平台' },
          { key: 'account_name', label: '账号' },
          { key: 'followers', label: '粉丝数', type: 'number' },
          { key: 'posts_count', label: '内容数', type: 'number' },
          { key: 'owner_id', label: '负责人', type: 'owner' },
          { key: 'account_url', label: '链接', type: 'link' },
          { key: 'status', label: '状态', type: 'status' },
        ],
        fromRow: (r) => ({
          platform: str(r.platform), account_name: str(r.account_name), account_url: str(r.account_url),
          followers: str(r.followers), posts_count: str(r.posts_count), owner_id: str(r.owner_id),
          status: str(r.status) || 'active', note: str(r.note),
        }),
        toPayload: (f) => ({
          platform: f.platform.trim(), account_name: f.account_name.trim(), account_url: nullable(f.account_url),
          followers: n(f.followers), posts_count: n(f.posts_count), owner_id: nullable(f.owner_id),
          status: f.status || 'active', note: nullable(f.note),
        }),
      },
      influencer: {
        label: '站外红人',
        table: 'brand_influencers',
        fields: [
          { key: 'name', label: '红人名称', required: true },
          { key: 'platform', label: '平台', type: 'select', options: PLATFORMS.map((x) => ({ value: x, label: x })), required: true },
          { key: 'handle', label: '账号 / Handle', placeholder: '@name' },
          { key: 'followers', label: '粉丝数', type: 'number' },
          { key: 'niche', label: '内容领域', placeholder: '家居 / 美妆 / 亲子' },
          { key: 'country', label: '国家 / 地区' },
          { key: 'contact_email', label: '联系邮箱' },
          { key: 'contact_wechat', label: '微信 / WhatsApp' },
          { key: 'price_cny', label: '合作报价（CNY）', type: 'number' },
          { key: 'status', label: '合作状态', type: 'select', options: INFLUENCER_STATUS },
          { key: 'last_collab_at', label: '最近合作日期', type: 'date' },
          { key: 'owner_id', label: '对接人', type: 'owner' },
          { key: 'note', label: '备注', type: 'textarea', full: true, placeholder: '寄样情况、内容形式、报价有效期…' },
        ],
        columns: [
          { key: 'name', label: '红人' },
          { key: 'platform', label: '平台' },
          { key: 'followers', label: '粉丝数', type: 'number' },
          { key: 'niche', label: '领域' },
          { key: 'price_cny', label: '报价', type: 'money' },
          { key: 'status', label: '状态', type: 'status' },
          { key: 'owner_id', label: '对接人', type: 'owner' },
        ],
        fromRow: (r) => ({
          name: str(r.name), platform: str(r.platform), handle: str(r.handle), followers: str(r.followers),
          niche: str(r.niche), country: str(r.country), contact_email: str(r.contact_email),
          contact_wechat: str(r.contact_wechat), price_cny: str(r.price_cny),
          status: str(r.status) || 'contacting', last_collab_at: str(r.last_collab_at),
          owner_id: str(r.owner_id), note: str(r.note),
        }),
        toPayload: (f) => ({
          name: f.name.trim(), platform: f.platform.trim(), handle: nullable(f.handle), followers: n(f.followers),
          niche: nullable(f.niche), country: nullable(f.country), contact_email: nullable(f.contact_email),
          contact_wechat: nullable(f.contact_wechat), price_cny: n(f.price_cny), status: f.status || 'contacting',
          last_collab_at: nullable(f.last_collab_at), owner_id: nullable(f.owner_id), note: nullable(f.note),
        }),
      },
      pr: {
        label: '公共关系',
        table: 'brand_pr_contacts',
        fields: [
          { key: 'media_name', label: '媒体 / 渠道名称', required: true },
          { key: 'channel_type', label: '类型', type: 'select', options: PR_TYPES },
          { key: 'contact_name', label: '联系人' },
          { key: 'contact_email', label: '联系邮箱' },
          { key: 'contact_phone', label: '联系电话' },
          { key: 'coverage_count', label: '累计报道次数', type: 'number' },
          { key: 'last_coverage_at', label: '最近报道日期', type: 'date' },
          { key: 'status', label: '状态', type: 'select', options: ACTIVE_STATUS },
          { key: 'owner_id', label: '负责人', type: 'owner' },
          { key: 'note', label: '备注', type: 'textarea', full: true, placeholder: '合作形式、发稿要求…' },
        ],
        columns: [
          { key: 'media_name', label: '媒体 / 渠道' },
          { key: 'channel_type', label: '类型' },
          { key: 'contact_name', label: '联系人' },
          { key: 'contact_email', label: '邮箱' },
          { key: 'coverage_count', label: '报道数', type: 'number' },
          { key: 'last_coverage_at', label: '最近报道', type: 'date' },
          { key: 'status', label: '状态', type: 'status' },
        ],
        fromRow: (r) => ({
          media_name: str(r.media_name), channel_type: str(r.channel_type) || 'media', contact_name: str(r.contact_name),
          contact_email: str(r.contact_email), contact_phone: str(r.contact_phone),
          coverage_count: str(r.coverage_count), last_coverage_at: str(r.last_coverage_at),
          status: str(r.status) || 'active', owner_id: str(r.owner_id), note: str(r.note),
        }),
        toPayload: (f) => ({
          media_name: f.media_name.trim(), channel_type: f.channel_type || 'media', contact_name: nullable(f.contact_name),
          contact_email: nullable(f.contact_email), contact_phone: nullable(f.contact_phone),
          coverage_count: n(f.coverage_count), last_coverage_at: nullable(f.last_coverage_at),
          status: f.status || 'active', owner_id: nullable(f.owner_id), note: nullable(f.note),
        }),
      },
      metric: {
        label: '曝光 / 搜索量',
        table: 'brand_metrics',
        fields: [
          { key: 'metric_date', label: '日期', type: 'date', required: true },
          { key: 'channel', label: '渠道', type: 'select', options: METRIC_CHANNELS },
          { key: 'impressions', label: '曝光量', type: 'number' },
          { key: 'search_volume', label: '品牌词搜索量', type: 'number' },
          { key: 'site_visits', label: '网站访问量', type: 'number' },
          { key: 'backlinks', label: '新增外链', type: 'number' },
          { key: 'note', label: '备注', type: 'textarea', full: true, placeholder: '数据来源、投放说明…' },
        ],
        columns: [
          { key: 'metric_date', label: '日期', type: 'date' },
          { key: 'channel', label: '渠道' },
          { key: 'impressions', label: '曝光量', type: 'number' },
          { key: 'search_volume', label: '搜索量', type: 'number' },
          { key: 'site_visits', label: '访问量', type: 'number' },
          { key: 'backlinks', label: '外链', type: 'number' },
        ],
        fromRow: (r) => ({
          metric_date: str(r.metric_date), channel: str(r.channel) || 'overall', impressions: str(r.impressions),
          search_volume: str(r.search_volume), site_visits: str(r.site_visits), backlinks: str(r.backlinks),
          note: str(r.note),
        }),
        toPayload: (f) => ({
          metric_date: f.metric_date || dayjs().format('YYYY-MM-DD'), channel: f.channel || 'overall',
          impressions: n(f.impressions), search_volume: n(f.search_volume), site_visits: n(f.site_visits),
          backlinks: n(f.backlinks), note: nullable(f.note),
        }),
      },
    }),
    [],
  )

  const cfg = CONFIG[kind]
  const rowsOf = (k: Kind): AnyRow[] => {
    if (k === 'social') return data?.social ?? []
    if (k === 'influencer') return data?.influencers ?? []
    if (k === 'pr') return data?.pr ?? []
    return data?.metrics ?? []
  }
  const allRows = rowsOf(kind)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allRows
    return allRows.filter((r) => Object.values(r).some((v) => str(v).toLowerCase().includes(q)))
  }, [allRows, query])

  /* ---------------- 汇总与趋势 ---------------- */
  const kpi = useMemo(() => {
    const social = data?.social ?? []
    const influencers = data?.influencers ?? []
    const pr = data?.pr ?? []
    const metrics = data?.metrics ?? []
    const month = dayjs().format('YYYY-MM')
    const thisMonth = metrics.filter((m) => dayjs(m.metric_date).format('YYYY-MM') === month)
    return {
      accounts: social.length,
      followers: social.reduce((s, x) => s + Number(x.followers || 0), 0),
      influencers: influencers.filter((x) => x.status === 'active' || x.status === 'done').length,
      pr: pr.length,
      impressions: thisMonth.reduce((s, x) => s + Number(x.impressions || 0), 0),
      search: thisMonth.reduce((s, x) => s + Number(x.search_volume || 0), 0),
    }
  }, [data])

  const trend = useMemo(() => {
    const map = new Map<string, { date: string; impressions: number; search: number }>()
    for (const m of [...(data?.metrics ?? [])].sort((a, b) => a.metric_date.localeCompare(b.metric_date))) {
      const cur = map.get(m.metric_date) ?? {
        date: dayjs(m.metric_date).format('MM/DD'),
        impressions: 0,
        search: 0,
      }
      cur.impressions += Number(m.impressions || 0)
      cur.search += Number(m.search_volume || 0)
      map.set(m.metric_date, cur)
    }
    return Array.from(map.values()).slice(-14)
  }, [data])

  const emptyEverything =
    !loading &&
    !error &&
    (data?.social ?? []).length === 0 &&
    (data?.influencers ?? []).length === 0 &&
    (data?.pr ?? []).length === 0 &&
    (data?.metrics ?? []).length === 0

  /* ---------------- 增删改 ---------------- */
  function openCreate() {
    setEditing(null)
    const initial: Record<string, string> = {}
    for (const f of cfg.fields) initial[f.key] = f.key === 'metric_date' ? dayjs().format('YYYY-MM-DD') : ''
    if (cfg === CONFIG.social) initial.status = 'active'
    if (cfg === CONFIG.influencer) initial.status = 'contacting'
    if (cfg === CONFIG.pr) initial.status = 'active'
    if (cfg === CONFIG.metric) initial.channel = 'overall'
    setForm(initial)
    setOpen(true)
  }

  function openEdit(r: AnyRow) {
    setEditing(r)
    setForm(cfg.fromRow(r))
    setOpen(true)
  }

  async function saveRow() {
    for (const f of cfg.fields) {
      if (f.required && !form[f.key]?.trim()) return push(`请填写${f.label}`, 'error')
    }
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        ...cfg.toPayload(form),
        updated_at: new Date().toISOString(),
      }
      if (editing) {
        await updateRow(cfg.table, editing.id, payload)
      } else if (kind === 'metric') {
        // 同一天同一渠道唯一：重复录入时更新原记录，而不是抛唯一键冲突
        const metricDate = str(payload.metric_date)
        const metricChannel = str(payload.channel)
        const sameDay = (data?.metrics ?? []).find(
          (m) => m.metric_date === metricDate && m.channel === metricChannel,
        )
        if (sameDay) await updateRow(cfg.table, sameDay.id, payload)
        else await insertRow(cfg.table, { ...payload, user_id: user?.id })
      } else {
        await insertRow(cfg.table, { ...payload, user_id: user?.id })
      }
      push(editing ? `${cfg.label}已更新` : `${cfg.label}已添加`)
      setOpen(false)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/could not find the table|relation .* does not exist/i.test(msg)
        ? '数据库表还没创建，请到「数据源」重跑最新建表脚本'
        : msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setConfirming(true)
    try {
      await deleteRow(cfg.table, deleting.id)
      push(`${cfg.label}已删除`)
      setDeleting(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirming(false)
    }
  }

  function switchKind(next: string) {
    setKind(next as Kind)
    setQuery('')
    setPage(1)
  }

  /* ---------------- 渲染 ---------------- */
  return (
    <>
      <PageHeader
        title="站外品牌营销"
        description="社媒账号、站外红人、公共关系与曝光搜索量统一看板，让品牌在公司外部被更多人看到"
        actions={
          <>
            <Link to="/expenses?source=brand" className="btn btn-sm btn-default">
              <Receipt className="w-3.5 h-3.5" /> 品牌费用归集
            </Link>
            {canEdit && (
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
                新增{cfg.label}
              </Button>
            )}
          </>
        }
      />

      {emptyEverything && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3.5 py-2.5 text-[11.5px] text-amber-800 leading-relaxed">
          还没有品牌营销数据。若刚升级过数据库，请到「数据源」复制最新脚本在 Supabase SQL Editor 执行一次；
          然后点右上角「新增」开始录入社媒账号与红人。
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mb-3">
        {[
          { label: '社媒账号', value: num(kpi.accounts), icon: <Globe2 className="w-4 h-4" />, tone: 'bg-brand-50 text-brand-600' },
          { label: '社媒粉丝总数', value: num(kpi.followers), icon: <Users className="w-4 h-4" />, tone: 'bg-violet-50 text-violet-600' },
          { label: '合作中红人', value: num(kpi.influencers), icon: <Heart className="w-4 h-4" />, tone: 'bg-rose-50 text-rose-600' },
          { label: 'PR 媒体资源', value: num(kpi.pr), icon: <Megaphone className="w-4 h-4" />, tone: 'bg-amber-50 text-amber-600' },
          { label: '本月曝光量', value: num(kpi.impressions), icon: <Activity className="w-4 h-4" />, tone: 'bg-emerald-50 text-emerald-600' },
          { label: '本月品牌词搜索', value: num(kpi.search), icon: <TrendingUp className="w-4 h-4" />, tone: 'bg-blue-50 text-blue-600' },
        ].map((k) => (
          <div key={k.label} className="card px-3.5 py-3 flex items-center gap-2.5">
            <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', k.tone)}>{k.icon}</span>
            <div className="min-w-0">
              <p className="text-[10.5px] text-ink-500 truncate">{k.label}</p>
              <p className="num text-[16px] font-semibold text-ink-900 leading-tight truncate">{k.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="card p-4 mb-3">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div>
            <p className="text-[13px] font-semibold text-ink-800">曝光量 / 品牌词搜索量趋势</p>
            <p className="text-[11px] text-ink-400">按日汇总全部渠道，最多展示最近 14 天</p>
          </div>
          <span className="text-[10.5px] text-ink-400 hidden sm:block">来源：曝光 / 搜索量表</span>
        </div>
        <div className="h-[210px]">
          {trend.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 6, right: 10, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eff1f5" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10.5, fill: '#98a2b3' }} axisLine={false} tickLine={false} minTickGap={18} />
                <YAxis tick={{ fontSize: 10.5, fill: '#98a2b3' }} axisLine={false} tickLine={false} width={52} />
                <Tooltip contentStyle={{ fontSize: 11.5, borderRadius: 8, border: '1px solid #eaecf0' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="impressions" name="曝光量" stroke="#6366f1" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="search" name="搜索量" stroke="#10b981" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-[11.5px] text-ink-400">
              还没有趋势数据，到「曝光 / 搜索量」页签录入每天的指标
            </div>
          )}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
          <Segmented
            value={kind}
            onChange={switchKind}
            options={[
              { value: 'social', label: '社媒营销' },
              { value: 'influencer', label: '站外红人' },
              { value: 'pr', label: '公共关系' },
              { value: 'metric', label: '曝光 / 搜索量' },
            ]}
          />
          <SearchInput
            value={query}
            onChange={(v) => { setQuery(v); setPage(1) }}
            placeholder={`搜索${cfg.label}`}
            className="w-full sm:w-56 ml-auto"
          />
        </div>

        {error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : loading ? (
          <LoadingBlock rows={6} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Globe2 className="w-5 h-5" />}
            title={query ? '没有匹配的数据' : `还没有${cfg.label}`}
            description={query ? '换个关键词试试' : '点右上角新增，把外部资源沉淀成可复用的品牌资产。'}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px]">
                <thead>
                  <tr>
                    {cfg.columns.map((c) => (
                      <th key={c.key} className={cn('th', c.type === 'number' || c.type === 'money' ? 'text-right' : '')}>
                        {c.label}
                      </th>
                    ))}
                    <th className="th w-20" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((r) => (
                    <tr key={r.id} className="hover:bg-ink-50/60 group">
                      {cfg.columns.map((c) => (
                        <td key={c.key} className={cn('td', c.type === 'number' || c.type === 'money' ? 'num text-right' : '')}>
                          {c.type === 'status' ? (
                            <Badge tone={r.status === 'active' || r.status === 'done' ? 'green' : 'gray'}>
                              {(STATUS_TEXT[str(r.status)] ?? str(r.status)) || '—'}
                            </Badge>
                          ) : c.type === 'money' ? (
                            money(Number(r[c.key] || 0), 'CNY')
                          ) : c.type === 'number' ? (
                            num(r[c.key] || 0)
                          ) : c.type === 'date' ? (
                            r[c.key] ? fmtDate(r[c.key], 'YYYY-MM-DD') : '—'
                          ) : c.type === 'link' ? (
                            r[c.key] ? (
                              <a href={str(r[c.key])} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline inline-flex items-center gap-0.5">
                                打开 <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : '—'
                          ) : c.type === 'owner' ? (
                            r.owner_id ? memberMap.get(r.owner_id) ?? '—' : '—'
                          ) : c.key === 'channel_type' ? (
                            (PR_TYPE_TEXT[str(r.channel_type)] ?? str(r.channel_type)) || '—'
                          ) : c.key === 'channel' ? (
                            (CHANNEL_TEXT[str(r.channel)] ?? str(r.channel)) || '—'
                          ) : (
                            str(r[c.key]) || '—'
                          )}
                        </td>
                      ))}
                      <td className="td">
                        {canEdit ? (
                          <div className="flex items-center gap-0.5">
                            <button
                              className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100"
                              title="编辑"
                              onClick={() => openEdit(r)}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            {kind === 'influencer' && (
                              <Link to={`/expenses?source=brand&source_id=${r.id}`} className="p-1.5 rounded-md text-ink-400 hover:text-brand-600 hover:bg-brand-50" title="记一笔费用并归集到该红人">
                                <Receipt className="w-3.5 h-3.5" />
                              </Link>
                            )}
                            <button
                              className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50"
                              title="删除"
                              onClick={() => setDeleting(r)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <span className="text-[10.5px] text-ink-400">只读</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2.5 border-t border-ink-100">
              <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} />
            </div>
          </>
        )}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-ink-400 flex items-start gap-1.5">
        <Globe2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        社媒账号沉淀粉丝与内容数据；站外红人记录报价与合作状态；公共关系维护媒体与发稿渠道；
        曝光 / 搜索量按日录入后自动汇总成趋势。负责人纳入离职资源移交，部门范围与岗位角色共同决定可见性。
      </p>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`${editing ? '编辑' : '新增'}${cfg.label}`}
        description={kind === 'metric' ? '同一天同一渠道只保留一条记录，重复保存会更新原记录' : undefined}
        width="max-w-3xl"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" onClick={saveRow} loading={saving}>保存</Button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {cfg.fields.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              required={f.required}
              hint={f.hint}
              className={f.full ? 'sm:col-span-2' : undefined}
            >
              {f.type === 'select' ? (
                <Select
                  value={form[f.key] ?? ''}
                  onChange={(v) => setForm({ ...form, [f.key]: v })}
                  options={f.options ?? []}
                />
              ) : f.type === 'owner' ? (
                <Select
                  value={form[f.key] ?? ''}
                  onChange={(v) => setForm({ ...form, [f.key]: v })}
                  options={[{ value: '', label: '未指定' }, ...memberOptions]}
                />
              ) : f.type === 'textarea' ? (
                <textarea
                  className="textarea"
                  rows={2}
                  value={form[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
              ) : (
                <input
                  className={cn('input', f.type === 'number' && 'num')}
                  type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                  min={f.type === 'number' ? 0 : undefined}
                  value={form[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
        {kind === 'metric' && !editing && (
          <p className="mt-3 text-[11px] text-ink-400">
            提示：如果同一天同渠道已有记录，请先编辑那条记录，不要重复新增。
          </p>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        loading={confirming}
        title={`删除${cfg.label}`}
        message={`确定删除这条${cfg.label}记录吗？删除后无法恢复。`}
      />
    </>
  )
}
