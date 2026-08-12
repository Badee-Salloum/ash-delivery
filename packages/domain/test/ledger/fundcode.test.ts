import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type FundRef, fundCode, fundRefFromCode } from '../../src/ledger/recipes.ts'

/**
 * `fundCode` and `fundRefFromCode` must be exact inverses.
 *
 * A manual entry (E-3) names its funds by code. An early version of the treasury route wrapped
 * EVERY code in a cost centre, so `office_cash` became `cost_center:office_cash`: the entry
 * posted, balanced, and moved a fund that did not exist while the real office cash never
 * changed. Money appeared to move and nothing did.
 */
describe('fund code round-trip', () => {
  const simple: FundRef[] = [
    { kind: 'office_cash' },
    { kind: 'office_wallet' },
    { kind: 'yalago_share' },
    { kind: 'company_revenue' },
    { kind: 'yalago_income' },
    { kind: 'fee_earned' },
    { kind: 'company_box' },
  ]

  it.each(simple.map((f) => [f.kind, f] as const))('round-trips %s', (_kind, fund) => {
    expect(fundRefFromCode(fundCode(fund))).toEqual(fund)
  })

  it('round-trips driver-scoped funds', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'driver_cash' as const,
          'driver_wallet' as const,
          'driver_share_payable' as const,
          'driver_receivable_cash' as const,
          'driver_receivable_wallet' as const,
        ),
        fc.string({ minLength: 1 }).filter((s) => !s.includes(' ')),
        (kind, driverId) => {
          expect(fundRefFromCode(fundCode({ kind, driverId }))).toEqual({ kind, driverId })
        },
      ),
    )
  })

  it('round-trips cost centres, including ids containing a colon', () => {
    // Vehicle-scoped cost centres are keyed `cost_center:<id>`, and an id may itself be
    // composite (`general:branch-x`), so the split must keep everything after the FIRST colon.
    for (const id of ['vehicle-1', 'general:branch-x', 'a:b:c']) {
      expect(fundRefFromCode(fundCode({ kind: 'cost_center', costCenterId: id }))).toEqual({
        kind: 'cost_center',
        costCenterId: id,
      })
    }
  })

  it('treats an unknown name as a contra cost centre rather than refusing', () => {
    // An operator needs accounts like "opening_balance" that are not in the client's fixed tree;
    // refusing them would make E-3 unusable.
    expect(fundRefFromCode('opening_balance')).toEqual({ kind: 'cost_center', costCenterId: 'opening_balance' })
  })

  it('refuses a driver fund with no driver id rather than inventing one', () => {
    expect(() => fundRefFromCode('driver_cash')).toThrow(RangeError)
    expect(() => fundRefFromCode('driver_cash:')).toThrow(RangeError)
  })

  it('NEVER silently re-points a known fund name', () => {
    // The exact bug this function exists to prevent.
    expect(fundRefFromCode('office_cash')).toEqual({ kind: 'office_cash' })
    expect(fundRefFromCode('office_cash')).not.toEqual({ kind: 'cost_center', costCenterId: 'office_cash' })
  })

  /**
   * صندوق الشركة is the newest name and therefore the likeliest to be missed. A manual entry that
   * writes «company_box» and silently moves `cost_center:company_box` instead would show the
   * operator a successful sweep while the company fund never changed.
   */
  it('resolves company_box to the FUND, never to a cost centre', () => {
    expect(fundRefFromCode('company_box')).toEqual({ kind: 'company_box' })
    expect(fundRefFromCode('company_box')).not.toEqual({ kind: 'cost_center', costCenterId: 'company_box' })
  })

  /** A ذمة without a driver is not a smaller ذمة — it is an unanswerable one. */
  it('refuses a receivable with no driver id', () => {
    expect(() => fundRefFromCode('driver_receivable_cash')).toThrow(RangeError)
    expect(() => fundRefFromCode('driver_receivable_wallet:')).toThrow(RangeError)
  })

  /**
   * The cash and wallet receivables must stay DISTINCT codes. الترميم counts each against its own
   * capital target — his book has 400,000 against كاش المكتب and 30,000 against محفظة المكتب — so
   * collapsing them would restore both boxes to the wrong numbers while every total still footed.
   */
  it('keeps the cash and wallet receivables apart', () => {
    const cash = fundCode({ kind: 'driver_receivable_cash', driverId: 'd1' })
    const wallet = fundCode({ kind: 'driver_receivable_wallet', driverId: 'd1' })
    expect(cash).not.toBe(wallet)
    expect(fundRefFromCode(cash).kind).toBe('driver_receivable_cash')
    expect(fundRefFromCode(wallet).kind).toBe('driver_receivable_wallet')
  })
})
