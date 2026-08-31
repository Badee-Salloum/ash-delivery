import { describe, expect, it } from 'vitest'
import { identityKeyFor } from '../src/close-draft.service.ts'

/**
 * The printed identity of a scanned row — date + clock + cost — is what decision 16 merges on, and
 * it is the only thing that can pair two reads of one screen once a retake has rotated the
 * attachment token and made every `clientKey` new.
 *
 * It was built by TWO recipes that could not agree. A freshly scanned row used the unpadded printed
 * hour and the raw OCR money string (`8:00` / `155`); a row rehydrated from `shift_orders` used the
 * stored padded minute and `serializeMoney` (`08:00` / `155.00`). Different strings, different
 * SHA-256 — so a rehydrated row could never match a freshly scanned one for any hour 0-9, which is
 * every morning shift, and never at all unless the reader happened to emit two decimals.
 *
 * Nothing asserted either key's value, in either path. This file is that assertion.
 */
describe('the printed identity of a scanned row', () => {
  it('is the same however the hour and the money were written', () => {
    // The exact drift: the scan side's shape against the rehydration side's shape.
    expect(identityKeyFor('orders', '2026-08-16', '8:00', '155'))
      .toBe(identityKeyFor('orders', '2026-08-16', '08:00', '155.00'))
  })

  it('ignores the AM/PM marker, so a retake that makes it legible merges', () => {
    // `normalizePrintedClock` strips the marker before this sees it, and the fold to a 12-hour form
    // keeps a resolved 13:00 equal to the 1:00 that was printed. That is what lets a rephoto heal a
    // row instead of duplicating it — the property the orphan-rebind pass relies on.
    expect(identityKeyFor('orders', '2026-08-16', '1:00', '155.00'))
      .toBe(identityKeyFor('orders', '2026-08-16', '13:00', '155.00'))
  })

  it('still separates genuinely different days, minutes and costs', () => {
    const base = identityKeyFor('orders', '2026-08-16', '08:00', '155.00')
    expect(identityKeyFor('orders', '2026-08-15', '08:00', '155.00')).not.toBe(base)
    expect(identityKeyFor('orders', '2026-08-16', '08:01', '155.00')).not.toBe(base)
    expect(identityKeyFor('orders', '2026-08-16', '08:00', '155.01')).not.toBe(base)
    // Cash deductions carry a negative cost and must never collide with the order of equal size.
    expect(identityKeyFor('orders', '2026-08-16', '08:00', '-155.00')).not.toBe(base)
  })

  it('is null unless date, clock and cost are all present', () => {
    // The guard decision 16 turns on: without all three there is no identity, so `mergeLinkedRows`
    // does not even attempt a match and the row is kept as its own operation.
    expect(identityKeyFor('orders', null, '08:00', '155.00')).toBeNull()
    expect(identityKeyFor('orders', '2026-08-16', null, '155.00')).toBeNull()
    expect(identityKeyFor('orders', '2026-08-16', '08:00', null)).toBeNull()
    expect(identityKeyFor('orders', '2026-08-16', 'not a clock', '155.00')).toBeNull()
    expect(identityKeyFor('orders', '2026-08-16', '08:00', 'not money')).toBeNull()
  })

  it('keeps midnight and noon distinct, which a naive 12-hour fold would not', () => {
    expect(identityKeyFor('orders', '2026-08-16', '00:30', '155.00'))
      .toBe(identityKeyFor('orders', '2026-08-16', '12:30', '155.00'))
    // …and both differ from half past one, so the fold has not flattened the whole clock.
    expect(identityKeyFor('orders', '2026-08-16', '01:30', '155.00'))
      .not.toBe(identityKeyFor('orders', '2026-08-16', '00:30', '155.00'))
  })
})
