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
 * whole feature. Every accuracy figure we have for a cloud model was measured on originals. The
 * wallet is the narrow exception: its original pixels are cropped around the orange card (never
 * locally read) so the cloud model sees the small white balance at a useful effective resolution.
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

/** The cloud question can ask for the whole screen or the fixed Yallago wallet card. */
export type OcrImageFocus = 'full' | 'wallet'

export interface ImageRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Crop containing the title + orange Yallago wallet card, excluding the empty lower screen.
 *
 * The live 540×1200 screenshot put the white balance around y=255. Sending all 1200 rows made
 * that first `٢` a small feature and the model called it `٣`; this crop gives the balance over
 * twice the effective resolution. Ratios keep it stable across Android screenshot sizes, while a
 * landscape fallback keeps the upper two-thirds rather than assuming portrait geometry.
 */
export function walletBalanceFocusRect(width: number, height: number): ImageRect {
  if (width <= 0 || height <= 0) return { x: 0, y: 0, width: Math.max(0, width), height: Math.max(0, height) }
  if (height <= width) return { x: 0, y: 0, width, height: Math.max(1, Math.round(height * 0.67)) }
  const y = Math.round(height * 0.1)
  const focusHeight = Math.min(height - y, Math.max(1, Math.round(height * 0.39)))
  return { x: 0, y, width, height: focusHeight }
}

export interface CompressResult {
  bytes: Uint8Array
  mimeType: string
  width: number
  height: number
  compressed: boolean
}

interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
  dispose(): void
}

type UploadableImageMime = 'image/jpeg' | 'image/png' | 'image/webp'

/**
 * Match the server's magic-byte check before deciding that untouched bytes are safe to send.
 * Android content providers are allowed to return an empty or misleading `Blob.type`, and HEIC
 * must be converted to JPEG rather than slipping through under that declaration.
 */
function uploadableImageMime(bytes: Uint8Array): UploadableImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png'
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF' &&
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP'
  ) return 'image/webp'
  return null
}

type CanvasSurface =
  | { kind: 'offscreen'; canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D }
  | { kind: 'dom'; canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }

const IMAGE_OPERATION_TIMEOUT_MS = 10_000

function timeLimit<T>(
  operation: Promise<T>,
  errorCode: string,
  disposeLate?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      settled = true
      reject(new Error(errorCode))
    }, IMAGE_OPERATION_TIMEOUT_MS)
    operation.then(
      (value) => {
        if (settled) {
          disposeLate?.(value)
          return
        }
        settled = true
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

/** Decode through the modern API, then fall back to the older Android DOM image path. */
async function decodeImage(file: Blob): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await timeLimit(
        createImageBitmap(file),
        'image_decode_timeout',
        (late) => {
          try {
            late.close()
          } catch {
            // A timed-out decoder owns no live image, even if its partial implementation objects.
          }
        },
      )
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => {
          try {
            if (typeof bitmap.close === 'function') bitmap.close()
          } catch {
            // Cleanup must not turn a successfully encoded upload into a preparation failure.
          }
        },
      }
    } catch {
      // Some Android WebViews expose createImageBitmap but fail to decode camera JPEGs through it.
    }
  }

  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) return null

  let objectUrl: string
  try {
    objectUrl = URL.createObjectURL(file)
  } catch {
    return null
  }

  let image: HTMLImageElement
  try {
    image = document.createElement('img')
  } catch {
    try {
      URL.revokeObjectURL(objectUrl)
    } catch {
      // Best-effort cleanup in a partial URL implementation.
    }
    return null
  }
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    image.onload = null
    image.onerror = null
    try {
      image.src = ''
    } catch {
      // A synthetic or already-detached WebView image can reject clearing its source.
    }
    try {
      URL.revokeObjectURL(objectUrl)
    } catch {
      // Revocation is cleanup; it must not turn a successfully prepared image into a failure.
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        image.onload = null
        image.onerror = null
        if (error) reject(error)
        else resolve()
      }
      const timeout = setTimeout(() => finish(new Error('image_decode_timeout')), IMAGE_OPERATION_TIMEOUT_MS)
      image.onload = () => finish()
      image.onerror = () => finish(new Error('image_decode_failed'))
      try {
        image.src = objectUrl
      } catch {
        finish(new Error('image_decode_failed'))
      }
    })
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      release()
      return null
    }
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: release,
    }
  } catch {
    release()
    return null
  }
}

/** DOM canvas is the broadest phone path; OffscreenCanvas remains the worker/non-DOM fallback. */
function canvasSurface(width: number, height: number): CanvasSurface | null {
  if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (context && typeof canvas.toBlob === 'function') return { kind: 'dom', canvas, context }
    } catch {
      // Some WebViews expose a partial DOM canvas; try the independent offscreen path below.
    }
  }
  if (typeof OffscreenCanvas !== 'function') return null
  try {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    return context ? { kind: 'offscreen', canvas, context } : null
  } catch {
    return null
  }
}

async function encodeSurface(surface: CanvasSurface, quality: number): Promise<Uint8Array> {
  const blob = surface.kind === 'offscreen'
    ? typeof surface.canvas.convertToBlob === 'function'
      ? await timeLimit(
          surface.canvas.convertToBlob({ type: 'image/jpeg', quality }),
          'image_encode_timeout',
        )
      : await Promise.reject(new Error('image_encode_unavailable'))
    : await new Promise<Blob>((resolve, reject) => {
        if (typeof surface.canvas.toBlob !== 'function') {
          reject(new Error('image_encode_unavailable'))
          return
        }
        let settled = false
        const finish = (value: Blob | null, error?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          if (error) reject(error)
          else if (value) resolve(value)
          else reject(new Error('image_encode_failed'))
        }
        const timeout = setTimeout(
          () => finish(null, new Error('image_encode_timeout')),
          IMAGE_OPERATION_TIMEOUT_MS,
        )
        try {
          surface.canvas.toBlob((value) => finish(value), 'image/jpeg', quality)
        } catch {
          finish(null, new Error('image_encode_failed'))
        }
      })
  return new Uint8Array(await blob.arrayBuffer())
}

