import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Download, ImageOff, Package, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { deleteRow, fetchRows, insertRows, insertRow, updateRow } from '../lib/db'
import { PLATFORM_LABEL, PRODUCT_STATUS, marketplaceMeta } from '../lib/constants'
import type { Product, Store } from '../lib/types'
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
  Pagination,
  SearchInput,
  Select,
  useToast,
} from '../components/ui'
import { ImportModal } from '../components/ImportModal'
import type { ImportField } from '../components/ImportModal'
import { cn, downloadTextFile, money, num, pct, toCsv } from '../lib/utils'

const PAGE_SIZE = 20

interface FormState {
  store_id: string
  sku: string
  asin: string
  title: string
  category: string
  cost_price: string
  sale_price: string
  status: Product['status']
  image_url: string
  note: string
}

const EMPTY: FormState = {
  store_id: '',
  sku: '',
  asin: '',
  title: '',
  category: '',
  cost_price: '',
  sale_price: '',
  status: 'active',
  image_url: '',
  note: '',
}

const IMPORT_FIELDS: ImportField[] = [
  { key: 'store', label: '店铺', aliases: ['店铺', 'store', 'store_name', '店铺名称'] },
  { key: 'sku', label: 'SKU', aliases: ['sku', 'seller_sku', 'seller sku', 'msku', '商家sku'], required: true },
  { key: 'asin', label: 'ASIN', aliases: ['asin', 'product_id', '商品id'] },
  { key: 'title', label: '商品名称', aliases: ['title', 'product_name', '商品名称', '标题', 'item_name'], required: true },
  { key: 'category', label: '类目', aliases: ['category', '类目', 'product_type'] },
  { key: 'cost_price', label: '成本', aliases: ['cost', 'cost_price', '成本', '采购成本'], numeric: true },
  { key: 'sale_price', label: '售价', aliases: ['price', 'sale_price', '售价', 'item_price'], numeric: true },
]

