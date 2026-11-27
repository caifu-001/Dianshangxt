import type { Platform } from './types'

/* ------------------------------------------------------------------ */
/*  跨境平台目录                                                        */
/*  所有平台的展示名、简称、配色、常用站点、广告类型与默认佣金率都在这里   */
/*  统一维护。各页面一律通过 platformMeta() 读取，不再写死 amazon/tiktok */
/*  二元判断。公司可在「系统设置 → 经营平台」中勾选自己实际经营的平台。  */
/* ------------------------------------------------------------------ */

export type PlatformTone = 'gray' | 'blue' | 'green' | 'red' | 'amber' | 'violet'

export interface PlatformMeta {
  code: Platform
  label: string
  short: string
  /** 区域分组，用于设置页展示 */
  region: string
  /** 头像底色，使用完整静态 class 以便 Tailwind 扫描 */
  badge: string
  tone: PlatformTone
  initial: string
  currency: string
  markets: string[]
  /** 是否需要填写 ASIN / 平台商品编码 */
  usesAsin: boolean
  /** 该系统支持的广告类型代码，空数组表示暂无站内广告模块 */
  adTypes: string[]
  /** 默认平台佣金率（0~1），仅用于新建订单时预估，可手工改 */
  feeRate: number
}

export const PLATFORM_CATALOG: PlatformMeta[] = [
  { code: 'amazon', label: 'Amazon 亚马逊', short: 'AMZ', region: '综合电商', badge: 'bg-amazon', tone: 'amber', initial: 'a', currency: 'USD', markets: ['US', 'UK', 'DE', 'FR', 'IT', 'ES', 'JP', 'CA', 'MX', 'AE', 'SA', 'SG'], usesAsin: true, adTypes: ['SP', 'SB', 'SD'], feeRate: 0.15 },
  { code: 'tiktok', label: 'TikTok Shop', short: 'TTS', region: '社交电商', badge: 'bg-tiktok', tone: 'violet', initial: 't', currency: 'USD', markets: ['US', 'UK', 'SG', 'MY', 'TH', 'VN', 'ID'], usesAsin: false, adTypes: ['GMV_MAX', 'LIVE', 'VIDEO'], feeRate: 0.08 },
  { code: 'shopee', label: 'Shopee 虾皮', short: 'SHPE', region: '东南亚 / 拉美', badge: 'bg-orange-500', tone: 'amber', initial: 's', currency: 'USD', markets: ['SG', 'MY', 'TH', 'VN', 'ID', 'BR'], usesAsin: false, adTypes: ['PSA'], feeRate: 0.06 },
  { code: 'lazada', label: 'Lazada 来赞达', short: 'LAZ', region: '东南亚', badge: 'bg-purple-600', tone: 'violet', initial: 'l', currency: 'USD', markets: ['SG', 'MY', 'TH', 'VN', 'ID'], usesAsin: false, adTypes: ['PSA'], feeRate: 0.06 },
  { code: 'temu', label: 'Temu', short: 'TEMU', region: '全球平台', badge: 'bg-rose-500', tone: 'red', initial: 'T', currency: 'USD', markets: ['US', 'UK', 'DE', 'FR', 'JP'], usesAsin: false, adTypes: [], feeRate: 0 },
  { code: 'walmart', label: 'Walmart 沃尔玛', short: 'WMT', region: '北美', badge: 'bg-blue-600', tone: 'blue', initial: 'W', currency: 'USD', markets: ['US', 'CA', 'MX'], usesAsin: true, adTypes: ['SP'], feeRate: 0.12 },
  { code: 'ebay', label: 'eBay', short: 'EBAY', region: '全球平台', badge: 'bg-sky-600', tone: 'blue', initial: 'e', currency: 'USD', markets: ['US', 'UK', 'DE', 'FR', 'CA', 'AU'], usesAsin: false, adTypes: ['SP'], feeRate: 0.1 },
  { code: 'aliexpress', label: 'AliExpress 速卖通', short: 'AEX', region: '全球平台', badge: 'bg-red-500', tone: 'red', initial: 'A', currency: 'USD', markets: ['US', 'UK', 'DE', 'FR', 'ES', 'BR', 'RU'], usesAsin: false, adTypes: ['SP'], feeRate: 0.05 },
  { code: 'mercadolibre', label: 'Mercado Libre 美客多', short: 'ML', region: '拉美', badge: 'bg-yellow-600', tone: 'amber', initial: 'M', currency: 'USD', markets: ['BR', 'MX', 'AR'], usesAsin: false, adTypes: ['SP'], feeRate: 0.12 },
  { code: 'shopify', label: 'Shopify 独立站', short: 'SFY', region: '独立站', badge: 'bg-emerald-600', tone: 'green', initial: 'S', currency: 'USD', markets: ['US', 'UK', 'DE', 'AU'], usesAsin: false, adTypes: [], feeRate: 0 },
  { code: 'etsy', label: 'Etsy', short: 'ETSY', region: '欧美', badge: 'bg-orange-600', tone: 'amber', initial: 'E', currency: 'USD', markets: ['US', 'UK', 'DE', 'FR', 'CA'], usesAsin: false, adTypes: ['SP'], feeRate: 0.08 },
  { code: 'shein', label: 'SHEIN', short: 'SHEIN', region: '全球平台', badge: 'bg-neutral-800', tone: 'gray', initial: 'S', currency: 'USD', markets: ['US', 'UK', 'DE', 'FR', 'BR'], usesAsin: false, adTypes: [], feeRate: 0 },
  { code: 'target', label: 'Target 塔吉特', short: 'TGT', region: '北美', badge: 'bg-red-600', tone: 'red', initial: 'T', currency: 'USD', markets: ['US'], usesAsin: true, adTypes: ['SP'], feeRate: 0.1 },
  { code: 'wayfair', label: 'Wayfair', short: 'WAY', region: '欧美家居', badge: 'bg-indigo-600', tone: 'blue', initial: 'W', currency: 'USD', markets: ['US', 'UK', 'DE', 'CA'], usesAsin: false, adTypes: ['SP'], feeRate: 0.12 },
  { code: 'noon', label: 'Noon', short: 'NOON', region: '中东', badge: 'bg-amber-500', tone: 'amber', initial: 'N', currency: 'AED', markets: ['AE', 'SA', 'EG'], usesAsin: false, adTypes: ['SP'], feeRate: 0.1 },
  { code: 'coupang', label: 'Coupang 酷澎', short: 'CPG', region: '韩国', badge: 'bg-emerald-500', tone: 'green', initial: 'C', currency: 'KRW', markets: ['KR'], usesAsin: false, adTypes: ['SP'], feeRate: 0.08 },
  { code: 'ozon', label: 'Ozon', short: 'OZON', region: '俄罗斯', badge: 'bg-sky-500', tone: 'blue', initial: 'O', currency: 'RUB', markets: ['RU'], usesAsin: false, adTypes: ['SP'], feeRate: 0.08 },
  { code: 'newegg', label: 'Newegg 新蛋', short: 'NEG', region: '北美 3C', badge: 'bg-orange-500', tone: 'amber', initial: 'N', currency: 'USD', markets: ['US', 'CA'], usesAsin: true, adTypes: ['SP'], feeRate: 0.08 },
]

