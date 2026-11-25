import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { Lock, LogOut, Loader2, ShieldOff } from 'lucide-react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ToastProvider, Button } from './components/ui'
import type { PermissionCode } from './lib/permissions'
import AppLayout from './components/Layout'
import Login from './pages/Login'
import Setup from './pages/Setup'
import Cockpit from './pages/Cockpit'
import Dashboard from './pages/Dashboard'
import Stores from './pages/Stores'
import Products from './pages/Products'
import Orders from './pages/Orders'
import Inventory from './pages/Inventory'
import Procurement from './pages/Procurement'
import Suppliers from './pages/Suppliers'
import Ads from './pages/Ads'
import Creators from './pages/Creators'
import Competitors from './pages/Competitors'
import Profit from './pages/Profit'
import Tasks from './pages/Tasks'
import Accounts from './pages/Accounts'
import AccessFlow from './pages/AccessFlow'
import Org from './pages/Org'
import Performance from './pages/Performance'
import Settings from './pages/Settings'

function FullScreenLoader({ label = '正在加载工作台…' }: { label?: string }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-ink-50">
      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shadow-sm">
        <span className="text-white font-bold text-sm">DS</span>
      </div>
      <div className="flex items-center gap-2 text-[12.5px] text-ink-500">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {label}
      </div>
    </div>
  )
}

/** 业务页面的前端守卫；真正的拦截在数据库 RLS 里（public.has_permission） */
function RequirePermission({
  perm,
  anyOf,
  children,
}: {
  perm?: PermissionCode
  /** 满足任意一个即可：例如「人员与账号」管理员或人事岗都能进 */
  anyOf?: PermissionCode[]
  children: ReactNode
}) {
  const { can } = useAuth()
  const allowed = perm ? can(perm) : (anyOf ?? []).some((code) => can(code))
  if (allowed) return <>{children}</>
  return (
    <div className="card p-10 text-center">
      <div className="w-11 h-11 rounded-xl bg-ink-100 text-ink-400 flex items-center justify-center mx-auto">
        <Lock className="w-5 h-5" />
      </div>
      <p className="mt-3 text-[14px] font-medium text-ink-800">没有该模块的访问权限</p>
      <p className="mt-1 text-[12.5px] text-ink-500 max-w-md mx-auto leading-relaxed">
        你的部门范围与岗位角色都不包含这个模块。如需访问，请联系管理员调整你所在部门的可见模块，
        或为你分配包含该模块的角色。
      </p>
      <Link to="/" className="inline-block mt-4">
        <Button size="sm">返回运营概览</Button>
      </Link>
    </div>
  )
}

function AccountBlocked({ kind, onSignOut }: { kind: 'disabled' | 'missing'; onSignOut: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-50 px-5">
      <div className="w-full max-w-[420px] card p-8 text-center">
        <div className="w-12 h-12 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto">
          <ShieldOff className="w-6 h-6" />
        </div>
        <h1 className="mt-4 text-[17px] font-semibold text-ink-900">
          {kind === 'disabled' ? '账号已被禁用' : '账号档案不存在'}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          {kind === 'disabled'
            ? '管理员已停用你的账号，业务数据暂时不可访问。需要恢复请联系团队的超级管理员。'
            : '登录凭据有效，但系统中查不到对应的成员档案。请联系管理员在「人员与账号」中恢复你的账号。'}
        </p>
        <Button className="mt-5" onClick={onSignOut} icon={<LogOut className="w-3.5 h-3.5" />}>
          退出登录
        </Button>
      </div>
    </div>
  )
}

function AppRoutes() {
  const { session, loading, schemaReady, blocked, signOut } = useAuth()

  if (loading) return <FullScreenLoader />

  if (!session) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    )
  }

  if (blocked) return <AccountBlocked kind={blocked} onSignOut={() => void signOut()} />

  if (!schemaReady) {
    return (
      <div className="min-h-screen bg-ink-50">
        <header className="h-14 bg-white border-b border-ink-200/70 flex items-center px-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center">
              <span className="text-white font-bold text-[13px]">DS</span>
            </div>
            <span className="text-[13.5px] font-semibold text-ink-900">电商运营中台</span>
          </div>
          <div className="ml-auto">
            <Button variant="ghost" size="sm" icon={<LogOut className="w-3.5 h-3.5" />} onClick={() => signOut()}>
              退出登录
            </Button>
          </div>
        </header>
        <main className="px-4 sm:px-6 py-6">
          <Setup />
        </main>
      </div>
    )
  }

  return (
    <Routes>
      {/* 数据驾驶舱是投屏用的大屏，不进工作台布局（没有侧边栏），
          权限沿用订单查看：连订单都看不到的账号，看驾驶舱也没有意义 */}
      <Route
        path="cockpit"
        element={
          <RequirePermission perm="orders.view">
            <Cockpit />
          </RequirePermission>
        }
      />
      <Route element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="stores" element={<RequirePermission perm="stores.view"><Stores /></RequirePermission>} />
        <Route path="products" element={<RequirePermission perm="products.view"><Products /></RequirePermission>} />
        <Route path="orders" element={<RequirePermission perm="orders.view"><Orders /></RequirePermission>} />
        <Route path="inventory" element={<RequirePermission perm="inventory.view"><Inventory /></RequirePermission>} />
        <Route path="purchase" element={<RequirePermission perm="purchase.view"><Procurement /></RequirePermission>} />
        <Route path="suppliers" element={<RequirePermission perm="purchase.view"><Suppliers /></RequirePermission>} />
        <Route path="ads" element={<RequirePermission perm="ads.view"><Ads /></RequirePermission>} />
        <Route path="creators" element={<RequirePermission perm="creators.view"><Creators /></RequirePermission>} />
        <Route path="competitors" element={<RequirePermission perm="competitors.view"><Competitors /></RequirePermission>} />
        <Route path="profit" element={<RequirePermission perm="profit.view"><Profit /></RequirePermission>} />
        <Route path="tasks" element={<RequirePermission perm="tasks.view"><Tasks /></RequirePermission>} />
        <Route path="performance" element={<Performance />} />
        {/* 组织架构对全员可见（通讯录），编辑按钮按 org.manage 收敛 */}
        <Route path="org" element={<Org />} />
        <Route
          path="accounts"
          element={
            <RequirePermission anyOf={['account.manage', 'hr.view']}>
              <Accounts />
            </RequirePermission>
          }
        />
        {/* 权限流程全员可见：普通成员在这里提交申请、看自己的变动记录 */}
        <Route path="access" element={<AccessFlow />} />
        <Route path="settings" element={<Settings />} />
        <Route path="setup" element={<Setup />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

// GitHub Pages 部署在 /Dianshangxt/ 子路径下，BrowserRouter 需要知道这段前缀，
// 否则所有路由都匹配不到，刷新后会掉回登录页。
// 本地开发时 BASE_URL 为 '/'，去掉尾部斜杠后回退为 '/'。
const BASENAME = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/'

export default function App() {
  return (
    <BrowserRouter basename={BASENAME}>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
