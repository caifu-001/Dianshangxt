export type Platform = 'amazon' | 'tiktok'

export type EmploymentStatus = 'pending' | 'active' | 'left'

export interface Profile {
  id: string
  email: string | null
  full_name: string | null
  company: string | null
  role: string
  status: string
  last_sign_in_at: string | null
  note: string | null
  settings: Record<string, unknown>
  created_at: string
  /** 组织架构关联（旧库可能没有这几列，读取时为 undefined） */
  department_id?: string | null
  position_id?: string | null
  role_id?: string | null
  /** 人事状态：待入职 / 在职 / 已离职（旧库为 undefined，按在职处理） */
  employment_status?: EmploymentStatus
  hire_date?: string | null
  left_at?: string | null
  left_reason?: string | null
  handover_to?: string | null
  provisioned_by?: string | null
  provisioned_at?: string | null
}

/* ---------------- 权限流程 ---------------- */

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface AccessRequest {
  id: string
  user_id: string
  /** role = 申请岗位角色；system_role = 申请系统角色 */
  kind: 'role' | 'system_role'
  target_role_id: string | null
  target_role: 'admin' | 'member' | null
  reason: string
  expect_scope: string | null
  status: AccessRequestStatus
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
  created_at: string
}

export type EmployeeEventType =
  | 'hire'
  | 'activate'
  | 'transfer'
  | 'permission'
  | 'disable'
  | 'enable'
  | 'offboard'

export interface EmployeeEvent {
  id: string
  profile_id: string
  event_type: EmployeeEventType
  summary: string
  detail: Record<string, unknown>
  actor_id: string | null
  created_at: string
}

/* ---------------- 组织架构 ---------------- */

export interface Department {
  id: string
  name: string
  parent_id: string | null
  leader_id: string | null
  description: string | null
  /** 部门编码：IT / HR / OPS / FIN ... */
  code?: string | null
  /** 部门级权限码：模块可见范围 + 人事职能（hr.view / hr.manage） */
  scope?: string[]
  /** 是否继承上级部门的可见范围，默认 true */
  inherit_parent?: boolean
  sort_order: number
  created_at: string
}

export interface Position {
  id: string
  name: string
  department_id: string | null
  level: string
  description: string | null
  sort_order: number
  created_at: string
}

export interface RoleDef {
  id: string
  name: string
  description: string | null
  permissions: string[]
  is_system: boolean
  sort_order: number
  created_at: string
}

/* ---------------- 绩效 ---------------- */

export type PerformanceGrade = 'S' | 'A' | 'B' | 'C' | 'D'

export interface PerformanceReview {
  id: string
  profile_id: string
  /** 考核周期：2026-Q4 / 2026-11 */
  period: string
  /** 评估时的部门快照，避免调岗后历史报表被改写 */
  department_id: string | null
  reviewer_id: string | null
  score: number
  grade: PerformanceGrade
  kpi: Record<string, number>
  summary: string | null
  improvement: string | null
  status: 'draft' | 'published'
  created_at: string
  updated_at: string
}

export interface Store {
  id: string
  user_id: string
  name: string
  platform: Platform
  marketplace: string
  currency: string
  seller_id: string | null
  status: 'active' | 'paused' | 'closed'
  target_acos: number
  note: string | null
  created_at: string
}

export interface Product {
  id: string
  user_id: string
  store_id: string
  sku: string
  asin: string | null
  title: string
  image_url: string | null
  category: string | null
  cost_price: number
  sale_price: number
  currency: string
  status: 'active' | 'inactive' | 'archived'
  tags: string[]
  note: string | null
  created_at: string
}

export interface Order {
  id: string
  user_id: string
  store_id: string
  product_id: string | null
  order_no: string
  order_date: string
  channel: 'amazon' | 'tiktok' | 'other'
  sku: string | null
  title: string | null
  customer_name: string | null
  country: string | null
  quantity: number
  unit_price: number
  cost_amount: number
  platform_fee: number
  fba_fee: number
  shipping_fee: number
  ad_cost: number
  refund_amount: number
  other_fee: number
  status: 'pending' | 'shipped' | 'delivered' | 'refunded' | 'cancelled'
  note: string | null
  gross_amount: number
  profit: number
  created_at: string
}

