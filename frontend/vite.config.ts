import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Avoids pulling in @types/node just for one env var.
declare const process: { env: Record<string, string | undefined> }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Backend FastAPI. The chat SSE stream can stay open for minutes (evolution + gate).
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:8001',
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        configure(proxy) {
          // Make sure SSE is streamed through unbuffered and uncompressed.
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.url?.includes('/stream')) {
              proxyReq.removeHeader('accept-encoding')
              proxyReq.setHeader('accept', 'text/event-stream')
            }
          })
          proxy.on('proxyRes', (proxyRes) => {
            if (String(proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform'
              proxyRes.headers['x-accel-buffering'] = 'no'
              delete proxyRes.headers['content-length']
            }
          })
        },
      },
    },
  },
})
