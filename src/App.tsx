import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { LogOut, Loader2 } from 'lucide-react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ToastProvider, Button } from './components/ui'
import AppLayout from './components/Layout'
import Login from './pages/Login'
import Setup from './pages/Setup'
import Dashboard from './pages/Dashboard'
import Stores from './pages/Stores'
import Products from './pages/Products'
import Orders from './pages/Orders'
import Inventory from './pages/Inventory'
import Ads from './pages/Ads'
import Creators from './pages/Creators'
import Profit from './pages/Profit'
import Tasks from './pages/Tasks'
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

function AppRoutes() {
  const { session, loading, schemaReady, signOut } = useAuth()

  if (loading) return <FullScreenLoader />

  if (!session) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    )
  }

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
      <Route element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="stores" element={<Stores />} />
        <Route path="products" element={<Products />} />
        <Route path="orders" element={<Orders />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="ads" element={<Ads />} />
        <Route path="creators" element={<Creators />} />
        <Route path="profit" element={<Profit />} />
        <Route path="tasks" element={<Tasks />} />
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
