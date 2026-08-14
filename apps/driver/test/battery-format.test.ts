import { describe, expect, it } from 'vitest'
import {
  type BmsEvidenceProgress,
  type PackState,
  expectedBmsMediaId,
  isBmsPackReady,
  isCurrentEvidenceFile,
  packForNewEvidence,
  restoreBmsEvidenceProgress,
  toText,
} from '../src/screens/BatteryPanel.tsx'

/**
 * The formatter that turns a stored scaled integer into what the driver sees in the field.
 *
 * This is where «100 read as 1» actually lived — for four rounds it was blamed on the OCR, but the
 * reader was handing 100 to a formatter whose trailing-zero trim was inverted: it stripped the
 * zeros off WHOLE numbers (100 → "1", 80 → "8", 20 → "2") and left decimals untouched. A correctly
 * recognised charge was corrupted on its way to the screen and to the server.
 */
describe('the field formatter no longer eats trailing zeros off whole numbers', () => {
  // percent and cycleCount: scale 1, decimals 0
  it('shows a full 100% charge as 100, not 1', () => {
    expect(toText(100, 1, 0)).toBe('100')
  })

  it('keeps every round-number charge intact', () => {
    expect(toText(80, 1, 0)).toBe('80')
    expect(toText(20, 1, 0)).toBe('20')
    expect(toText(10, 1, 0)).toBe('10')
    expect(toText(0, 1, 0)).toBe('0')
  })

  it('leaves a non-round charge alone, as it always did', () => {
    expect(toText(47, 1, 0)).toBe('47')
  })

  // voltage: scale 1000, decimals 2 — the decimal trim that was actually wanted
  it('still trims a decimal field: 50.0 Ah shows as 50', () => {
    expect(toText(500, 10, 1)).toBe('50') // 500 deci-Ah = 50.0 Ah
    expect(toText(5000, 10, 1)).toBe('500') // 5000 deci-Ah = 500.0 Ah
  })

  it('keeps a real decimal: 81.48 V and 33.6 °C', () => {
    expect(toText(81_480, 1000, 2)).toBe('81.48')
    expect(toText(336, 10, 1)).toBe('33.6')
  })

  it('a null reading is an empty field, never a zero', () => {
    expect(toText(null, 1, 0)).toBe('')
  })
})

describe('a replacement BMS screenshot starts a new reader race', () => {
  it('clears old machine values while preserving a human correction', () => {
    const prior: PackState = {
      values: { percent: '66.0', cycleCount: '125' },
      ocrRaw: { percent: 66, cycleCount: 120 },
      outcome: 'ok',
      fieldsFound: 2,
      text: 'old screenshot',
    }

    expect(packForNewEvidence(prior)).toEqual({
      values: { percent: '', cycleCount: '125' },
      ocrRaw: null,
      outcome: 'reading',
      fieldsFound: 0,
      text: '',
    })
  })

  it('rejects a late result from the replaced File object', () => {
    const oldFile = {} as File
    const currentFile = {} as File
    const files = { battery: currentFile }
    expect(isCurrentEvidenceFile(files, 'battery', oldFile)).toBe(false)
    expect(isCurrentEvidenceFile(files, 'battery', currentFile)).toBe(true)
  })

  it('blocks close while the replacement upload is in flight and after upload failure', () => {
    const replacement = {} as File
    const inFlight: BmsEvidenceProgress = {
      file: replacement,
      uploadedMediaId: null,
      persistedMediaId: null,
    }
    const ready = (progress: BmsEvidenceProgress) =>
      isBmsPackReady({ unavailable: false, hasPercent: true, slotUploaded: true, progress })

    // `slotUploaded` is deliberately true: it is the OLD attachment still present in the parent
    // snapshot. Selecting a new File must invalidate that otherwise-ready combination immediately.
    expect(ready(inFlight)).toBe(false)
    // An upload failure produces no accepted media id, so the same state remains incomplete.
    expect(ready({ ...inFlight })).toBe(false)
  })

  it('requires the reading to persist against the exact newly returned media id', () => {
    const replacement = {} as File
    const ready = (progress: BmsEvidenceProgress) =>
      isBmsPackReady({ unavailable: false, hasPercent: true, slotUploaded: true, progress })

    expect(
      ready({ file: replacement, uploadedMediaId: 'media-new', persistedMediaId: null }),
    ).toBe(false)
    expect(
      ready({ file: replacement, uploadedMediaId: 'media-new', persistedMediaId: 'media-old' }),
    ).toBe(false)
    expect(
      ready({ file: replacement, uploadedMediaId: 'media-new', persistedMediaId: 'media-new' }),
    ).toBe(true)
  })
})

describe('a resumed BMS reading keeps its server evidence generation', () => {
  it('edits and remains ready without manufacturing or reuploading a File', () => {
    const restored = restoreBmsEvidenceProgress({ battery: 'media-restored' }).battery!
    expect(restored.file).toBeNull()
    expect(expectedBmsMediaId(restored, undefined)).toBe('media-restored')
    expect(
      isBmsPackReady({
        unavailable: false,
        hasPercent: true,
        slotUploaded: true,
        progress: restored,
      }),
    ).toBe(true)

    // An ordinary edit closes the local gate until the expected-media write returns, then reopens
    // against that same server attachment; no gallery trip is involved.
    const saving = { ...restored, persistedMediaId: null }
    expect(
      isBmsPackReady({ unavailable: false, hasPercent: true, slotUploaded: true, progress: saving }),
    ).toBe(false)
    expect(
      isBmsPackReady({
        unavailable: false,
        hasPercent: true,
        slotUploaded: true,
        progress: { ...saving, persistedMediaId: 'media-restored' },
      }),
    ).toBe(true)
  })

  it('switches back to upload-first when a real new File is selected', () => {
    const replacement = {} as File
    const pending: BmsEvidenceProgress = {
      file: replacement,
      uploadedMediaId: null,
      persistedMediaId: null,
    }
    expect(expectedBmsMediaId(pending, replacement)).toBeNull()
    expect(
      isBmsPackReady({ unavailable: false, hasPercent: true, slotUploaded: true, progress: pending }),
    ).toBe(false)
  })
})
