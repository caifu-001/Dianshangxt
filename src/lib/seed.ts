import { fetchRows, insertRow, insertRows, updateRow } from './db'
import { supabase } from './supabase'
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
  // 演示单据挂到当前账号，绩效与利润归属才能算出东西
  const me = (await supabase.auth.getUser()).data.user
  const ownerId = me?.id ?? null

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
        owner_id: ownerId,
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
    { store_id: stores[2].id, title: 'Silk Pillowcase 补货 500 件', module: 'inventory', priority: 'high', status: 'todo', due_date: daysAgo(-3), assignee: '供应链', owner_id: ownerId },
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

  // 9. 竞品分析：同站点竞品 + 近 48 天的价格 / 评论快照（表不存在时整体跳过）
  try {
    const competitorSeed = [
      {
        product: 0,
        brand: 'Nordic Home',
        asin: 'B0C9TR4Y21',
        title: 'Bamboo Serving Tray Set with Handles, Extra Large (Set of 2)',
        delta: 1.06,
        rating: 4.6,
        reviews: 3120,
        bsr: 860,
        monthly: 2400,
        seller: 'Nordic Home LLC',
      },
      {
        product: 2,
        brand: 'Stone & Clay',
        asin: 'B0D2MU7K83',
        title: 'Speckled Stoneware Mug Set of 4, Handmade Glaze',
        delta: 0.92,
        rating: 4.7,
        reviews: 5480,
        bsr: 410,
        monthly: 3600,
        seller: 'Stone & Clay Studio',
      },
      {
        product: 4,
        brand: 'WoodCraft Co.',
        asin: 'B0D5AC9P17',
        title: 'Acacia Wood Cutting Board, Large with Deep Juice Groove',
        delta: 1.14,
        rating: 4.4,
        reviews: 1860,
        bsr: 1420,
        monthly: 1500,
        seller: 'WoodCraft Co.',
      },
      {
        product: 5,
        brand: 'PureGlow',
        asin: 'B0D8VC2S65',
        title: 'Vitamin C Serum 30ml with Hyaluronic Acid, Fragrance Free',
        delta: 0.95,
        rating: 4.5,
        reviews: 7240,
        bsr: 320,
        monthly: 4200,
        seller: 'PureGlow Beauty',
      },
      {
        product: 7,
        brand: 'JadeLux',
        asin: 'B0E1JR8L30',
        title: 'Jade Roller & Gua Sha Facial Set with Travel Pouch',
        delta: 1.1,
        rating: 4.3,
        reviews: 980,
        bsr: 2650,
        monthly: 900,
        seller: 'JadeLux Official',
      },
      {
        product: 8,
        brand: 'SilkCloud',
        asin: 'GL-SLK-22M-A',
        title: '22 Momme Silk Pillowcase, Hidden Zipper, Gift Box',
        delta: 0.9,
        rating: 4.8,
        reviews: 4630,
        bsr: 190,
        monthly: 5200,
        seller: 'SilkCloud',
      },
    ]

    const competitorRows = await insertRows<{ id: string }>(
      'competitors',
      competitorSeed.map((c) => {
        const product = PRODUCTS[c.product]
        const store = STORES[product.store]
        return {
          store_id: stores[product.store].id,
          product_id: products[c.product].id,
          platform: store.platform,
          marketplace: store.marketplace,
          asin: c.asin,
          title: c.title,
          brand: c.brand,
          currency: store.currency,
          price: round2(product.price * c.delta),
          list_price: round2(product.price * c.delta * 1.25),
          coupon: c.delta < 1 ? 'Coupon 10%' : null,
          rating: c.rating,
          reviews: c.reviews,
          bsr: c.bsr,
          est_monthly_sales: c.monthly,
          seller: c.seller,
          category: product.category,
          status: 'tracking',
          last_checked: daysAgo(randInt(0, 2)),
        }
      }),
    )

    const snapshots: Array<Record<string, unknown>> = []
    competitorSeed.forEach((c, idx) => {
      const current = round2(PRODUCTS[c.product].price * c.delta)
      const points = 17
      for (let k = 0; k < points; k++) {
        const t = k / (points - 1)
        const isLast = k === points - 1
        snapshots.push({
          competitor_id: competitorRows[idx].id,
          snapshot_date: daysAgo(Math.round(48 * (1 - t))),
          price: isLast ? current : round2(current * (1 + 0.14 * (1 - t)) + rand(-0.35, 0.35)),
          rating: isLast ? c.rating : round2(Math.max(3.6, c.rating - (1 - t) * 0.3)),
          reviews: isLast ? c.reviews : Math.max(0, Math.round(c.reviews - (1 - t) * rand(60, 240))),
          bsr: Math.round(c.bsr * (1 + (1 - t) * 0.4)),
          est_monthly_sales: Math.round(c.monthly * (0.85 + t * 0.15)),
        })
      }
    })
    for (let i = 0; i < snapshots.length; i += 200) {
      await insertRows('competitor_snapshots', snapshots.slice(i, i + 200))
    }
  } catch {
    // 竞品表还没建（旧库未升级）：跳过这段演示数据
  }

  // 9.5 站外品牌营销：社媒账号 / 站外红人 / 公关 / 曝光搜索量
  try {
    await insertRows('brand_social_accounts', [
      { platform: 'YouTube', account_name: 'HomyLife Official', account_url: 'https://youtube.com/@homylife', followers: 128000, posts_count: 86, status: 'active', note: '开箱与场景化短视频' },
      { platform: 'Instagram', account_name: 'homylife_home', account_url: 'https://instagram.com/homylife_home', followers: 64200, posts_count: 214, status: 'active', note: '家居搭配图集' },
      { platform: 'TikTok', account_name: 'homylife.us', account_url: 'https://tiktok.com/@homylife.us', followers: 93500, posts_count: 152, status: 'active' },
      { platform: 'Pinterest', account_name: 'HomyLife Board', account_url: 'https://pinterest.com/homylife', followers: 18700, posts_count: 310, status: 'paused', note: '暂停更新，保留外链' },
    ])
    await insertRows('brand_influencers', [
      { name: 'Emily Home', platform: 'YouTube', handle: '@emilyhome', followers: 320000, niche: '家居收纳', country: 'US', contact_email: 'emily@example.com', price_cny: 18000, status: 'active', last_collab_at: daysAgo(12), note: '已寄样 2 款' },
      { name: 'Sofia Lives', platform: 'Instagram', handle: '@sofialives', followers: 168000, niche: '软装搭配', country: 'US', contact_wechat: 'sofia_lives', price_cny: 9500, status: 'negotiating', note: '报价待确认' },
      { name: 'Mike Unboxes', platform: 'TikTok', handle: '@mikeunboxes', followers: 89000, niche: '开箱测评', country: 'UK', contact_email: 'mike@example.com', price_cny: 6200, status: 'done', last_collab_at: daysAgo(36) },
      { name: '田园小美', platform: 'TikTok', handle: '@tianyuanxm', followers: 54000, niche: '厨房好物', country: 'CN', contact_wechat: 'tianyuan_xm', price_cny: 3800, status: 'contacting' },
    ])
    await insertRows('brand_pr_contacts', [
      { media_name: 'Home Living Weekly', channel_type: 'media', contact_name: 'Anna Lee', contact_email: 'anna@homeliving.example', coverage_count: 3, last_coverage_at: daysAgo(20), status: 'active', note: '季度家居专题' },
      { media_name: 'The Pretty House Blog', channel_type: 'blog', contact_name: 'Claire', contact_email: 'claire@prettyhouse.example', coverage_count: 5, last_coverage_at: daysAgo(8), status: 'active' },
      { media_name: 'Reddit r/HomeDecor', channel_type: 'forum', contact_name: '社区运营', coverage_count: 2, last_coverage_at: daysAgo(31), status: 'paused', note: '仅做自然互动，不投硬广' },
    ])
    const metricRows = []
    for (let i = 13; i >= 0; i--) {
      const wave = 1 + 0.18 * Math.sin(i / 2.2)
      metricRows.push({
        metric_date: daysAgo(i),
        channel: 'overall',
        impressions: Math.round(18500 * wave + i * 120),
        search_volume: Math.round(3200 * wave + i * 26),
        site_visits: Math.round(960 * wave + i * 9),
        backlinks: 2 + (i % 3),
        note: '自动演示数据',
      })
    }
    await insertRows('brand_metrics', metricRows)
  } catch {
    // 旧库还没有品牌营销四张表：跳过演示数据
  }

  // 10. 采购：4 家供应商 + 5 张采购单（含部分到货 / 逾期未到各一张）
  try {
    const supplierRows = await insertRows<{ id: string }>(
      'suppliers',
      [
        { name: '东莞恒美家居制品厂', contact: '王建国', phone: '138-2688-4471', email: 'sales@hengmeihome.cn', address: '广东东莞厚街镇家具大道 88 号', category: '竹木餐厨 / 家居', payment_terms: '30 天账期', lead_time_days: 25, rating: 5 },
        { name: '义乌市雅陶瓷业有限公司', contact: '陈雅', phone: '139-5799-2210', email: 'chenya@yiyao-ceramic.com', address: '浙江义乌北苑工业区', category: '陶瓷餐具', payment_terms: '预付 30%', lead_time_days: 32, rating: 4 },
        { name: '广州妆源生物科技', contact: '林曦', phone: '136-0208-9931', email: 'lily@zhuangyuan-bio.cn', address: '广州白云区太和镇', category: '护肤 / 美妆', payment_terms: '45 天账期', lead_time_days: 38, rating: 4 },
        { name: '杭州丝语丝绸', contact: '周敏', phone: '137-5812-6677', email: 'zhoumin@siyu-silk.cn', address: '浙江杭州余杭区', category: '真丝家纺', payment_terms: '现结', lead_time_days: 20, rating: 5 },
      ].map((s) => ({ ...s, status: 'active' })),
    )

    // 供应商联系人：一家供应商多位联系人（业务 / 跟单 / 工厂），演示多联系人档案
    try {
      const contactSeed: Array<
        Array<{ name: string; title: string; phone: string; email: string; im?: string; note?: string }>
      > = [
        [
          { name: '王建国', title: '销售经理', phone: '138-2688-4471', email: 'sales@hengmeihome.cn', im: 'wx_wangjg', note: '报价与样品只找他' },
          { name: '李丽', title: '业务跟单', phone: '139-2299-1038', email: 'lily@hengmeihome.cn', im: 'lili_hm' },
          { name: '陈厂长', title: '工厂排期', phone: '0769-8599-2233', email: 'factory@hengmeihome.cn', note: '只对接大货交期' },
        ],
        [
          { name: '陈雅', title: '外贸经理', phone: '139-5799-2210', email: 'chenya@yiyao-ceramic.com', im: 'chenya_wx' },
          { name: '吴婷', title: '客服跟单', phone: '0579-8551-7788', email: 'service@yiyao-ceramic.com' },
        ],
        [
          { name: '林曦', title: '大客户销售', phone: '136-0208-9931', email: 'lily@zhuangyuan-bio.cn', im: 'linxi_wx' },
          { name: '赵工', title: '品质负责人', phone: '020-3705-6688', email: 'qa@zhuangyuan-bio.cn', note: '客诉与质检报告找他' },
        ],
        [
          { name: '周敏', title: '销售主管', phone: '137-5812-6677', email: 'zhoumin@siyu-silk.cn' },
          { name: '许晴', title: '打样专员', phone: '0571-8876-2210', email: 'sample@siyu-silk.cn', im: 'xuqing_sample' },
        ],
      ]
      const contactRows = contactSeed.flatMap((list, supplierIndex) =>
        list.map((c, i) => ({
          supplier_id: supplierRows[supplierIndex].id,
          name: c.name,
          title: c.title,
          phone: c.phone,
          email: c.email,
          im: c.im ?? null,
          note: c.note ?? null,
          is_primary: i === 0,
        })),
      )
      await insertRows('supplier_contacts', contactRows)
    } catch {
      // 旧库还没有联系人表：主表里的单一联系人快照仍然可用
    }

    // 供应商可供产品 / 报价：与采购单里的品类对应，供缺货补货自动带价
    const spSeed: Array<{ supplier: number; product: number; cost: number; lead: number; tags: string[] }> = [
      { supplier: 0, product: 0, cost: 45.5, lead: 25, tags: ['快速打样'] },
      { supplier: 0, product: 4, cost: 54.0, lead: 28, tags: ['实木'] },
      { supplier: 0, product: 1, cost: 34.2, lead: 22, tags: ['小批量'] },
      { supplier: 1, product: 2, cost: 65.4, lead: 32, tags: ['手工釉面'] },
      { supplier: 1, product: 3, cost: 22.0, lead: 30, tags: [] },
      { supplier: 2, product: 5, cost: 37.0, lead: 38, tags: ['OEM'] },
      { supplier: 2, product: 6, cost: 43.5, lead: 40, tags: [] },
      { supplier: 3, product: 8, cost: 63.0, lead: 20, tags: ['22姆米', '外贸原单'] },
    ]
    const supplierProducts = spSeed.map((x) => {
      const product = PRODUCTS[x.product]
      return {
        supplier_id: supplierRows[x.supplier].id,
        product_id: products[x.product].id,
        sku: product.sku,
        title: product.title,
        unit: '件',
        currency: 'CNY',
        unit_cost: x.cost,
        moq: 100,
        lead_time_days: x.lead,
        status: 'active',
        note: x.tags.join(' / ') || null,
      }
    })
    try {
      await insertRows('supplier_products', supplierProducts)
    } catch {
      // 供应商库表还没建（旧库未升级）：跳过报价演示数据
    }

    const poSeed: Array<{
      supplier: number
      daysBack: number
      status: 'ordered' | 'partial' | 'received'
      warehouse: string
      shipping: number
      items: Array<{ p: number; qty: number }>
    }> = [
      { supplier: 0, daysBack: 52, status: 'received', warehouse: '深圳仓', shipping: 4800, items: [{ p: 0, qty: 800 }, { p: 1, qty: 600 }, { p: 4, qty: 400 }] },
      { supplier: 1, daysBack: 38, status: 'received', warehouse: '国内仓', shipping: 2600, items: [{ p: 2, qty: 500 }, { p: 3, qty: 900 }] },
      { supplier: 2, daysBack: 24, status: 'partial', warehouse: '国内仓', shipping: 1800, items: [{ p: 5, qty: 1200 }, { p: 6, qty: 800 }] },
      { supplier: 3, daysBack: 45, status: 'ordered', warehouse: '宁波仓', shipping: 3200, items: [{ p: 8, qty: 1500 }] },
      { supplier: 0, daysBack: 5, status: 'ordered', warehouse: '深圳仓', shipping: 1500, items: [{ p: 0, qty: 600 }, { p: 9, qty: 2000 }] },
    ]

    const purchaseItems: Array<Record<string, unknown>> = []
    for (let i = 0; i < poSeed.length; i++) {
      const seed = poSeed[i]
      const orderDate = daysAgo(seed.daysBack)
      const storeIndex = PRODUCTS[seed.items[0].p].store
      const po = await insertRow<{ id: string }>('purchase_orders', {
        buyer_id: ownerId,
        po_no: `PO-${orderDate.replace(/-/g, '').slice(2)}-0${i + 1}`,
        supplier_id: supplierRows[seed.supplier].id,
        store_id: stores[storeIndex].id,
        warehouse: seed.warehouse,
        order_date: orderDate,
        expected_date: daysAgo(seed.daysBack - (STORES[storeIndex].platform === 'amazon' ? 35 : 20)),
        currency: 'CNY',
        status: seed.status,
        shipping_fee: seed.shipping,
        other_fee: 0,
        note: seed.status === 'partial' ? '首批先到 60%，剩余随下一柜' : null,
      })

      for (const line of seed.items) {
        const product = PRODUCTS[line.p]
        const received =
          seed.status === 'received' ? line.qty : seed.status === 'partial' ? Math.round(line.qty * 0.6) : 0
        purchaseItems.push({
          po_id: po.id,
          product_id: products[line.p].id,
          sku: product.sku,
          title: product.title,
          quantity: line.qty,
          unit_price: round2(product.cost * 7.1),
          received_qty: received,
        })
      }
    }
    await insertRows('purchase_items', purchaseItems)
  } catch {
    // 采购表还没建：跳过
  }

  // 11. 组织架构（演示用）：把当前账号归到一个部门 / 岗位 / 角色上，
  //    这样「组织架构」页不会是空的。表不存在（旧库未升级）时整体跳过。
  try {
    const { data: authData } = await supabase.auth.getUser()
    const uid = authData.user?.id
    if (!uid) return

    const [depts, posList, roleList] = await Promise.all([
      fetchRows<{ id: string; name: string }>('departments', { order: { column: 'sort_order' } }),
      fetchRows<{ id: string; name: string }>('positions', { order: { column: 'sort_order' } }),
      fetchRows<{ id: string; name: string }>('roles', { order: { column: 'sort_order' } }),
    ])
    if (!depts.length || !posList.length) return

    const dept = depts.find((d) => d.name === '运营部') ?? depts[0]
    const pos = posList.find((p) => p.name === '高级运营') ?? posList[0]
    const role = roleList.find((r) => r.name === '运营专员') ?? null

    await updateRow('profiles', uid, {
      department_id: dept.id,
      position_id: pos.id,
      role_id: role?.id ?? null,
    })

    // 人事字段单独写：旧库还没有这几列时只跳过这一句，不影响上面的组织归属
    try {
      await updateRow('profiles', uid, {
        hire_date: daysAgo(560),
        employment_status: 'active',
      })
    } catch {
      // 旧库没有 employment_status / hire_date 列
    }
  } catch {
    // 组织架构表还没建：忽略，不影响业务数据的生成
  }
}
