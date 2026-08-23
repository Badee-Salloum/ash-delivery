import { describe, expect, it } from 'vitest'
import {
  balanceOf,
  postingsForCashSettledApproval,
  postingsForOpen,
} from '@ash/domain'
import { SeedRefused, assertSeedAllowed, buildDemoShiftMoney } from '../src/seed.ts'

/**
 * The seed guard.
 *
 * The design review flagged the original as a three-way AND — which meant a virgin production
 * database happily accepted the full demo dataset. It is now an OR of independent conditions:
 * ANY one of them refuses.
 */
describe('the seed refuses to touch production', () => {
  it.each([
    ['NODE_ENV=production', { NODE_ENV: 'production' }],
    ['APP_ENV=production', { APP_ENV: 'production' }],
    ['a DATABASE_URL mentioning prod', { DATABASE_URL: 'postgres://u:p@db/ash_prod' }],
    ['ALLOW_SEED=false', { ALLOW_SEED: 'false' }],
  ])('refuses on %s — ALONE, not only in combination', (_label, env) => {
    expect(() => assertSeedAllowed(env as NodeJS.ProcessEnv)).toThrow(SeedRefused)
  })

  it('names every reason it refused, so the operator is not guessing', () => {
    try {
      assertSeedAllowed({ NODE_ENV: 'production', ALLOW_SEED: 'false' } as NodeJS.ProcessEnv)
      expect.unreachable('should have refused')
    } catch (err) {
      expect((err as Error).message).toContain('NODE_ENV=production')
      expect((err as Error).message).toContain('ALLOW_SEED=false')
    }
  })

  it('allows a clean development environment', () => {
    expect(() =>
      assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: 'postgres://localhost/ash_dev' } as NodeJS.ProcessEnv),
    ).not.toThrow()
  })

  it('--force overrides, because sometimes you really do mean it', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, true)).not.toThrow()
  })
})

describe('the demo shift uses the current fixed-40 cash settlement', () => {
  it('is balanced, variance-free, and clears every driver money fund', () => {
    const demo = buildDemoShiftMoney('2026-08-23')

    expect(demo.orders).toHaveLength(20)
    expect(demo.orders.filter((order) => order.payMode === 'cash')).toHaveLength(12)
    expect(demo.orders.filter((order) => order.payMode === 'electronic')).toHaveLength(6)
    expect(demo.orders.filter((order) => order.payMode === 'free')).toHaveLength(2)
    expect(demo.settlement).toMatchObject({
      deliveryFeeTotal: 10_000_000n,
      fixedDriverShare: 4_000_000n,
      baseDriverShare: 4_000_000n,
      expectedCash: 16_000_000n,
      expectedWallet: 7_000_000n,
      actualTotal: 23_000_000n,
      variance: 0n,
      finalEmployeeCash: 4_000_000n,
      walletToOffice: 7_000_000n,
      cashToOffice: 12_000_000n,
    })

    const postings = [
      ...postingsForOpen(demo.input),
      ...postingsForCashSettledApproval(demo.input, demo.split, demo.settlement),
    ]
    for (const posting of postings) {
      const debits = posting.lines
        .filter((line) => line.side === 'D')
        .reduce((total, line) => total + line.amount, 0n)
      const credits = posting.lines
        .filter((line) => line.side === 'C')
        .reduce((total, line) => total + line.amount, 0n)
      expect(debits).toBe(credits)
    }
    expect(postings.filter((posting) => posting.eventType === 'wallet_return'))
      .toMatchObject([{ occurrenceKey: '1' }])
    expect(postings.filter((posting) => posting.eventType === 'float_return'))
      .toMatchObject([{ occurrenceKey: '1' }])

    const belongsToDemoDriver = (kind: string) => (fund: { kind: string; driverId?: string }) =>
      fund.kind === kind && fund.driverId === demo.input.driverId
    expect(balanceOf(postings, belongsToDemoDriver('driver_cash'))).toBe(0n)
    expect(balanceOf(postings, belongsToDemoDriver('driver_wallet'))).toBe(0n)
    expect(balanceOf(postings, belongsToDemoDriver('driver_share_payable'))).toBe(0n)
    expect(balanceOf(postings, belongsToDemoDriver('driver_receivable_cash'))).toBe(0n)
  })
})
