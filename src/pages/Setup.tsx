import { useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, Copy, Database, ExternalLink, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import schemaSql from '../../supabase/schema.sql?raw'
import { useAuth } from '../context/AuthContext'
import { SQL_EDITOR_URL, SUPABASE_URL } from '../lib/supabase'
import { PageHeader, Button, Badge, useToast } from '../components/ui'
import { seedDemoData } from '../lib/seed'
import { checkSchema } from '../lib/db'

const STEPS = [
  { title: '打开 SQL 编辑器', desc: '登录 Supabase 控制台，进入本项目的 SQL Editor' },
  { title: '粘贴并执行脚本', desc: '建表、索引、行级权限（RLS）与注册触发器一次装好' },
  { title: '刷新缓存并检测', desc: '执行缓存刷新语句，回到这里重新检测即可使用' },
]

const RELOAD_SQL = 'NOTIFY pgrst, \'reload schema\';'

export default function Setup() {
  const { schemaReady, schemaMessage, recheckSchema } = useAuth()
  const { push } = useToast()
  const [copied, setCopied] = useState(false)
  const [reloadCopied, setReloadCopied] = useState(false)
  const [checking, setChecking] = useState(false)
  const [seeding, setSeeding] = useState(false)

  async function copyText(text: string, onDone: () => void, message: string) {
    try {
      await navigator.clipboard.writeText(text)
      onDone()
      push(message)
      setTimeout(() => onDone(), 2200)
    } catch {
      push('复制失败，请手动选中文本复制', 'error')
    }
  }

  const copySql = () => copyText(schemaSql, () => setCopied((v) => !v), 'SQL 脚本已复制到剪贴板')
  const copyReloadSql = () => copyText(RELOAD_SQL, () => setReloadCopied((v) => !v), '缓存刷新语句已复制')

  async function handleRecheck() {
    setChecking(true)
    const ok = await recheckSchema()
    setChecking(false)
    push(ok ? '数据库连接正常，已就绪' : '仍未检测到数据表，请确认脚本已执行成功', ok ? 'success' : 'error')
  }

  async function handleSeed() {
    setSeeding(true)
    try {
      const ok = await checkSchema()
      if (!ok.ready) {
        push('请先执行建表脚本', 'error')
        return
      }
      await seedDemoData()
      push('演示数据已生成，去运营概览看看吧')
    } catch (err) {
      push(err instanceof Error ? err.message : '生成失败', 'error')
    } finally {
      setSeeding(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        title="数据源初始化"
        description="系统基于 Supabase（PostgreSQL）存储数据，首次使用需要执行一次建表脚本"
      />

      <div
        className={
          schemaReady
            ? 'card p-4 flex items-start gap-3 border-emerald-200 bg-emerald-50/40'
            : 'card p-4 flex items-start gap-3 border-amber-200 bg-amber-50/40'
        }
      >
        {schemaReady ? (
          <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5" />
        ) : (
          <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink-900">
            {schemaReady ? '数据库已连接，一切就绪' : '数据库尚未初始化'}
          </p>
          <p className="mt-0.5 text-xs text-ink-600 leading-relaxed">
            {schemaReady
              ? '业务表与行级权限均已生效，可以直接开始录入数据。'
              : schemaMessage ?? '需要执行建表脚本后才能使用系统功能。'}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
            <Badge tone="gray" dot>
              项目
            </Badge>
            <code className="font-mono text-[11px] text-ink-600">{SUPABASE_URL.replace('https://', '')}</code>
          </div>
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-3 mt-4">
        {STEPS.map((s, i) => (
          <div key={s.title} className="card p-4">
            <div className="w-6 h-6 rounded-md bg-brand-50 text-brand-700 flex items-center justify-center text-[11px] font-semibold mb-2.5">
              {i + 1}
            </div>
            <p className="text-[13px] font-medium text-ink-900">{s.title}</p>
            <p className="mt-1 text-[11.5px] text-ink-500 leading-relaxed">{s.desc}</p>
          </div>
        ))}
      </div>

      <div className="card mt-4 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-ink-100">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-ink-400" />
            <span className="text-[13px] font-medium text-ink-800">schema.sql</span>
            <Badge tone="blue">幂等 · 可重复执行</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} onClick={copySql}>
              {copied ? '已复制' : '复制脚本'}
            </Button>
            <a href={SQL_EDITOR_URL} target="_blank" rel="noreferrer" className="btn btn-sm btn-primary">
              打开 SQL 编辑器
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
        <pre className="max-h-[320px] overflow-auto bg-ink-900 text-[11.5px] leading-relaxed text-ink-100 p-4 font-mono scrollbar-thin">
          {schemaSql}
        </pre>
      </div>

      {/* 执行 DDL 后 PostgREST 的 schema 缓存可能滞后，新表明明建好了却报「表不存在」。
          给出一键复制的刷新语句，避免用户误以为脚本没执行成功而反复重跑。 */}
      <div className="card mt-4 p-4 flex items-start gap-3 border-sky-200 bg-sky-50/40">
        <RefreshCw className="w-4 h-4 text-sky-600 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink-900">执行完脚本后如果提示「数据表还没创建」</p>
          <p className="mt-1 text-[11.5px] text-ink-600 leading-relaxed">
            这通常不是脚本没执行，而是接口缓存还没刷新。在 SQL Editor 再执行下面这句，然后回到本页点「重新检测」即可：
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-md bg-white border border-ink-200 px-2.5 py-1.5 text-[11.5px] font-mono text-ink-800">
              {RELOAD_SQL}
            </code>
            <Button size="sm" icon={reloadCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} onClick={copyReloadSql}>
              {reloadCopied ? '已复制' : '复制'}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <Button onClick={handleRecheck} loading={checking} icon={<Database className="w-3.5 h-3.5" />}>
          我已执行，重新检测
        </Button>
        <Button variant="primary" onClick={handleSeed} loading={seeding} icon={seeding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}>
          生成演示数据
        </Button>
        <span className="text-[11px] text-ink-400">
          演示数据包含 3 家店铺、11 个 SKU、近 60 天订单，以及竞品、供应商与采购单，可随时在「系统设置」中清空
        </span>
      </div>
    </div>
  )
}
