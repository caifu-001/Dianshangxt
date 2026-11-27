/**
 * refresh token 加解密（AES-GCM-256），密钥只在 Edge Function secret 里。
 * 密文格式：v1:<iv-base64>:<ciphertext-base64>
 * 数据库只存这串密文，不存明文、不参与解密。
 */
import { config } from './config.ts'

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    unb64(config.tokenEncryptionKey) as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptToken(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const k = await key()
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    k,
    new TextEncoder().encode(plain) as BufferSource,
  )
  return `v1:${b64(iv)}:${b64(new Uint8Array(ct))}`
}

export async function decryptToken(cipher: string): Promise<string> {
  const parts = cipher.split(':')
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('token 密文格式无效')
  const k = await key()
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(parts[1]) as BufferSource },
    k,
    unb64(parts[2]) as BufferSource,
  )
  return new TextDecoder().decode(pt)
}
