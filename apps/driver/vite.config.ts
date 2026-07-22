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
      workbox: {
        // The on-device OCR assets (a few MB of wasm core + traineddata) must NOT be folded into the
        // install precache — that would bloat every update. They are fetched lazily on first use and
        // then cached at runtime, so OCR still works offline after the first read.
        globIgnores: ['**/tesseract/**'],
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/tesseract/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'tesseract-ocr',
              expiration: { maxEntries: 40 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
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
