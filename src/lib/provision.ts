/**
 * 管理员代建账号。
 *
 * Supabase 的注册接口只能由「未登录」的客户端调用，且一旦登录就会写入
 * localStorage 覆盖管理员自己的会话。这里用一个不持久化、不自动刷新的
 * 一次性 client 去注册，注册完丢弃，管理员的登录态不受影响。
 *
 * 注意：账号的部门 / 岗位 / 角色不在这里设置 —— signUp 是匿名调用，
 * 若从 user_metadata 里读角色，任何人都能伪造 metadata 给自己开超管。
 * 所以这里只建登录凭据，profile 由 handle_new_user 建档（默认普通人员），
 * 再由管理员会话调用 updateProfile 补上组织归属。
 */
import { createClient } from '@supabase/supabase-js'

import { SUPABASE_KEY, SUPABASE_URL } from './supabase'

export interface CreatedAccount {
  userId: string
  /** true 表示项目开启了「Confirm email」，需要本人点邮件才能登录 */
  needsConfirm: boolean
}

export async function createAuthAccount(email: string, password: string, fullName: string): Promise<CreatedAccount> {
  const temp = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      // 兜底：即使 persistSession 被改回 true，也写不进任何地方，
      // 不会覆盖管理员自己的登录态
      storage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    },
  })

  const { data, error } = await temp.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { full_name: fullName.trim() } },
  })

  if (error) throw new Error(translateSignupError(error.message))
  if (!data.user) throw new Error('账号创建失败：服务端没有返回用户信息')
  // 开启「防止邮箱枚举」后，已存在的邮箱不会报错，而是返回一个 identities 为空的占位用户
  if (data.user.identities && data.user.identities.length === 0) {
    throw new Error('该邮箱已经注册过，请直接在成员列表里调整他的角色与组织归属')
  }

  return { userId: data.user.id, needsConfirm: !data.session }
}

/** 生成一个满足强度要求的初始密码（去掉 0/O/1/l/I 这类易混字符） */
export function randomPassword(length = 12): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const digit = '23456789'
  const symbol = '!@#$%&*'
  const pool = upper + lower + digit + symbol

  const pick = (set: string) => {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    return set[buf[0] % set.length]
  }

  // 先保证四类字符各一个，剩下的从全字符池随机，避免「看起来随机其实缺符号」
  const chars = [pick(upper), pick(lower), pick(digit), pick(symbol)]
  while (chars.length < length) chars.push(pick(pool))

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    const j = buf[0] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

function translateSignupError(message: string): string {
  const map: Array<[RegExp, string]> = [
    [/signup is disabled|Signups not allowed/i, '系统已关闭邮箱注册，请联系管理员处理'],
    [/User already registered/i, '该邮箱已经注册过，请直接在成员列表里调整他的角色与组织归属'],
    [/Password should be at least (\d+)/i, '密码长度不足，至少 8 位'],
    [/Unable to validate email address/i, '邮箱格式不正确'],
    [/rate limit|too many requests/i, '创建过于频繁，请稍等几分钟再试'],
    [/Database error saving new user/i, '系统尚未初始化，请联系管理员处理'],
  ]
  for (const [pattern, text] of map) if (pattern.test(message)) return text
  return message
}
