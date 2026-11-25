import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { checkSchema, fetchRows } from '../lib/db'
import type { Profile } from '../lib/types'

interface AuthContextValue {
  session: Session | null
  user: User | null
  profile: Profile | null
  loading: boolean
  schemaReady: boolean
  schemaMessage: string | null
  recheckSchema: () => Promise<boolean>
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, fullName: string) => Promise<{ needsConfirm: boolean }>
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

  const loadProfile = useCallback(async (userId: string) => {
    try {
      const rows = await fetchRows<Profile>('profiles', { filters: [['id', 'eq', userId]], limit: 1 })
      setProfile(rows[0] ?? null)
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
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw new Error(translateAuthError(error.message))
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

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setProfile(null)
  }, [])

  const refreshProfile = useCallback(async () => {
    if (session?.user) await loadProfile(session.user.id)
  }, [loadProfile, session?.user])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading,
      schemaReady,
      schemaMessage,
      recheckSchema,
      signIn,
      signUp,
      signOut,
      refreshProfile,
    }),
    [session, profile, loading, schemaReady, schemaMessage, recheckSchema, signIn, signUp, signOut, refreshProfile],
  )

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
    [/Database error saving new user/i, '数据库未初始化，请先执行建表脚本'],
  ]
  for (const [pattern, text] of map) if (pattern.test(message)) return text
  return message
}
