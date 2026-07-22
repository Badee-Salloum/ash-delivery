import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// The admin console is a desktop + tablet SPA (SRS §7). Charts, when they arrive, are ECharts
// lazy-loaded per route — no chart lib in the initial bundle.
export default defineConfig({
  plugins: [react(), tailwind()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
})
