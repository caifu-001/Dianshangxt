import { insertRows } from './db'
import { daysAgo } from './utils'
import type { Platform } from './types'

const rand = (min: number, max: number) => Math.random() * (max - min) + min
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1))
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const round2 = (n: number) => Math.round(n * 100) / 100

interface SeedProduct {
  sku: string
  asin: string
  title: string
  category: string
  cost: number
  price: number
  store: number
}

const STORES = [
  { name: 'Aurora Home · US', platform: 'amazon' as Platform, marketplace: 'US', currency: 'USD', seller_id: 'A2X9HOME01', target_acos: 28, note: '家居类目主力店铺，FBA 发货' },
  { name: 'Lumière Beauty · UK', platform: 'amazon' as Platform, marketplace: 'UK', currency: 'GBP', seller_id: 'B1LUMEU02', target_acos: 32, note: '英国站美妆，含 VAT' },
  { name: 'GlowLab Official', platform: 'tiktok' as Platform, marketplace: 'US', currency: 'USD', seller_id: 'GLOWLAB-US', target_acos: 22, note: 'TikTok 小店，达人带货为主' },
]

const PRODUCTS: SeedProduct[] = [
  { sku: 'AH-BAMBOO-TRAY', asin: 'B0C7K2M1QA', title: 'Bamboo Serving Tray Set with Handles (Set of 2)', category: 'Home & Kitchen', cost: 6.4, price: 27.99, store: 0 },
  { sku: 'AH-LINEN-RUNNER', asin: 'B0C8N4T7RB', title: 'Linen Table Runner 72 inch, Washable Farmhouse Decor', category: 'Home & Kitchen', cost: 4.8, price: 21.5, store: 0 },
  { sku: 'AH-CERAMIC-MUG4', asin: 'B0C9P1V3SC', title: 'Handmade Ceramic Mug Set of 4, Speckled Stoneware', category: 'Kitchen & Dining', cost: 9.2, price: 38.9, store: 0 },
  { sku: 'AH-TEALIGHT-H', asin: 'B0C2Q8W5TD', title: 'Ceramic Tealight Candle Holder, Minimalist Home Decor', category: 'Home Décor', cost: 3.1, price: 16.99, store: 0 },
  { sku: 'AH-CUTTING-BD', asin: 'B0C5R9X6UE', title: 'Acacia Wood Cutting Board with Juice Groove', category: 'Kitchen & Dining', cost: 7.6, price: 32.0, store: 0 },
  { sku: 'LB-VITC-SERUM', asin: 'B0D1S2Y7VF', title: 'Vitamin C Brightening Serum 30ml, Fragrance Free', category: 'Beauty', cost: 5.2, price: 24.99, store: 1 },
  { sku: 'LB-HYDRA-CREAM', asin: 'B0D3T4Z8WG', title: 'Hyaluronic Acid Hydrating Face Cream 50ml', category: 'Beauty', cost: 6.1, price: 29.5, store: 1 },
  { sku: 'LB-JADE-ROLLER', asin: 'B0D6U5A9XH', title: 'Jade Facial Roller & Gua Sha Set, Gift Box', category: 'Beauty Tools', cost: 2.9, price: 18.99, store: 1 },
  { sku: 'GL-SILK-PILLOW', asin: 'GL-SLK-22M', title: '22 Momme Mulberry Silk Pillowcase, Standard Size', category: 'Bedding', cost: 8.9, price: 34.9, store: 2 },
  { sku: 'GL-HEATLESS-CURL', asin: 'GL-HL-CURL', title: 'Heatless Curl Headband Set, Overnight Hair Curler', category: 'Hair Tools', cost: 1.8, price: 12.99, store: 2 },
  { sku: 'GL-LED-MIRROR', asin: 'GL-LED-MIR', title: 'Portable LED Vanity Mirror with 3 Light Modes', category: 'Beauty Tools', cost: 7.4, price: 29.9, store: 2 },
]

