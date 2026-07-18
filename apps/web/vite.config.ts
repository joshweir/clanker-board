import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev = 2 processes (Vite + api) for HMR; the client uses same-origin relative
// URLs, so Vite proxies the api surface with no CORS and no API-base config
// (#10/#17). Proxy self-heals: turbo starts both concurrently with no ordering
// barrier, and requests just fail until the api is up.
const apiTarget = `http://localhost:${process.env.API_PORT ?? '4711'}`
const proxy = { target: apiTarget, changeOrigin: true }

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5711),
    proxy: {
      '/api': proxy,
      '/openapi.json': proxy,
      '/docs': proxy
    }
  }
})
