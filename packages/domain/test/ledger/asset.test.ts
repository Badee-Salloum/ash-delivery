import { describe, expect, it } from 'vitest'
import {
  assetPurchase,
  depreciationRelease,
  depreciationTransfer,
  fundCode,
  minor,
} from '../../src/index.ts'

const m = (value: bigint) => minor(value)

describe('fixed-asset and depreciation postings', () => {
  it('splits a purchase into paid and financed amounts exactly', () => {
    const result = assetPurchase({
      assetId: 'asset-1',
      currency: 'USD',
      price: m(180_000n),
      paidNow: m(120_000n),
      paidFrom: 'pocket',
      debtId: 'debt-1',
      occurrenceKey: 'asset-1',
    })
    expect(result.financed).toBe(60_000n)
    expect(result.posting.lines.map((line) => [line.side, fundCode(line.fund), line.amount])).toEqual([
      ['D', 'fixed_asset:USD:asset-1', 180_000n],
      ['C', 'company_cash:USD', 120_000n],
      ['C', 'company_payable:USD:debt-1', 60_000n],
    ])
  })

  it('supports a historical fully financed opening without a fake cash movement', () => {
    const result = assetPurchase({
      assetId: 'asset-2',
      currency: 'SYP_NEW',
      price: m(90_000n),
      paidNow: m(0n),
      paidFrom: 'opening',
      debtId: 'debt-2',
      occurrenceKey: 'asset-2',
    })
    expect(result.posting.lines.map((line) => fundCode(line.fund))).toEqual([
      'fixed_asset:SYP_NEW:asset-2',
      'company_payable:SYP_NEW:debt-2',
    ])
  })

  it('moves depreciation between the pocket and reserve without touching P&L', () => {
    const transfer = depreciationTransfer('USD', m(5_000n), 'dep-2026-09')
    const release = depreciationRelease('USD', m(2_000n), 'release-1')
    expect(transfer.lines.map((line) => [line.side, fundCode(line.fund)])).toEqual([
      ['D', 'depreciation_reserve:USD'],
      ['C', 'company_cash:USD'],
    ])
    expect(release.lines.map((line) => [line.side, fundCode(line.fund)])).toEqual([
      ['D', 'company_cash:USD'],
      ['C', 'depreciation_reserve:USD'],
    ])
  })

  it('refuses impossible purchase splits', () => {
    expect(() =>
      assetPurchase({
        assetId: 'a',
        currency: 'USD',
        price: m(100n),
        paidNow: m(101n),
        paidFrom: 'pocket',
        occurrenceKey: 'x',
      }),
    ).toThrow('exceeds price')
    expect(() =>
      assetPurchase({
        assetId: 'a',
        currency: 'USD',
        price: m(100n),
        paidNow: m(99n),
        paidFrom: 'pocket',
        occurrenceKey: 'x',
      }),
    ).toThrow('needs its debt id')
  })
})
