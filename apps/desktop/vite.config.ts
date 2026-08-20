import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))

// pdfjs 静态资产目录：构建时拷入 dist（standard_fonts 与 iccs 不在仓库内；
// cmaps 已由 public/ 自动拷贝）。dev 下由 configureServer 直接托管。
const PDFJS_ASSETS = ['standard_fonts', 'iccs'] as const

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'copy-pdfjs-assets',
      closeBundle() {
        for (const dir of PDFJS_ASSETS) {
          cpSync(
            resolve(projectRoot, `node_modules/pdfjs-dist/${dir}`),
            resolve(projectRoot, `dist/${dir}`),
            { recursive: true },
          )
        }
      },
      configureServer(server) {
        for (const dir of PDFJS_ASSETS) {
          const base = resolve(projectRoot, `node_modules/pdfjs-dist/${dir}`)
          server.middlewares.use((req, res, next) => {
            let url: string
            try {
              url = decodeURIComponent((req.url ?? '').split('?')[0])
            } catch {
              return next()
            }
            if (!url.startsWith(`/${dir}/`)) return next()
            const file = resolve(base, url.slice(dir.length + 2))
            if (!file.startsWith(base) || !existsSync(file)) return next()
            res.setHeader('Content-Type', file.endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream')
            res.end(readFileSync(file))
          })
        }
      },
    },
  ],
  server: {
    port: 5173,
    // dev 代理目标与生产 API 一致（VITE_API_BASE，见 src/api/client.ts）
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8737',
        changeOrigin: false,
      },
    },
  },
  build: { chunkSizeWarningLimit: 4096 },
})