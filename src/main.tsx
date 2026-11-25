import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import { installGlobalErrorReporter } from './lib/errorReporter'

// 全局异常自动留痕，供平台超管在系统日志中排查故障
installGlobalErrorReporter()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
