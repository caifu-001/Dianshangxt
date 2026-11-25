import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  Building2,
  ChevronDown,
  CheckSquare,
  Database,
  Factory,
  FlaskConical,
  Globe2,
  KeyRound,
  LayoutDashboard,
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  RotateCcw,
  ScrollText,
  LogOut,
  Megaphone,
  Menu,
  MonitorPlay,
  Network,
  Package,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store as StoreIcon,
  Telescope,
  Target,
  Truck,
  Wallet,
  UserCog,
  X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { fetchRows } from '../lib/db'
import { ROLE_META, type PermissionCode } from '../lib/permissions'
import { cn, initials } from '../lib/utils'
import { Badge } from './ui'

const NAV_GROUPS: Array<{
  title: string
  items: Array<{
    to: string
    label: string
    icon: typeof LayoutDashboard
    end?: boolean
    badge?: string
    /** 需要该权限码才显示；不填表示全员可见 */
    perm?: PermissionCode
    /** 满足任意一个权限码即显示（部门职能、管理权限等组合场景） */
    perms?: PermissionCode[]
    /** 仅平台超级管理员可见 */
    superOnly?: boolean
  }>
}> = [
  {
    title: '经营',
    items: [
      { to: '/', label: '运营概览', icon: LayoutDashboard, end: true },
      { to: '/cockpit', label: '数据驾驶舱', icon: MonitorPlay, perm: 'orders.view' },
      { to: '/stores', label: '店铺管理', icon: StoreIcon, perm: 'stores.view' },
      { to: '/products', label: '商品管理', icon: Package, perm: 'products.view' },
      { to: '/development', label: '产品开发', icon: FlaskConical, perm: 'dev.view' },
    ],
  },
  {
    title: '交易',
    items: [
      { to: '/orders', label: '订单管理', icon: ShoppingCart, perm: 'orders.view' },
      { to: '/inventory', label: '库存管理', icon: Boxes, perm: 'inventory.view' },
      { to: '/purchase', label: '采购管理', icon: Truck, perm: 'purchase.view' },
      { to: '/suppliers', label: '供应商库', icon: Factory, perm: 'purchase.view' },
      { to: '/profit', label: '利润核算', icon: BarChart3, perm: 'profit.view' },
      { to: '/expenses', label: '费用管理', icon: Wallet, perm: 'expense.view' },
    ],
  },
  {
    title: '增长',
    items: [
      { to: '/onsite-brand', label: '站内品牌营销', icon: Megaphone, perms: ['ads.view', 'creators.view'] },
      { to: '/competitors', label: '竞品分析', icon: Telescope, perm: 'competitors.view' },
      { to: '/brand', label: '站外品牌营销', icon: Globe2, perm: 'brand.view' },
    ],
  },
  {
    title: '协同',
    items: [
      { to: '/tasks', label: '任务看板', icon: CheckSquare, perm: 'tasks.view' },
    ],
  },
  {
    title: '组织',
    items: [
      { to: '/performance', label: '绩效管理', icon: Target },
      { to: '/org', label: '组织架构', icon: Network },
      { to: '/accounts', label: '人员与账号', icon: UserCog, perms: ['account.manage', 'hr.view'] },
      { to: '/access', label: '权限流程', icon: ShieldCheck },
    ],
  },
  {
    title: '平台',
    items: [
      { to: '/companies', label: '公司管理', icon: Building2, superOnly: true },
      { to: '/system-logs', label: '系统日志', icon: ScrollText, superOnly: true },
    ],
  },
]

/** 用户自定义导航顺序：分组标题序列 + 每个分组内的路由序列 */
interface NavOrder {
  groups: string[]
  items: Record<string, string[]>
}

function defaultNavOrder(): NavOrder {
  return {
    groups: NAV_GROUPS.map((g) => g.title),
    items: Object.fromEntries(NAV_GROUPS.map((g) => [g.title, g.items.map((i) => i.to)])),
  }
}

