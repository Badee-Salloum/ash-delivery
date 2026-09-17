import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CURRENCIES } from '../../src/money/currency.ts'
import {
  COMPANY_EQUITY_ACCOUNTS,
  COMPANY_FUND_KINDS,
  COMPANY_INCOME_ACCOUNTS,
  type CompanyExpenseCentre,
  FUND_KINDS,
  type FundRef,
  currencyOf,
  fundCode,
  fundRefFromCode,
  isCompanyFund,
} from '../../src/ledger/recipes.ts'

/** An id as the system mints them: no colon (the code separator), never empty. */
const id = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.includes(':'))
const currency = fc.constantFrom(...CURRENCIES)
const centre: fc.Arbitrary<CompanyExpenseCentre> = fc.oneof(
  fc.constantFrom('general' as const, 'receivable_writeoff' as const),
  id.map((v) => `vehicle:${v}` as const),
  id.map((v) => `asset:${v}` as const),
)

/**
 * One arbitrary per kind, keyed by the kind so the record type itself refuses to compile if a
 * kind is missing — `FUND_KINDS` is exhaustive by construction and this is exhaustive over it.
 */
const ARBITRARY: { [K in FundRef['kind']]: fc.Arbitrary<Extract<FundRef, { kind: K }>> } = {
  office_cash: fc.constant({ kind: 'office_cash' }),
  office_wallet: fc.constant({ kind: 'office_wallet' }),
  yalago_share: fc.constant({ kind: 'yalago_share' }),
  company_revenue: fc.constant({ kind: 'company_revenue' }),
  yalago_income: fc.constant({ kind: 'yalago_income' }),
  fee_earned: fc.constant({ kind: 'fee_earned' }),
  other_income: fc.constant({ kind: 'other_income' }),
  company_box: fc.constant({ kind: 'company_box' }),
  driver_cash: id.map((driverId) => ({ kind: 'driver_cash', driverId })),
  driver_wallet: id.map((driverId) => ({ kind: 'driver_wallet', driverId })),
  driver_share_payable: id.map((driverId) => ({ kind: 'driver_share_payable', driverId })),
  driver_receivable_cash: id.map((driverId) => ({ kind: 'driver_receivable_cash', driverId })),
  driver_receivable_wallet: id.map((driverId) => ({ kind: 'driver_receivable_wallet', driverId })),
  driver_shift_funding_cash: id.map((driverId) => ({ kind: 'driver_shift_funding_cash', driverId })),
  driver_shift_funding_wallet: id.map((driverId) => ({ kind: 'driver_shift_funding_wallet', driverId })),
  advance_receivable_cash: id.map((advanceId) => ({ kind: 'advance_receivable_cash', advanceId })),
  advance_receivable_wallet: id.map((advanceId) => ({ kind: 'advance_receivable_wallet', advanceId })),
  cost_center: fc.string({ minLength: 1 }).map((costCenterId) => ({ kind: 'cost_center', costCenterId })),
  company_cash: currency.map((c) => ({ kind: 'company_cash', currency: c })),
  depreciation_reserve: currency.map((c) => ({ kind: 'depreciation_reserve', currency: c })),
  company_fx_position: currency.map((c) => ({ kind: 'company_fx_position', currency: c })),
  company_equity: fc
    .tuple(currency, fc.constantFrom(...COMPANY_EQUITY_ACCOUNTS))
    .map(([c, account]) => ({ kind: 'company_equity', currency: c, account })),
  company_expense: fc.tuple(currency, centre).map(([c, ce]) => ({ kind: 'company_expense', currency: c, centre: ce })),
  company_income: fc
    .tuple(currency, fc.constantFrom(...COMPANY_INCOME_ACCOUNTS))
    .map(([c, account]) => ({ kind: 'company_income', currency: c, account })),
  branch_clearing: id.map((branchId) => ({ kind: 'branch_clearing', branchId })),
  company_payable: fc.tuple(id, currency).map(([debtId, c]) => ({ kind: 'company_payable', debtId, currency: c })),
  company_receivable: fc
    .tuple(id, currency)
    .map(([debtId, c]) => ({ kind: 'company_receivable', debtId, currency: c })),
  fixed_asset: fc.tuple(id, currency).map(([assetId, c]) => ({ kind: 'fixed_asset', assetId, currency: c })),
}

describe('fund code round-trip — EVERY kind', () => {
  it('lists every kind exactly once', () => {
    expect(new Set(FUND_KINDS).size).toBe(FUND_KINDS.length)
    expect([...FUND_KINDS].sort()).toEqual(Object.keys(ARBITRARY).sort())
  })

  it.each([...FUND_KINDS])('round-trips %s', (kind) => {
    fc.assert(
      fc.property(ARBITRARY[kind] as fc.Arbitrary<FundRef>, (fund) => {
        expect(fundRefFromCode(fundCode(fund))).toEqual(fund)
      }),
    )
  })

  it('gives every fund exactly one currency, and only company funds anything but SYP_NEW', () => {
    for (const kind of FUND_KINDS) {
      fc.assert(
        fc.property(ARBITRARY[kind] as fc.Arbitrary<FundRef>, (fund) => {
          const cur = currencyOf(fund)
          expect(CURRENCIES).toContain(cur)
          if (!isCompanyFund(fund)) expect(cur).toBe('SYP_NEW')
          if (fund.kind === 'branch_clearing') expect(cur).toBe('SYP_NEW')
          if ('currency' in fund) expect(cur).toBe(fund.currency)
        }),
      )
    }
  })
})

