import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  COMPANY_LINE_ROLES,
  REVERSIBLE_COMPANY_EVENTS,
  companyBoxMovement,
  companyDeposit,
  companyExpense,
  companyFxExchange,
  companyIncome,
  companyOpeningTransfer,
  companyPocketAfterRestoration,
  companyReversal,
  companyWithdrawal,
  exchangeRate,
  exchangeRoundingGap,
  fxRateFromAmounts,
  mirrorOrder,
  restorationMirror,
} from '../../src/ledger/company.ts'
import {
  type FundRef,
  type Posting,
  assertBalanced,
  balanceOf,
  currencyBalances,
  fundCode,
  fundFromCompany,
  manualKaish,
  reverse,
  sweepToCompany,
} from '../../src/ledger/recipes.ts'
import { type Currency, money, usdToSypMinor } from '../../src/money/currency.ts'
import { FxError } from '../../src/fx/rate.ts'
import { minor } from '../../src/money/minor.ts'
import { planRestoration } from '../../src/treasury/restoration.ts'

const KEY = '4b7f0c3e-8d7f-4a57-9f0e-2f3f0b2b8a11'
const BRANCH = '11111111-1111-4111-8111-111111111111'
const m = (n: bigint) => minor(n)

/** The lines as the guard compares them: code, side, amount, role. */
const shape = (posting: Posting) =>
  posting.lines.map((l) => [fundCode(l.fund), l.side, l.amount, l.role ?? null] as const)

const code = (fund: FundRef): string => fundCode(fund)
const byCode = (target: string) => (fund: FundRef) => code(fund) === target

describe('company commands — the exact line sets 0067 demands', () => {
  it('deposits into the pocket of its currency against owner funding or an opening balance', () => {
    expect(shape(companyDeposit('USD', m(12_500n), 'owner_funding', KEY))).toEqual([
      ['company_cash:USD', 'D', 12_500n, 'deposit_received'],
      ['company_equity:USD:owner_funding', 'C', 12_500n, 'deposit_source'],
    ])
    const opening = companyDeposit('SYP_NEW', m(7_905_726n), 'opening', KEY)
    expect(opening.eventType).toBe('company_deposit')
    expect(opening.occurrenceKey).toBe(KEY)
    expect(shape(opening)).toEqual([
      ['company_cash:SYP_NEW', 'D', 7_905_726n, 'deposit_received'],
      ['company_equity:SYP_NEW:opening', 'C', 7_905_726n, 'deposit_source'],
    ])
  })

  it('withdraws to the owner drawings only', () => {
    const posting = companyWithdrawal('SYP_NEW', m(100n), KEY)
    expect(posting.eventType).toBe('company_withdrawal')
    expect(shape(posting)).toEqual([
      ['company_equity:SYP_NEW:owner_drawings', 'D', 100n, 'withdrawal_destination'],
      ['company_cash:SYP_NEW', 'C', 100n, 'withdrawal_paid'],
    ])
  })

  it('files an expense under its centre and pays it from the named source', () => {
    const centre = 'vehicle:88888888-8888-4888-8888-888888888888' as const
    expect(shape(companyExpense('USD', m(35_000n), centre, 'pocket', KEY))).toEqual([
      [`company_expense:USD:${centre}`, 'D', 35_000n, 'expense_cost'],
      ['company_cash:USD', 'C', 35_000n, 'expense_paid'],
    ])
    expect(shape(companyExpense('USD', m(1n), 'general', 'reserve', KEY))[1]).toEqual([
      'depreciation_reserve:USD',
      'C',
      1n,
      'expense_paid',
    ])
    expect(shape(companyExpense('SYP_NEW', m(1n), 'general', 'owner_outside', KEY))[1]).toEqual([
      'company_equity:SYP_NEW:owner_funding',
      'C',
      1n,
      'expense_paid',
    ])
    expect(companyExpense('SYP_NEW', m(1n), 'asset:abc', 'pocket', KEY).lines[0]!.fund).toEqual({
      kind: 'company_expense',
      currency: 'SYP_NEW',
      centre: 'asset:abc',
    })
  })

  it('takes income into the pocket against general company income', () => {
    expect(shape(companyIncome('SYP_NEW', m(50_000n), KEY))).toEqual([
      ['company_cash:SYP_NEW', 'D', 50_000n, 'income_received'],
      ['company_income:SYP_NEW:general', 'C', 50_000n, 'income_earned'],
    ])
  })

  it('refuses a zero or negative amount and a blank key', () => {
    expect(() => companyDeposit('USD', m(0n), 'owner_funding', KEY)).toThrow(RangeError)
    expect(() => companyWithdrawal('USD', m(-1n), KEY)).toThrow(RangeError)
    expect(() => companyExpense('USD', m(0n), 'general', 'pocket', KEY)).toThrow(RangeError)
    expect(() => companyIncome('USD', m(1n), ' ')).toThrow(RangeError)
  })
})

