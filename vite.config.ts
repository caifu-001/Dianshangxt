import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // 已绑定自定义域名 kuahaishidai.dpdns.org，生产与开发都走根路径 '/'，
  // 静态资源与 SPA 路由不再带 /Dianshangxt/ 前缀，否则自定义域名下会白屏。
  // 若将来改用 github.io 子路径访问，在 .env 里设 VITE_BASE_PATH=/Dianshangxt/ 即可。
  const env = loadEnv(mode, '.', 'VITE_')
  const basePath = env.VITE_BASE_PATH || '/'

  return {
    base: basePath,
    plugins: [react()],
    server: {
      port: 5173,
      host: '127.0.0.1',
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            charts: ['recharts'],
            supabase: ['@supabase/supabase-js'],
          },
        },
      },
    },
  }
})