export async function compressImage(file: Blob, targetBytes = TARGET_BYTES): Promise<CompressResult> {
  const original = new Uint8Array(await file.arrayBuffer())
  const originalMime = uploadableImageMime(original)
  const passthrough: CompressResult | null = originalMime
    ? { bytes: original, mimeType: originalMime, width: 0, height: 0, compressed: false }
    : null

  const image = await decodeImage(file)
  if (!image) {
    if (passthrough) return passthrough
    throw new Error('unsupported_image_format')
  }
  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(image.width, image.height))
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const surface = canvasSurface(width, height)
    if (!surface) {
      if (passthrough) return passthrough
      throw new Error('image_encode_unavailable')
    }
    surface.context.drawImage(image.source, 0, 0, width, height)

    // Binary search JPEG quality for the largest that fits the budget. `best` starts at the
    // lowest quality so a dense image can never accidentally return the largest attempted encode.
    let lo = 0.4
    let hi = 0.92
    let best = await encodeSurface(surface, lo)
    for (let i = 0; i < 6; i++) {
      const q = (lo + hi) / 2
      const candidate = await encodeSurface(surface, q)
      if (candidate.length <= targetBytes) {
        best = candidate
        lo = q
      } else {
        hi = q
      }
    }
    return { bytes: best, mimeType: 'image/jpeg', width, height, compressed: true }
  } catch (error) {
    if (passthrough) return passthrough
    throw error
  } finally {
    image.dispose()
  }
}

/**
 * The copy sent to the cloud reader. See `OCR_MAX_DIMENSION` above for why this is not
 * `compressImage`.
 *
 * Returns `null` when the result would still be too large for the request body. The caller reports
 * an AI failure and leaves explicit typing available; phone OCR remains training evidence and is
 * never promoted to money. Refusing to send is better than a 413 the driver has to interpret.
 */
export async function compressForOcr(file: Blob, focus: OcrImageFocus = 'full'): Promise<CompressResult | null> {
  const original = new Uint8Array(await file.arrayBuffer())
  const originalMime = uploadableImageMime(original)
  const passthrough: CompressResult | null = originalMime
    ? { bytes: original, mimeType: originalMime, width: 0, height: 0, compressed: false }
    : null

  const image = await decodeImage(file)
  if (!image) {
    if (!passthrough) throw new Error('unsupported_image_format')
    return original.length <= OCR_MAX_BYTES ? passthrough : null
  }
  try {
    const longEdge = Math.max(image.width, image.height)

    if (focus === 'wallet') {
      const rect = walletBalanceFocusRect(image.width, image.height)
      // Cropping is the accuracy lever. Upscaling no more than 3× does not manufacture detail, but
      // it prevents the provider's own whole-screen resize from shrinking the white glyphs again.
      const scale = Math.min(3, OCR_MAX_DIMENSION / Math.max(rect.width, rect.height))
      const width = Math.max(1, Math.round(rect.width * scale))
      const height = Math.max(1, Math.round(rect.height * scale))
      const surface = canvasSurface(width, height)
      if (!surface) {
        if (!passthrough) throw new Error('image_encode_unavailable')
        return original.length <= OCR_MAX_BYTES ? passthrough : null
      }
      surface.context.drawImage(image.source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height)
      let bytes = await encodeSurface(surface, 0.95)
      if (bytes.length > OCR_MAX_BYTES) bytes = await encodeSurface(surface, OCR_QUALITY)
      if (bytes.length > OCR_MAX_BYTES) bytes = await encodeSurface(surface, 0.7)
      if (bytes.length > OCR_MAX_BYTES) return null
      return { bytes, mimeType: 'image/jpeg', width, height, compressed: true }
    }

    // Already small enough in both dimensions and bytes: send the ORIGINAL pixels. Re-encoding a
    // screenshot that is already 40 KB would cost detail and save nothing.
    if (passthrough && longEdge <= OCR_MAX_DIMENSION && original.length <= OCR_MAX_BYTES) return passthrough

    const scale = Math.min(1, OCR_MAX_DIMENSION / longEdge)
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const surface = canvasSurface(width, height)
    if (!surface) {
      if (!passthrough) throw new Error('image_encode_unavailable')
      return original.length <= OCR_MAX_BYTES ? passthrough : null
    }
    surface.context.drawImage(image.source, 0, 0, width, height)

    let bytes = await encodeSurface(surface, OCR_QUALITY)
    // A 2000 px photo at q0.85 is normally well under the cap. If it is not — a very noisy camera
    // shot — step down once rather than binary-searching toward the recognition floor.
    if (bytes.length > OCR_MAX_BYTES) bytes = await encodeSurface(surface, 0.7)
    if (bytes.length > OCR_MAX_BYTES) return null

    return { bytes, mimeType: 'image/jpeg', width, height, compressed: true }
  } catch (error) {
    if (passthrough) return original.length <= OCR_MAX_BYTES ? passthrough : null
    throw error
  } finally {
    image.dispose()
  }
}
