/**
 * Client-side image compression to ~300 KB (SRS §7).
 *
 * Uploads happen on office Wi-Fi from cheap Android phones, so the photo must be shrunk before it
 * leaves the device. This runs in the browser (canvas + createImageBitmap), so it is behind a
 * capability check and returns the original bytes when the APIs are absent — a Node test, for
 * instance, exercises the surrounding flow without a DOM.
 *
 * The binary-search on JPEG quality is deliberate: a fixed quality either overshoots the budget
 * on a busy photo or wastes bytes on a plain one.
 */
export const TARGET_BYTES = 300 * 1024
export const MAX_DIMENSION = 1280

export interface CompressResult {
  bytes: Uint8Array
  mimeType: string
  width: number
  height: number
  compressed: boolean
}

export async function compressImage(file: Blob, targetBytes = TARGET_BYTES): Promise<CompressResult> {
  const original = new Uint8Array(await file.arrayBuffer())

  // No canvas (Node, or a very old browser): pass the bytes through untouched.
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return { bytes: original, mimeType: file.type || 'image/jpeg', width: 0, height: 0, compressed: false }
  }

  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return { bytes: original, mimeType: file.type || 'image/jpeg', width: 0, height: 0, compressed: false }
  ctx.drawImage(bitmap, 0, 0, width, height)

  // Binary search JPEG quality for the largest that fits the budget.
  let lo = 0.4
  let hi = 0.92
  let best = await encode(canvas, hi)
  for (let i = 0; i < 6; i++) {
    const q = (lo + hi) / 2
    const candidate = await encode(canvas, q)
    if (candidate.length <= targetBytes) {
      best = candidate
      lo = q
    } else {
      hi = q
    }
  }
  return { bytes: best, mimeType: 'image/jpeg', width, height, compressed: true }
}

async function encode(canvas: OffscreenCanvas, quality: number): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return new Uint8Array(await blob.arrayBuffer())
}
