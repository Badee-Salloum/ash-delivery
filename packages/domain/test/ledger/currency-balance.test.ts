import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { COMPANY_LEDGER_EVENTS, type LedgerEvent } from '../../src/ledger/recipes.ts'
import {
  COMPANY_FUND_ALLOWED_EVENTS,
  COMPANY_FUND_KINDS,
  MixedCurrencyPostingError,
  type Posting,
  UnbalancedPostingError,
  assertBalanced,
  currencyBalances,
  isCompanyLedgerEvent,
  postingBalanceProblem,
} from '../../src/ledger/recipes.ts'
import { minor } from '../../src/money/minor.ts'

const usdCash = { kind: 'company_cash', currency: 'USD' } as const
const sypCash = { kind: 'company_cash', currency: 'SYP_NEW' } as const
const usdFx = { kind: 'company_fx_position', currency: 'USD' } as const
const sypFx = { kind: 'company_fx_position', currency: 'SYP_NEW' } as const
const m = (n: bigint) => minor(n)

const exchange = (usdCents: bigint, sypMinor: bigint, eventType: LedgerEvent = 'company_fx_exchange'): Posting => ({
  eventType,
  occurrenceKey: 'x-1',
  lines: [
    // USD → SYP: USD leaves the pocket into the position, SYP arrives from the position.
    { fund: usdFx, side: 'D', amount: m(usdCents) },
    { fund: usdCash, side: 'C', amount: m(usdCents) },
    { fund: sypCash, side: 'D', amount: m(sypMinor) },
    { fund: sypFx, side: 'C', amount: m(sypMinor) },
  ],
})

/**
 * Double entry PER CURRENCY — the domain twin of 0066's `assert_entry_balanced`.
 *
 * With two currencies «Σ debits = Σ credits» is meaningless: $100 against 100 lira sums to zero
 * and is two unbalanced entries. The rule is per currency, and only an exchange may span two.
 */
describe('assertBalanced — per currency', () => {
  it('refuses D USD 100 / C SYP 100 although the plain sums agree', () => {
    const forged: Posting = {
      eventType: 'company_correction',
      occurrenceKey: '1',
      lines: [
        { fund: usdCash, side: 'D', amount: m(100n) },
        { fund: sypCash, side: 'C', amount: m(100n) },
      ],
    }
    expect(() => assertBalanced(forged)).toThrow(UnbalancedPostingError)
    expect(postingBalanceProblem(forged)).toEqual({
      kind: 'unbalanced',
      currency: 'SYP_NEW',
      debits: 0n,
      credits: 100n,
    })
    try {
      assertBalanced(forged)
    } catch (error) {
      expect((error as UnbalancedPostingError).currency).toBe('SYP_NEW')
    }
  })

  it('refuses a balanced two-currency entry that is not an exchange', () => {
    for (const eventType of ['manual', 'company_correction', 'company_deposit'] as const) {
      expect(() => assertBalanced(exchange(100n, 13_000n, eventType))).toThrow(MixedCurrencyPostingError)
    }
  })

  it('accepts a four-line exchange whose sides differ in amount but each balance', () => {
    const posting = exchange(10_000n, 1_305_000n)
    expect(assertBalanced(posting)).toBe(posting)
    expect(currencyBalances(posting)).toEqual([
      { currency: 'SYP_NEW', debits: 1_305_000n, credits: 1_305_000n },
      { currency: 'USD', debits: 10_000n, credits: 10_000n },
    ])
  })

  it('refuses an exchange that is unbalanced in one of its currencies', () => {
    const lopsided: Posting = { ...exchange(100n, 13_000n), lines: exchange(100n, 13_000n).lines.slice(0, 3) }
    expect(() => assertBalanced(lopsided)).toThrow(UnbalancedPostingError)
  })

  it('keeps the old single-currency rule exactly', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('D' as const, 'C' as const), fc.bigInt({ min: 1n, max: 10n ** 12n })), {
          minLength: 1,
          maxLength: 12,
        }),
        (rows) => {
          const posting: Posting = {
            eventType: 'manual',
            occurrenceKey: 'p',
            lines: rows.map(([side, amount]) => ({ fund: { kind: 'office_cash' }, side, amount: m(amount) })),
          }
          const d = rows.filter(([s]) => s === 'D').reduce((a, [, v]) => a + v, 0n)
          const c = rows.filter(([s]) => s === 'C').reduce((a, [, v]) => a + v, 0n)
          if (d === c) {
            expect(() => assertBalanced(posting)).not.toThrow()
          } else {
            expect(() => assertBalanced(posting)).toThrow(UnbalancedPostingError)
            try {
              assertBalanced(posting)
            } catch (error) {
              // Same figures, same message shape as before C1 for a lira posting.
              expect((error as Error).message).toBe(`posting manual/p is unbalanced: D ${d} <> C ${c}`)
            }
          }
        },
      ),
    )
  })

  it('still refuses an empty posting and a non-positive line', () => {
    expect(() => assertBalanced({ eventType: 'manual', occurrenceKey: 'e', lines: [] })).toThrow(UnbalancedPostingError)
    expect(() =>
      assertBalanced({
        eventType: 'manual',
        occurrenceKey: 'z',
        lines: [
          { fund: { kind: 'office_cash' }, side: 'D', amount: m(0n) },
          { fund: { kind: 'office_wallet' }, side: 'C', amount: m(0n) },
        ],
      }),
    ).toThrow(RangeError)
  })

  it('accepts a single-currency USD entry under any event — the ledger partition, not the balance, decides where it may post', () => {
    const deposit: Posting = {
      eventType: 'company_deposit',
      occurrenceKey: 'd',
      lines: [
        { fund: usdCash, side: 'D', amount: m(5_000n) },
        { fund: { kind: 'company_equity', currency: 'USD', account: 'owner_funding' }, side: 'C', amount: m(5_000n) },
      ],
    }
    expect(postingBalanceProblem(deposit)).toBeNull()
    expect(currencyBalances(deposit)).toEqual([{ currency: 'USD', debits: 5_000n, credits: 5_000n }])
  })
})

describe('the company vocabulary', () => {
  it('knows exactly which events are company events', () => {
    for (const event of COMPANY_LEDGER_EVENTS) expect(isCompanyLedgerEvent(event)).toBe(true)
    for (const event of ['manual', 'correction', 'expense', 'income', 'restoration', 'float_out'] as const) {
      expect(isCompanyLedgerEvent(event)).toBe(false)
    }
  })

  it('allows only company events on company accounts, and gives every account at least one', () => {
    for (const kind of COMPANY_FUND_KINDS) {
      const allowed = COMPANY_FUND_ALLOWED_EVENTS[kind]
      expect(allowed.length).toBeGreaterThan(0)
      for (const event of allowed) expect(COMPANY_LEDGER_EVENTS).toContain(event)
      expect(new Set(allowed).size).toBe(allowed.length)
    }
    // The clearing account moves only with the cutover and the restoration mirror — never through
    // a generic correction, which would break the mirror invariant with the branch company_box.
    expect(COMPANY_FUND_ALLOWED_EVENTS.branch_clearing).toEqual([
      'company_opening_transfer',
      'company_restoration_mirror',
    ])
  })
})