describe('«تصريف عملة» — both actual amounts, four lines, no profit', () => {
  it('passes through each currency\'s FX position and balances per currency', () => {
    const posting = companyFxExchange(money('USD', m(10_000n)), money('SYP_NEW', m(1_305_000n)), KEY)
    expect(posting.eventType).toBe('company_fx_exchange')
    expect(shape(posting)).toEqual([
      ['company_fx_position:USD', 'D', 10_000n, 'fx_sold'],
      ['company_cash:USD', 'C', 10_000n, 'fx_paid'],
      ['company_cash:SYP_NEW', 'D', 1_305_000n, 'fx_received'],
      ['company_fx_position:SYP_NEW', 'C', 1_305_000n, 'fx_bought'],
    ])
    expect(currencyBalances(posting)).toEqual([
      { currency: 'SYP_NEW', debits: 1_305_000n, credits: 1_305_000n },
      { currency: 'USD', debits: 10_000n, credits: 10_000n },
    ])
    // Lira to dollars is the mirror image.
    const back = companyFxExchange(money('SYP_NEW', m(1_310_000n)), money('USD', m(10_000n)), KEY)
    expect(shape(back).map(([c, side, , role]) => [c, side, role])).toEqual([
      ['company_fx_position:SYP_NEW', 'D', 'fx_sold'],
      ['company_cash:SYP_NEW', 'C', 'fx_paid'],
      ['company_cash:USD', 'D', 'fx_received'],
      ['company_fx_position:USD', 'C', 'fx_bought'],
    ])
  })

  it('refuses one currency twice and a non-positive side', () => {
    expect(() => companyFxExchange(money('USD', m(1n)), money('USD', m(1n)), KEY)).toThrow(/two different currencies/)
    expect(() => companyFxExchange(money('USD', m(0n)), money('SYP_NEW', m(1n)), KEY)).toThrow(RangeError)
    expect(() => companyFxExchange(money('USD', m(1n)), money('SYP_NEW', m(-1n)), KEY)).toThrow(RangeError)
  })
})

