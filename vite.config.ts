import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'

// Local development talks to a Score API started with SCORE_AUTH_MODE=dev-header (see README).
const DEFAULT_API_ORIGIN = 'http://127.0.0.1:8080'

function scoreApiProxy(): Record<string, ProxyOptions> {
  const principal = process.env.SCORE_DEV_PRINCIPAL?.trim()
  return {
    '/api': {
      target: process.env.SCORE_API_ORIGIN?.trim() || DEFAULT_API_ORIGIN,
      configure(proxy) {
        // The developer identity comes only from the Node-side dev server; it never reaches the browser bundle.
        proxy.on('proxyReq', (request) => {
          request.removeHeader('x-score-dev-principal')
          if (principal) request.setHeader('X-Score-Dev-Principal', principal)
        })
      },
    },
  }
}

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: { proxy: scoreApiProxy() },
  preview: { proxy: scoreApiProxy() },
})