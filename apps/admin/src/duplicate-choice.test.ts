import { describe, expect, it } from 'vitest'
import {
  duplicateChoiceKey,
  duplicateChoiceRevision,
  duplicateChoiceView,
  type DuplicateChoiceRow,
  type DuplicateChoiceTarget,
  type DuplicateChoiceView,
} from './duplicate-choice.ts'

/**
 * The decision that produced 21 rows for 10 deliveries.
 *
 * These tests pin two things: the screen never invents a counterpart it cannot show, and one click
 * changes exactly the rows that need changing — in EITHER direction, which is the part the current
 * single-row «تثبيت كتكرار» cannot do.
 */

const row = (over: Partial<DuplicateChoiceRow> = {}): DuplicateChoiceRow => ({
  amount: '165.00',
  occurredMinute: null,
  occurredDate: '2026-08-31',
  included: true,
  hasScanOrigin: true,
  ...over,
})

const ORDER_A: DuplicateChoiceTarget = { kind: 'order', providerOrderNo: 'A' }
const ORDER_B: DuplicateChoiceTarget = { kind: 'order', providerOrderNo: 'B' }

const build = (
  selfRow: DuplicateChoiceRow,
  otherRow: DuplicateChoiceRow | null,
  counterpart = { kind: 'order' as const, providerOrderNo: 'B', observationId: 'o2', rowIndex: 2 },
): DuplicateChoiceView | null =>
  duplicateChoiceView({
    self: { target: ORDER_A, row: selfRow, slot: 'dashboard_2', rowIndex: 3 },
    hint: {
      counterpart,
      counterpartSlot: 'dashboard',
      counterpartRowIndex: 2,
      causes: ['scan_overlap_pair_amount_agrees', 'scan_overlap_pair_route_agrees'],
    },
    lookup: () => otherRow,
  })

describe('duplicateChoiceView', () => {
  it('pairs the two operations with the page and row each was read from', () => {
    const view = build(row(), row({ occurredMinute: '12:08' }))!
    expect(view.self.key).toBe('order:A')
    expect(view.counterpart.key).toBe('order:B')
    expect(view.self.slot).toBe('dashboard_2')
    expect(view.self.rowIndex).toBe(3)
    expect(view.counterpart.slot).toBe('dashboard')
    expect(view.counterpart.rowIndex).toBe(2)
    expect(view.agreements).toEqual([
      'scan_overlap_pair_amount_agrees',
      'scan_overlap_pair_route_agrees',
    ])
  })

  it('names the difference that actually distinguishes them', () => {
    const view = build(row(), row({ occurredMinute: '12:08' }))!
    expect(view.differences).toEqual(['minute'])
  })

  it('reads the printed clock off the table without pre-selecting it', () => {
    // Decision 16 makes the printed time the identity, so the timed side is the natural candidate.
    // It is surfaced as a fact and nothing more: there is no `selected`, no default — a pre-checked
    // radio beside a save button means one click excludes a real delivery.
    const view = build(row(), row({ occurredMinute: '12:08' }))!
    expect(view.timedKey).toBe('order:B')
    expect(view).not.toHaveProperty('selected')
  })

  it('says nothing about which to keep when both, or neither, carry a clock', () => {
    expect(build(row({ occurredMinute: '11:46' }), row({ occurredMinute: '12:08' }))!.timedKey).toBeNull()
    expect(build(row(), row())!.timedKey).toBeNull()
    // An empty string is the form's «no clock», not a clock.
    expect(build(row({ occurredMinute: '' }), row({ occurredMinute: '12:08' }))!.timedKey).toBe('order:B')
  })

  it('refuses a comparison when the other sighting never became an operation', () => {
    // `unmatched_row`: there is no second operation, so there is nothing to choose between. The
    // card falls back to the plain position note rather than drawing a phantom column.
    expect(build(row(), row(), { kind: 'unmatched_row', observationId: 'o2', rowIndex: 2 } as never)).toBeNull()
  })

  it('refuses when the named row is not in this snapshot', () => {
    expect(build(row(), null)).toBeNull()
  })

  it('refuses to offer a row against itself', () => {
    const view = duplicateChoiceView({
      self: { target: ORDER_A, row: row(), slot: 'dashboard', rowIndex: 1 },
      hint: {
        counterpart: { kind: 'order', providerOrderNo: 'A', observationId: 'o1', rowIndex: 1 },
        counterpartSlot: 'dashboard',
        counterpartRowIndex: 1,
        causes: [],
      },
      lookup: () => row(),
    })
    expect(view).toBeNull()
  })

  it('compares across kinds, because one printed row can be read as either', () => {
    // Decision 12: a negative row is a cash deduction, never an order. Two reads of one screen can
    // disagree about the sign, and then the pair genuinely crosses kinds.
    const view = duplicateChoiceView({
      self: { target: ORDER_A, row: row(), slot: 'dashboard', rowIndex: 1 },
      hint: {
        counterpart: { kind: 'cash_deduction', id: 'd-1', observationId: 'o2', rowIndex: 4 },
        counterpartSlot: 'dashboard_2',
        counterpartRowIndex: 4,
        causes: ['scan_overlap_pair_amount_agrees'],
      },
      lookup: () => row({ included: false }),
    })!
    expect(view.counterpart.key).toBe('cash_deduction:d-1')
    expect(view.differences).toEqual(['inclusion'])
  })
})

