import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { checkSchema, fetchRows } from '../lib/db'
import type { Profile } from '../lib/types'
import { type Role, isStaff as checkStaff, isSuperAdmin as checkSuper, normalizeRole } from '../lib/permissions'

interface AuthContextValue {
  session: Session | null
  user: User | null
  profile: Profile | null
  loading: boolean
  schemaReady: boolean
  schemaMessage: string | null
  /** 当前账号角色（super_admin / admin / member） */
  role: Role
  isStaff: boolean
  isSuperAdmin: boolean
  /** 账号被禁用或档案被移除时非空，用于阻断进入工作台 */
  blocked: 'disabled' | 'missing' | null
  recheckSchema: () => Promise<boolean>
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, fullName: string) => Promise<{ needsConfirm: boolean }>
  /** 发送邮箱验证码（只对已注册账号生效，避免任意人用邮箱创建账号） */
  sendOtp: (email: string) => Promise<void>
  /** 校验邮箱验证码，通过后直接建立会话 */
  verifyOtp: (email: string, token: string) => Promise<void>
  /** 先用当前密码确认身份，再更新为新密码 */
  changePassword: (current: string, next: string) => Promise<void>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [schemaReady, setSchemaReady] = useState(true)
  const [schemaMessage, setSchemaMessage] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<'disabled' | 'missing' | null>(null)

  const loadProfile = useCallback(async (userId: string) => {
    try {
      const rows = await fetchRows<Profile>('profiles', { filters: [['id', 'eq', userId]], limit: 1 })
      const next = rows[0] ?? null
      setProfile(next)
      // 被管理员禁用、或档案已被移除的账号，直接挡在工作台之外
      if (!next) setBlocked('missing')
      else if (next.status === 'disabled') setBlocked('disabled')
      else setBlocked(null)
    } catch {
      setProfile(null)
    }
  }, [])

  const recheckSchema = useCallback(async () => {
    const result = await checkSchema()
    setSchemaReady(result.ready)
    setSchemaMessage(result.message ?? null)
    return result.ready
  }, [])

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      setSession(data.session)
      if (data.session?.user) {
        await recheckSchema()
        await loadProfile(data.session.user.id)
      }
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return
      setSession(nextSession)
      if (event === 'SIGNED_OUT') {
        setProfile(null)
      } else if (nextSession?.user) {
        void loadProfile(nextSession.user.id)
      }
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [loadProfile, recheckSchema])

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw new Error(translateAuthError(error.message))
    // 记录最近登录时间，供账号管理页做审计（失败不影响登录）
    if (data.user) {
      void supabase
        .from('profiles')
        .update({ last_sign_in_at: new Date().toISOString() })
        .eq('id', data.user.id)
        .then(() => undefined, () => undefined)
    }
  }, [])

  const signUp = useCallback(async (email: string, password: string, fullName: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    })
    if (error) throw new Error(translateAuthError(error.message))
    return { needsConfirm: !data.session }
  }, [])

  const sendOtp = useCallback(async (email: string) => {
    // 邮件里的链接要跳回本站（GitHub Pages 子路径），
    // 该地址需在 Supabase → Authentication → URL Configuration → Redirect URLs 白名单里。
    const redirectTo = `${window.location.origin}${import.meta.env.BASE_URL}`
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        // 不开放在此创建用户：验证码仅作为已有账号的登录方式
        shouldCreateUser: false,
        emailRedirectTo: redirectTo,
      },
    })
    if (error) throw new Error(translateAuthError(error.message))
  }, [])

  const verifyOtp = useCallback(async (email: string, token: string) => {
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: token.trim(),
      type: 'email',
    })
    if (error) throw new Error(translateAuthError(error.message))
  }, [])

  const changePassword = useCallback(
    async (current: string, next: string) => {
      const emailAddr = session?.user?.email
      if (!emailAddr) throw new Error('登录状态已失效，请重新登录')
      // 改密前必须重新验证当前密码，否则会话被盗后可直接改密接管账号
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email: emailAddr,
        password: current,
      })
      if (verifyError) throw new Error('当前密码不正确')
      const { error } = await supabase.auth.updateUser({ password: next })
      if (error) throw new Error(translateAuthError(error.message))
    },
    [session?.user?.email],
  )

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setProfile(null)
    setBlocked(null)
  }, [])
  const refreshProfile = useCallback(async () => {
    if (session?.user) await loadProfile(session.user.id)
  }, [loadProfile, session?.user])

  const value = useMemo<AuthContextValue>(() => {
    const role: Role = normalizeRole(profile?.role)
    return {
      session,
      user: session?.user ?? null,
      profile,
      loading,
      schemaReady,
      schemaMessage,
      role,
      isStaff: checkStaff(role),
      isSuperAdmin: checkSuper(role),
      blocked,
      recheckSchema,
      signIn,
      signUp,
      sendOtp,
      verifyOtp,
      changePassword,
      signOut,
      refreshProfile,
    }
  }, [
    session, profile, loading, schemaReady, schemaMessage, blocked,
    recheckSchema, signIn, signUp, sendOtp, verifyOtp, changePassword, signOut, refreshProfile,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

function translateAuthError(message: string) {
  const map: Array<[RegExp, string]> = [
    [/Invalid login credentials/i, '邮箱或密码不正确'],
    [/Email not confirmed/i, '邮箱还未验证，请先到邮箱点击确认链接'],
    [/User already registered/i, '该邮箱已注册，请直接登录'],
    [/Password should be at least (\d+) characters/i, '密码长度至少 6 位'],
    [/Unable to validate email address/i, '邮箱格式不正确'],
    [/signup is disabled/i, '当前项目已关闭邮箱注册，请在 Supabase 控制台开启'],
    [/Email rate limit exceeded/i, '发送过于频繁，请稍后再试'],
    [/For security purposes, you can only request this after (\d+) seconds/i, '请求过于频繁，请稍后再试'],
    [/Signups not allowed for otp/i, '该邮箱尚未注册，请先切换到「注册」创建账号'],
    [/Token has expired or is invalid/i, '验证码错误或已过期，请重新获取'],
    [/invalid.*otp|otp.*invalid/i, '验证码错误，请核对后重试'],
    [/Database error saving new user/i, '数据库未初始化，请先执行建表脚本'],
  ]
  for (const [pattern, text] of map) if (pattern.test(message)) return text
  return message
}
