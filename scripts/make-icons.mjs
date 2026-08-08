#!/usr/bin/env node
/**
 * The driver PWA's home-screen icons.
 *
 *   node scripts/make-icons.mjs      # → apps/driver/public/icon-{192,512,maskable}.png
 *
 * Generated rather than committed as binaries so the brand colour has ONE source of truth
 * (styles.css `--color-brand`) and a designer's replacement is a file swap, not a hunt.
 *
 * Chrome will not offer «إضافة إلى الشاشة الرئيسية» without a 192 AND a 512, which is why a
 * phone-only app used twice a day had to be found in a browser tab every shift.
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const driver = join(root, 'apps', 'driver')
const { createCanvas } = await import(
  pathToFileURL(createRequire(join(driver, 'package.json')).resolve('@napi-rs/canvas')).href
)

const BRAND = '#1b2a5c'

/** `safe` is the fraction of the canvas a maskable icon may use — Android crops to a circle. */
function icon(size, { maskable = false } = {}) {
  const c = createCanvas(size, size)
  const ctx = c.getContext('2d')
  ctx.fillStyle = BRAND
  if (maskable) {
    ctx.fillRect(0, 0, size, size) // full bleed; the launcher crops it
  } else {
    const r = size * 0.22
    ctx.beginPath()
    ctx.roundRect(0, 0, size, size, r)
    ctx.fill()
  }
  // «ASH» in white, centred, at a size that survives the maskable safe zone.
  const scale = maskable ? 0.3 : 0.42
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${Math.round(size * scale)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('ASH', size / 2, size / 2)
  return c.toBuffer('image/png')
}

for (const [name, buf] of [
  ['icon-192.png', icon(192)],
  ['icon-512.png', icon(512)],
  ['icon-maskable-512.png', icon(512, { maskable: true })],
]) {
  const out = join(driver, 'public', name)
  writeFileSync(out, buf)
  console.log(`written: ${out} (${buf.length} bytes)`)
}
