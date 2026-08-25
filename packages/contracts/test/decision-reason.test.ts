import { describe, expect, it } from 'vitest'
import { hasVisibleText } from '@ash/domain'
import { reviseOperationsRequest } from '../src/wire.ts'

/**
 * A decision reason is the ONLY record of why a delivery fee entered or left BR1, so a reason with
 * nothing readable in it is not an audit trail.
 *
 * The system used to hold three different answers to "is this blank": JavaScript `.trim()` (which
 * leaves U+200B and the rest of `Cf` in place), Postgres one-argument `btrim()` (which strips the
 * ASCII space and nothing else — a lone tab counted as content), and `ash_has_visible_text`. They
 * disagreed about the same row, so the release-blocker script could report a settlement as wrong
 * for an order the system had legitimately included.
 *
 * In an Arabic-first product the gap is routine, not theoretical: U+200F RIGHT-TO-LEFT MARK rides
 * along in pasted Arabic constantly and `'‏'.trim()` is truthy.
 */
const RLM = String.fromCharCode(0x200f)
const ZWSP = String.fromCharCode(0x200b)

describe('a decision reason must contain something a human can read', () => {
  it.each([
    ['a bidi mark alone', RLM],
    ['a zero-width space alone', ZWSP],
    ['a tab alone', '\t'],
    ['spaces alone', '   '],
    ['an empty string', ''],
  ])('refuses %s', (_label, reason) => {
    const parsed = reviseOperationsRequest.safeParse({
      orders: [{ providerOrderNo: 'YAL-1', included: true, reason }],
    })
    expect(parsed.success).toBe(false)
  })

  it.each([
    ['plain Arabic', 'الطلب وصل قبل إغلاق الوردية'],
    ['Arabic carrying the bidi marks a paste brings with it', `${RLM}الطلب وصل قبل الإغلاق${RLM}`],
    ['English', 'verified against the printed receipt'],
  ])('accepts %s', (_label, reason) => {
    const parsed = reviseOperationsRequest.safeParse({
      orders: [{ providerOrderNo: 'YAL-1', included: true, reason }],
    })
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('applies the same rule to a cash-deduction decision, where the reason is mandatory', () => {
    expect(reviseOperationsRequest.safeParse({
      cashDeductions: [{ id: 'd-1', included: false, reason: ZWSP }],
    }).success).toBe(false)
    expect(reviseOperationsRequest.safeParse({
      cashDeductions: [{ id: 'd-1', included: false, reason: 'الخصم خارج نافذة الوردية' }],
    }).success).toBe(true)
  })

  /**
   * The wire schema, the API predicate, the UI copies and the Postgres CHECK must all be the same
   * rule. This pins the JavaScript half; `ash_has_visible_text` (0035) is its SQL twin and 0043
   * puts every database site on it.
   */
  it('is the same predicate the rest of the system imports', () => {
    expect(hasVisibleText(RLM)).toBe(false)
    expect(hasVisibleText(ZWSP)).toBe(false)
    expect(hasVisibleText('\t')).toBe(false)
    expect(hasVisibleText(null)).toBe(false)
    expect(hasVisibleText(undefined)).toBe(false)
    expect(hasVisibleText(`${RLM}الطلب`)).toBe(true)
  })
})
