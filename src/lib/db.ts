import { supabase } from './supabase'
import { reportClientError } from './errorReporter'

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = () => supabase as any

/** 把接口失败记入系统日志，供超管排查。RLS 拒绝属于「越权拦截」，单独标记。 */
function reportDbFailure(message: string): void {
  const denied = /row-level security policy|permission denied/i.test(message)
  const missing = /relation .* does not exist|could not find the table|could not find the function/i.test(message)
  if (missing) return // 初始化未完成时刷屏没有排查价值
  reportClientError(
    denied ? 'permission_denied' : 'api_error',
    `${denied ? '越权操作拦截' : '接口调用失败'}：${message.slice(0, 300)}`,
    { raw: message.slice(0, 600) },
  )
}

/**
 * 把数据库层的原始报错翻成人话。
 * RLS 拒绝时 PostgREST 返回的是 "new row violates row-level security policy ..."，
 * 用户看到这句话完全不知道该怎么办。
 */
function translateDbError(message: string): string {
  reportDbFailure(message)
  if (/row-level security policy/i.test(message)) {
    return '你的岗位角色没有该操作的权限，请联系管理员在「人员与账号」中调整角色'
  }
  if (/relation .* does not exist|could not find the table/i.test(message)) {
    return '该功能尚未初始化，请联系系统管理员处理'
  }
  if (/could not find the function|function .* does not exist/i.test(message)) {
    return '该功能依赖的能力尚未启用，请联系系统管理员处理'
  }
  if (/column .* does not exist/i.test(message)) {
    return '该功能的数据格式需要升级，请联系系统管理员处理'
  }
  if (/duplicate key value/i.test(message)) {
    return '记录已存在（SKU / 订单号等唯一键重复）'
  }
  if (/null value in column/i.test(message)) {
    return '必填字段没有填写'
  }
  if (/violates foreign key constraint/i.test(message)) {
    return '关联的数据不存在，可能已被删除'
  }
  if (/violates check constraint/i.test(message)) {
    if (/finance_expense_approvals/i.test(message)) {
      return '费用审核流水写入失败：数据库函数仍是旧版，请联系管理员在 Supabase 执行审批热修复脚本（supabase/hotfix_expense_approval.sql）'
    }
    return '数据格式校验未通过，请检查填写内容后重试'
  }
  if (/JSON object requested/i.test(message)) {
    return '没有找到对应的成员档案，可能账号刚创建还没同步完，请刷新页面重试'
  }
  if (/permission denied for table|permission denied for function/i.test(message)) {
    return '当前账号没有执行该操作的权限，请联系管理员'
  }
  return message
}

export interface QueryOptions {
  order?: { column: string; ascending?: boolean }
  limit?: number
  filters?: Array<[string, 'eq' | 'neq' | 'gte' | 'lte' | 'ilike', unknown]>
  columns?: string
}

export async function fetchRows<T>(table: string, options: QueryOptions = {}): Promise<T[]> {
  let query = db().from(table).select(options.columns ?? '*')
  for (const [column, op, value] of options.filters ?? []) {
    query = query[op](column, value)
  }
  if (options.order) query = query.order(options.order.column, { ascending: options.order.ascending ?? true })
  if (options.limit) query = query.limit(options.limit)
  const { data, error } = await query
  if (error) throw new Error(translateDbError(error.message))
  return (data ?? []) as T[]
}

export async function insertRow<T>(table: string, values: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().from(table).insert(values).select().single()
  if (error) throw new Error(translateDbError(error.message))
  return data as T
}

export async function insertRows<T>(table: string, values: Record<string, unknown>[]): Promise<T[]> {
  const { data, error } = await db().from(table).insert(values).select()
  if (error) throw new Error(translateDbError(error.message))
  return (data ?? []) as T[]
}

export async function updateRow<T>(table: string, id: string, values: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().from(table).update(values).eq('id', id).select().single()
  if (error) throw new Error(translateDbError(error.message))
  return data as T
}

export async function deleteRow(table: string, id: string): Promise<void> {
  // 带上 select 才能知道到底删掉了几行：
  // RLS 拒绝 delete 时 PostgREST 仍返回 204，若不加判断，界面会显示「已删除」但其实什么都没发生
  const { data, error } = await db().from(table).delete().eq('id', id).select('id')
  if (error) throw new Error(translateDbError(error.message))
  if (!data || data.length === 0) {
    throw new Error('你的岗位角色没有删除权限，请联系管理员调整角色')
  }
}

/** 清空整张业务表（团队共享数据，仅管理员可通过 RLS 删除） */
export async function deleteAllRows(table: string): Promise<void> {
  // Supabase 要求 delete 必须带条件，这里用一个永远不成立的过滤，等价于清空全表
  const { error } = await db().from(table).delete().not('id', 'is', null)
  if (error) throw new Error(translateDbError(error.message))
}

/**
 * 按条件批量删除（用于「重写采购明细」这类子表操作）。
 * 与 deleteRow 不同，这里删 0 行不报错：子表可能本来就是空的。
 */
export async function deleteWhere(table: string, column: string, value: string): Promise<number> {
  const { data, error } = await db().from(table).delete().eq(column, value).select('id')
  if (error) throw new Error(translateDbError(error.message))
  return (data ?? []).length
}

export async function countRows(table: string): Promise<number> {
  const { count, error } = await db().from(table).select('id', { count: 'exact', head: true })
  if (error) throw new Error(translateDbError(error.message))
  return count ?? 0
}

/** 带条件的行数统计：只取 count，不拉数据（离职交接时统计名下资源） */
export async function countRowsWhere(table: string, column: string, value: string): Promise<number> {
  const { count, error } = await db().from(table).select('id', { count: 'exact', head: true }).eq(column, value)
  if (error) throw new Error(translateDbError(error.message))
  return count ?? 0
}

/**
 * 调用数据库函数（离职交接、权限审批等需要原子性的流程）。
 * 函数内部会用 is_staff() / has_permission() 重新校验一次调用者身份，
 * 前端传什么参数都绕不过去。
 */
export async function callRpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db().rpc(fn, args)
  if (error) throw new Error(translateDbError(error.message))
  return data as T
}

/**
 * 调用 Supabase Edge Function（带当前用户登录态）。
 * 敏感逻辑（OAuth 换 token / SP-API 签名）都在服务端，前端只传业务参数。
 */
export async function invokeFunction<T = unknown>(
  name: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await db().functions.invoke(name, { body })
  if (error) {
    const msg = error.message || ''
    // 未配置凭证是预期状态，不记入错误日志噪音
    if (/NOT_CONFIGURED|尚未配置/.test(msg)) throw new Error(msg)
    throw new Error(translateDbError(msg))
  }
  return data as T
}

/** 检测数据库是否已执行初始化脚本 */
export async function checkSchema(): Promise<{ ready: boolean; message?: string }> {
  const { error } = await db().from('stores').select('id', { head: true, count: 'exact' }).limit(1)
  if (!error) return { ready: true }
  if (error.code === 'PGRST205' || /could not find the table/i.test(error.message)) {
    return { ready: false, message: '系统尚未初始化，请联系管理员处理' }
  }
  return { ready: false, message: error.message }
}
