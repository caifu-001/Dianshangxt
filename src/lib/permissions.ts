/**
 * 角色能力矩阵。
 * 前端只负责「界面可见性」，真正的拦截在数据库 RLS 与触发器里 ——
 * 即使有人改了前端代码，越权请求也会被 Postgres 拒绝。
 */

export type Role = 'super_admin' | 'admin' | 'member'

export const ROLES: Role[] = ['super_admin', 'admin', 'member']

export const ROLE_META: Record<Role, { label: string; short: string; desc: string; badge: string }> = {
  super_admin: {
    label: '超级管理员',
    short: '超管',
    desc: '全部权限，可管理任何账号，可移除账号档案',
    badge: 'bg-violet-50 text-violet-700 border-violet-200',
  },
  admin: {
    label: '普通管理员',
    short: '管理员',
    desc: '可增删改业务数据，可管理普通人员的角色与状态',
    badge: 'bg-brand-50 text-brand-700 border-brand-200',
  },
  member: {
    label: '普通人员',
    short: '成员',
    desc: '可读写业务数据，不能删除记录，不能进入账号管理',
    badge: 'bg-ink-100 text-ink-600 border-ink-200',
  },
}

export function normalizeRole(role?: string | null): Role {
  if (role === 'super_admin' || role === 'admin') return role
  return 'member'
}

export function roleLabel(role?: string | null) {
  return ROLE_META[normalizeRole(role)].label
}

/** 管理员及以上 */
export function isStaff(role?: string | null) {
  const r = normalizeRole(role)
  return r === 'admin' || r === 'super_admin'
}

export function isSuperAdmin(role?: string | null) {
  return normalizeRole(role) === 'super_admin'
}

/** 能否删除业务数据（订单 / 商品 / 店铺等） */
export function canDeleteRecords(role?: string | null) {
  return isStaff(role)
}

/** 能否进入账号管理页 */
export function canManageAccounts(role?: string | null) {
  return isStaff(role)
}

/** 能否调整汇率、清空数据、生成演示数据 */
export function canManageSystem(role?: string | null) {
  return isStaff(role)
}

/**
 * 能否对某个目标账号执行「改角色 / 禁用 / 移除」。
 * 规则：
 *  - 普通人员：不能操作任何人
 *  - 普通管理员：只能操作普通人员
 *  - 超级管理员：能操作除自己以外的所有人（自己的角色与状态在 UI 上锁死）
 */
export function canOperateOn(actorRole: string | null | undefined, target: { id: string; role: string }, actorId?: string | null) {
  const actor = normalizeRole(actorRole)
  if (target.id === actorId) return false
  if (actor === 'super_admin') return true
  if (actor === 'admin') return normalizeRole(target.role) === 'member'
  return false
}

/** 可授予的角色范围：管理员不能造出超级管理员 */
export function assignableRoles(actorRole?: string | null): Role[] {
  return isSuperAdmin(actorRole) ? ROLES : ['admin', 'member']
}
