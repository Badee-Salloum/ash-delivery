import { describe, expect, it } from 'vitest'
import { isValidOpeningFundInput, openingApprovalRequest, openingFundTranches } from './opening-funds.ts'

describe('opening fund tranche payload', () => {
  it.each([
    ['', '', { floatTranches: [], topupTranches: [] }],
    ['', '50000', { floatTranches: [], topupTranches: ['50000'] }],
    ['100000', '', { floatTranches: ['100000'], topupTranches: [] }],
    ['0', '50000', { floatTranches: [], topupTranches: ['50000'] }],
    ['100000', '0', { floatTranches: ['100000'], topupTranches: [] }],
    ['0.0', '0.00', { floatTranches: [], topupTranches: [] }],
    ['100000', '50000.25', { floatTranches: ['100000'], topupTranches: ['50000.25'] }],
  ] as const)('maps float %j and top-up %j without fake zero tranches', (cash, wallet, expected) => {
    expect(openingFundTranches(cash, wallet)).toEqual(expected)
  })

  it('accepts Arabic-keyboard zero and sends localized positive amounts as ASCII money', () => {
    expect(openingFundTranches('٠', '٥٠٠٠٠')).toEqual({
      floatTranches: [],
      topupTranches: ['50000'],
    })
    expect(openingFundTranches('۱۰۰۰۰۰', '۰')).toEqual({
      floatTranches: ['100000'],
      topupTranches: [],
    })
  })

  it('does not hide invalid or negative operator input as an empty tranche', () => {
    expect(openingFundTranches('-1', 'not-money')).toEqual({
      floatTranches: ['-1'],
      topupTranches: ['not-money'],
    })
  })

  it('sends the exact reviewed cash and wallet funding, including explicit zero arrays', () => {
    expect(openingApprovalRequest('100000', '0', { cash: '12500.00', wallet: '0.00' })).toEqual({
      floatTranches: ['100000'],
      topupTranches: [],
      carriedTranches: ['12500.00'],
      carriedWalletTranches: [],
    })
    expect(openingApprovalRequest('', '', { cash: '0.00', wallet: '0.00' })).toEqual({
      floatTranches: [],
      topupTranches: [],
      carriedTranches: [],
      carriedWalletTranches: [],
    })
  })

  it.each([
    ['', true],
    ['0', true],
    ['0.00', true],
    ['٠', true],
    ['۰', true],
    ['12.34', true],
    ['-0.01', false],
    ['not-money', false],
  ])('validates opening input %j before confirmation', (value, expected) => {
    expect(isValidOpeningFundInput(value)).toBe(expected)
  })
})
