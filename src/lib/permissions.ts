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
  | 'brand.view' | 'brand.edit'
  | 'dev.view' | 'dev.edit'
  | 'expense.view' | 'expense.edit'
  | 'profit.view' | 'profit.edit'
  | 'tasks.view' | 'tasks.edit'
  | 'performance.view' | 'performance.edit'
  | 'hr.view' | 'hr.manage'
  | 'finance.audit'
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
  { key: 'development', label: '产品开发', desc: '自有品牌立项、打样、成本与上市节点', view: 'dev.view', edit: 'dev.edit', group: '经营' },
  { key: 'orders', label: '订单管理', desc: '订单、退款与利润明细', view: 'orders.view', edit: 'orders.edit', group: '交易' },
  { key: 'inventory', label: '库存管理', desc: '库存水位与补货建议', view: 'inventory.view', edit: 'inventory.edit', group: '交易' },
  { key: 'purchase', label: '采购管理', desc: '供应商、采购单与到货入库', view: 'purchase.view', edit: 'purchase.edit', group: '交易' },
  { key: 'profit', label: '利润核算', desc: 'P&L 与费用台账', view: 'profit.view', edit: 'profit.edit', group: '交易' },
  { key: 'expenses', label: '费用管理', desc: '研发 / 营销 / 薪酬社保 / 差旅等费用单、预算与审批', view: 'expense.view', edit: 'expense.edit', group: '交易' },
  { key: 'ads', label: '站内品牌营销 · 广告', desc: '站内广告活动与 ACOS', view: 'ads.view', edit: 'ads.edit', group: '增长' },
  { key: 'creators', label: '站内品牌营销 · 达人', desc: 'TikTok 达人建联与内容', view: 'creators.view', edit: 'creators.edit', group: '增长' },
  { key: 'competitors', label: '竞品分析', desc: '竞品价格、评分与排名监控', view: 'competitors.view', edit: 'competitors.edit', group: '增长' },
  { key: 'brand', label: '站外品牌营销', desc: '社媒营销、站外红人、公共关系与曝光搜索', view: 'brand.view', edit: 'brand.edit', group: '增长' },
  { key: 'tasks', label: '任务看板', desc: '运营任务与协作', view: 'tasks.view', edit: 'tasks.edit', group: '协同' },
  { key: 'performance', label: '绩效管理', desc: '考核周期、评分与评语', view: 'performance.view', edit: 'performance.edit', group: '人事' },
]

/** 部门职能权限：不是业务模块，但可以按部门授予（典型：人力资源部） */
export const FUNCTION_META: Record<string, { label: string; desc: string }> = {
  'hr.view': { label: '人事档案', desc: '查看花名册、入离职记录与人员变动流水' },
  'hr.manage': { label: '入离职办理', desc: '开通账号、确认入职、办理离职与资源移交' },
  'finance.audit': { label: '财务审核', desc: '审核采购单与费用单，通过后才能登记付款' },
}

export const FUNCTION_CODES: PermissionCode[] = ['hr.view', 'hr.manage', 'finance.audit']

/* ------------------------------------------------------------------ */
/*  部门模板                                                           */
/* ------------------------------------------------------------------ */

export interface DeptTemplate {
  key: string
  name: string
  code: string
  desc: string
  scope: PermissionCode[]
}

function moduleScope(keys: string[], edit = true): PermissionCode[] {
  const out: PermissionCode[] = []
  for (const key of keys) {
    const mod = MODULES.find((m) => m.key === key)
    if (!mod) continue
    out.push(mod.view)
    if (edit && mod.edit) out.push(mod.edit)
  }
  return out
}

/**
 * 建部门时可直接套用的职能模板。
 * 信息中心给全部业务模块；人力资源部给人事与绩效；其余按职能收敛。
 */
