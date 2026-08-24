import { afterEach, describe, expect, it, vi } from 'vitest'
import { compressForOcr, compressImage, walletBalanceFocusRect } from '../src/compress.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const HEIC_BYTES = new TextEncoder().encode('\u0000\u0000\u0000\u0018ftypheiccamera')

describe('wallet AI image focus', () => {
  it('covers the orange wallet card in the live 540×1200 Android layout', () => {
    const rect = walletBalanceFocusRect(540, 1200)
    expect(rect).toEqual({ x: 0, y: 120, width: 540, height: 468 })
    // The live balance baseline was around y=255; pin that it cannot drift outside the focus crop.
    expect(255).toBeGreaterThanOrEqual(rect.y)
    expect(255).toBeLessThan(rect.y + rect.height)
  })

  it('keeps the upper portion on a landscape screenshot', () => {
    expect(walletBalanceFocusRect(1200, 540)).toEqual({ x: 0, y: 0, width: 1200, height: 362 })
  })

  it('crops and magnifies a wallet before the authoritative cloud upload', async () => {
    const bitmap = { width: 540, height: 1200 }
    const draws: unknown[][] = []
    const canvases: Array<{ width: number; height: number }> = []

    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        readonly width: number
        readonly height: number
        constructor(width: number, height: number) {
          this.width = width
          this.height = height
          canvases.push({ width, height })
        }
        getContext(): { drawImage: (...args: unknown[]) => void } {
          return { drawImage: (...args: unknown[]) => draws.push(args) }
        }
        async convertToBlob(): Promise<Blob> {
          return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
        }
      },
    )

    const result = await compressForOcr(new Blob([new Uint8Array([9])], { type: 'image/png' }), 'wallet')

    expect(canvases).toEqual([{ width: 1620, height: 1404 }])
    expect(draws).toEqual([[bitmap, 0, 120, 540, 468, 0, 0, 1620, 1404]])
    expect(result).toMatchObject({ mimeType: 'image/jpeg', width: 1620, height: 1404, compressed: true })
    expect(result?.bytes).not.toEqual(new Uint8Array([9]))
  })

  it('leaves a small non-wallet screenshot byte-for-byte untouched', async () => {
    const original = PNG_BYTES
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 540, height: 1200 })))
    const result = await compressForOcr(new Blob([original], { type: 'image/png' }), 'full')
    expect(result?.compressed).toBe(false)
    expect(result?.bytes).toEqual(original)
  })

  it('falls back to DOM image and canvas APIs when an older Android bitmap decoder fails', async () => {
    const draws: unknown[][] = []
    const revoked: string[] = []
    const image: {
      naturalWidth: number
      naturalHeight: number
      onload: (() => void) | null
      onerror: (() => void) | null
      src: string
    } = {
      naturalWidth: 2400,
      naturalHeight: 1200,
      onload: null,
      onerror: null,
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      },
      get src() {
        return 'blob:camera-photo'
      },
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: (...args: unknown[]) => draws.push(args) }),
      toBlob: (done: (blob: Blob | null) => void) => done(new Blob([new Uint8Array([1, 2, 3])])),
    }

    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decoder unavailable') }))
    vi.stubGlobal('OffscreenCanvas', class {
      constructor() {
        throw new Error('partial WebView OffscreenCanvas')
      }
    })
    vi.stubGlobal('document', {
      createElement: (tag: string) => tag === 'img' ? image : canvas,
    })
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:camera-photo',
      revokeObjectURL: (url: string) => revoked.push(url),
    })

    const result = await compressImage(new Blob([new Uint8Array([9])], { type: 'image/jpeg' }))

    expect(result).toMatchObject({ compressed: true, width: 1280, height: 640, mimeType: 'image/jpeg' })
    expect(draws[0]).toEqual([image, 0, 0, 1280, 640])
    expect(revoked).toEqual(['blob:camera-photo'])
  })

  it('converts a decoded small HEIC instead of passing a server-unsupported MIME through', async () => {
    const close = vi.fn()
    const bitmap = { width: 540, height: 1200, close }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        readonly width: number
        readonly height: number
        constructor(width: number, height: number) {
          this.width = width
          this.height = height
        }
        getContext(): { drawImage: () => void } {
          return { drawImage: () => undefined }
        }
        async convertToBlob(): Promise<Blob> {
          return new Blob([JPEG_BYTES], { type: 'image/jpeg' })
        }
      },
    )

    const result = await compressForOcr(new Blob([HEIC_BYTES], { type: 'image/heic' }), 'full')

    expect(result).toMatchObject({ compressed: true, mimeType: 'image/jpeg', width: 540, height: 1200 })
    expect(result?.bytes).toEqual(JPEG_BYTES)
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects an undecodable HEIC locally and revokes its fallback object URL exactly once', async () => {
    const revoked: string[] = []
    const image = {
      naturalWidth: 0,
      naturalHeight: 0,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.())
      },
    }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported') }))
    vi.stubGlobal('document', { createElement: () => image })
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:heic',
      revokeObjectURL: (url: string) => revoked.push(url),
    })

    await expect(compressForOcr(new Blob([HEIC_BYTES], { type: 'image/heic' }))).rejects.toThrow(
      'unsupported_image_format',
    )
    expect(revoked).toEqual(['blob:heic'])
  })

  it('revokes an object URL if a partial DOM cannot even create an image element', async () => {
    const revoked: string[] = []
    vi.stubGlobal('createImageBitmap', undefined)
    vi.stubGlobal('document', { createElement: () => { throw new Error('broken DOM') } })
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:jpeg',
      revokeObjectURL: (url: string) => revoked.push(url),
    })

    const result = await compressImage(new Blob([JPEG_BYTES], { type: 'image/jpeg' }))

    expect(result).toMatchObject({ compressed: false, mimeType: 'image/jpeg' })
    expect(revoked).toEqual(['blob:jpeg'])
  })

  it('times out a wedged DOM decoder and releases its object URL', async () => {
    vi.useFakeTimers()
    const revoked: string[] = []
    const image = {
      naturalWidth: 0,
      naturalHeight: 0,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      src: '',
    }
    vi.stubGlobal('createImageBitmap', undefined)
    vi.stubGlobal('document', { createElement: () => image })
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:wedged-heic',
      revokeObjectURL: (url: string) => revoked.push(url),
    })

    const pending = compressForOcr(new Blob([HEIC_BYTES], { type: 'image/heic' }))
    const rejection = expect(pending).rejects.toThrow('unsupported_image_format')
    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
    expect(revoked).toEqual(['blob:wedged-heic'])
  })

  it('falls back from a wedged bitmap decoder and closes its late result', async () => {
    vi.useFakeTimers()
    const lateClose = vi.fn()
    let finishBitmap: (value: { width: number; height: number; close(): void }) => void = () => undefined
    const bitmap = new Promise<{ width: number; height: number; close(): void }>((resolve) => {
      finishBitmap = resolve
    })
    const revoked: string[] = []
    const image = {
      naturalWidth: 2400,
      naturalHeight: 1200,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      },
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => undefined }),
      toBlob: (done: (blob: Blob | null) => void) => done(new Blob([JPEG_BYTES])),
    }
    vi.stubGlobal('createImageBitmap', vi.fn(() => bitmap))
    vi.stubGlobal('document', { createElement: (tag: string) => tag === 'img' ? image : canvas })
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:bitmap-timeout',
      revokeObjectURL: (url: string) => revoked.push(url),
    })

    const pending = compressImage(new Blob([JPEG_BYTES], { type: 'image/jpeg' }))
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await pending

    expect(result.compressed).toBe(true)
    expect(revoked).toEqual(['blob:bitmap-timeout'])
    finishBitmap({ width: 1, height: 1, close: lateClose })
    await Promise.resolve()
    expect(lateClose).toHaveBeenCalledOnce()
  })

  it('times out a DOM encoder and closes the decoded bitmap', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 540, height: 1200, close })))
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined }),
        toBlob: () => undefined,
      }),
    })

    const pending = compressForOcr(new Blob([HEIC_BYTES], { type: 'image/heic' }))
    const rejection = expect(pending).rejects.toThrow('image_encode_timeout')
    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
    expect(close).toHaveBeenCalledOnce()
  })

  it('uses OffscreenCanvas when a partial DOM canvas has no encoder', async () => {
    const bitmap = { width: 2400, height: 1200, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => undefined }) }),
    })
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(_width: number, _height: number) {}
        getContext(): { drawImage: () => void } {
          return { drawImage: () => undefined }
        }
        async convertToBlob(): Promise<Blob> {
          return new Blob([JPEG_BYTES])
        }
      },
    )

    const result = await compressImage(new Blob([HEIC_BYTES], { type: 'image/heic' }))

    expect(result).toMatchObject({ compressed: true, mimeType: 'image/jpeg' })
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
})
