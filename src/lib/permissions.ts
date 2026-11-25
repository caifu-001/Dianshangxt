/**
 * 权限体系：系统角色（上限）× 自定义角色（范围）。
 *
 *  - 系统角色（profiles.role）决定"管理级别"：super_admin / admin / member
 *  - 自定义角色（profiles.role_id → roles.permissions）决定"业务范围"：
 *    能看到哪些模块、能不能删数据
 *
 * 前端这份清单只负责界面可见性，真正的拦截在数据库 RLS 与触发器里
 * （public.has_permission(code)），两边必须保持同一套权限码。
 */

export type Role = 'super_admin' | 'admin' | 'member'

export const ROLES: Role[] = ['super_admin', 'admin', 'member']

export const ROLE_META: Record<Role, { label: string; short: string; desc: string; badge: string }> = {
  super_admin: {
    label: '超级管理员',
    short: '超管',
    desc: '全部权限，可管理任何账号与组织架构，可移除账号档案',
    badge: 'bg-violet-50 text-violet-700 border-violet-200',
  },
  admin: {
    label: '普通管理员',
    short: '管理员',
    desc: '可管理账号与组织架构，业务数据范围受自定义角色约束',
    badge: 'bg-brand-50 text-brand-700 border-brand-200',
  },
  member: {
    label: '普通人员',
    short: '成员',
    desc: '业务数据范围由自定义角色决定，不能管理账号、组织与系统配置',
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

/* ------------------------------------------------------------------ */
/*  权限码                                                             */
/* ------------------------------------------------------------------ */
export type PermissionCode =
  | 'stores.view' | 'stores.edit'
  | 'products.view' | 'products.edit'
  | 'orders.view' | 'orders.edit'
  | 'inventory.view' | 'inventory.edit'
  | 'purchase.view' | 'purchase.edit'
  | 'ads.view' | 'ads.edit'
  | 'creators.view' | 'creators.edit'
  | 'competitors.view' | 'competitors.edit'
  | 'profit.view' | 'profit.edit'
  | 'tasks.view' | 'tasks.edit'
  | 'data.delete'
  | 'account.manage'
  | 'org.manage'
  | 'system.manage'

/** 业务模块：菜单可见性、路由守卫都基于 view 权限码 */
export interface ModuleDef {
  key: string
  label: string
  desc: string
  view: PermissionCode
  edit?: PermissionCode
  group: string
}

export const MODULES: ModuleDef[] = [
  { key: 'stores', label: '店铺管理', desc: '店铺档案、站点与目标 ACOS', view: 'stores.view', edit: 'stores.edit', group: '经营' },
  { key: 'products', label: '商品管理', desc: 'SKU、成本与售价', view: 'products.view', edit: 'products.edit', group: '经营' },
  { key: 'orders', label: '订单管理', desc: '订单、退款与利润明细', view: 'orders.view', edit: 'orders.edit', group: '交易' },
  { key: 'inventory', label: '库存管理', desc: '库存水位与补货建议', view: 'inventory.view', edit: 'inventory.edit', group: '交易' },
  { key: 'purchase', label: '采购管理', desc: '供应商、采购单与到货入库', view: 'purchase.view', edit: 'purchase.edit', group: '交易' },
  { key: 'profit', label: '利润核算', desc: 'P&L 与费用台账', view: 'profit.view', edit: 'profit.edit', group: '交易' },
  { key: 'ads', label: '广告投放', desc: '广告活动与 ACOS', view: 'ads.view', edit: 'ads.edit', group: '增长' },
  { key: 'creators', label: '达人合作', desc: 'TikTok 达人建联与内容', view: 'creators.view', edit: 'creators.edit', group: '增长' },
  { key: 'competitors', label: '竞品分析', desc: '竞品价格、评分与排名监控', view: 'competitors.view', edit: 'competitors.edit', group: '增长' },
  { key: 'tasks', label: '任务看板', desc: '运营任务与协作', view: 'tasks.view', edit: 'tasks.edit', group: '协同' },
]

/** 管理类权限：只有系统角色管理员及以上才拿得到，自定义角色无法授予 */
export const ADMIN_ONLY: PermissionCode[] = [
  'data.delete',
  'account.manage',
  'org.manage',
  'system.manage',
]

/** 管理类权限里"管理员恒有"的部分：不随自定义角色收窄，避免把自己锁在门外 */
export const ADMIN_ALWAYS: PermissionCode[] = ['account.manage', 'org.manage', 'system.manage']

export const PERMISSION_META: Record<string, { label: string; desc: string; adminOnly?: boolean }> = {
  'data.delete': { label: '删除业务数据', desc: '删除订单、商品、店铺等记录', adminOnly: true },
  'account.manage': { label: '管理账号', desc: '查看成员列表、调整角色与状态', adminOnly: true },
  'org.manage': { label: '管理组织架构', desc: '维护部门、岗位与自定义角色', adminOnly: true },
  'system.manage': { label: '系统配置', desc: '汇率、清空数据、生成演示数据', adminOnly: true },
}

export const ALL_PERMISSIONS: PermissionCode[] = [
  ...MODULES.flatMap((m) => [m.view, ...(m.edit ? [m.edit] : [])]),
  ...ADMIN_ONLY,
]

/** 普通人员的权限上限：所有模块的查看与编辑，不含任何管理类权限 */
export const MEMBER_CAP: PermissionCode[] = MODULES.flatMap((m) => [m.view, ...(m.edit ? [m.edit] : [])])

export function capFor(role?: string | null): PermissionCode[] {
  return normalizeRole(role) === 'member' ? MEMBER_CAP : ALL_PERMISSIONS
}

/**
 * 计算有效权限。
 * @param role     系统角色
 * @param rolePerms 自定义角色的权限码；null 表示未分配角色（按系统角色默认值放行）
 *
 * 与数据库 public.has_permission() 的判定保持一致：
 *  - super_admin：全部
 *  - admin：管理类恒有，业务类按角色收窄
 *  - member：上限是「查看 + 编辑」，永远拿不到管理类
 */
export function effectivePermissions(
  role?: string | null,
  rolePerms?: string[] | null,
): PermissionCode[] {
  const r = normalizeRole(role)

  if (r === 'super_admin') return ALL_PERMISSIONS

  // 未分配自定义角色：按系统角色默认值
  const assigned = Array.isArray(rolePerms)
  if (!assigned) return r === 'admin' ? ALL_PERMISSIONS : MEMBER_CAP

  if (r === 'admin') {
    return ALL_PERMISSIONS.filter((p) => ADMIN_ALWAYS.includes(p) || rolePerms.includes(p))
  }
  return MEMBER_CAP.filter((p) => rolePerms.includes(p))
}

/** 该角色能否被授予某个权限码（用于角色编辑器的勾选框态） */
export function canGrantPermission(role: Role, code: PermissionCode) {
  if (role === 'super_admin' || role === 'admin') return true
  return !ADMIN_ONLY.includes(code)
}

/**
 * 能否对某个目标账号执行「改角色 / 禁用 / 移除」。
 *  - 普通人员：不能操作任何人
 *  - 普通管理员：只能操作普通人员
 *  - 超级管理员：能操作除自己以外的所有人
 */
export function canOperateOn(actorRole: string | null | undefined, target: { id: string; role: string }, actorId?: string | null) {
  const actor = normalizeRole(actorRole)
  if (target.id === actorId) return false
  if (actor === 'super_admin') return true
  if (actor === 'admin') return normalizeRole(target.role) === 'member'
  return false
}

/** 可授予的系统角色范围：管理员不能造出超级管理员 */
export function assignableRoles(actorRole?: string | null): Role[] {
  return isSuperAdmin(actorRole) ? ROLES : ['admin', 'member']
}

/** 权限码 → 中文名（审计展示用） */
export function permissionLabel(code: string): string {
  const admin = PERMISSION_META[code]
  if (admin) return admin.label
  for (const m of MODULES) {
    if (code === m.view) return `查看${m.label.replace('管理', '')}`
    if (code === m.edit) return `编辑${m.label.replace('管理', '')}`
  }
  return code
}
