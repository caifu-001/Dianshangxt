import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // GitHub Pages 部署在 https://<user>.github.io/<repo>/ 子路径下，
  // 静态资源与 SPA 路由都必须带上这个前缀，否则整站白屏。
  // 开发模式保持根路径，仓库改名或绑定自定义域名时在 .env 里设 VITE_BASE_PATH=/。
  const env = loadEnv(mode, '.', 'VITE_')
  const basePath = env.VITE_BASE_PATH || (mode === 'production' ? '/Dianshangxt/' : '/')

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