export const DEPT_TEMPLATES: DeptTemplate[] = [
  {
    key: 'it',
    name: '信息中心',
    code: 'IT',
    desc: '全部业务模块可读写，负责系统与数据支持（账号管理仍由管理员角色决定）',
    scope: [...moduleScope(MODULES.map((m) => m.key)), 'hr.view'],
  },
  {
    key: 'hr',
    name: '人力资源部',
    code: 'HR',
    desc: '花名册、入离职办理、绩效查看与录入',
    scope: ['hr.view', 'hr.manage', ...moduleScope(['performance', 'tasks'])],
  },
  {
    key: 'ops',
    name: '运营部',
    code: 'OPS',
    desc: '店铺、商品、订单、库存、采购、产品开发与任务看板',
    scope: [...moduleScope(['stores', 'products', 'development', 'orders', 'inventory', 'purchase', 'tasks']), 'performance.view'],
  },
  {
    key: 'ads',
    name: '广告投放部',
    code: 'ADS',
    desc: '广告投放与竞品监控，可查看商品',
    scope: [...moduleScope(['ads', 'competitors']), 'products.view', 'tasks.view', 'performance.view'],
  },
  {
    key: 'content',
    name: '内容营销部',
    code: 'CONTENT',
    desc: '达人建联、站外品牌营销与内容合作',
    scope: [...moduleScope(['creators', 'brand', 'tasks']), 'products.view', 'performance.view'],
  },
  {
    key: 'fin',
    name: '财务部',
    code: 'FIN',
    desc: '利润核算、费用管理、采购与费用财务审核，订单、采购、商品只读',
    scope: ['profit.view', 'profit.edit', 'expense.view', 'expense.edit', 'orders.view', 'purchase.view', 'products.view', 'stores.view', 'performance.view', 'finance.audit'],
  },
]

/** 按名称/编码匹配模板，用于「一键套用」 */
export function matchDeptTemplate(name?: string | null, code?: string | null): DeptTemplate | undefined {
  return DEPT_TEMPLATES.find(
    (t) => (code && t.code.toLowerCase() === code.toLowerCase()) || (name && t.name === name),
  )
}

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
  ...FUNCTION_CODES,
  ...ADMIN_ONLY,
]

/** 部门可授予的范围：业务模块 + 人事职能；不含删除与管理类权限 */
export const DEPT_GRANTS: PermissionCode[] = [
  ...MODULES.flatMap((m) => [m.view, ...(m.edit ? [m.edit] : [])]),
  ...FUNCTION_CODES,
]

/** 普通人员的权限上限：业务模块 + 人事职能，不含任何管理类权限 */
export const MEMBER_CAP: PermissionCode[] = DEPT_GRANTS

/**
 * 未配置部门范围、也没有岗位角色时的兜底权限（仅兼容老库）。
 * 绩效与人事属于敏感数据，不在兜底范围内。
 */
export const MEMBER_DEFAULT: PermissionCode[] = MODULES.filter((m) => m.key !== 'performance').flatMap(
  (m) => [m.view, ...(m.edit ? [m.edit] : [])],
)

export function capFor(role?: string | null): PermissionCode[] {
  return normalizeRole(role) === 'member' ? MEMBER_CAP : ALL_PERMISSIONS
}

/* ------------------------------------------------------------------ */
/*  部门范围                                                           */
/* ------------------------------------------------------------------ */

export interface DeptScopeLike {
  id: string
  name?: string
  parent_id: string | null
  scope?: string[] | null
  inherit_parent?: boolean | null
}

export interface DeptScopeResult {
  /** 本部门自己配置的权限 */
  own: PermissionCode[]
  /** 从上级部门继承来的权限 */
  inherited: PermissionCode[]
  /** 实际生效（own ∪ inherited） */
  all: PermissionCode[]
  /** 继承链上的部门名，用于界面提示 */
  chain: string[]
}

function asCodes(list?: string[] | null): PermissionCode[] {
  return (list ?? []).filter((c): c is PermissionCode => typeof c === 'string')
}

