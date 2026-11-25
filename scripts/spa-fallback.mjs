/**
 * GitHub Pages 只能托管静态文件，没有服务端 rewrite。
 * 直接刷新 /Dianshangxt/orders 这类子路由会返回 404。
 * 把 index.html 复制一份为 404.html，Pages 就用它兜底，
 * React Router 拿到原始 pathname 后可正常渲染对应页面。
 */
import { copyFile, access } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const index = resolve(root, 'dist/index.html')
const fallback = resolve(root, 'dist/404.html')

try {
  await access(index)
  await copyFile(index, fallback)
  console.log('[spa-fallback] dist/404.html 已生成')
} catch {
  console.error('[spa-fallback] 未找到 dist/index.html，请先执行 vite build')
  process.exit(1)
}
