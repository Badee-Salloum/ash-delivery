import { afterEach, describe, expect, it, vi } from 'vitest'
import { compressForOcr, walletBalanceFocusRect } from '../src/compress.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

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
    const original = new Uint8Array([9, 8, 7])
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 540, height: 1200 })))
    const result = await compressForOcr(new Blob([original], { type: 'image/png' }), 'full')
    expect(result?.compressed).toBe(false)
    expect(result?.bytes).toEqual(original)
  })
})
