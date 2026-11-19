import { describe, expect, it } from 'vitest'
import { existingAssetCalculatedBookValue, existingAssetDepreciationSchedule } from '../../src/assets/existing.ts'
import { minor } from '../../src/money/minor.ts'

describe('optional existing motor depreciation calculation', () => {
  it('uses individual cost, residual and useful life with exact integer conservation', () => {
    const schedule = existingAssetDepreciationSchedule({ cost: minor(10001n), residualValue: minor(1000n), startsOn: '2026-07-21', usefulMonths: 5 })
    expect(schedule.map((row) => row.amount)).toEqual([1800n, 1800n, 1800n, 1800n, 1801n])
    expect(schedule.map((row) => row.periodMonth)).toEqual(['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'])
    expect(schedule.reduce((sum, row) => sum + row.amount, 0n)).toBe(9001n)
    expect(schedule[0]).toMatchObject({ startsOn: '2026-07-21', endsOn: '2026-07-31' })
    expect(schedule[1]).toMatchObject({ startsOn: '2026-08-01', endsOn: '2026-08-31' })
  })
  it('does not count depreciation already approved in the baseline again', () => {
    const input = { cost: minor(12000n), residualValue: minor(0n), startsOn: '2026-01-01', usefulMonths: 12, accumulatedDepreciation: minor(6000n), recognitionAsOf: '2026-06-30' }
    expect(existingAssetCalculatedBookValue({ ...input, asOf: '2026-08-31' })).toBe(4000n)
    expect(existingAssetCalculatedBookValue({ ...input, asOf: '2026-12-31', soldOn: '2026-08-10' })).toBe(5000n)
  })
  it('rejects invalid costs, dates, residual values and useful lives', () => {
    const base = { cost: minor(100n), residualValue: minor(0n), startsOn: '2026-01-01', usefulMonths: 12 }
    for (const patch of [{ cost: minor(0n) }, { residualValue: minor(101n) }, { residualValue: minor(-1n) }, { usefulMonths: 0 }, { usefulMonths: 601 }, { usefulMonths: 1.5 }, { startsOn: '2026-02-30' }]) {
      expect(() => existingAssetDepreciationSchedule({ ...base, ...patch })).toThrow(RangeError)
    }
  })
})