export default function Products() {
  const { push } = useToast()
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [storeFilter, setStoreFilter] = useState(searchParams.get('store') ?? '')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [modalOpen, setModalOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importStore, setImportStore] = useState('')
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Product | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)

  const { data, loading, error, reload } = useAsync(async () => {
    const [products, stores] = await Promise.all([
      fetchRows<Product>('products', { order: { column: 'created_at', ascending: false } }),
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
    ])
    return { products, stores }
  }, [])

  const storeMap = useMemo(() => new Map((data?.stores ?? []).map((s) => [s.id, s])), [data])

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return (data?.products ?? []).filter((p) => {
      if (storeFilter && p.store_id !== storeFilter) return false
      if (statusFilter && p.status !== statusFilter) return false
      if (!kw) return true
      return [p.sku, p.title, p.asin ?? '', p.category ?? ''].some((v) => v.toLowerCase().includes(kw))
    })
  }, [data, search, storeFilter, statusFilter])

  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY, store_id: storeFilter || data?.stores[0]?.id || '' })
    setModalOpen(true)
  }

  function openEdit(product: Product) {
    setEditing(product)
    setForm({
      store_id: product.store_id,
      sku: product.sku,
      asin: product.asin ?? '',
      title: product.title,
      category: product.category ?? '',
      cost_price: String(product.cost_price),
      sale_price: String(product.sale_price),
      status: product.status,
      image_url: product.image_url ?? '',
      note: product.note ?? '',
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.store_id) return push('请选择所属店铺', 'error')
    if (!form.sku.trim()) return push('请填写 SKU', 'error')
    if (!form.title.trim()) return push('请填写商品名称', 'error')
    setSaving(true)
    try {
      const store = storeMap.get(form.store_id)
      const payload = {
        store_id: form.store_id,
        sku: form.sku.trim(),
        asin: form.asin.trim() || null,
        title: form.title.trim(),
        category: form.category.trim() || null,
        cost_price: Number(form.cost_price) || 0,
        sale_price: Number(form.sale_price) || 0,
        currency: store?.currency ?? 'USD',
        status: form.status,
        image_url: form.image_url.trim() || null,
        note: form.note.trim() || null,
      }
      if (editing) {
        await updateRow('products', editing.id, payload)
        push('商品已更新')
      } else {
        await insertRow('products', payload)
        push('商品已创建')
      }
      setModalOpen(false)
      reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      push(/duplicate|unique/i.test(msg) ? '该店铺下已存在相同 SKU' : msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleting) return
    setConfirmLoading(true)
    try {
      await deleteRow('products', deleting.id)
      push('商品已删除')
      setDeleting(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirmLoading(false)
    }
  }

  async function handleImport(rows: Array<Record<string, string>>) {
    const fallback = importStore || storeFilter || data?.stores[0]?.id
    const byName = new Map((data?.stores ?? []).map((s) => [s.name.trim().toLowerCase(), s]))
    const payload: Array<Record<string, unknown>> = []
    let skipped = 0
    for (const row of rows) {
      const store = (row.store && byName.get(row.store.trim().toLowerCase())) || (fallback ? storeMap.get(fallback) : undefined)
      if (!store || !row.sku || !row.title) {
        skipped += 1
        continue
      }
      payload.push({
        store_id: store.id,
        sku: row.sku,
        asin: row.asin || null,
        title: row.title,
        category: row.category || null,
        cost_price: Number(String(row.cost_price).replace(/[^\d.-]/g, '')) || 0,
        sale_price: Number(String(row.sale_price).replace(/[^\d.-]/g, '')) || 0,
        currency: store.currency,
        status: 'active',
      })
    }
    if (!payload.length) throw new Error('没有可导入的有效行（需包含 SKU 与商品名称）')
    for (let i = 0; i < payload.length; i += 200) {
      await insertRows('products', payload.slice(i, i + 200))
    }
    push(`成功导入 ${payload.length} 个商品${skipped ? `，跳过 ${skipped} 行` : ''}`)
    reload()
  }

  function handleExport() {
    const rows = filtered.map((p) => {
      const store = storeMap.get(p.store_id)
      return {
        店铺: store?.name ?? '',
        平台: store ? PLATFORM_LABEL[store.platform] : '',
        SKU: p.sku,
        ASIN: p.asin ?? '',
        商品名称: p.title,
        类目: p.category ?? '',
        成本: p.cost_price,
        售价: p.sale_price,
        币种: p.currency,
        毛利率: p.sale_price ? (((p.sale_price - p.cost_price) / p.sale_price) * 100).toFixed(1) + '%' : '',
        状态: PRODUCT_STATUS[p.status]?.label ?? p.status,
      }
    })
    downloadTextFile(`商品列表_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), 'text/csv;charset=utf-8')
  }

  return (
    <>
      <PageHeader
        title="商品管理"
        description="SKU 档案、成本与售价，是利润核算的基础"
        actions={
          <>
            <Button icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setImportOpen(true)} disabled={!data?.stores.length}>
              批量导入
            </Button>
            <Button icon={<Download className="w-3.5 h-3.5" />} onClick={handleExport} disabled={!filtered.length}>
              导出
            </Button>
            <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate} disabled={!data?.stores.length}>
              新增商品
            </Button>
          </>
        }
      />

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-100">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="搜索 SKU / ASIN / 商品名" className="w-full sm:w-64" />
          <Select
            className="w-full sm:w-44"
            value={storeFilter}
            onChange={(v) => { setStoreFilter(v); setPage(1) }}
            placeholder="全部店铺"
            options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            className="w-full sm:w-32"
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1) }}
            placeholder="全部状态"
            options={Object.entries(PRODUCT_STATUS).map(([value, v]) => ({ value, label: v.label }))}
          />
          <span className="ml-auto text-[11.5px] text-ink-400">
            共 <span className="num text-ink-700 font-medium">{num(filtered.length)}</span> 个 SKU
          </span>
        </div>

        {error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : loading ? (
          <LoadingBlock rows={6} />
        ) : !data?.stores.length ? (
          <EmptyState icon={<Package className="w-5 h-5" />} title="请先创建店铺" description="商品需要归属于某个店铺，先去「店铺管理」创建第一家店铺。" />
        ) : pageRows.length === 0 ? (
          <EmptyState
            icon={<Package className="w-5 h-5" />}
            title={search || storeFilter || statusFilter ? '没有匹配的商品' : '还没有商品'}
            description={search || storeFilter || statusFilter ? '换个关键词或清空筛选条件试试' : '手动新增或从平台导出的商品报表批量导入'}
            action={
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
                新增商品
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead>
                <tr>
                  <th className="th">商品</th>
                  <th className="th">店铺 / 平台</th>
                  <th className="th">ASIN</th>
                  <th className="th text-right">成本</th>
                  <th className="th text-right">售价</th>
                  <th className="th text-right">毛利</th>
                  <th className="th">状态</th>
                  <th className="th w-20" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((p) => {
                  const store = storeMap.get(p.store_id)
                  const gross = p.sale_price - p.cost_price
                  const margin = p.sale_price ? (gross / p.sale_price) * 100 : 0
                  const status = PRODUCT_STATUS[p.status]
                  return (
                    <tr key={p.id} className="hover:bg-ink-50/60 group">
                      <td className="td">
                        <div className="flex items-center gap-2.5">
                          {p.image_url ? (
                            <img src={p.image_url} alt="" className="w-9 h-9 rounded-lg object-cover border border-ink-200 shrink-0" />
                          ) : (
                            <div className="w-9 h-9 rounded-lg bg-ink-100 flex items-center justify-center shrink-0">
                              <ImageOff className="w-4 h-4 text-ink-300" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="text-[12.5px] font-medium text-ink-800 truncate max-w-[280px]">{p.title}</p>
                            <p className="text-[10.5px] text-ink-400 font-mono">{p.sku}{p.category ? ` · ${p.category}` : ''}</p>
                          </div>
                        </div>
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              'w-4 h-4 rounded flex items-center justify-center text-[8px] font-bold text-white shrink-0',
                              store?.platform === 'amazon' ? 'bg-amazon' : 'bg-tiktok',
                            )}
                          >
                            {store?.platform === 'amazon' ? 'a' : 't'}
                          </span>
                          <span className="text-[12px] truncate max-w-[130px]">{store?.name ?? '—'}</span>
                        </div>
                      </td>
                      <td className="td text-[11.5px] font-mono text-ink-500">{p.asin ?? '—'}</td>
                      <td className="td text-right num text-ink-500">{money(p.cost_price, p.currency)}</td>
                      <td className="td text-right num font-medium">{money(p.sale_price, p.currency)}</td>
                      <td className="td text-right">
                        <div className="num font-medium text-ink-800">{money(gross, p.currency)}</div>
                        <div className={cn('text-[10.5px] num', margin >= 40 ? 'text-emerald-600' : margin >= 20 ? 'text-ink-400' : 'text-rose-500')}>
                          {pct(margin)}
                        </div>
                      </td>
                      <td className="td">
                        <Badge tone={status?.tone ?? 'gray'}>{status?.label ?? p.status}</Badge>
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button className="p-1.5 rounded-md text-ink-400 hover:text-ink-800 hover:bg-ink-100" onClick={() => openEdit(p)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button data-perm="delete" className="p-1.5 rounded-md text-ink-400 hover:text-rose-600 hover:bg-rose-50" onClick={() => setDeleting(p)}>
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

        {filtered.length > PAGE_SIZE && (
          <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} />
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? '编辑商品' : '新增商品'}
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
          <Field label="所属店铺" required>
            <Select
              value={form.store_id}
              onChange={(v) => setForm({ ...form, store_id: v })}
              placeholder="选择店铺"
              options={(data?.stores ?? []).map((s) => ({ value: s.id, label: `${s.name}（${s.marketplace}）` }))}
            />
          </Field>
          <Field label="SKU" required hint="同一店铺内唯一">
            <input className="input font-mono" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="如 AH-BAMBOO-TRAY" />
          </Field>
          <Field label="商品名称" required className="sm:col-span-2">
            <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Listing 标题" />
          </Field>
          <Field label="ASIN / 商品 ID">
            <input className="input font-mono" value={form.asin} onChange={(e) => setForm({ ...form, asin: e.target.value })} placeholder="B0XXXXXXXX" />
          </Field>
          <Field label="类目">
            <input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="如 Home & Kitchen" />
          </Field>
          <Field label="采购成本" hint="含头程分摊更准确">
            <input className="input num" type="number" step="0.01" value={form.cost_price} onChange={(e) => setForm({ ...form, cost_price: e.target.value })} placeholder="0.00" />
          </Field>
          <Field
            label="售价"
            hint={
              storeMap.get(form.store_id)
                ? `币种：${marketplaceMeta(storeMap.get(form.store_id)?.marketplace).currency}`
                : '由店铺币种决定'
            }
          >
            <input className="input num" type="number" step="0.01" value={form.sale_price} onChange={(e) => setForm({ ...form, sale_price: e.target.value })} placeholder="0.00" />
          </Field>
          <Field label="状态">
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v as Product['status'] })}
              options={Object.entries(PRODUCT_STATUS).map(([value, v]) => ({ value, label: v.label }))}
            />
          </Field>
          <Field label="主图链接">
            <input className="input" value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} placeholder="https://…" />
          </Field>
          <Field label="备注" className="sm:col-span-2">
            <textarea className="textarea" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
        </div>
      </Modal>

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="批量导入商品"
        fields={IMPORT_FIELDS}
        onImport={handleImport}
        note="导入时按「店铺」列匹配已有店铺名称；未匹配到时使用下方选择的默认店铺。重复 SKU 会被数据库拒绝，建议先导出核对。"
        extra={
          <Field label="默认店铺（CSV 无店铺列时使用）">
            <Select
              value={importStore || storeFilter || data?.stores[0]?.id || ''}
              onChange={setImportStore}
              options={(data?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
        }
      />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={confirmLoading}
        title="删除商品"
        message={`确定删除「${deleting?.title}」吗？关联订单会保留，但不再关联该商品。`}
      />
    </>
  )
}
