import type { Platform } from './types'

export const PLATFORM_LABEL: Record<Platform, string> = {
  amazon: 'Amazon',
  tiktok: 'TikTok Shop',
}

export const PLATFORM_SHORT: Record<Platform, string> = {
  amazon: 'AMZ',
  tiktok: 'TTS',
}

export const MARKETPLACES = [
  { code: 'US', name: '美国', currency: 'USD', flag: '🇺🇸' },
  { code: 'UK', name: '英国', currency: 'GBP', flag: '🇬🇧' },
  { code: 'DE', name: '德国', currency: 'EUR', flag: '🇩🇪' },
  { code: 'FR', name: '法国', currency: 'EUR', flag: '🇫🇷' },
  { code: 'IT', name: '意大利', currency: 'EUR', flag: '🇮🇹' },
  { code: 'ES', name: '西班牙', currency: 'EUR', flag: '🇪🇸' },
  { code: 'JP', name: '日本', currency: 'JPY', flag: '🇯🇵' },
  { code: 'CA', name: '加拿大', currency: 'CAD', flag: '🇨🇦' },
  { code: 'MX', name: '墨西哥', currency: 'MXN', flag: '🇲🇽' },
  { code: 'AE', name: '阿联酋', currency: 'AED', flag: '🇦🇪' },
  { code: 'SA', name: '沙特', currency: 'SAR', flag: '🇸🇦' },
  { code: 'SG', name: '新加坡', currency: 'SGD', flag: '🇸🇬' },
  { code: 'MY', name: '马来西亚', currency: 'MYR', flag: '🇲🇾' },
  { code: 'TH', name: '泰国', currency: 'THB', flag: '🇹🇭' },
  { code: 'VN', name: '越南', currency: 'VND', flag: '🇻🇳' },
  { code: 'ID', name: '印尼', currency: 'IDR', flag: '🇮🇩' },
]

export const CURRENCIES = ['USD', 'CNY', 'EUR', 'GBP', 'JPY', 'CAD', 'MXN', 'AED', 'SAR', 'SGD', 'MYR', 'THB', 'BRL']

export function marketplaceMeta(code?: string | null) {
  return MARKETPLACES.find((m) => m.code === code) ?? { code: code ?? '', name: code ?? '—', currency: 'USD', flag: '🌐' }
}

export const AD_TYPES: Record<string, string> = {
  SP: 'Sponsored Products',
  SB: 'Sponsored Brands',
  SD: 'Sponsored Display',
  GMV_MAX: 'GMV Max',
  VIDEO: 'Video Ads',
  LIVE: 'Live Ads',
  PSA: 'Product Shopping Ads',
}

export const ORDER_STATUS: Record<string, { label: string; tone: 'gray' | 'blue' | 'green' | 'red' | 'amber' }> = {
  pending: { label: '待发货', tone: 'amber' },
  shipped: { label: '已发货', tone: 'blue' },
  delivered: { label: '已签收', tone: 'green' },
  refunded: { label: '已退款', tone: 'red' },
  cancelled: { label: '已取消', tone: 'gray' },
}

export const PRODUCT_STATUS: Record<string, { label: string; tone: 'gray' | 'blue' | 'green' | 'red' | 'amber' }> = {
  active: { label: '在售', tone: 'green' },
  inactive: { label: '已下架', tone: 'gray' },
  archived: { label: '已归档', tone: 'gray' },
}

export const STORE_STATUS: Record<string, { label: string; tone: 'gray' | 'blue' | 'green' | 'red' | 'amber' }> = {
  active: { label: '运营中', tone: 'green' },
  paused: { label: '已暂停', tone: 'amber' },
  closed: { label: '已关闭', tone: 'gray' },
}

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: 'gray' | 'blue' | 'green' | 'red' | 'amber' }> = {
  active: { label: '投放中', tone: 'green' },
  paused: { label: '已暂停', tone: 'amber' },
  ended: { label: '已结束', tone: 'gray' },
}

export const CREATOR_STATUS: Record<string, { label: string; tone: 'gray' | 'blue' | 'green' | 'red' | 'amber' | 'violet' }> = {
  pending: { label: '待联系', tone: 'gray' },
  contacted: { label: '已联系', tone: 'blue' },
  sampling: { label: '寄样中', tone: 'amber' },
  cooperating: { label: '合作中', tone: 'green' },
  paused: { label: '已暂停', tone: 'red' },
}

export const TASK_STATUS: Record<string, { label: string; tone: 'gray' | 'blue' | 'green' | 'red' | 'amber' }> = {
  todo: { label: '待处理', tone: 'gray' },
  doing: { label: '进行中', tone: 'blue' },
  done: { label: '已完成', tone: 'green' },
}

export const TASK_MODULE: Record<string, string> = {
  listing: 'Listing 优化',
  ads: '广告投放',
  inventory: '库存补货',
  content: '内容制作',
  customer: '客服售后',
  finance: '财务结算',
  other: '其他',
}

export const PRIORITY: Record<string, { label: string; tone: 'gray' | 'blue' | 'green' | 'red' | 'amber' }> = {
  high: { label: '高', tone: 'red' },
  medium: { label: '中', tone: 'amber' },
  low: { label: '低', tone: 'gray' },
}

export const EXPENSE_CATEGORY: Record<string, string> = {
  shipping: '头程物流',
  warehouse: '仓储费',
  software: '软件订阅',
  sample: '样品寄送',
  influencer: '达人佣金',
  tax: '税费',
  other: '其他',
}
