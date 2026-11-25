import { callRpc } from './db'
import type { ShortageRow, TraceEvent } from './types'

/* ------------------------------------------------------------------ */
/*  链路操作：所有涉及库存 / 成本 / 状态的写入都走数据库函数           */
/*  分散 update 会留下「库存扣了但单子没标出库」这类对不上的脏数据。    */
/* ------------------------------------------------------------------ */

export interface FulfillResult {
  ok: boolean
  already?: boolean
  reason?: 'shortage' | string
  available?: number
  need?: number
  shortage?: number
  warehouse?: string
  unit_cost?: number
  sku?: string
}

/** 订单出库：扣库存 + 写流水 + 回填采购加权成本 */
export function fulfillOrder(orderId: string, warehouse?: string | null, force = false) {
  return callRpc<FulfillResult>('fulfill_order', {
    p_order_id: orderId,
    p_warehouse: warehouse ?? null,
    p_force: force,
  })
}

/** 撤销出库：取消 / 退款时把货退回可用库存 */
export function restoreOrderStock(orderId: string) {
  return callRpc<{ ok: boolean; reason?: string; restored?: number }>('restore_order_stock', {
    p_order_id: orderId,
  })
}

export interface ReceiveLine {
  item_id: string
  qty: number
  unit_cost?: number
}

/** 采购到货入库：写流水 + 加库存 + 采购价回流商品成本 */
export function receivePurchase(poId: string, lines: ReceiveLine[], warehouse?: string | null, note?: string) {
  return callRpc<{ ok: boolean; reason?: string; message?: string; received?: number; status?: string }>(
    'receive_purchase',
    { p_po_id: poId, p_lines: lines, p_warehouse: warehouse ?? null, p_note: note ?? null },
  )
}

/** 采购付款登记：自动维护已付金额与付款状态 */
export function registerPayment(
  poId: string,
  amount: number,
  paidAt?: string,
  method = 'bank',
  voucher?: string,
  note?: string,
) {
  return callRpc<{ ok: boolean; paid: number; total: number; status: 'unpaid' | 'partial' | 'paid' }>(
    'register_payment',
    {
      p_po_id: poId,
      p_amount: amount,
      p_paid_at: paidAt ?? null,
      p_method: method,
      p_voucher: voucher ?? null,
      p_note: note ?? null,
    },
  )
}

/** 缺货补货建议 */
export function fetchShortagePlan(storeId?: string | null) {
  return callRpc<ShortageRow[]>('shortage_plan', { p_store_id: storeId ?? null })
}

export interface ShortagePoLine {
  sku: string
  title?: string | null
  product_id?: string | null
  qty: number
  unit_cost?: number
}

/** 缺货建议一键生成草稿采购单 */
export function createPoFromShortage(
  lines: ShortagePoLine[],
  supplierId?: string | null,
  storeId?: string | null,
  orderId?: string | null,
) {
  return callRpc<{ ok: boolean; po_id: string; po_no: string; lines: number; amount: number }>(
    'create_po_from_shortage',
    {
      p_lines: lines,
      p_supplier_id: supplierId ?? null,
      p_store_id: storeId ?? null,
      p_order_id: orderId ?? null,
    },
  )
}

/** 一张订单的完整链路时间线 */
export function fetchOrderTrace(orderId: string) {
  return callRpc<{ order: Record<string, unknown>; timeline: TraceEvent[] }>('order_trace', {
    p_order_id: orderId,
  })
}

export interface MemberMetrics {
  period: string
  start: string
  end: string
  orders: number
  units: number
  gmv: number
  profit: number
  prev_profit: number
  task_total: number
  task_done: number
  task_ontime: number
  po_count: number
  po_amount: number
  kpi: { sales: number; execution: number; collaboration: number; growth: number }
  score: number
  grade: 'S' | 'A' | 'B' | 'C' | 'D'
}

/** 按真实订单 / 任务 / 采购数据算绩效指标 */
export function fetchMemberMetrics(profileId: string, period: string) {
  return callRpc<MemberMetrics>('member_metrics', { p_profile_id: profileId, p_period: period })
}

/** 按真实数据算分并写回绩效记录 */
export function applyPerformanceScore(profileId: string, period: string) {
  return callRpc<MemberMetrics>('apply_performance_score', { p_profile_id: profileId, p_period: period })
}

/* ------------------------------------------------------------------ */
/*  展示元数据                                                         */
/* ------------------------------------------------------------------ */

export const MOVE_META: Record<string, { label: string; cls: string }> = {
  in: { label: '入库', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200/70' },
  out: { label: '出库', cls: 'bg-rose-50 text-rose-700 border-rose-200/70' },
  return: { label: '退回', cls: 'bg-brand-50 text-brand-700 border-brand-200/70' },
  adjust: { label: '盘点', cls: 'bg-amber-50 text-amber-700 border-amber-200/70' },
}

export const TRACE_META: Record<string, { label: string; dot: string; cls: string }> = {
  order: { label: '订单', dot: 'bg-brand-500', cls: 'text-brand-700' },
  out: { label: '出库', dot: 'bg-rose-500', cls: 'text-rose-700' },
  purchase: { label: '采购', dot: 'bg-amber-500', cls: 'text-amber-700' },
  payment: { label: '付款', dot: 'bg-violet-500', cls: 'text-violet-700' },
  in: { label: '入库', dot: 'bg-emerald-500', cls: 'text-emerald-700' },
  task: { label: '任务', dot: 'bg-ink-400', cls: 'text-ink-600' },
}

export const STOCK_STATE_META: Record<string, { label: string; cls: string }> = {
  pending: { label: '未出库', cls: 'bg-ink-100 text-ink-600 border-ink-200/70' },
  out: { label: '已出库', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200/70' },
  returned: { label: '已退回', cls: 'bg-amber-50 text-amber-700 border-amber-200/70' },
}

export const PAYMENT_META: Record<string, { label: string; cls: string }> = {
  unpaid: { label: '未付款', cls: 'bg-rose-50 text-rose-700 border-rose-200/70' },
  partial: { label: '部分付款', cls: 'bg-amber-50 text-amber-700 border-amber-200/70' },
  paid: { label: '已付清', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200/70' },
}

export const PAY_METHODS = [
  { value: 'bank', label: '银行转账' },
  { value: 'alipay', label: '支付宝' },
  { value: 'wechat', label: '微信' },
  { value: 'cash', label: '现金' },
  { value: 'other', label: '其他' },
]