/** 图表专用色值（Tailwind class 不能用于 canvas/SVG fill） */
export const PLATFORM_HEX: Record<Platform, string> = {
  amazon: '#ff9900',
  tiktok: '#161823',
  shopee: '#ee4d2d',
  lazada: '#8b3fd1',
  temu: '#e02e24',
  walmart: '#0071dc',
  ebay: '#3665f3',
  aliexpress: '#e62e04',
  mercadolibre: '#f5d400',
  shopify: '#95bf47',
  etsy: '#f1641e',
  shein: '#111827',
  target: '#cc0000',
  wayfair: '#4b2e83',
  noon: '#f5b921',
  coupang: '#00a082',
  ozon: '#005bff',
  newegg: '#f5a623',
}

/** 未识别平台（历史脏数据 / 自定义值）的统一兜底元数据 */
const PLATFORM_FALLBACK: PlatformMeta = {
  code: 'amazon',
  label: '其他平台',
  short: 'OTH',
  region: '其他',
  badge: 'bg-ink-400',
  tone: 'gray',
  initial: '?',
  currency: 'USD',
  markets: [],
  usesAsin: false,
  adTypes: [],
  feeRate: 0.08,
}

const PLATFORM_MAP = new Map<string, PlatformMeta>(PLATFORM_CATALOG.map((p) => [p.code, p]))

