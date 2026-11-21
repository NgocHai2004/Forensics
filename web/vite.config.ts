import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev: Vite 5173 proxy sang FastAPI 8000. Build: xuất vào app/static/dist để FastAPI phục vụ.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:8000', '/file': 'http://127.0.0.1:8000', '/thumb': 'http://127.0.0.1:8000' },
  },
  build: { outDir: '../app/static/dist', emptyOutDir: true },
})