describe('the frozen rate two actual amounts imply', () => {
  it('is SYP minor units per dollar, rounded half up', () => {
    // $100.00 for 13,055.00 lira → 130.55 lira per dollar.
    expect(fxRateFromAmounts(m(10_000n), m(1_305_500n))).toBe(13_055n)
    // $37.00 for 4,820.00 lira → 130.270… → 13,027.
    expect(fxRateFromAmounts(m(3_700n), m(482_000n))).toBe(13_027n)
    // Exactly half a unit rounds up.
    expect(fxRateFromAmounts(m(200n), m(3n))).toBe(2n)
    expect(fxRateFromAmounts(m(200n), m(1n))).toBe(1n)
    // Whichever way the exchange went.
    expect(exchangeRate(money('SYP_NEW', m(1_305_500n)), money('USD', m(10_000n)))).toBe(13_055n)
    expect(exchangeRate(money('USD', m(10_000n)), money('SYP_NEW', m(1_305_500n)))).toBe(13_055n)
  })

  it('names the rounding gap of a pair no integer rate reproduces', () => {
    const rate = fxRateFromAmounts(m(3_700n), m(482_000n))
    expect(usdToSypMinor(m(3_700n), rate)).toBe(481_999n)
    expect(exchangeRoundingGap(m(3_700n), m(482_000n), rate)).toBe(1n)
  })

  it('refuses non-positive amounts and a rate below one minor unit', () => {
    expect(() => fxRateFromAmounts(m(0n), m(1n))).toThrow(FxError)
    expect(() => fxRateFromAmounts(m(1n), m(0n))).toThrow(FxError)
    expect(() => fxRateFromAmounts(m(-5n), m(10n))).toThrow(FxError)
    expect(() => fxRateFromAmounts(m(100_000n), m(1n))).toThrow(/below one minor unit/)
    expect(() => exchangeRate(money('USD', m(1n)), money('USD', m(1n)))).toThrow(FxError)
  })

  it('reproduces the lira side exactly whenever some integer rate does (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.bigInt({ min: 1n, max: 10n ** 8n }),
        (usdCents, anyRate) => {
          const syp = usdToSypMinor(m(usdCents), anyRate)
          fc.pre(syp > 0n)
          const rate = fxRateFromAmounts(m(usdCents), syp)
          expect(usdToSypMinor(m(usdCents), rate)).toBe(syp)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('is the integer nearest the true ratio for any pair (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.bigInt({ min: 1n, max: 10n ** 14n }),
        (usdCents, sypMinor) => {
          fc.pre(sypMinor * 200n >= usdCents)
          const rate = fxRateFromAmounts(m(usdCents), m(sypMinor))
          // |100·S − U·r| ≤ U/2, i.e. |S/U·100 − r| ≤ ½.
          const gap = sypMinor * 100n - usdCents * rate
          expect(2n * (gap < 0n ? -gap : gap)).toBeLessThanOrEqual(usdCents)
          // The lira side sits within half a cent's worth (plus the conversion's own half unit).
          const lira = exchangeRoundingGap(m(usdCents), m(sypMinor), rate)
          expect(200n * (lira < 0n ? -lira : lira)).toBeLessThanOrEqual(usdCents + 100n)
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe('«عكس» — the exact inverse, roles kept', () => {
  const targets: Posting[] = [
    companyDeposit('USD', m(10_000n), 'owner_funding', 'a'),
    companyDeposit('SYP_NEW', m(10_000n), 'opening', 'b'),
    companyWithdrawal('SYP_NEW', m(400n), 'c'),
    companyExpense('USD', m(250n), 'vehicle:v1', 'reserve', 'd'),
    companyIncome('SYP_NEW', m(90n), 'e'),
    companyFxExchange(money('USD', m(5_000n)), money('SYP_NEW', m(652_500n)), 'f'),
  ]

  it('flips every side and keeps fund, amount and role, for every reversible command', () => {
    expect(REVERSIBLE_COMPANY_EVENTS).toEqual([
      'company_deposit',
      'company_withdrawal',
      'company_expense',
      'company_income',
      'company_fx_exchange',
    ])
    for (const target of targets) {
      const reversal = companyReversal(target, KEY)
      expect(reversal.eventType).toBe('company_correction')
      expect(reversal.occurrenceKey).toBe(KEY)
      expect(shape(reversal)).toEqual(
        shape(target).map(([c, side, amount, role]) => [c, side === 'D' ? 'C' : 'D', amount, role]),
      )
      // Target plus reversal leave every fund where it was.
      for (const line of target.lines) {
        expect(balanceOf([target, reversal], byCode(code(line.fund)))).toBe(0n)
      }
      // Flipping the reversal's sides once more gives the target's lines back, role for role.
      expect(shape(reversal).map(([c, side, amount, role]) => [c, side === 'D' ? 'C' : 'D', amount, role])).toEqual(
        shape(target),
      )
    }
  })

  it('may span two currencies only because an exchange does — each still balances', () => {
    const reversal = companyReversal(targets[5]!, KEY)
    expect(assertBalanced(reversal)).toBe(reversal)
    expect(currencyBalances(reversal)).toEqual([
      { currency: 'SYP_NEW', debits: 652_500n, credits: 652_500n },
      { currency: 'USD', debits: 5_000n, credits: 5_000n },
    ])
  })

  it('refuses what is not a reversible company command', () => {
    expect(() => companyReversal(sweepToCompany('office_cash', m(1n)), KEY)).toThrow(/not a reversible/)
    expect(() => companyReversal(companyOpeningTransfer(BRANCH, m(1n)), KEY)).toThrow(/not a reversible/)
    expect(() => companyReversal(restorationMirror('to_company', m(1n), BRANCH, 7), KEY)).toThrow(/not a reversible/)
    expect(() => companyReversal(companyReversal(targets[0]!, 'x'), KEY)).toThrow(/not a reversible/)
    const roleless: Posting = {
      eventType: 'company_deposit',
      occurrenceKey: 'r',
      lines: [
        { fund: { kind: 'company_cash', currency: 'USD' }, side: 'D', amount: m(1n) },
        { fund: { kind: 'company_equity', currency: 'USD', account: 'owner_funding' }, side: 'C', amount: m(1n) },
      ],
    }
    expect(() => companyReversal(roleless, KEY)).toThrow(/role/)
  })
})

describe('the restoration mirror and the cutover', () => {
  it('mirrors «كييش» into the SYP pocket and «شحن» out of it, keyed by the source entry', () => {
    const kaish = restorationMirror('to_company', m(630_000n), BRANCH, 41)
    expect(kaish.eventType).toBe('company_restoration_mirror')
    expect(kaish.occurrenceKey).toBe('mirror:41')
    expect(shape(kaish)).toEqual([
      ['company_cash:SYP_NEW', 'D', 630_000n, COMPANY_LINE_ROLES.kaishMirror],
      [`branch_clearing:${BRANCH}`, 'C', 630_000n, COMPANY_LINE_ROLES.kaishMirror],
    ])
    const shahn = restorationMirror('from_company', m(630_000n), BRANCH, 42)
    expect(shahn.occurrenceKey).toBe('mirror:42')
    expect(shape(shahn)).toEqual([
      [`branch_clearing:${BRANCH}`, 'D', 630_000n, 'shahn_mirror'],
      ['company_cash:SYP_NEW', 'C', 630_000n, 'shahn_mirror'],
    ])
    expect(() => restorationMirror('to_company', m(0n), BRANCH, 1)).toThrow(RangeError)
    expect(() => restorationMirror('to_company', m(1n), BRANCH, 0)).toThrow(RangeError)
    expect(() => restorationMirror('to_company', m(1n), BRANCH, 1.5)).toThrow(RangeError)
  })

  it('moves the opening balance as-is, once per branch', () => {
    const opening = companyOpeningTransfer(BRANCH, m(7_905_726n))
    expect(opening.eventType).toBe('company_opening_transfer')
    expect(opening.occurrenceKey).toBe(`opening:${BRANCH}`)
    expect(shape(opening)).toEqual([
      ['company_cash:SYP_NEW', 'D', 7_905_726n, 'opening_transfer'],
      [`branch_clearing:${BRANCH}`, 'C', 7_905_726n, 'opening_transfer'],
    ])
    expect(() => companyOpeningTransfer(BRANCH, m(0n))).toThrow(RangeError)
  })

  it('reads the direction and amount of a branch entry\'s one company_box line', () => {
    const lines = (p: Posting) => p.lines.map((l) => ({ fundCode: fundCode(l.fund), side: l.side, amount: l.amount }))
    expect(companyBoxMovement(lines(sweepToCompany('office_cash', m(5n))))).toEqual({ direction: 'to_company', amount: 5n })
    expect(companyBoxMovement(lines(fundFromCompany('office_wallet', m(6n))))).toEqual({ direction: 'from_company', amount: 6n })
    expect(companyBoxMovement(lines(reverse(manualKaish('office_cash', m(7n)), 'r')))).toEqual({
      direction: 'from_company',
      amount: 7n,
    })
    expect(companyBoxMovement([{ fundCode: 'office_cash', side: 'D', amount: m(1n) }])).toBeNull()
    expect(() =>
      companyBoxMovement([
        { fundCode: 'company_box', side: 'D', amount: m(1n) },
        { fundCode: 'company_box', side: 'C', amount: m(1n) },
      ]),
    ).toThrow(/one line/)
  })

  it('orders sweeps before top-ups and keeps each group in place', () => {
    const rows = [
      { direction: 'from_company' as const, id: 1 },
      { direction: 'to_company' as const, id: 2 },
      { direction: 'from_company' as const, id: 3 },
      { direction: 'to_company' as const, id: 4 },
    ]
    expect(mirrorOrder(rows).map((r) => r.id)).toEqual([2, 4, 1, 3])
  })

  /**
   * THE INVARIANT. Whatever a branch does to company_box — restorations, hand sweeps, top-ups and
   * reversals of any of them — the opening transfer plus one mirror per entry keeps
   * `company_box(branch) + branch_clearing(branch) = 0`, and the pocket moves by exactly the same net.
   */
  it('keeps branch company_box plus HQ clearing at zero through any sequence (property)', () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('sweep' as const), office: fc.constantFrom('office_cash' as const, 'office_wallet' as const), amount: fc.bigInt({ min: 1n, max: 10n ** 9n }) }),
      fc.record({ kind: fc.constant('shahn' as const), office: fc.constantFrom('office_cash' as const, 'office_wallet' as const), amount: fc.bigInt({ min: 1n, max: 10n ** 9n }) }),
      fc.record({ kind: fc.constant('hand' as const), office: fc.constantFrom('office_cash' as const, 'office_wallet' as const), amount: fc.bigInt({ min: 1n, max: 10n ** 9n }) }),
      fc.record({ kind: fc.constant('reverse' as const), pick: fc.nat() }),
    )
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.array(op, { maxLength: 30 }), (opening, ops) => {
        const branch: Posting[] = []
        const company: Posting[] = []
        if (opening > 0n) {
          // History before cutover: the branch box already holds `opening`.
          branch.push(manualKaish('office_cash', m(opening), 'history'))
          company.push(companyOpeningTransfer(BRANCH, m(opening)))
        }
        let nextId = 1
        const post = (p: Posting) => {
          const id = nextId++
          branch.push(p)
          const movement = companyBoxMovement(
            p.lines.map((l) => ({ fundCode: fundCode(l.fund), side: l.side, amount: l.amount })),
          )
          if (movement) company.push(restorationMirror(movement.direction, movement.amount, BRANCH, id))
        }
        const moving: Posting[] = []
        for (const o of ops) {
          if (o.kind === 'reverse') {
            if (moving.length === 0) continue
            const target = moving[o.pick % moving.length]!
            post(reverse(target, `rev-${nextId}`))
            continue
          }
          const posting =
            o.kind === 'sweep'
              ? sweepToCompany(o.office, m(o.amount), `k-${nextId}`)
              : o.kind === 'shahn'
                ? fundFromCompany(o.office, m(o.amount), `k-${nextId}`)
                : manualKaish(o.office, m(o.amount), `k-${nextId}`)
          moving.push(posting)
          post(posting)
        }
        const box = balanceOf(branch, byCode('company_box'))
        const clearing = balanceOf(company, byCode(`branch_clearing:${BRANCH}`))
        expect(box + clearing).toBe(0n)
        // Every lira the branch sent or received shows up in the company SYP pocket.
        expect(balanceOf(company, byCode('company_cash:SYP_NEW'))).toBe(box)
        for (const p of company) assertBalanced(p)
      }),
      { numRuns: 300 },
    )
  })
})

