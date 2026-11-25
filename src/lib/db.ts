import { supabase } from './supabase'

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = () => supabase as any

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
  if (error) throw new Error(error.message)
  return (data ?? []) as T[]
}

export async function insertRow<T>(table: string, values: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().from(table).insert(values).select().single()
  if (error) throw new Error(error.message)
  return data as T
}

export async function insertRows<T>(table: string, values: Record<string, unknown>[]): Promise<T[]> {
  const { data, error } = await db().from(table).insert(values).select()
  if (error) throw new Error(error.message)
  return (data ?? []) as T[]
}

export async function updateRow<T>(table: string, id: string, values: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().from(table).update(values).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return data as T
}

export async function deleteRow(table: string, id: string): Promise<void> {
  // 带上 select 才能知道到底删掉了几行：
  // RLS 拒绝 delete 时 PostgREST 仍返回 204，若不加判断，界面会显示「已删除」但其实什么都没发生
  const { data, error } = await db().from(table).delete().eq('id', id).select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error('没有删除权限：普通人员只能新增与编辑，删除需要管理员角色')
  }
}

/** 清空整张业务表（团队共享数据，仅管理员可通过 RLS 删除） */
export async function deleteAllRows(table: string): Promise<void> {
  // Supabase 要求 delete 必须带条件，这里用一个永远不成立的过滤，等价于清空全表
  const { error } = await db().from(table).delete().not('id', 'is', null)
  if (error) throw new Error(error.message)
}

export async function countRows(table: string): Promise<number> {
  const { count, error } = await db().from(table).select('id', { count: 'exact', head: true })
  if (error) throw new Error(error.message)
  return count ?? 0
}

/** 检测数据库是否已执行初始化脚本 */
export async function checkSchema(): Promise<{ ready: boolean; message?: string }> {
  const { error } = await db().from('stores').select('id', { head: true, count: 'exact' }).limit(1)
  if (!error) return { ready: true }
  if (error.code === 'PGRST205' || /could not find the table/i.test(error.message)) {
    return { ready: false, message: '数据库尚未初始化，需要执行建表脚本' }
  }
  return { ready: false, message: error.message }
}