/** 按编码取平台元数据，未知编码返回兜底项（label 显示为原始编码，便于排查） */
export function platformMeta(code?: string | null): PlatformMeta {
  if (!code) return PLATFORM_FALLBACK
  return PLATFORM_MAP.get(code) ?? { ...PLATFORM_FALLBACK, label: code, short: code.toUpperCase().slice(0, 4), initial: code.charAt(0).toUpperCase() }
}

export const PLATFORM_LABEL: Record<Platform, string> = Object.fromEntries(
  PLATFORM_CATALOG.map((p) => [p.code, p.label]),
) as Record<Platform, string>

export const PLATFORM_SHORT: Record<Platform, string> = Object.fromEntries(
  PLATFORM_CATALOG.map((p) => [p.code, p.short]),
) as Record<Platform, string>

/** 平台选项：传入公司启用列表时只返回启用的平台；未传或为空时返回全部（兼容未配置的旧公司） */
export function platformOptions(enabled?: string[] | null): PlatformMeta[] {
  const codes = Array.isArray(enabled) ? enabled.filter((c) => PLATFORM_MAP.has(c)) : []
  return codes.length ? PLATFORM_CATALOG.filter((p) => codes.includes(p.code)) : PLATFORM_CATALOG
}

/** 某平台是否支持站内广告模块 */
export function platformHasAds(code?: string | null): boolean {
  return platformMeta(code).adTypes.length > 0
}

/** 新建订单时的默认平台佣金率 */
export function platformFeeRate(code?: string | null): number {
  return platformMeta(code).feeRate
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
  { code: 'AU', name: '澳大利亚', currency: 'AUD', flag: '🇦🇺' },
  { code: 'BR', name: '巴西', currency: 'BRL', flag: '🇧🇷' },
  { code: 'KR', name: '韩国', currency: 'KRW', flag: '🇰🇷' },
  { code: 'RU', name: '俄罗斯', currency: 'RUB', flag: '🇷🇺' },
  { code: 'AR', name: '阿根廷', currency: 'ARS', flag: '🇦🇷' },
  { code: 'EG', name: '埃及', currency: 'EGP', flag: '🇪🇬' },
]

export const CURRENCIES = ['USD', 'CNY', 'EUR', 'GBP', 'JPY', 'CAD', 'MXN', 'AED', 'SAR', 'SGD', 'MYR', 'THB', 'BRL', 'AUD', 'KRW', 'RUB', 'ARS', 'EGP', 'INR']

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

/* ---------------- 竞品分析 ---------------- */

export const COMPETITOR_STATUS: Record<string, { label: string; tone: 'gray' | 'blue' | 'green' | 'red' | 'amber' }> = {
  tracking: { label: '跟踪中', tone: 'green' },
  paused: { label: '已暂停', tone: 'amber' },
  archived: { label: '已归档', tone: 'gray' },
}

/** 竞品相对我方售价的位置：决定列表里的预警颜色 */
export const PRICE_POSITION: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'gray' }> = {
  lower: { label: '低于我方', tone: 'red' },
  similar: { label: '价格接近', tone: 'amber' },
  higher: { label: '高于我方', tone: 'green' },
}

/* ---------------- 采购 ---------------- */

export const PO_STATUS: Record<string, { label: string; tone: 'gray' | 'blue' | 'green' | 'red' | 'amber' }> = {
  draft: { label: '草稿', tone: 'gray' },
  ordered: { label: '待到货', tone: 'blue' },
  partial: { label: '部分到货', tone: 'amber' },
  received: { label: '已入库', tone: 'green' },
  cancelled: { label: '已取消', tone: 'gray' },
}

export const SUPPLIER_STATUS: Record<string, { label: string; tone: 'gray' | 'blue' | 'green' | 'red' | 'amber' }> = {
  active: { label: '合作中', tone: 'green' },
  paused: { label: '已暂停', tone: 'amber' },
}

export const PAYMENT_TERMS = ['现结', '预付 30%', '30 天账期', '45 天账期', '60 天账期', '90 天账期']

export const PURCHASE_WAREHOUSES = ['国内仓', '深圳仓', '义乌仓', '宁波仓', 'US-3PL', 'UK-3PL', 'FBA-US', 'FBA-UK', 'FBA-DE']