describe('the company pocket after tonight\'s restoration — a warning, never a refusal', () => {
  const plan = (cash: bigint, wallet: bigint) =>
    planRestoration([
      { fundCode: 'office_cash', officeBalance: m(cash), receivables: m(0n), advances: m(0n), capitalTarget: m(5_000_000n) },
      { fundCode: 'office_wallet', officeBalance: m(wallet), receivables: m(0n), advances: m(0n), capitalTarget: m(1_000_000n) },
    ])

  it('adds the sweeps and subtracts the top-ups', () => {
    // −630,000 cash shortfall, +630,000 wallet surplus: net zero.
    expect(companyPocketAfterRestoration(m(100n), plan(4_370_000n, 1_630_000n))).toEqual({ pocketAfter: 100n, warning: false })
    // A pure top-up larger than the pocket: allowed, and flagged.
    expect(companyPocketAfterRestoration(m(1_000_000n), plan(3_760_000n, 1_000_000n))).toEqual({
      pocketAfter: -240_000n,
      warning: true,
    })
    // Exactly empty is not negative.
    expect(companyPocketAfterRestoration(m(1_240_000n), plan(3_760_000n, 1_000_000n))).toEqual({ pocketAfter: 0n, warning: false })
  })

  it('warns exactly when the pocket would end below zero (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 10n), max: 10n ** 10n }),
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        (pocket, cash, wallet) => {
          const p = plan(cash, wallet)
          const out = companyPocketAfterRestoration(m(pocket), p)
          expect(out.pocketAfter).toBe(pocket + p.netToCompany)
          expect(out.warning).toBe(pocket + p.netToCompany < 0n)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('currency never leaks between the pockets', () => {
  it('names the currency in every company line code', () => {
    for (const currency of ['SYP_NEW', 'USD'] as const satisfies readonly Currency[]) {
      for (const posting of [
        companyDeposit(currency, m(1n), 'owner_funding', KEY),
        companyWithdrawal(currency, m(1n), KEY),
        companyExpense(currency, m(1n), 'general', 'pocket', KEY),
        companyIncome(currency, m(1n), KEY),
      ]) {
        expect(posting.lines.every((l) => fundCode(l.fund).split(':')[1] === currency)).toBe(true)
        expect(currencyBalances(posting).map((b) => b.currency)).toEqual([currency])
      }
    }
  })
})