describe('company fund codes', () => {
  it('spell the currency as the enum literal', () => {
    expect(fundCode({ kind: 'company_cash', currency: 'SYP_NEW' })).toBe('company_cash:SYP_NEW')
    expect(fundCode({ kind: 'company_cash', currency: 'USD' })).toBe('company_cash:USD')
    expect(fundCode({ kind: 'depreciation_reserve', currency: 'USD' })).toBe('depreciation_reserve:USD')
    expect(fundCode({ kind: 'company_fx_position', currency: 'SYP_NEW' })).toBe('company_fx_position:SYP_NEW')
    expect(fundCode({ kind: 'company_equity', currency: 'USD', account: 'opening' })).toBe('company_equity:USD:opening')
    expect(fundCode({ kind: 'company_expense', currency: 'USD', centre: 'vehicle:v-1' })).toBe(
      'company_expense:USD:vehicle:v-1',
    )
    expect(fundCode({ kind: 'company_income', currency: 'SYP_NEW', account: 'payable_forgiven' })).toBe(
      'company_income:SYP_NEW:payable_forgiven',
    )
    expect(fundCode({ kind: 'branch_clearing', branchId: 'b-1' })).toBe('branch_clearing:b-1')
    expect(fundCode({ kind: 'company_payable', debtId: 'd-1', currency: 'USD' })).toBe('company_payable:USD:d-1')
    expect(fundCode({ kind: 'company_receivable', debtId: 'd-1', currency: 'SYP_NEW' })).toBe(
      'company_receivable:SYP_NEW:d-1',
    )
    expect(fundCode({ kind: 'fixed_asset', assetId: 'a-1', currency: 'USD' })).toBe('fixed_asset:USD:a-1')
  })

  it('keeps the two currency pockets apart', () => {
    expect(fundCode({ kind: 'company_cash', currency: 'USD' })).not.toBe(
      fundCode({ kind: 'company_cash', currency: 'SYP_NEW' }),
    )
  })

  it.each([
    'company_cash',
    'company_cash:',
    'company_cash:SYP',
    'company_cash:usd',
    'company_cash:USD:extra',
    'depreciation_reserve:EUR',
    'company_fx_position',
    'company_equity:USD',
    'company_equity:USD:owner',
    'company_equity:USD:opening:x',
    'company_equity:XXX:opening',
    'company_income:USD',
    'company_income:USD:salary',
    'company_expense:USD',
    'company_expense:USD:',
    'company_expense:USD:vehicle',
    'company_expense:USD:vehicle:',
    'company_expense:USD:vehicle:a:b',
    'company_expense:USD:truck:a',
    'company_expense:GBP:general',
    'branch_clearing',
    'branch_clearing:',
    'branch_clearing:a:b',
    'company_payable:USD',
    'company_payable:USD:',
    'company_payable:d-1',
    'company_payable:USD:d:1',
    'company_receivable:SYP_NEW',
    'fixed_asset:USD',
    'fixed_asset:a-1',
    'fixed_asset:EUR:a-1',
  ])('refuses the malformed company code %s', (code) => {
    expect(() => fundRefFromCode(code)).toThrow(RangeError)
  })

  it('refuses to MINT a code it could not read back', () => {
    expect(() => fundCode({ kind: 'company_payable', debtId: '', currency: 'USD' })).toThrow(RangeError)
    expect(() => fundCode({ kind: 'fixed_asset', assetId: 'a:b', currency: 'USD' })).toThrow(RangeError)
    expect(() => fundCode({ kind: 'branch_clearing', branchId: '' })).toThrow(RangeError)
    expect(() => fundCode({ kind: 'company_expense', currency: 'USD', centre: 'vehicle:' })).toThrow(RangeError)
    expect(() => fundCode({ kind: 'company_cash', currency: 'EUR' as 'USD' })).toThrow(RangeError)
    expect(() =>
      fundCode({ kind: 'company_equity', currency: 'USD', account: 'salary' as 'opening' }),
    ).toThrow(RangeError)
  })

  it('lists the ten company kinds 0065 adds', () => {
    expect([...COMPANY_FUND_KINDS].sort()).toEqual(
      [
        'branch_clearing',
        'company_cash',
        'company_equity',
        'company_expense',
        'company_fx_position',
        'company_income',
        'company_payable',
        'company_receivable',
        'depreciation_reserve',
        'fixed_asset',
      ],
    )
  })
})

/**
 * THE C1 STRICTNESS CHANGE. A known name with a suffix it does not take used to be read as the bare
 * fund, the suffix silently dropped — so `company_box:alias` WAS صندوق الشركة. It now throws.
 */
describe('a known name never swallows a suffix', () => {
  it.each([
    'company_box:x',
    'company_box:',
    'office_cash:x',
    'office_wallet:1',
    'yalago_share:a',
    'company_revenue:a',
    'yalago_income:a',
    'fee_earned:a',
    'other_income:a',
  ])('refuses %s', (code) => {
    expect(() => fundRefFromCode(code)).toThrow(RangeError)
  })
})

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