/**
 * 解析部门的实际可见范围：本部门 + 逐级向上的父部门。
 * 任一环关闭「继承上级」即截止，避免把上层的大范围无差别下放。
 */
export function resolveDeptScope(
  departmentId?: string | null,
  deptById?: Map<string, DeptScopeLike>,
): DeptScopeResult {
  const own: PermissionCode[] = []
  const inherited: PermissionCode[] = []
  const chain: string[] = []
  if (!departmentId || !deptById) return { own, inherited, all: [], chain }

  let current = deptById.get(departmentId)
  let guard = 0
  let first = true
  while (current && guard < 10) {
    const codes = asCodes(current.scope)
    if (first) own.push(...codes)
    else {
      inherited.push(...codes)
      if (current.name) chain.push(current.name)
    }
    // 只有当前节点允许继承，才继续向上取父部门
    if (current.inherit_parent === false) break
    current = current.parent_id ? deptById.get(current.parent_id) : undefined
    first = false
    guard += 1
  }

  const all = Array.from(new Set<PermissionCode>([...own, ...inherited]))
  return { own: Array.from(new Set(own)), inherited: Array.from(new Set(inherited)), all, chain }
}

/** 某个权限码的来源，用于「这个人为什么能看到这个模块」 */
export type PermissionSource = 'system' | 'role' | 'dept'

export function permissionSources(
  role: string | null | undefined,
  rolePerms: string[] | null | undefined,
  deptPerms: string[] | null | undefined,
): Map<string, PermissionSource[]> {
  const r = normalizeRole(role)
  const out = new Map<string, PermissionSource[]>()
  const push = (code: string, src: PermissionSource) => {
    const arr = out.get(code) ?? []
    if (!arr.includes(src)) arr.push(src)
    out.set(code, arr)
  }
  if (r === 'super_admin') {
    for (const code of ALL_PERMISSIONS) push(code, 'system')
    return out
  }
  for (const code of rolePerms ?? []) push(code, 'role')
  for (const code of deptPerms ?? []) push(code, 'dept')
  if (r === 'admin') for (const code of ADMIN_ALWAYS) push(code, 'system')
  return out
}

/**
 * 计算有效权限。
 * @param role     系统角色
 * @param rolePerms 岗位角色的权限码；null 表示未分配角色
 * @param deptPerms 部门范围（含上级继承）；空数组表示部门没配范围
 *
 * 与数据库 public.has_permission() 的判定保持一致：
 *  - super_admin：全部
 *  - admin：管理类恒有，业务类 = 部门范围 ∪ 角色范围（都没配时全放行）
 *  - member：上限是「模块 + 人事职能」，永远拿不到管理类与删除
 */
export function effectivePermissions(
  role?: string | null,
  rolePerms?: string[] | null,
  deptPerms?: string[] | null,
): PermissionCode[] {
  const r = normalizeRole(role)

  if (r === 'super_admin') return ALL_PERMISSIONS

  const hasRole = Array.isArray(rolePerms)
  const hasDept = Array.isArray(deptPerms) && deptPerms.length > 0

  // 岗位角色与部门范围都没配：按系统角色默认值（兼容老库）
  if (!hasRole && !hasDept) return r === 'admin' ? ALL_PERMISSIONS : MEMBER_DEFAULT

  const granted = new Set<string>([...(hasRole ? rolePerms : []), ...(hasDept ? deptPerms : [])])
  const cap = r === 'admin' ? ALL_PERMISSIONS : MEMBER_CAP

  if (r === 'admin') {
    return cap.filter((p) => ADMIN_ALWAYS.includes(p) || granted.has(p))
  }
  return cap.filter((p) => granted.has(p))
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
  const fn = FUNCTION_META[code]
  if (fn) return fn.label
  for (const m of MODULES) {
    if (code === m.view) return `查看${m.label.replace('管理', '')}`
    if (code === m.edit) return `编辑${m.label.replace('管理', '')}`
  }
  return code
}