export async function seedDemoData() {
  // 1. 店铺
  const stores = await insertRows<{ id: string; platform: string; currency: string }>(
    'stores',
    STORES.map((s) => ({ ...s, status: 'active' })),
  )

  // 2. 商品
  const products = await insertRows<{ id: string; sku: string; title: string; cost_price: number; sale_price: number }>(
    'products',
    PRODUCTS.map((p) => ({
      store_id: stores[p.store].id,
      sku: p.sku,
      asin: p.asin,
      title: p.title,
      category: p.category,
      cost_price: p.cost,
      sale_price: p.price,
      currency: STORES[p.store].currency,
      status: 'active',
      tags: [p.category],
    })),
  )

  // 3. 订单（近 60 天）
  const orders: Array<Record<string, unknown>> = []
  let seq = 1000
  for (let d = 59; d >= 0; d--) {
    const date = daysAgo(d)
    const weekday = new Date(date).getDay()
    const weekendBoost = weekday === 0 || weekday === 6 ? 1.35 : 1
    const growth = 1 + ((59 - d) / 59) * 0.45
    const count = Math.max(1, Math.round(randInt(5, 10) * weekendBoost * growth))

    for (let i = 0; i < count; i++) {
      const idx = randInt(0, PRODUCTS.length - 1)
      const p = PRODUCTS[idx]
      const product = products[idx]
      const store = stores[p.store]
      const qty = Math.random() > 0.82 ? randInt(2, 3) : 1
      const unit = round2(p.price * rand(0.92, 1.02))
      const gross = unit * qty
      const isAmazon = STORES[p.store].platform === 'amazon'
      const refunded = Math.random() < 0.035
      seq += 1

      orders.push({
        store_id: store.id,
        product_id: product.id,
        order_no: `${isAmazon ? 'AMZ' : 'TTS'}-${date.replace(/-/g, '')}-${seq}`,
        order_date: date,
        channel: isAmazon ? 'amazon' : 'tiktok',
        sku: p.sku,
        title: p.title,
        customer_name: pick(['Emily R.', 'James T.', 'Sofia M.', 'Liam K.', 'Olivia P.', 'Noah B.', 'Ava L.', 'Mason D.']),
        country: STORES[p.store].marketplace,
        quantity: qty,
        unit_price: unit,
        cost_amount: round2(p.cost * qty),
        platform_fee: round2(gross * (isAmazon ? 0.15 : 0.08)),
        fba_fee: round2(qty * (isAmazon ? rand(3.1, 4.6) : rand(2.2, 3.4))),
        shipping_fee: round2(qty * rand(0.9, 1.8)),
        ad_cost: round2(gross * rand(0.05, 0.10)),
        refund_amount: refunded ? gross : 0,
        other_fee: round2(rand(0, 0.8)),
        status: refunded ? 'refunded' : d < 6 ? pick(['pending', 'shipped']) : 'delivered',
      })
    }
  }

  // 分批写入，避免单次请求过大
  for (let i = 0; i < orders.length; i += 200) {
    await insertRows('orders', orders.slice(i, i + 200))
  }

  // 4. 库存
  await insertRows(
    'inventory',
    products.map((product, i) => {
      const p = PRODUCTS[i]
      const isAmazon = STORES[p.store].platform === 'amazon'
      const daily = round2(rand(0.6, 3.2))
      return {
        store_id: stores[p.store].id,
        product_id: product.id,
        sku: p.sku,
        title: p.title,
        warehouse: isAmazon ? `FBA-${STORES[p.store].marketplace}` : 'US-3PL',
        available_qty: randInt(0, 420),
        inbound_qty: Math.random() > 0.6 ? randInt(100, 600) : 0,
        reserved_qty: randInt(0, 20),
        safety_stock: randInt(60, 180),
        avg_daily_sales: daily,
      }
    }),
  )

  // 5. 广告
  const campaignSeed = [
    { store: 0, name: 'AH · SP 自动-广泛匹配', type: 'SP', budget: 60 },
    { store: 0, name: 'AH · SP 手动-核心词 tray', type: 'SP', budget: 45 },
    { store: 0, name: 'AH · SB 品牌旗舰', type: 'SB', budget: 35 },
    { store: 1, name: 'LB · SP 自动-美妆', type: 'SP', budget: 40 },
    { store: 1, name: 'LB · SD 再营销', type: 'SD', budget: 25 },
    { store: 2, name: 'GL · GMV Max 全域', type: 'GMV_MAX', budget: 120 },
    { store: 2, name: 'GL · Video 短视频带货', type: 'VIDEO', budget: 80 },
  ]
  await insertRows(
    'campaigns',
    campaignSeed.map((c) => {
      const spend = round2(c.budget * rand(18, 26))
      const sales = round2(spend * rand(2.6, 6.2))
      const clicks = randInt(600, 2600)
      return {
        store_id: stores[c.store].id,
        name: c.name,
        platform: STORES[c.store].platform,
        ad_type: c.type,
        status: Math.random() > 0.82 ? 'paused' : 'active',
        daily_budget: c.budget,
        spend,
        impressions: clicks * randInt(28, 60),
        clicks,
        orders_count: randInt(18, 120),
        sales,
        start_date: daysAgo(randInt(40, 70)),
      }
    }),
  )

  // 6. TikTok 达人
  const creatorSeed = [
    { handle: '@glowwithjess', name: 'Jess Lin', followers: 284000, cat: 'Beauty', status: 'cooperating', commission: 20 },
    { handle: '@skincarebymia', name: 'Mia Wong', followers: 96000, cat: 'Skincare', status: 'cooperating', commission: 18 },
    { handle: '@homedecorali', name: 'Ali Carter', followers: 412000, cat: 'Home', status: 'sampling', commission: 15 },
    { handle: '@thebeautybear', name: 'Bear Nguyen', followers: 58000, cat: 'Beauty', status: 'contacted', commission: 20 },
    { handle: '@softlife.studio', name: 'Nora Bell', followers: 133000, cat: 'Lifestyle', status: 'cooperating', commission: 22 },
    { handle: '@curlygirlrae', name: 'Rae Adams', followers: 76000, cat: 'Hair', status: 'sampling', commission: 18 },
    { handle: '@morningroutineco', name: 'Dana Cole', followers: 22000, cat: 'Skincare', status: 'pending', commission: 25 },
    { handle: '@luxeonthebudge', name: 'Ivy Park', followers: 305000, cat: 'Lifestyle', status: 'contacted', commission: 20 },
  ]
  await insertRows(
    'creators',
    creatorSeed.map((c) => ({
      store_id: stores[2].id,
      handle: c.handle,
      name: c.name,
      region: 'US',
      category: c.cat,
      followers: c.followers,
      email: `${c.handle.replace('@', '')}@creator.com`,
      commission_rate: c.commission,
      status: c.status,
      gmv: c.status === 'cooperating' ? round2(rand(4200, 38000)) : 0,
      video_count: c.status === 'cooperating' ? randInt(2, 18) : 0,
      last_contact: daysAgo(randInt(1, 20)),
      note: c.status === 'pending' ? '来自 Creator Marketplace 邀约' : null,
    })),
  )

  // 7. 任务
  await insertRows('tasks', [
    { store_id: stores[0].id, title: 'AH-BAMBOO-TRAY 主图 A/B 测试', module: 'listing', priority: 'high', status: 'doing', due_date: daysAgo(-2), assignee: '视觉组' },
    { store_id: stores[0].id, title: '补充 cutting board 五点描述卖点', module: 'listing', priority: 'medium', status: 'todo', due_date: daysAgo(-4), assignee: '文案组' },
    { store_id: stores[2].id, title: '@homedecorali 寄样跟进', module: 'content', priority: 'high', status: 'doing', due_date: daysAgo(-1), assignee: '达人组' },
    { store_id: stores[1].id, title: '英国站 VAT 季度申报资料整理', module: 'finance', priority: 'high', status: 'todo', due_date: daysAgo(-6), assignee: '财务' },
    { store_id: stores[2].id, title: 'Silk Pillowcase 补货 500 件', module: 'inventory', priority: 'high', status: 'todo', due_date: daysAgo(-3), assignee: '供应链' },
    { store_id: stores[0].id, title: 'SP 自动广告否定词清理', module: 'ads', priority: 'medium', status: 'done', due_date: daysAgo(1), assignee: '广告组' },
    { store_id: stores[1].id, title: '处理 3 条 1 星差评', module: 'customer', priority: 'high', status: 'todo', due_date: daysAgo(0), assignee: '客服' },
    { store_id: null, title: 'Q4 旺季备货计划评审', module: 'other', priority: 'medium', status: 'todo', due_date: daysAgo(-8), assignee: '运营负责人' },
  ])

  // 8. 费用
  await insertRows('expenses', [
    { store_id: stores[0].id, category: 'shipping', amount: 6800, currency: 'CNY', expense_date: daysAgo(28), remark: '海运头程拼柜费' },
    { store_id: stores[0].id, category: 'warehouse', amount: 320, currency: 'USD', expense_date: daysAgo(14), remark: 'FBA 月度仓储费' },
    { store_id: stores[1].id, category: 'tax', amount: 560, currency: 'GBP', expense_date: daysAgo(20), remark: 'VAT 季度申报' },
    { store_id: stores[2].id, category: 'influencer', amount: 420, currency: 'USD', expense_date: daysAgo(9), remark: '达人佣金结算' },
    { store_id: null, category: 'software', amount: 1299, currency: 'CNY', expense_date: daysAgo(5), remark: 'ERP + 选品工具年费' },
    { store_id: stores[2].id, category: 'sample', amount: 86, currency: 'USD', expense_date: daysAgo(3), remark: '寄样快递费' },
  ])
}
