#!/usr/bin/env node
/**
 * Stage Tesseract's runtime assets into the driver PWA's `public/tesseract/` so on-device OCR works
 * OFFLINE and without a CDN (the app runs on modest Androids over the Damascus network). Copies the
 * worker + the wasm core variants out of node_modules and fetches the English traineddata (the small
 * `tessdata_fast` model), gzipped the way tesseract.js expects.
 *
 * Best-effort: if anything here fails (e.g. no network for the traineddata), it WARNS and exits 0 —
 * the OCR degrades to manual entry, which is the existing behaviour, so a build is never blocked.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'apps/driver/public/tesseract')
const TESSDATA = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main'
/**
 * Both languages. The client uses an English BMS app and an Arabic one, and `eng.traineddata`
 * cannot read Arabic script at all — its unicharset has no Arabic codepoints, so Arabic labels
 * come back as Latin noise. `ara` adds roughly 0.7-1 MB gzipped to the first-use download, which
 * is then cached forever by the service worker's CacheFirst rule for /tesseract/.
 */
const LANGS = ['eng', 'ara']

/** Find the first path under a base dir whose full path ends with `suffix`. */
function findUnder(base, suffix, depth = 6) {
  if (depth < 0 || !existsSync(base)) return null
  let entries
  try {
    entries = readdirSync(base)
  } catch {
    return null
  }
  for (const e of entries) {
    const full = join(base, e)
    if (full.replaceAll('\\', '/').endsWith(suffix)) return full
    try {
      if (statSync(full).isDirectory()) {
        const hit = findUnder(full, suffix, depth - 1)
        if (hit) return hit
      }
    } catch {
      /* skip */
    }
  }
  return null
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  const nm = join(root, 'node_modules/.pnpm')

  // 1) The worker script.
  const worker = findUnder(nm, 'tesseract.js/dist/worker.min.js')
  if (worker) copyFileSync(worker, join(outDir, 'worker.min.js'))
  else console.warn('[tesseract] worker.min.js not found — OCR will fall back to manual entry')

  // 2) The wasm core variants (the worker picks the one the browser supports).
  const coreDir = findUnder(nm, 'node_modules/tesseract.js-core')
  if (coreDir && statSync(coreDir).isDirectory()) {
    for (const f of readdirSync(coreDir)) {
      if (/^tesseract-core.*\.(wasm|js)$/.test(f)) copyFileSync(join(coreDir, f), join(outDir, f))
    }
  } else {
    console.warn('[tesseract] core dir not found — OCR will fall back to manual entry')
  }

  // 3) The traineddata (small fast models), gzipped as tesseract.js expects at langPath.
  for (const lang of LANGS) {
    const gzPath = join(outDir, `${lang}.traineddata.gz`)
    if (existsSync(gzPath)) {
      console.log(`[tesseract] ${lang}.traineddata.gz already present`)
      continue
    }
    try {
      const res = await fetch(`${TESSDATA}/${lang}.traineddata`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      writeFileSync(gzPath, gzipSync(bytes))
      console.log(`[tesseract] fetched ${lang}.traineddata (${(bytes.length / 1024 / 1024).toFixed(1)} MB) → gz`)
    } catch (err) {
      console.warn(
        `[tesseract] could not fetch ${lang}.traineddata (${(err instanceof Error && err.message) || err}) — OCR degrades to manual entry`,
      )
    }
  }
  console.log('[tesseract] assets staged in apps/driver/public/tesseract/')
}

await main()
