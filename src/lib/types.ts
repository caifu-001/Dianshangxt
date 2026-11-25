export type Platform = 'amazon' | 'tiktok'

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
