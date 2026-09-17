import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  assetBookValue,
  depreciationAmount,
  depreciationPeriodsDue,
  depreciationSchedule,
  minor,
  planDepreciationTransfer,
} from '../../src/index.ts'

const m = (value: bigint) => minor(value)

describe('fixed-asset depreciation', () => {
  it('makes the purchase month period one and puts the remainder in period 36', () => {
    const rows = depreciationSchedule('bike-1', m(100n), '2026-09-17')
    expect(rows).toHaveLength(36)
    expect(rows[0]).toEqual({ assetId: 'bike-1', period: 1, periodMonth: '2026-09-01', amount: 2n })
    expect(rows[34]?.amount).toBe(2n)
    expect(rows[35]).toEqual({ assetId: 'bike-1', period: 36, periodMonth: '2029-08-01', amount: 30n })
    expect(rows.reduce((total, row) => total + row.amount, 0n)).toBe(100n)
  })

  it('the schedule always sums exactly to price', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000_000_000n }),
        fc.integer({ min: 1, max: 120 }),
        (price, months) => {
          let total = 0n
          for (let period = 1; period <= months; period += 1) {
            total += depreciationAmount(m(price), months, period)
          }
          expect(total).toBe(price)
        },
      ),
    )
  })

  it('book value is time-based, catches up, and reaches zero', () => {
    expect(depreciationPeriodsDue('2025-10-20', '2025-09-30')).toBe(0)
    expect(depreciationPeriodsDue('2025-10-20', '2025-10-01')).toBe(1)
    expect(depreciationPeriodsDue('2025-10-20', '2026-09-17')).toBe(12)
    expect(assetBookValue(m(3_600n), '2025-10-20', '2026-09-17')).toBe(2_400n)
    expect(assetBookValue(m(3_600n), '2025-10-20', '2030-01-01')).toBe(0n)
  })

  it('funds oldest due periods first and leaves a visible shortfall', () => {
    const schedule = [
      ...depreciationSchedule('b', m(360n), '2026-01-10'),
      ...depreciationSchedule('a', m(720n), '2026-02-10'),
    ]
    const plan = planDepreciationTransfer({
      schedule,
      funded: [{ assetId: 'b', period: 1, amount: m(5n) }],
      asOfMonth: '2026-02-20',
      available: m(18n),
    })

    // b Jan: 10 scheduled - 5 funded = 5; then a Feb gets 13 of its 20. b Feb remains due.
    expect(plan.totalDue).toBe(35n)
    expect(plan.transferAmount).toBe(18n)
    expect(plan.remainingDue).toBe(17n)
    expect(plan.allocations).toEqual([
      { assetId: 'b', period: 1, periodMonth: '2026-01-01', amount: 5n },
      { assetId: 'a', period: 1, periodMonth: '2026-02-01', amount: 13n },
    ])
  })

  it('moves nothing when the company pocket is negative', () => {
    const plan = planDepreciationTransfer({
      schedule: depreciationSchedule('a', m(36n), '2026-01-01'),
      funded: [],
      asOfMonth: '2026-01-01',
      available: m(-10n),
    })
    expect(plan.transferAmount).toBe(0n)
    expect(plan.remainingDue).toBe(1n)
    expect(plan.allocations).toEqual([])
  })
})
