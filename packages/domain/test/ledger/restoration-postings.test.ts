import { describe, expect, it } from 'vitest'
import { creditsOf, debitsOf, fundCode, fundFromCompany, sweepToCompany } from '../../src/ledger/recipes.ts'
import { minor } from '../../src/money/minor.ts'

/**
 * «الترميم» — the two postings the daily restoration emits.
 *
 * The owner's process, in his words: office capital is a FIXED target per box, and at the end of
 * each working day the surplus is withdrawn as profit («كييش») and any shortfall replenished
 * («شحن من الصندوق»), counting الذمم toward the capital.
 *
 * These two functions are the whole ledger surface of that. Everything else — deciding WHICH way
 * and HOW MUCH — is the planner's job and is tested separately; what is pinned here is that the
 * money moves in the right direction and that the pair are exact inverses.
 */
describe('كييش — profit leaves the branch box for صندوق الشركة', () => {
  it('debits the company fund and credits the office box', () => {
    const p = sweepToCompany('office_cash', minor(297_000_00n))
    expect(p.eventType).toBe('restoration')
    expect(p.lines).toHaveLength(2)

    const debit = p.lines.find((l) => l.side === 'D')!
    const credit = p.lines.find((l) => l.side === 'C')!
    expect(fundCode(debit.fund)).toBe('company_box')
    expect(fundCode(credit.fund)).toBe('office_cash')
    expect(debit.amount).toBe(minor(297_000_00n))
  })

  /**
   * The wallet sweeps to the SAME place as the cash (owner decision (l)). An earlier reading of his
   * answer routed the wallet surplus into the branch cash box first; he corrected it — both boxes
   * settle directly against صندوق الشركة.
   */
  it('works on the wallet box too, and sweeps it to the same fund', () => {
    const p = sweepToCompany('office_wallet', minor(230_000_00n))
    expect(fundCode(p.lines.find((l) => l.side === 'D')!.fund)).toBe('company_box')
    expect(fundCode(p.lines.find((l) => l.side === 'C')!.fund)).toBe('office_wallet')
  })
})

describe('شحن من الصندوق — the company fund restores the office capital', () => {
  it('is the exact inverse of a sweep', () => {
    const amount = minor(50_000_00n)
    const out = sweepToCompany('office_cash', amount)
    const back = fundFromCompany('office_cash', amount)

    const sideOf = (p: typeof out, code: string) => p.lines.find((l) => fundCode(l.fund) === code)!.side
    expect(sideOf(out, 'company_box')).toBe('D')
    expect(sideOf(back, 'company_box')).toBe('C')
    expect(sideOf(out, 'office_cash')).toBe('C')
    expect(sideOf(back, 'office_cash')).toBe('D')
  })

  it('nets to nothing when a sweep is immediately undone', () => {
    const amount = minor(12_345_67n)
    const both = [sweepToCompany('office_wallet', amount), fundFromCompany('office_wallet', amount)]
    const net = (code: string) =>
      both
        .flatMap((p) => p.lines)
        .filter((l) => fundCode(l.fund) === code)
        .reduce((sum, l) => sum + (l.side === 'D' ? l.amount : -l.amount), 0n)
    expect(net('company_box')).toBe(0n)
    expect(net('office_wallet')).toBe(0n)
  })
})

describe('both postings obey the ledger', () => {
  it.each([
    ['sweep cash', sweepToCompany('office_cash', minor(1n))],
    ['sweep wallet', sweepToCompany('office_wallet', minor(999_999_99n))],
    ['fund cash', fundFromCompany('office_cash', minor(1n))],
    ['fund wallet', fundFromCompany('office_wallet', minor(999_999_99n))],
  ])('%s balances', (_label, posting) => {
    expect(debitsOf(posting)).toBe(creditsOf(posting))
  })

  /** Direction is carried by `side`; a zero has no direction, so the ledger refuses it. */
  it('refuses a zero or negative amount rather than posting a no-op', () => {
    expect(() => sweepToCompany('office_cash', minor(0n))).toThrow(RangeError)
    expect(() => fundFromCompany('office_cash', minor(-1n))).toThrow(RangeError)
  })

  /**
   * One restoration per box per day, so the two legs of a day must not collide on the idempotency
   * key (shift_id, event_type, occurrence_key). The caller supplies it; this pins that it is used.
   */
  it('carries the caller occurrence key, so cash and wallet legs can coexist', () => {
    expect(sweepToCompany('office_cash', minor(1n), '2026-08-12:office_cash').occurrenceKey).toBe(
      '2026-08-12:office_cash',
    )
    expect(fundFromCompany('office_wallet', minor(1n), '2026-08-12:office_wallet').occurrenceKey).toBe(
      '2026-08-12:office_wallet',
    )
  })
})
