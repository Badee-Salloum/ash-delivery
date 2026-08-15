import { describe, expect, it } from 'vitest'
import {
  buildCountLines,
  countDifference,
  countDraftReady,
  differenceView,
  restoreCountDraft,
  summarizeRestoration,
} from './treasury-view.ts'

describe('treasury presentation', () => {
  it('separates count direction from the absolute amount', () => {
    expect(countDifference('120.00', '100.00')).toEqual({ direction: 'increase', signed: '20.00', amount: '20.00' })
    expect(countDifference('80.00', '100.00')).toEqual({ direction: 'shortage', signed: '-20.00', amount: '20.00' })
    expect(countDifference('100.00', '100.00')).toEqual({ direction: 'none', signed: '0.00', amount: '0.00' })
  })

  it('does not infer a difference from an empty or invalid draft', () => {
    expect(countDifference('', '100.00')).toBeNull()
    expect(countDifference('not-money', '100.00')).toBeNull()
  })

  it('requires an audited reason only for a non-zero count difference', () => {
    const funds = [
      { fundCode: 'office_cash', computed: '100.00' },
      { fundCode: 'office_wallet', computed: '50.00' },
    ]
    const counted = { office_cash: '120.00', office_wallet: '50.00' }
    expect(countDraftReady(funds, counted, {})).toBe(false)
    expect(countDraftReady(funds, counted, { office_cash: 'Verified against the physical box' })).toBe(true)
    expect(buildCountLines(funds, counted, { office_cash: '  Verified against the physical box  ' })).toEqual([
      { fundCode: 'office_cash', counted: '120.00', resolution: 'Verified against the physical box' },
      { fundCode: 'office_wallet', counted: '50.00', resolution: null },
    ])
  })

  it('restores a persisted count and its reasons after refresh', () => {
    expect(
      restoreCountDraft([
        { fundCode: 'office_cash', counted: '120.00', computed: '100.00', variance: '20.00', resolution: 'Counted twice' },
        { fundCode: 'office_wallet', counted: '50.00', computed: '50.00', variance: '0.00', resolution: null },
      ]),
    ).toEqual({
      counted: { office_cash: '120.00', office_wallet: '50.00' },
      resolutions: { office_cash: 'Counted twice', office_wallet: '' },
    })
  })

  it('matches the spreadsheet capital example and keeps the direction explicit', () => {
    const summary = summarizeRestoration([
      {
        fundCode: 'office_cash',
        position: '5088592.00',
        capitalTarget: '4000000.00',
        delta: '1088592.00',
        direction: 'to_company',
        amount: '1088592.00',
      },
      {
        fundCode: 'office_wallet',
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
        position: '1100.00',
        capitalTarget: '1000.00',
        delta: '100.00',
        direction: 'to_company' as const,
        amount: '100.00',
      },
      {
        fundCode: 'office_wallet',
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
})
