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

/**
 * A SECOND profile, for the copy sent to the cloud reader — not the copy stored as evidence.
 *
 * The evidence settings above exist to make a photo cheap to keep, and they work: 1280 px at
 * quality 0.4 lands near 300 KB. They also make it unreadable. `PhotoSlot` says so directly — that
 * compression "puts a phone screenshot's body text at roughly 10–13 px of x-height, below what
 * Tesseract's LSTM can read" — and migration 0019 calls it the single largest accuracy lever in the
 * whole feature. Every accuracy figure we have for a cloud model was measured on ORIGINALS.
 *
 * So the reader gets its own profile, and it is barely a compression at all:
 *
 *   • 2000 px matches `OCR_MAX_DIMENSION` in the on-device reader, which downscales to exactly this
 *     before recognising. Sending more pixels than our own reader uses buys nothing.
 *   • Quality 0.85 is high enough that JPEG ringing does not close the gap between ٢ and ٣.
 *   • An image already inside both limits is passed through UNTOUCHED. This is the normal case:
 *     the screenshots in the benchmark corpus are 21–170 KB, often SMALLER than the compressed
 *     evidence copy of the same photo. Re-encoding them would only lose detail.
 *
 * The one case this really bites is the odometer, which is a camera photograph rather than a
 * screenshot and can be several megabytes — above Vercel's request body limit and painful on a
 * Damascus connection. That is the case the cap is for.
 */
export const OCR_MAX_DIMENSION = 2000
export const OCR_QUALITY = 0.85
/** Comfortably inside Vercel's ~4.5 MB body cap, with room for the request around it. */
export const OCR_MAX_BYTES = 4 * 1024 * 1024

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
  //
  // `best` is seeded with the LOWEST quality, not the highest. Seeded with hi, an image that
  // cannot reach the budget even at q=0.4 — a dense, noisy screenshot full of text and gridlines
  // is exactly that — never assigned inside the loop and the function returned the q=0.92 bytes:
  // the largest encode it produced, from the routine whose whole job is to keep uploads small.
  let lo = 0.4
  let hi = 0.92
  let best = await encode(canvas, lo)
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

/**
 * The copy sent to the cloud reader. See `OCR_MAX_DIMENSION` above for why this is not
 * `compressImage`.
 *
 * Returns `null` when the result would still be too large for the request body — the caller then
 * skips the cloud read and keeps the on-device one, which is exactly what it does with no network.
 * Refusing to send is better than a 413 the driver has to interpret.
 */
export async function compressForOcr(file: Blob): Promise<CompressResult | null> {
  const original = new Uint8Array(await file.arrayBuffer())
  const passthrough: CompressResult = {
    bytes: original,
    mimeType: file.type || 'image/jpeg',
    width: 0,
    height: 0,
    compressed: false,
  }

  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return original.length <= OCR_MAX_BYTES ? passthrough : null
  }

  const bitmap = await createImageBitmap(file)
  const longEdge = Math.max(bitmap.width, bitmap.height)

  // Already small enough in both dimensions and bytes: send the ORIGINAL pixels. Re-encoding a
  // screenshot that is already 40 KB would cost detail and save nothing.
  if (longEdge <= OCR_MAX_DIMENSION && original.length <= OCR_MAX_BYTES) return passthrough

  const scale = Math.min(1, OCR_MAX_DIMENSION / longEdge)
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return original.length <= OCR_MAX_BYTES ? passthrough : null
  ctx.drawImage(bitmap, 0, 0, width, height)

  let bytes = await encode(canvas, OCR_QUALITY)
  // A 2000 px photo at q0.85 is normally well under the cap. If it is not — a very noisy camera
  // shot — step down once rather than binary-searching toward the recognition floor.
  if (bytes.length > OCR_MAX_BYTES) bytes = await encode(canvas, 0.7)
  if (bytes.length > OCR_MAX_BYTES) return null

  return { bytes, mimeType: 'image/jpeg', width, height, compressed: true }
}

async function encode(canvas: OffscreenCanvas, quality: number): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return new Uint8Array(await blob.arrayBuffer())
}
