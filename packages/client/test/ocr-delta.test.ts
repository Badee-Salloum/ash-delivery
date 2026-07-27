import { describe, expect, it } from 'vitest'
import { ocrReadingDelta } from '../src/ocr-delta.ts'

/**
 * SRS D-3: the difference between what OCR read and what the driver confirmed. The helper is the
 * pure core the manager's review renders; these pin the four behaviours that matter.
 */
const KEYS = ['percent', 'packMillivolts', 'cycleCount'] as const

describe('ocrReadingDelta (SRS D-3)', () => {
  it('returns nothing when OCR never ran (ocrRaw null)', () => {
    expect(ocrReadingDelta(KEYS, null, { percent: 90 })).toEqual([])
    expect(ocrReadingDelta(KEYS, undefined, { percent: 90 })).toEqual([])
  })

  it('returns nothing when every field is null on both sides', () => {
    expect(ocrReadingDelta(KEYS, { percent: null, packMillivolts: null, cycleCount: null }, { percent: null })).toEqual([])
  })

  it('omits a field the driver confirmed unchanged (a confirmation, not an edit)', () => {
    expect(ocrReadingDelta(KEYS, { percent: 90 }, { percent: 90 })).toEqual([])
  })

  it('reports an edited field with both values', () => {
    expect(ocrReadingDelta(KEYS, { percent: 90 }, { percent: 88 })).toEqual([
      { key: 'percent', ocr: 90, confirmed: 88, kind: 'edited' },
    ])
  })

  it('reports a field OCR left blank that the driver filled', () => {
    expect(ocrReadingDelta(KEYS, { cycleCount: null }, { cycleCount: 12 })).toEqual([
      { key: 'cycleCount', ocr: null, confirmed: 12, kind: 'filled' },
    ])
  })

  it('reports several fields at once and preserves key order', () => {
    const deltas = ocrReadingDelta(
      KEYS,
      { percent: 90, packMillivolts: 83_370, cycleCount: null },
      { percent: 88, packMillivolts: 83_370, cycleCount: 5 },
    )
    expect(deltas).toEqual([
      { key: 'percent', ocr: 90, confirmed: 88, kind: 'edited' },
      { key: 'cycleCount', ocr: null, confirmed: 5, kind: 'filled' },
    ])
  })
})