/** 按用户偏好排序；偏好里缺失的新增分组 / 条目自动补到末尾，兼容版本升级 */
function applyNavOrder(order: NavOrder | null): typeof NAV_GROUPS {
  const base = defaultNavOrder()
  const groups = order?.groups ?? []
  const orderedGroups = [
    ...groups.filter((t) => base.groups.includes(t)),
    ...base.groups.filter((t) => !groups.includes(t)),
  ]
  return orderedGroups.map((title) => {
    const src = NAV_GROUPS.find((g) => g.title === title)!
    const saved = order?.items?.[title] ?? []
    const items = [
      ...saved.filter((to) => src.items.some((i) => i.to === to)),
      ...src.items.filter((i) => !saved.includes(i.to)).map((i) => i.to),
    ].map((to) => src.items.find((i) => i.to === to)!)
    return { ...src, items }
  })
}

export default function AppLayout() {
  const { profile, user, signOut, schemaReady, role, isSuperAdmin, can, customRole, mustChangePassword, currentCompany, updateSettings } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [sorting, setSorting] = useState(false)
  const [sortSaving, setSortSaving] = useState(false)
  const [sortError, setSortError] = useState('')
  const [draftOrder, setDraftOrder] = useState<NavOrder | null>(null)
  const location = useLocation()

  const savedOrder = (profile?.settings as Record<string, unknown> | undefined)?.navOrder as NavOrder | null | undefined
  const navGroups = applyNavOrder(sorting ? draftOrder : savedOrder ?? null)

  useEffect(() => {
    setMobileOpen(false)
    setMenuOpen(false)
  }, [location.pathname])

  // 待审批的权限申请数：只拉 id 列，切换页面时刷新一次，管理员才需要
  useEffect(() => {
    if (!can('account.manage')) return
    let alive = true
    fetchRows<{ id: string }>('access_requests', { columns: 'id', filters: [['status', 'eq', 'pending']] })
      .then((rows) => {
        if (alive) setPendingApprovals(rows.length)
      })
      .catch(() => {
        // 旧库还没有 access_requests 表，忽略
      })
    return () => {
      alive = false
    }
  }, [can, location.pathname])

  const displayName = profile?.full_name || user?.email?.split('@')[0] || '运营同学'

  // 排序操作：只调整草稿快照，保存时才落库
  function startSorting() {
    setDraftOrder(sorting ? draftOrder : (savedOrder ?? defaultNavOrder()))
    setSorting(!sorting)
  }
  // 与相邻「可见」项交换：跳过当前账号无权限看到的条目，避免隐藏项造成错位
  function swapVisible<T>(full: T[], visibleSelf: T, dir: -1 | 1, isVisible: (v: T) => boolean): T[] {
    const i = full.indexOf(visibleSelf)
    if (i < 0) return full
    let j = i + dir
    while (j >= 0 && j < full.length && !isVisible(full[j])) j += dir
    if (j < 0 || j >= full.length) return full
    const next = [...full]
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  }
  function moveGroup(title: string, dir: -1 | 1) {
    const cur = draftOrder ?? defaultNavOrder()
    const visibleTitles = new Set(navGroups.map((g) => g.title))
    setDraftOrder({ ...cur, groups: swapVisible(cur.groups, title, dir, (t) => visibleTitles.has(t)) })
  }
  function moveItem(groupTitle: string, to: string, dir: -1 | 1) {
    const cur = draftOrder ?? defaultNavOrder()
    const src = NAV_GROUPS.find((g) => g.title === groupTitle)
    if (!src) return
    const visibleRoutes = new Set(
      src.items
        .filter((item) => {
          if (item.superOnly && !isSuperAdmin) return false
          if (item.perms && item.perms.length > 0) return item.perms.some((code) => can(code))
          return !item.perm || can(item.perm)
        })
        .map((i) => i.to),
    )
    const list = cur.items[groupTitle] ?? defaultNavOrder().items[groupTitle]
    setDraftOrder({ ...cur, items: { ...cur.items, [groupTitle]: swapVisible(list, to, dir, (t) => visibleRoutes.has(t)) } })
  }
  async function saveSorting() {
    setSortSaving(true)
    setSortError('')
    try {
      await updateSettings({ navOrder: draftOrder ?? defaultNavOrder() })
      setSorting(false)
      setDraftOrder(null)
    } catch (e) {
      setSortError(e instanceof Error ? e.message : '保存失败，请重试')
    } finally {
      setSortSaving(false)
    }
  }
  function resetSorting() {
    setDraftOrder(defaultNavOrder())
    setSortError('')
  }

  // 菜单按权限码收敛：自定义角色看不到的模块，入口也不出现
  const visibleGroups = navGroups.map((group) => ({
    ...group,
    items: group.items
      .filter((item) => {
        if (item.superOnly && !isSuperAdmin) return false
        if (item.perms && item.perms.length > 0) return item.perms.some((code) => can(code))
        return !item.perm || can(item.perm)
      })
      .map((item) =>
        item.to === '/access' && pendingApprovals > 0
          ? { ...item, badge: String(pendingApprovals) }
          : item,
      ),
  })).filter((group) => group.items.length > 0)

  const sidebar = (
    <div className="flex flex-col h-full">
      <div className="h-14 flex items-center gap-2.5 px-4 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shadow-sm shrink-0">
          <span className="text-white font-bold text-[13px] tracking-tight">DS</span>
        </div>
        <div className="leading-tight min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-ink-900 truncate">电商运营中台</p>
          <p className="text-[10px] text-ink-400 tracking-wide">AMAZON · TIKTOK SHOP</p>
        </div>
        <button
          onClick={startSorting}
          title={sorting ? '退出排序' : '调整导航排序'}
          className={cn(
            'shrink-0 p-1.5 rounded-lg transition-colors',
            sorting ? 'bg-brand-50 text-brand-600' : 'text-ink-400 hover:bg-ink-100 hover:text-ink-700',
          )}
        >
          <GripVertical className="w-4 h-4" />
        </button>
      </div>

      {sorting && (
        <div className="mx-2.5 mb-2 px-2 py-2 rounded-lg bg-brand-50/70 border border-brand-100">
          <div className="flex items-center gap-1.5">
            <p className="flex-1 text-[10.5px] leading-tight text-brand-700">用箭头调整顺序</p>
            <button onClick={resetSorting} title="恢复默认" className="p-1 rounded text-ink-500 hover:bg-white">
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={saveSorting}
              disabled={sortSaving}
              title="保存排序"
              className="p-1 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => { setSorting(false); setDraftOrder(null); setSortError('') }} title="取消" className="p-1 rounded text-ink-500 hover:bg-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {sortError && <p className="mt-1 text-[10.5px] text-rose-600">{sortError}</p>}
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-2.5 pb-4 pt-1">
        {visibleGroups.map((group, gi) => (
          <div key={group.title} className="mb-3">
            <div className="flex items-center gap-1 px-2.5 py-1.5">
              <p className="flex-1 text-[10px] font-semibold text-ink-400 tracking-widest">{group.title.toUpperCase()}</p>
              {sorting && (
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => moveGroup(group.title, -1)}
                    disabled={gi === 0}
                    title="上移分组"
                    className="p-0.5 rounded text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => moveGroup(group.title, 1)}
                    disabled={gi === visibleGroups.length - 1}
                    title="下移分组"
                    className="p-0.5 rounded text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item, ii) => (
                <div key={item.to} className="flex items-center gap-0.5">
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={(e) => { if (sorting) e.preventDefault() }}
                    className={({ isActive }) =>
                      cn(
                        'group flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-[13px] transition-colors min-w-0 flex-1',
                        isActive && !sorting
                          ? 'bg-brand-50 text-brand-700 font-medium'
                          : 'text-ink-600 hover:bg-ink-100/70 hover:text-ink-900',
                        sorting && 'bg-ink-50/60',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon className={cn('w-4 h-4 shrink-0', isActive && !sorting ? 'text-brand-600' : 'text-ink-400 group-hover:text-ink-600')} />
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.badge && (
                          <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-ink-900 text-white tracking-wide">
                            {item.badge}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                  {sorting && (
                    <div className="flex flex-col shrink-0">
                      <button
                        onClick={() => moveItem(group.title, item.to, -1)}
                        disabled={ii === 0}
                        title="上移"
                        className="p-0.5 rounded text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-30 disabled:cursor-not-allowed leading-none"
                      >
                        <ArrowUp className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => moveItem(group.title, item.to, 1)}
                        disabled={ii === group.items.length - 1}
                        title="下移"
                        className="p-0.5 rounded text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-30 disabled:cursor-not-allowed leading-none"
                      >
                        <ArrowDown className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-2.5 pb-3 shrink-0 space-y-0.5">
        {isSuperAdmin && (
          <NavLink
            to="/setup"
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-[13px] transition-colors',
                isActive ? 'bg-brand-50 text-brand-700 font-medium' : 'text-ink-600 hover:bg-ink-100/70 hover:text-ink-900',
              )
            }
          >
            <Database className="w-4 h-4 text-ink-400" />
            <span className="flex-1">数据源</span>
            <span className={cn('w-1.5 h-1.5 rounded-full', schemaReady ? 'bg-emerald-500' : 'bg-amber-500')} />
          </NavLink>
        )}
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-[13px] transition-colors',
              isActive ? 'bg-brand-50 text-brand-700 font-medium' : 'text-ink-600 hover:bg-ink-100/70 hover:text-ink-900',
            )
          }
        >
          <Settings className="w-4 h-4 text-ink-400" />
          <span className="flex-1">系统设置</span>
        </NavLink>
      </div>

      <div className="p-2.5 border-t border-ink-200/70 shrink-0">
        <div className="flex items-center gap-2.5 px-1.5 py-1.5">
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-ink-700 to-ink-900 text-white flex items-center justify-center text-[11px] font-semibold">
            {initials(displayName)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-medium text-ink-800 truncate">{displayName}</p>
              <span
                className={cn(
                  'shrink-0 rounded border px-1 py-px text-[9px] leading-[1.5]',
                  ROLE_META[role].badge,
                )}
              >
                {ROLE_META[role].short}
              </span>
            </div>
            <p className="text-[10px] text-ink-400 truncate">{user?.email}</p>
            {customRole && role !== 'super_admin' && (
              <p className="text-[10px] text-brand-600 truncate" title="岗位角色决定可见模块">
                {customRole.name}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen flex bg-ink-50">
      {/* 桌面侧边栏 */}
      <aside className="hidden lg:flex w-[214px] shrink-0 flex-col bg-white border-r border-ink-200/70 fixed inset-y-0 left-0 z-30">
        {sidebar}
      </aside>

      {/* 移动端抽屉 */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-ink-900/30" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[240px] bg-white border-r border-ink-200 animate-fade-up">
            <button
              className="absolute right-2 top-3 p-1.5 rounded-lg text-ink-400 hover:bg-ink-100 z-10"
              onClick={() => setMobileOpen(false)}
            >
              <X className="w-4 h-4" />
            </button>
            {sidebar}
          </div>
        </div>
      )}

      <div className="flex-1 lg:pl-[214px] min-w-0 flex flex-col">
        <header className="h-14 shrink-0 bg-white/85 backdrop-blur border-b border-ink-200/70 sticky top-0 z-20">
          <div className="h-full px-4 sm:px-6 flex items-center gap-3">
            <button className="lg:hidden p-1.5 -ml-1 rounded-lg text-ink-600 hover:bg-ink-100" onClick={() => setMobileOpen(true)}>
              <Menu className="w-5 h-5" />
            </button>

            {isSuperAdmin && (
              <div className="flex items-center gap-2 text-[11px] text-ink-400">
                <span className={cn('w-1.5 h-1.5 rounded-full', schemaReady ? 'bg-emerald-500' : 'bg-amber-500')} />
                <span className="hidden sm:inline">{schemaReady ? 'Supabase 数据已连接' : '数据库待初始化'}</span>
              </div>
            )}

            <div className="ml-auto flex items-center gap-2">
              {currentCompany && (
                <div
                  className="hidden sm:flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-ink-50 border border-ink-200/70"
                  title={`所属公司：${currentCompany.name}${currentCompany.code ? `（${currentCompany.code}）` : ''}`}
                >
                  <Building2 className="w-3.5 h-3.5 text-brand-600 shrink-0" />
                  <span className="text-xs font-medium text-ink-700 max-w-[130px] truncate">{currentCompany.name}</span>
                  {isSuperAdmin && <span className="text-[10px] text-ink-400 shrink-0">视角</span>}
                </div>
              )}
              <Badge tone="gray" className="hidden md:inline-flex">
                专业版 · 内部使用
              </Badge>
              <div className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className="flex items-center gap-1.5 h-8 pl-1 pr-2 rounded-lg hover:bg-ink-100 transition-colors"
                >
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white flex items-center justify-center text-[10px] font-semibold">
                    {initials(displayName)}
                  </div>
                  <span className="text-xs font-medium text-ink-700 max-w-[90px] truncate hidden sm:block">{displayName}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-ink-400" />
                </button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1.5 w-60 bg-white border border-ink-200 rounded-xl shadow-pop py-1 z-20 animate-scale-in">
                      <div className="px-3 py-2 border-b border-ink-100">
                        <p className="text-xs font-medium text-ink-800 truncate">{displayName}</p>
                        <p className="text-[11px] text-ink-400 truncate">{user?.email}</p>
                        {currentCompany && (
                          <p
                            className="mt-1.5 flex items-center gap-1 text-[11px] text-ink-500"
                            title={`所属公司：${currentCompany.name}`}
                          >
                            <Building2 className="w-3 h-3 shrink-0 text-ink-400" />
                            <span className="truncate">{currentCompany.name}</span>
                            {isSuperAdmin && <span className="text-ink-400 shrink-0">· 管理视角</span>}
                          </p>
                        )}
                      </div>
                      <Link to="/settings" className="flex items-center gap-2 px-3 py-2 text-[13px] text-ink-600 hover:bg-ink-50">
                        <Settings className="w-3.5 h-3.5" />
                        账号设置
                      </Link>
                      <button
                        onClick={() => signOut()}
                        className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-rose-600 hover:bg-rose-50"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        退出登录
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* 旧版数据库缺少组织架构字段时，权限体系不完整；仅提示超管去处理 */}
        {isSuperAdmin && profile && !('role_id' in profile) && (
          <div className="px-4 sm:px-6 pt-4">
            <div className="rounded-xl border border-amber-200/80 bg-amber-50 px-3.5 py-2.5 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
              <p className="text-[11.5px] leading-relaxed text-amber-800">
                数据库还没升级到组织架构版本，部门 / 岗位 / 自定义角色暂不可用（当前按系统角色默认权限运行）。
                请到 <Link to="/setup" className="underline font-medium">数据源</Link> 页复制最新脚本，
                在 SQL Editor 重新执行一次即可启用。
              </p>
            </div>
          </div>
        )}

        {/* 管理员代建账号发出的一次性初始密码，登录后提醒本人尽快改掉 */}
        {mustChangePassword && (
          <div className="px-4 sm:px-6 pt-4">
            <div className="rounded-xl border border-amber-200/80 bg-amber-50 px-3.5 py-2.5 flex items-start gap-2">
              <KeyRound className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
              <p className="text-[11.5px] leading-relaxed text-amber-800">
                你正在使用管理员下发的初始密码。为了账号安全，请先到
                <Link to="/settings" className="mx-1 underline font-medium">
                  系统设置 → 修改密码
                </Link>
                改成只有自己知道的密码，改完这条提示会自动消失。
              </p>
            </div>
          </div>
        )}

        <main className="flex-1 px-4 sm:px-6 py-5 min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