describe('duplicateChoiceRevision', () => {
  const REASON = 'صفّان لتوصيلة واحدة'

  it('excludes the row the manager did not choose', () => {
    const view = build(row(), row({ occurredMinute: '12:08' }))!
    expect(duplicateChoiceRevision(view, 'order:B', REASON)).toEqual({
      orders: [{ providerOrderNo: 'A', included: false, reason: REASON }],
      cashDeductions: [],
    })
  })

  it('works in the OTHER direction, which is the whole point', () => {
    // «تثبيت كتكرار» acts on the displayed row only. When the displayed row is the good one, a
    // manager today has to hunt down the other card — so he does not, and both stay counted.
    const view = build(row(), row({ occurredMinute: '12:08' }))!
    expect(duplicateChoiceRevision(view, 'order:A', REASON)).toEqual({
      orders: [{ providerOrderNo: 'B', included: false, reason: REASON }],
      cashDeductions: [],
    })
  })

  it('brings the chosen row back when it was the excluded one', () => {
    const view = build(row({ included: false }), row({ occurredMinute: '12:08' }))!
    expect(duplicateChoiceRevision(view, 'order:A', REASON)).toEqual({
      orders: [
        { providerOrderNo: 'A', included: true, reason: REASON },
        { providerOrderNo: 'B', included: false, reason: REASON },
      ],
      cashDeductions: [],
    })
  })

  it('posts nothing when the answer is already what the books say', () => {
    // Re-asserting a value a row already holds still rotates `orders_hash` and forces a full
    // re-review for nothing.
    const view = build(row({ included: false }), row({ occurredMinute: '12:08', included: true }))!
    expect(duplicateChoiceRevision(view, 'order:B', REASON)).toBeNull()
  })

  it('addresses a deduction by id and an order by number', () => {
    const view = duplicateChoiceView({
      self: { target: ORDER_A, row: row(), slot: 'dashboard', rowIndex: 1 },
      hint: {
        counterpart: { kind: 'cash_deduction', id: 'd-1', observationId: 'o2', rowIndex: 4 },
        counterpartSlot: 'dashboard_2',
        counterpartRowIndex: 4,
        causes: [],
      },
      lookup: () => row(),
    })!
    expect(duplicateChoiceRevision(view, 'order:A', REASON)).toEqual({
      orders: [],
      cashDeductions: [{ id: 'd-1', included: false, reason: REASON }],
    })
  })

  it('refuses a key that names neither side', () => {
    const view = build(row(), row({ occurredMinute: '12:08' }))!
    expect(duplicateChoiceRevision(view, 'order:ZZZ', REASON)).toBeNull()
  })
})

describe('duplicateChoiceKey', () => {
  it('keeps the two kinds apart', () => {
    expect(duplicateChoiceKey(ORDER_B)).toBe('order:B')
    expect(duplicateChoiceKey({ kind: 'cash_deduction', id: 'B' })).toBe('cash_deduction:B')
  })
})
