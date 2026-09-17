import { describe, expect, it } from 'vitest'
import { minor } from '../../src/money/minor.ts'
import { type WeekCloseFacts, checkWeekClose, isDateLocked } from '../../src/week/close.ts'

const clean = (over: Partial<WeekCloseFacts> = {}): WeekCloseFacts => ({
  closeDate: '2026-07-26', // a Sunday
  unapprovedShiftCount: 0,
  daysMissingCashCount: [],
  provisionalFxDays: [],
  priorWeekClosed: true,
  trialBalanceDiff: minor(0n),
  alreadyClosed: false,
  ...over,
})

describe('the Sunday close (BR7, AC #9)', () => {
  it('closes the week that ENDED yesterday, Sunday 19th → Saturday 25th', () => {
    const check = checkWeekClose(clean())
    expect(check.weekStart).toBe('2026-07-19')
    expect(check.weekEnd).toBe('2026-07-25')
    expect(check.canClose).toBe(true)
  })

  it('refuses on any day that is not a Sunday', () => {
    for (const date of ['2026-07-25', '2026-07-27', '2026-07-24']) {
      const check = checkWeekClose(clean({ closeDate: date }))
      expect(check.canClose).toBe(false)
      expect(check.blockers[0]).toMatchObject({ kind: 'not_a_sunday' })
    }
  })

  it('never freezes a shift worked on the closing Sunday itself', () => {
    // The close on the 26th covers 19th–25th. The 26th belongs to the next week.
    const check = checkWeekClose(clean())
    expect(check.weekEnd < '2026-07-26').toBe(true)
  })

  it('reports the Yallago reconciliation gate as deferred rather than pretending it is satisfied', () => {
    expect(checkWeekClose(clean()).reconciliationGate).toBe('deferred_to_bundle_2')
  })
})

describe('close pre-flight blockers', () => {
  it('blocks on unapproved shifts', () => {
    const check = checkWeekClose(clean({ unapprovedShiftCount: 3 }))
    expect(check.canClose).toBe(false)
    expect(check.blockers).toContainEqual({ kind: 'unapproved_shifts', count: 3 })
  })

  it('blocks on a missing daily cash count', () => {
    const check = checkWeekClose(clean({ daysMissingCashCount: ['2026-07-22'] }))
    expect(check.blockers).toContainEqual({ kind: 'missing_cash_counts', dates: ['2026-07-22'] })
  })

  it('blocks on a provisional FX rate — a carried-forward rate must be confirmed before sealing', () => {
    const check = checkWeekClose(clean({ provisionalFxDays: ['2026-07-23'] }))
    expect(check.blockers).toContainEqual({ kind: 'provisional_fx', dates: ['2026-07-23'] })
  })

  it('blocks when the prior week is still open — locks must be contiguous', () => {
    // A gap would leave an earlier week permanently editable behind a sealed one.
    expect(checkWeekClose(clean({ priorWeekClosed: false })).blockers).toContainEqual({ kind: 'prior_week_open' })
  })

  it('blocks when the trial balance does not foot', () => {
    const check = checkWeekClose(clean({ trialBalanceDiff: minor(1n) }))
    expect(check.blockers).toContainEqual({ kind: 'trial_balance_not_zero', diff: 1n })
  })

  it('judges a multi-currency ledger per currency, one blocker for each that does not foot', () => {
    // $1.00 up and 100 minor lira down sum to zero — and are two broken books.
    const check = checkWeekClose(
      clean({
        trialBalanceDiff: minor(0n),
        trialBalanceByCurrency: [
          { currency: 'SYP_NEW', diff: minor(-100n) },
          { currency: 'USD', diff: minor(100n) },
        ],
      }),
    )
    expect(check.canClose).toBe(false)
    expect(check.blockers.filter((b) => b.kind === 'trial_balance_not_zero')).toEqual([
      { kind: 'trial_balance_not_zero', diff: -100n, currency: 'SYP_NEW' },
      { kind: 'trial_balance_not_zero', diff: 100n, currency: 'USD' },
    ])
  })

  it('closes a multi-currency ledger whose every currency foots', () => {
    const check = checkWeekClose(
      clean({
        trialBalanceByCurrency: [
          { currency: 'SYP_NEW', diff: minor(0n) },
          { currency: 'USD', diff: minor(0n) },
        ],
      }),
    )
    expect(check.canClose).toBe(true)
  })

  it('refuses a company week whose branch mirror does not cancel (C2)', () => {
    const check = checkWeekClose(
      clean({
        companyClearing: [
          { branchId: 'dam', companyBox: minor(7_905_726n), clearing: minor(-7_905_726n) },
          { branchId: 'alp', companyBox: minor(500n), clearing: minor(-400n) },
        ],
      }),
    )
    expect(check.canClose).toBe(false)
    expect(check.blockers).toEqual([
      { kind: 'company_clearing_mismatch', branchId: 'alp', companyBox: 500n, clearing: -400n },
    ])
    expect(checkWeekClose(clean({ companyClearing: [] })).canClose).toBe(true)
    expect(
      checkWeekClose(clean({ companyClearing: [{ branchId: 'dam', companyBox: minor(0n), clearing: minor(0n) }] })).canClose,
    ).toBe(true)
  })

  it('refuses to close a week twice', () => {
    expect(checkWeekClose(clean({ alreadyClosed: true })).blockers).toContainEqual({ kind: 'already_closed' })
  })

  it('reports EVERY blocker at once, so the admin fixes them in one pass', () => {
    const check = checkWeekClose(
      clean({
        unapprovedShiftCount: 1,
        daysMissingCashCount: ['2026-07-20'],
        provisionalFxDays: ['2026-07-21'],
        priorWeekClosed: false,
        trialBalanceDiff: minor(-5n),
      }),
    )
    expect(check.blockers).toHaveLength(5)
    expect(check.canClose).toBe(false)
  })
})

describe('isDateLocked', () => {
  const closed = ['2026-07-12', '2026-07-19']

  it('covers the full Sunday-to-Saturday span', () => {
    expect(isDateLocked('2026-07-19', closed)).toBe(true) // Sunday
    expect(isDateLocked('2026-07-22', closed)).toBe(true) // midweek
    expect(isDateLocked('2026-07-25', closed)).toBe(true) // Saturday
  })

  it('leaves the following Sunday open', () => {
    expect(isDateLocked('2026-07-26', closed)).toBe(false)
  })

  it('leaves a week that was never closed open', () => {
    expect(isDateLocked('2026-08-02', closed)).toBe(false)
  })

  it('handles a month boundary', () => {
    expect(isDateLocked('2026-07-18', closed)).toBe(true) // in the 12th's week
    expect(isDateLocked('2026-07-11', closed)).toBe(false)
  })
})
