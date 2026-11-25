import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  ChevronDown,
  CheckSquare,
  Database,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Network,
  Package,
  Settings,
  ShoppingCart,
  Store as StoreIcon,
  Telescope,
  Truck,
  UserCog,
  Users,
  X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
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
  }>
}> = [
  {
    title: '经营',
    items: [
      { to: '/', label: '运营概览', icon: LayoutDashboard, end: true },
      { to: '/stores', label: '店铺管理', icon: StoreIcon, perm: 'stores.view' },
      { to: '/products', label: '商品管理', icon: Package, perm: 'products.view' },
    ],
  },
  {
    title: '交易',
    items: [
      { to: '/orders', label: '订单管理', icon: ShoppingCart, perm: 'orders.view' },
      { to: '/inventory', label: '库存管理', icon: Boxes, perm: 'inventory.view' },
      { to: '/purchase', label: '采购管理', icon: Truck, perm: 'purchase.view' },
      { to: '/profit', label: '利润核算', icon: BarChart3, perm: 'profit.view' },
    ],
  },
  {
    title: '增长',
    items: [
      { to: '/ads', label: '广告投放', icon: Megaphone, perm: 'ads.view' },
      { to: '/creators', label: '达人合作', icon: Users, badge: 'TikTok', perm: 'creators.view' },
      { to: '/competitors', label: '竞品分析', icon: Telescope, perm: 'competitors.view' },
    ],
  },
  {
    title: '协同',
    items: [
      { to: '/tasks', label: '任务看板', icon: CheckSquare, perm: 'tasks.view' },
      { to: '/org', label: '组织架构', icon: Network },
      { to: '/accounts', label: '账号管理', icon: UserCog, perm: 'account.manage' },
    ],
  },
]

export default function AppLayout() {
  const { profile, user, signOut, schemaReady, role, can, customRole } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    setMobileOpen(false)
    setMenuOpen(false)
  }, [location.pathname])

  const displayName = profile?.full_name || user?.email?.split('@')[0] || '运营同学'

  // 菜单按权限码收敛：自定义角色看不到的模块，入口也不出现
  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.perm || can(item.perm)),
  })).filter((group) => group.items.length > 0)

  const sidebar = (
    <div className="flex flex-col h-full">
      <div className="h-14 flex items-center gap-2.5 px-4 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shadow-sm">
          <span className="text-white font-bold text-[13px] tracking-tight">DS</span>
        </div>
        <div className="leading-tight">
          <p className="text-[13.5px] font-semibold text-ink-900">电商运营中台</p>
          <p className="text-[10px] text-ink-400 tracking-wide">AMAZON · TIKTOK SHOP</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 pb-4 pt-1">
        {visibleGroups.map((group) => (
          <div key={group.title} className="mb-3">
            <p className="px-2.5 py-1.5 text-[10px] font-semibold text-ink-400 tracking-widest">{group.title.toUpperCase()}</p>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'group flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-[13px] transition-colors',
                      isActive
                        ? 'bg-brand-50 text-brand-700 font-medium'
                        : 'text-ink-600 hover:bg-ink-100/70 hover:text-ink-900',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <item.icon className={cn('w-4 h-4 shrink-0', isActive ? 'text-brand-600' : 'text-ink-400 group-hover:text-ink-600')} />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.badge && (
                        <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-ink-900 text-white tracking-wide">
                          {item.badge}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-2.5 pb-3 shrink-0 space-y-0.5">
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

            <div className="flex items-center gap-2 text-[11px] text-ink-400">
              <span className={cn('w-1.5 h-1.5 rounded-full', schemaReady ? 'bg-emerald-500' : 'bg-amber-500')} />
              <span className="hidden sm:inline">{schemaReady ? 'Supabase 数据已连接' : '数据库待初始化'}</span>
            </div>

            <div className="ml-auto flex items-center gap-2">
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
                    <div className="absolute right-0 top-full mt-1.5 w-52 bg-white border border-ink-200 rounded-xl shadow-pop py-1 z-20 animate-scale-in">
                      <div className="px-3 py-2 border-b border-ink-100">
                        <p className="text-xs font-medium text-ink-800 truncate">{displayName}</p>
                        <p className="text-[11px] text-ink-400 truncate">{user?.email}</p>
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

        {/* 旧版数据库缺少组织架构字段时，权限体系不完整，给出明确指引 */}
        {profile && !('role_id' in profile) && (
          <div className="px-4 sm:px-6 pt-4">
            <div className="rounded-xl border border-amber-200/80 bg-amber-50 px-3.5 py-2.5 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
              <p className="text-[11.5px] leading-relaxed text-amber-800">
                数据库还没升级到组织架构版本，部门 / 岗位 / 自定义角色暂不可用（当前按系统角色默认权限运行）。
                请到 <Link to="/setup" className="underline font-medium">数据源</Link> 页复制最新脚本，
                在 Supabase SQL Editor 重新执行一次即可启用。
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
