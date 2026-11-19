import { describe, expect, it } from 'vitest'
import { evidenceImageSize } from './evidence-image-fit.ts'
describe('uploaded photo viewport fit', () => {
  it('fits a tall screenshot to the available height, not the page width', () => {
    expect(evidenceImageSize(1080, 6000, 1400, 720)).toEqual({ width: 129.6, height: 720 })
  })
  it('fits wide photos without distortion', () => {
    expect(evidenceImageSize(4000, 1000, 360, 600)).toEqual({ width: 360, height: 90 })
  })
  it('zooms from the fitted dimensions', () => {
    expect(evidenceImageSize(1080, 6000, 1400, 720, 2)).toEqual({ width: 259.2, height: 1440 })
  })
  it('adapts to mobile rotation and keeps small originals sharp', () => {
    expect(evidenceImageSize(1000, 2000, 360, 600)).toEqual({ width: 300, height: 600 })
    expect(evidenceImageSize(1000, 2000, 780, 240)).toEqual({ width: 120, height: 240 })
    expect(evidenceImageSize(100, 200, 1400, 720)).toEqual({ width: 100, height: 200 })
  })
  it('waits for real image and viewport dimensions', () => {
    expect(evidenceImageSize(0, 200, 1400, 720)).toBeNull()
    expect(evidenceImageSize(100, 200, 0, 0)).toBeNull()
    expect(evidenceImageSize(NaN, 200, 1400, 720)).toBeNull()
  })
})
