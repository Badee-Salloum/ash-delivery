import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// The driver app is a separate bundle with a tight budget: no component library, no chart lib.
// `registerType: 'prompt'` — a money app must never silently serve a stale service worker
// mid-shift; the app shows an Arabic "new version" bar instead.
export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'ASH Delivery — السائق',
        short_name: 'ASH',
        lang: 'ar',
        dir: 'rtl',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [],
      },
    }),
  ],
  server: { proxy: { '/api': 'http://localhost:3000' } },
})
