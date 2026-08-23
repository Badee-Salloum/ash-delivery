import { describe, expect, it } from 'vitest'
import { isValidOpeningFundInput, openingFundTranches } from './opening-funds.ts'

describe('opening fund tranche payload', () => {
  it.each([
    ['', '', { floatTranches: [], topupTranches: [] }],
    ['0', '', { floatTranches: [], topupTranches: [] }],
    ['', '0.00', { floatTranches: [], topupTranches: [] }],
    ['0.0', '0', { floatTranches: [], topupTranches: [] }],
    ['100000', '50000.25', { floatTranches: ['100000'], topupTranches: ['50000.25'] }],
  ] as const)('maps float %j and top-up %j without fake zero tranches', (cash, wallet, expected) => {
    expect(openingFundTranches(cash, wallet)).toEqual(expected)
  })

  it('does not hide invalid or negative operator input as an empty tranche', () => {
    expect(openingFundTranches('-1', 'not-money')).toEqual({
      floatTranches: ['-1'],
      topupTranches: ['not-money'],
    })
  })

  it.each([
    ['', true],
    ['0', true],
    ['0.00', true],
    ['12.34', true],
    ['-0.01', false],
    ['not-money', false],
  ])('validates opening input %j before confirmation', (value, expected) => {
    expect(isValidOpeningFundInput(value)).toBe(expected)
  })
})
