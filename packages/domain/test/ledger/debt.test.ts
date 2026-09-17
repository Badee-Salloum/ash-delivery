import { describe, expect, it } from 'vitest'
import {
  companyDebtOpen,
  companyDebtOutstanding,
  companyDebtPayment,
  companyDebtWriteoff,
  fundCode,
  minor,
} from '../../src/index.ts'

const m = (value: bigint) => minor(value)

describe('company debt postings', () => {
  it('opens a cash payable as cash received against the named liability', () => {
    const posting = companyDebtOpen({
      debtId: 'debt-1',
      direction: 'payable',
      currency: 'USD',
      principal: m(25_000n),
      origin: 'cash',
      occurrenceKey: 'open-1',
    })

    expect(posting.eventType).toBe('company_debt_open')
    expect(posting.lines.map((line) => [line.side, fundCode(line.fund), line.amount, line.role])).toEqual([
      ['D', 'company_cash:USD', 25_000n, 'debt_open_counterpart'],
      ['C', 'company_payable:USD:debt-1', 25_000n, 'debt_open_balance'],
    ])
  })

  it('opens earned but uncollected income as a receivable', () => {
    const posting = companyDebtOpen({
      debtId: 'debt-2',
      direction: 'receivable',
      currency: 'SYP_NEW',
      principal: m(91_000n),
      origin: 'income',
      occurrenceKey: 'open-2',
    })

    expect(posting.lines.map((line) => [line.side, fundCode(line.fund)])).toEqual([
      ['D', 'company_receivable:SYP_NEW:debt-2'],
      ['C', 'company_income:SYP_NEW:general'],
    ])
  })

  it('records a payable instalment from the reserve without changing profit', () => {
    const posting = companyDebtPayment({
      debtId: 'debt-3',
      direction: 'payable',
      currency: 'USD',
      amount: m(10_000n),
      outstanding: m(60_000n),
      paidFrom: 'reserve',
      occurrenceKey: 'pay-1',
    })

    expect(posting.lines.map((line) => [line.side, fundCode(line.fund)])).toEqual([
      ['D', 'company_payable:USD:debt-3'],
      ['C', 'depreciation_reserve:USD'],
    ])
  })

  it('collects a receivable into the matching-currency company pocket', () => {
    const posting = companyDebtPayment({
      debtId: 'debt-4',
      direction: 'receivable',
      currency: 'SYP_NEW',
      amount: m(9_000n),
      outstanding: m(9_000n),
      occurrenceKey: 'collect-1',
    })

    expect(posting.lines.map((line) => [line.side, fundCode(line.fund)])).toEqual([
      ['D', 'company_cash:SYP_NEW'],
      ['C', 'company_receivable:SYP_NEW:debt-4'],
    ])
  })

  it('recognises the two write-off directions outside cash', () => {
    const payable = companyDebtWriteoff({
      debtId: 'p',
      direction: 'payable',
      currency: 'USD',
      amount: m(1_000n),
      outstanding: m(1_000n),
      occurrenceKey: 'writeoff-p',
    })
    const receivable = companyDebtWriteoff({
      debtId: 'r',
      direction: 'receivable',
      currency: 'SYP_NEW',
      amount: m(2_000n),
      outstanding: m(2_000n),
      occurrenceKey: 'writeoff-r',
    })

    expect(payable.lines.map((line) => fundCode(line.fund))).toEqual([
      'company_payable:USD:p',
      'company_income:USD:payable_forgiven',
    ])
    expect(receivable.lines.map((line) => fundCode(line.fund))).toEqual([
      'company_expense:SYP_NEW:receivable_writeoff',
      'company_receivable:SYP_NEW:r',
    ])
  })

  it('refuses impossible origins, overpayment and malformed ids', () => {
    expect(() =>
      companyDebtOpen({
        debtId: 'bad',
        direction: 'payable',
        currency: 'USD',
        principal: m(1n),
        origin: 'income',
        occurrenceKey: 'x',
      }),
    ).toThrow('income can open a receivable')

    expect(() =>
      companyDebtOpen({
        debtId: 'bad:id',
        direction: 'receivable',
        currency: 'USD',
        principal: m(1n),
        origin: 'cash',
        occurrenceKey: 'x',
      }),
    ).toThrow('fund-code segment')

    expect(() =>
      companyDebtPayment({
        debtId: 'd',
        direction: 'receivable',
        currency: 'USD',
        amount: m(11n),
        outstanding: m(10n),
        occurrenceKey: 'x',
      }),
    ).toThrow('exceeds outstanding')
  })

  it('derives outstanding from the debt fund sign and refuses an impossible sign', () => {
    expect(companyDebtOutstanding('payable', m(-77n))).toBe(77n)
    expect(companyDebtOutstanding('receivable', m(88n))).toBe(88n)
    expect(() => companyDebtOutstanding('payable', m(1n))).toThrow('wrong balance sign')
    expect(() => companyDebtOutstanding('receivable', m(-1n))).toThrow('wrong balance sign')
  })
})
