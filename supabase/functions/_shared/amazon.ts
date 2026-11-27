/**
 * Amazon SP-API 调用基础：
 *  1) LWA refresh_token → access_token（1 小时有效）
 *  2) AWS SigV4 给请求签名（execute-api 服务）
 *  3) 限流退避：429/503 指数重试，读 x-amzn-ratelimit-limit
 *
 * 双认证缺一不可：x-amz-access-token + Authorization(SigV4)。
 */
import { config } from './config.ts'
import { decryptToken } from './crypto.ts'

export type Region = 'na' | 'eu' | 'fe'

const HOSTS: Record<Region, string> = {
  na: 'sellingpartnerapi-na.amazon.com',
  eu: 'sellingpartnerapi-eu.amazon.com',
  fe: 'sellingpartnerapi-fe.amazon.com',
}
const AWS_REGION: Record<Region, string> = {
  na: 'us-east-1',
  eu: 'eu-west-1',
  fe: 'us-west-2',
}

export interface Tokens {
  accessToken: string
  refreshToken?: string // Amazon 可能轮换 refresh token，需回写
  expiresIn?: number
}

/** 用 refresh token 换 access token。 */
export async function refreshAccessToken(cipher: string): Promise<Tokens> {
  const refreshToken = await decryptToken(cipher)
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.lwaClientId,
    client_secret: config.lwaClientSecret,
  })
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LWA 刷新令牌失败 (${res.status})：${text.slice(0, 300)}`)
  }
  const data = await res.json()
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  }
}

/** 用授权码换 token（OAuth 回调阶段）。 */
export async function exchangeCodeForToken(code: string): Promise<Tokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.lwaClientId,
    client_secret: config.lwaClientSecret,
    redirect_uri: config.redirectUri,
  })
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LWA 授权码兑换失败 (${res.status})：${text.slice(0, 300)}`)
  }
  const data = await res.json()
  if (!data.refresh_token) throw new Error('LWA 未返回 refresh_token，请检查应用类型与 scope')
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  }
}

/* --------------------------- AWS SigV4 --------------------------- */

function sha256(data: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return crypto.subtle.digest('SHA-256', bytes as BufferSource)
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmac(key: CryptoKey | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = key instanceof ArrayBuffer
    ? await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    : key
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data) as BufferSource)
}

function amzDate(d: Date) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

/** 生成 SigV4 Authorization 头所需的签名与时间戳。 */
async function signV4(
  method: string,
  host: string,
  path: string,
  query: URLSearchParams,
  accessToken: string,
  region: Region,
  payload = '',
): Promise<{ amzDate: string; dateStamp: string; signature: string }> {
  const now = new Date()
  const amzDateStr = amzDate(now)
  const dateStamp = amzDateStr.slice(0, 8)
  const service = 'execute-api'
  const awsRegion = AWS_REGION[region]

  const signedHeaders = 'host;x-amz-access-token;x-amz-date'
  const canonicalQuery = [...query.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQuery,
    `host:${host}\n`,
    `x-amz-access-token:${accessToken}\n`,
    `x-amz-date:${amzDateStr}\n`,
    '',
    signedHeaders,
    hex(await sha256(payload)),
  ].join('\n')

  const scope = `${dateStamp}/${awsRegion}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDateStr,
    scope,
    hex(await sha256(canonicalRequest)),
  ].join('\n')

  const kDate = await hmac(new TextEncoder().encode(`AWS4${config.awsSecretAccessKey}`).buffer as ArrayBuffer, dateStamp)
  const kRegion = await hmac(kDate, awsRegion)
  const kService = await hmac(kRegion, service)
  const kSigning = await hmac(kService, 'aws4_request')
  const signature = hex(await hmac(kSigning, stringToSign))

  return { amzDate: amzDateStr, dateStamp, signature }
}

export interface SpApiResult<T> {
  data: T
  nextToken?: string
  requestId?: string
}

/**
 * 调一次 SP-API GET。429/503 指数退避，最多 5 次。
 * path 以 / 开头，如 /orders/v0/orders。
 */
export async function spApiGet<T>(
  region: Region,
  accessToken: string,
  path: string,
  query: URLSearchParams = new URLSearchParams(),
): Promise<SpApiResult<T>> {
  const host = HOSTS[region]
  const url = `https://${host}${path}?${query.toString()}`
  let attempt = 0
  let lastError = ''

  while (attempt < 5) {
    const sig = await signV4('GET', host, path, query, accessToken, region)
    const awsRegion = AWS_REGION[region]
    const credential = `${config.awsAccessKeyId}/${sig.dateStamp}/${awsRegion}/execute-api/aws4_request`
    const authHeader =
      `AWS4-HMAC-SHA256 Credential=${credential}, ` +
      `SignedHeaders=host;x-amz-access-token;x-amz-date, Signature=${sig.signature}`

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        host,
        'x-amz-access-token': accessToken,
        'x-amz-date': sig.amzDate,
        Authorization: authHeader,
        'x-amz-security-token': config.awsSessionToken || undefined,
        'user-agent': 'DianshangxtSync/1.0 (SP-API)',
      } as Record<string, string>,
    })

    const requestId = res.headers.get('x-amzn-requestid') ?? undefined
    if (res.ok) {
      const data = await res.json() as T & { nextToken?: string; pagination?: { nextToken?: string } }
      return {
        data,
        nextToken: data.nextToken ?? data.pagination?.nextToken,
        requestId,
      }
    }

    const text = await res.text()
    lastError = `${res.status} ${text.slice(0, 300)} (requestId=${requestId ?? '-'})`
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      const headerLimit = Number(res.headers.get('x-amzn-ratelimit-limit') ?? 0)
      const base = headerLimit > 0 ? Math.max(250, Math.ceil(1000 / headerLimit)) : 1000
      await new Promise((r) => setTimeout(r, base * 2 ** attempt))
      attempt++
      continue
    }
    throw new Error(`SP-API ${path} 调用失败：${lastError}`)
  }
  throw new Error(`SP-API ${path} 重试耗尽：${lastError}`)
}