export interface InventoryItem {
  id: string
  user_id: string
  store_id: string
  product_id: string | null
  sku: string
  title: string | null
  warehouse: string
  available_qty: number
  inbound_qty: number
  reserved_qty: number
  safety_stock: number
  avg_daily_sales: number
  updated_at: string
}

export interface Campaign {
  id: string
  user_id: string
  store_id: string
  name: string
  platform: Platform
  ad_type: string
  status: 'active' | 'paused' | 'ended'
  daily_budget: number
  spend: number
  impressions: number
  clicks: number
  orders_count: number
  sales: number
  start_date: string
  end_date: string | null
  note: string | null
  created_at: string
}

export interface Creator {
  id: string
  user_id: string
  store_id: string | null
  handle: string
  name: string | null
  avatar_url: string | null
  region: string | null
  category: string | null
  followers: number
  email: string | null
  commission_rate: number
  status: 'pending' | 'contacted' | 'sampling' | 'cooperating' | 'paused'
  gmv: number
  video_count: number
  last_contact: string | null
  note: string | null
  created_at: string
}

export interface Task {
  id: string
  user_id: string
  store_id: string | null
  title: string
  description: string | null
  module: 'listing' | 'ads' | 'inventory' | 'content' | 'customer' | 'finance' | 'other'
  priority: 'high' | 'medium' | 'low'
  status: 'todo' | 'doing' | 'done'
  due_date: string | null
  assignee: string | null
  created_at: string
  completed_at: string | null
}

export interface Expense {
  id: string
  user_id: string
  store_id: string | null
  category: string
  amount: number
  currency: string
  expense_date: string
  remark: string | null
  created_at: string
}

/* ---------------- 竞品分析 ---------------- */

export type CompetitorStatus = 'tracking' | 'paused' | 'archived'

export interface Competitor {
  id: string
  user_id: string
  store_id: string | null
  /** 我方对标商品，用于算价差 */
  product_id: string | null
  platform: Platform
  marketplace: string
  asin: string | null
  title: string
  brand: string | null
  url: string | null
  image_url: string | null
  currency: string
  price: number
  /** 划线价，用来算折扣力度 */
  list_price: number
  coupon: string | null
  rating: number
  reviews: number
  bsr: number | null
  est_monthly_sales: number
  seller: string | null
  category: string | null
  status: CompetitorStatus
  note: string | null
  last_checked: string | null
  created_at: string
}

export interface CompetitorSnapshot {
  id: string
  user_id: string
  competitor_id: string
  snapshot_date: string
  price: number
  rating: number
  reviews: number
  bsr: number | null
  est_monthly_sales: number
  note: string | null
  created_at: string
}

/* ---------------- 采购 ---------------- */

export interface Supplier {
  id: string
  user_id: string
  name: string
  contact: string | null
  phone: string | null
  email: string | null
  address: string | null
  category: string | null
  payment_terms: string
  lead_time_days: number
  rating: number
  status: 'active' | 'paused'
  note: string | null
  created_at: string
}

export type PurchaseStatus = 'draft' | 'ordered' | 'partial' | 'received' | 'cancelled'

export interface PurchaseOrder {
  id: string
  user_id: string
  po_no: string
  supplier_id: string | null
  store_id: string | null
  warehouse: string
  order_date: string
  expected_date: string | null
  currency: string
  status: PurchaseStatus
  shipping_fee: number
  other_fee: number
  note: string | null
  created_at: string
  updated_at: string
}

export interface PurchaseItem {
  id: string
  user_id: string
  po_id: string
  product_id: string | null
  sku: string
  title: string | null
  quantity: number
  unit_price: number
  received_qty: number
  /** 数据库生成列：quantity * unit_price */
  amount: number
  created_at: string
}
