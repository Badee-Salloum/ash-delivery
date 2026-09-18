import { addMonths, monthStartFor, monthsBetween, type CalendarDate } from '../time/civil.ts'
import { type Minor, ZERO, minor } from '../money/minor.ts'

export const DEFAULT_ASSET_USEFUL_MONTHS = 36

export interface DepreciationPeriod {
  assetId: string
  period: number
  /** First day of the month. Period 1 is the purchase month. */
  periodMonth: CalendarDate
  amount: Minor
}

export interface DepreciationFunding {
  assetId: string
  period: number
  amount: Minor
}

export interface PlannedDepreciationAllocation {
  assetId: string
  period: number
  periodMonth: CalendarDate
  amount: Minor
}

function positiveMonths(months: number): void {
  if (!Number.isSafeInteger(months) || months <= 0) {
    throw new RangeError(`asset useful months must be a positive safe integer, got ${months}`)
  }
}

/**
 * Straight-line amount for one period. Every period except the last gets floor(price / months);
 * the final period receives the integer remainder, so the schedule sums to the purchase price.
 */
export function depreciationAmount(price: Minor, months: number, period: number): Minor {
  if (price <= ZERO) throw new RangeError(`asset price must be positive, got ${price}`)
  positiveMonths(months)
  if (!Number.isSafeInteger(period) || period < 1 || period > months) {
    throw new RangeError(`depreciation period ${period} is outside 1..${months}`)
  }
  const count = BigInt(months)
  const base = price / count
  return period === months ? minor(price - base * BigInt(months - 1)) : minor(base)
}

export function depreciationSchedule(
  assetId: string,
  price: Minor,
  purchasedOn: CalendarDate,
  usefulMonths = DEFAULT_ASSET_USEFUL_MONTHS,
): DepreciationPeriod[] {
  if (assetId.trim() === '') throw new RangeError('a depreciation schedule needs an asset id')
  positiveMonths(usefulMonths)
  const firstMonth = monthStartFor(purchasedOn)
  return Array.from({ length: usefulMonths }, (_, index) => ({
    assetId,
    period: index + 1,
    periodMonth: addMonths(firstMonth, index),
    amount: depreciationAmount(price, usefulMonths, index + 1),
  }))
}

/** Number of scheduled periods due through `asOf`, including the purchase month as period one. */
export function depreciationPeriodsDue(
  purchasedOn: CalendarDate,
  asOf: CalendarDate,
  usefulMonths = DEFAULT_ASSET_USEFUL_MONTHS,
): number {
  positiveMonths(usefulMonths)
  const elapsed = monthsBetween(monthStartFor(purchasedOn), monthStartFor(asOf))
  if (elapsed < 0) return 0
  return Math.min(usefulMonths, elapsed + 1)
}

/** Time-based book value. Funding the reserve never changes it; the calendar does. */
export function assetBookValue(
  price: Minor,
  purchasedOn: CalendarDate,
  asOf: CalendarDate,
  usefulMonths = DEFAULT_ASSET_USEFUL_MONTHS,
): Minor {
  const due = depreciationPeriodsDue(purchasedOn, asOf, usefulMonths)
  let depreciated = 0n
  for (let period = 1; period <= due; period += 1) {
    depreciated += depreciationAmount(price, usefulMonths, period)
  }
  return minor(price - depreciated)
}

function fundingKey(assetId: string, period: number): string {
  return `${assetId}\u0000${period}`
}

/**
 * Allocate the amount that can actually move into the reserve, oldest due period first.
 * Existing allocations are immutable history and are subtracted per (asset, period).
 */
export function planDepreciationTransfer(input: {
  schedule: readonly DepreciationPeriod[]
  funded: readonly DepreciationFunding[]
  asOfMonth: CalendarDate
  available: Minor
}): { totalDue: Minor; transferAmount: Minor; remainingDue: Minor; allocations: PlannedDepreciationAllocation[] } {
  const asOfMonth = monthStartFor(input.asOfMonth)
  const fundedByPeriod = new Map<string, bigint>()
  for (const row of input.funded) {
    if (row.amount < ZERO) throw new RangeError(`funded depreciation cannot be negative, got ${row.amount}`)
    const key = fundingKey(row.assetId, row.period)
    fundedByPeriod.set(key, (fundedByPeriod.get(key) ?? 0n) + row.amount)
  }

  const dueRows = input.schedule
    .filter((row) => monthStartFor(row.periodMonth) <= asOfMonth)
    .map((row) => {
      const funded = fundedByPeriod.get(fundingKey(row.assetId, row.period)) ?? 0n
      if (funded > row.amount) {
        throw new RangeError(`depreciation funding exceeds ${row.assetId} period ${row.period}`)
      }
      return { ...row, remaining: row.amount - funded }
    })
    .filter((row) => row.remaining > 0n)
    .sort((a, b) =>
      a.periodMonth === b.periodMonth
        ? a.assetId === b.assetId
          ? a.period - b.period
          : a.assetId.localeCompare(b.assetId, 'en')
        : a.periodMonth.localeCompare(b.periodMonth, 'en'),
    )

  let due = 0n
  for (const row of dueRows) due += row.remaining
  const available = input.available > ZERO ? input.available : ZERO
  let left = due < available ? due : available
  const transferAmount = minor(left)
  const allocations: PlannedDepreciationAllocation[] = []
  for (const row of dueRows) {
    if (left === 0n) break
    const amount = row.remaining < left ? row.remaining : left
    allocations.push({ assetId: row.assetId, period: row.period, periodMonth: row.periodMonth, amount: minor(amount) })
    left -= amount
  }

  return {
    totalDue: minor(due),
    transferAmount,
    remainingDue: minor(due - transferAmount),
    allocations,
  }
}
