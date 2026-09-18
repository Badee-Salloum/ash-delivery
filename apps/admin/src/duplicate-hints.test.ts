import { describe, expect, it } from 'vitest'
import {
  type ScanDuplicateHintWire,
  duplicateHintsForDeduction,
  duplicateHintsForOrder,
} from './duplicate-hints.ts'

// The overlap from shift 4f40640e: the last two rows of the `dashboard` page are the first two of
// `dashboard_2`, matched on the printed amount alone because the second page lost its date header.
const HINT: ScanDuplicateHintWire = {
  earlier: { slot: 'dashboard', mediaId: 'media-a' },
  later: { slot: 'dashboard_2', mediaId: 'media-b' },
  length: 2,
  causes: ['scan_overlap_suffix_prefix', 'scan_overlap_amount_only'],
  pairs: [
    {
      earlier: { kind: 'order', providerOrderNo: 'YAL-A3', observationId: 'obs-a3', rowIndex: 3 },
      later: { kind: 'order', providerOrderNo: 'YAL-B0', observationId: 'obs-b0', rowIndex: 0 },
      causes: ['scan_overlap_pair_amount_agrees'],
    },
    {
      earlier: { kind: 'cash_deduction', id: 'ded-a4', observationId: 'obs-a4', rowIndex: 4 },
      later: { kind: 'cash_deduction', id: 'ded-b1', observationId: 'obs-b1', rowIndex: 1 },
      causes: ['scan_overlap_pair_amount_agrees', 'scan_overlap_pair_minute_agrees'],
    },
  ],
}

describe('duplicateHintsForOrder', () => {
  it('names the counterpart row and page for the later sighting', () => {
    const [hint] = duplicateHintsForOrder([HINT], 'YAL-B0')
    expect(hint).toBeDefined()
    expect(hint!.counterpartSlot).toBe('dashboard')
    expect(hint!.counterpartRowIndex).toBe(3)
    expect(hint!.counterpart).toMatchObject({ kind: 'order', providerOrderNo: 'YAL-A3' })
    // This row is the repeat, so it is the one the manager would normally exclude.
    expect(hint!.isLaterSighting).toBe(true)
  })

  it('names the counterpart from the earlier side too, without claiming it is the repeat', () => {
    const [hint] = duplicateHintsForOrder([HINT], 'YAL-A3')
    expect(hint!.counterpartSlot).toBe('dashboard_2')
    expect(hint!.counterpartRowIndex).toBe(0)
    expect(hint!.isLaterSighting).toBe(false)
  })

  it('carries the reason the match was made, so weak evidence reads as weak', () => {
    const [hint] = duplicateHintsForOrder([HINT], 'YAL-B0')
    expect(hint!.causes).toEqual(['scan_overlap_pair_amount_agrees'])
    expect(hint!.pageCauses).toContain('scan_overlap_amount_only')
  })

  it('returns nothing for an order no hint mentions', () => {
    expect(duplicateHintsForOrder([HINT], 'YAL-UNRELATED')).toEqual([])
  })

  it('never confuses a deduction id with an order number', () => {
    expect(duplicateHintsForOrder([HINT], 'ded-a4')).toEqual([])
    expect(duplicateHintsForDeduction([HINT], 'YAL-A3')).toEqual([])
  })

  it('renders nothing when the API predates the field', () => {
    expect(duplicateHintsForOrder(undefined, 'YAL-B0')).toEqual([])
    expect(duplicateHintsForDeduction(undefined, 'ded-b1')).toEqual([])
  })
})

describe('duplicateHintsForDeduction', () => {
  it('resolves a deduction to its counterpart deduction', () => {
    const [hint] = duplicateHintsForDeduction([HINT], 'ded-b1')
    expect(hint!.counterpartSlot).toBe('dashboard')
    expect(hint!.counterpartRowIndex).toBe(4)
    expect(hint!.counterpart).toMatchObject({ kind: 'cash_deduction', id: 'ded-a4' })
    expect(hint!.causes).toContain('scan_overlap_pair_minute_agrees')
  })
})

describe('an unmatched row', () => {
  it('is still named as the counterpart, so a real overlap is not hidden', () => {
    const withCancelled: ScanDuplicateHintWire = {
      ...HINT,
      pairs: [{
        earlier: { kind: 'unmatched_row', observationId: 'obs-a3', rowIndex: 3 },
        later: { kind: 'order', providerOrderNo: 'YAL-B0', observationId: 'obs-b0', rowIndex: 0 },
        causes: ['scan_overlap_pair_amount_agrees'],
      }],
    }
    const [hint] = duplicateHintsForOrder([withCancelled], 'YAL-B0')
    expect(hint!.counterpart.kind).toBe('unmatched_row')
    expect(hint!.counterpartRowIndex).toBe(3)
  })
})
