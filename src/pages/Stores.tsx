import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Archive, MoreHorizontal, Pencil, Plus, Store as StoreIcon, Target, Trash2 } from 'lucide-react'
import { deleteRow, fetchRows, insertRow, updateRow } from '../lib/db'
import { CURRENCIES, MARKETPLACES, PLATFORM_LABEL, STORE_STATUS, marketplaceMeta } from '../lib/constants'
import type { Campaign, Order, Platform, Product, Store } from '../lib/types'
import { useAsync } from '../hooks/useAsync'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBlock,
  Field,
  Modal,
  PageHeader,
  Select,
  useToast,
} from '../components/ui'
import { cn, daysAgo, money, num, pct } from '../lib/utils'

interface FormState {
  name: string
  platform: Platform
  marketplace: string
  currency: string
  seller_id: string
  status: Store['status']
  target_acos: string
  note: string
}

const EMPTY: FormState = {
  name: '',
  platform: 'amazon',
  marketplace: 'US',
  currency: 'USD',
  seller_id: '',
  status: 'active',
  target_acos: '30',
  note: '',
}

export default function Stores() {
  const { push } = useToast()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Store | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Store | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)

  const { data, loading, error, reload } = useAsync(async () => {
    const [stores, orders, products, campaigns] = await Promise.all([
      fetchRows<Store>('stores', { order: { column: 'created_at' } }),
      fetchRows<Order>('orders', { filters: [['order_date', 'gte', daysAgo(29)]] }),
      fetchRows<Product>('products'),
      fetchRows<Campaign>('campaigns'),
    ])
    return { stores, orders, products, campaigns }
  }, [])

  const stats = useMemo(() => {
    const map = new Map<string, { sales: number; profit: number; orders: number; ad: number; skus: number; adSales: number }>()
    const ensure = (id: string) => {
      const row = map.get(id) ?? { sales: 0, profit: 0, orders: 0, ad: 0, skus: 0, adSales: 0 }
      map.set(id, row)
      return row
    }
    for (const o of data?.orders ?? []) {
      if (o.status === 'cancelled') continue
      const row = ensure(o.store_id)
      row.sales += Number(o.gross_amount)
      row.profit += Number(o.profit)
      row.orders += 1
      row.ad += Number(o.ad_cost)
    }
    for (const p of data?.products ?? []) ensure(p.store_id).skus += 1
    for (const c of data?.campaigns ?? []) ensure(c.store_id).adSales += Number(c.sales)
    return map
  }, [data])

  function openCreate() {
    setEditing(null)
    setForm(EMPTY)
    setModalOpen(true)
  }

  function openEdit(store: Store) {
    setEditing(store)
    setForm({
      name: store.name,
      platform: store.platform,
      marketplace: store.marketplace,
      currency: store.currency,
      seller_id: store.seller_id ?? '',
      status: store.status,
      target_acos: String(store.target_acos),
      note: store.note ?? '',
    })
    setModalOpen(true)
    setMenuId(null)
  }

  async function handleSave() {
    if (!form.name.trim()) {
      push('请填写店铺名称', 'error')
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        platform: form.platform,
        marketplace: form.marketplace,
        currency: form.currency,
        seller_id: form.seller_id.trim() || null,
        status: form.status,
        target_acos: Number(form.target_acos) || 0,
        note: form.note.trim() || null,
      }
      if (editing) {
        await updateRow('stores', editing.id, payload)
        push('店铺信息已更新')
      } else {
        await insertRow('stores', payload)
        push('店铺创建成功')
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
      await deleteRow('stores', deleting.id)
      push('店铺已删除')
      setDeleting(null)
      reload()
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setConfirmLoading(false)
    }
  }

  function changeMarketplace(code: string) {
    const meta = marketplaceMeta(code)
    setForm((f) => ({ ...f, marketplace: code, currency: meta.currency }))
  }

  const amazonCount = data?.stores.filter((s) => s.platform === 'amazon').length ?? 0
  const tiktokCount = data?.stores.filter((s) => s.platform === 'tiktok').length ?? 0

  return (
    <>
      <PageHeader
        title="店铺管理"
        description="Amazon 与 TikTok Shop 多店铺、多站点统一档案"
        actions={
          <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
            新增店铺
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Badge tone="amber" dot>
          Amazon {amazonCount}
        </Badge>
        <Badge tone="gray" dot>
          TikTok Shop {tiktokCount}
        </Badge>
        <span className="text-[11.5px] text-ink-400">下方面板数据统计口径：近 30 天</span>
      </div>

      {error && <ErrorBlock message={error} onRetry={reload} />}

      {loading ? (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card p-4 h-[196px]">
              <div className="skeleton h-9 w-2/3" />
              <div className="skeleton h-14 w-full mt-4" />
              <div className="skeleton h-8 w-full mt-3" />
            </div>
          ))}
        </div>
      ) : data && data.stores.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<StoreIcon className="w-5 h-5" />}
            title="还没有店铺"
            description="先添加一家 Amazon 或 TikTok Shop 店铺，后续的商品、订单、广告都会归属到店铺下。"
            action={
              <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreate}>
                新增店铺
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {data?.stores.map((store) => {
            const s = stats.get(store.id) ?? { sales: 0, profit: 0, orders: 0, ad: 0, skus: 0, adSales: 0 }
            const meta = marketplaceMeta(store.marketplace)
            const margin = s.sales ? (s.profit / s.sales) * 100 : 0
            const storeAcos = s.adSales ? (s.ad / s.adSales) * 100 : 0
            const status = STORE_STATUS[store.status]
            return (
              <div key={store.id} className="card p-4 group relative hover:shadow-pop transition-shadow">
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      'w-9 h-9 rounded-lg flex items-center justify-center text-white text-[13px] font-bold shrink-0',
                      store.platform === 'amazon' ? 'bg-amazon' : 'bg-tiktok',
                    )}
                  >
                    {store.platform === 'amazon' ? 'a' : 't'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-semibold text-ink-900 truncate">{store.name}</p>
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      {meta.flag} {meta.name} · {PLATFORM_LABEL[store.platform]} · {store.currency}
                    </p>
                  </div>
                  <div className="relative">
                    <button
                      className="p-1 rounded-md text-ink-400 hover:bg-ink-100 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => setMenuId(menuId === store.id ? null : store.id)}
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                    {menuId === store.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setMenuId(null)} />
                        <div className="absolute right-0 top-full mt-1 w-32 bg-white border border-ink-200 rounded-lg shadow-pop py-1 z-20">
                          <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-600 hover:bg-ink-50" onClick={() => openEdit(store)}>
                            <Pencil className="w-3 h-3" /> 编辑
                          </button>
                          <button
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-rose-600 hover:bg-rose-50"
                            onClick={() => {
                              setDeleting(store)
                              setMenuId(null)
                            }}
                          >
                            <Trash2 className="w-3 h-3" /> 删除
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-ink-50/80 border border-ink-100 px-3 py-2.5">
                  <div>
                    <p className="text-[10px] text-ink-400">销售额</p>
                    <p className="num text-[13px] font-semibold text-ink-900 mt-0.5">{money(s.sales, store.currency, 0)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-ink-400">订单</p>
                    <p className="num text-[13px] font-semibold text-ink-900 mt-0.5">{num(s.orders)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-ink-400">净利率</p>
                    <p className={cn('num text-[13px] font-semibold mt-0.5', margin >= 15 ? 'text-emerald-600' : margin >= 5 ? 'text-amber-600' : 'text-rose-600')}>
                      {pct(margin)}
                    </p>
                  </div>
                </div>

                <div className="mt-2.5 flex items-center justify-between text-[11px] text-ink-500">
                  <span className="flex items-center gap-1">
                    <Archive className="w-3 h-3" />
                    {s.skus} 个 SKU
                  </span>
                  <span className="flex items-center gap-1">
                    <Target className="w-3 h-3" />
                    ACOS {pct(storeAcos)} / 目标 {pct(store.target_acos, 0)}
                  </span>
                </div>

                <div className="mt-3 pt-3 border-t border-ink-100 flex items-center justify-between">
                  <Badge tone={status.tone} dot>
                    {status.label}
                  </Badge>
                  <Link to={`/products?store=${store.id}`} className="text-[11.5px] link">
                    查看商品 →
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? '编辑店铺' : '新增店铺'}
        description="平台与站点决定后续数据统计口径，建好后可修改"
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
          <Field label="店铺名称" required className="sm:col-span-2">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：Aurora Home · US" />
          </Field>
          <Field label="平台" required>
            <Select
              value={form.platform}
              onChange={(v) => setForm({ ...form, platform: v as Platform })}
              options={[
                { value: 'amazon', label: 'Amazon' },
                { value: 'tiktok', label: 'TikTok Shop' },
              ]}
            />
          </Field>
          <Field label="站点">
            <Select
              value={form.marketplace}
              onChange={changeMarketplace}
              options={MARKETPLACES.map((m) => ({ value: m.code, label: `${m.flag} ${m.name} (${m.code})` }))}
            />
          </Field>
          <Field label="结算币种">
            <Select value={form.currency} onChange={(v) => setForm({ ...form, currency: v })} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
          </Field>
          <Field label="Seller / Shop ID">
            <input className="input" value={form.seller_id} onChange={(e) => setForm({ ...form, seller_id: e.target.value })} placeholder="选填，用于对账" />
          </Field>
          <Field label="运营状态">
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v as Store['status'] })}
              options={Object.entries(STORE_STATUS).map(([value, v]) => ({ value, label: v.label }))}
            />
          </Field>
          <Field label="目标 ACOS (%)">
            <input className="input num" type="number" step="0.1" value={form.target_acos} onChange={(e) => setForm({ ...form, target_acos: e.target.value })} />
          </Field>
          <Field label="备注" className="sm:col-span-2">
            <textarea className="textarea" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="发货方式、经营重点等" />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={confirmLoading}
        title="删除店铺"
        message={`删除「${deleting?.name}」会同时移除该店铺下的商品、订单、库存与广告数据，且无法恢复。确定继续吗？`}
      />
    </>
  )
}
