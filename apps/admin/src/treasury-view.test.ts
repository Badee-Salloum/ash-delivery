import { describe, expect, it } from 'vitest'
import {
  differenceView,
  receivableDriverTotal,
  summarizeRestoration,
} from './treasury-view.ts'

describe('treasury presentation', () => {
  it('summarizes ledger-backed office balances and keeps the direction explicit', () => {
    const summary = summarizeRestoration([
      {
        fundCode: 'office_cash',
        officeBalance: '4688592.00',
        receivables: '400000.00',
        position: '5088592.00',
        capitalTarget: '4000000.00',
        delta: '1088592.00',
        direction: 'to_company',
        amount: '1088592.00',
      },
      {
        fundCode: 'office_wallet',
        officeBalance: '983560.00',
        receivables: '30000.00',
        position: '1013560.00',
        capitalTarget: '1000000.00',
        delta: '13560.00',
        direction: 'to_company',
        amount: '13560.00',
      },
    ])
    expect(summary).toEqual({
      position: '6102152.00',
      target: '5000000.00',
      delta: { direction: 'increase', signed: '1102152.00', amount: '1102152.00' },
    })
  })

  it('keeps opposing restoration legs even when their net is zero', () => {
    const legs = [
      {
        fundCode: 'office_cash',
        officeBalance: '1050.00',
        receivables: '50.00',
        position: '1100.00',
        capitalTarget: '1000.00',
        delta: '100.00',
        direction: 'to_company' as const,
        amount: '100.00',
      },
      {
        fundCode: 'office_wallet',
        officeBalance: '875.00',
        receivables: '25.00',
        position: '900.00',
        capitalTarget: '1000.00',
        delta: '-100.00',
        direction: 'from_company' as const,
        amount: '100.00',
      },
    ]
    expect(summarizeRestoration(legs).delta.direction).toBe('none')
    expect(legs.map((leg) => leg.direction)).toEqual(['to_company', 'from_company'])
    expect(differenceView('0.00')).toEqual({ direction: 'none', signed: '0.00', amount: '0.00' })
  })

  it('totals each driver receivable with integer money math', () => {
    expect(receivableDriverTotal({ cash: '400000.00', wallet: '30000.00' })).toBe('430000.00')
    expect(receivableDriverTotal({ cash: '9007199254740993.00', wallet: '7.00' })).toBe('9007199254741000.00')
  })
})
