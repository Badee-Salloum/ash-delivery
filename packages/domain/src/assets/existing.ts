import { isCalendarDate, monthStartFor, monthEndFor, addMonths, type CalendarDate } from '../time/civil.ts'
import { minor, type Minor } from '../money/minor.ts'

export interface ExistingDepreciationInputs {
  cost: Minor
  residualValue: Minor
  startsOn: CalendarDate
  usefulMonths: number
}

/** Pure calculation. This never posts an expense or moves cash into a reserve. */
export function existingAssetDepreciationSchedule(input: ExistingDepreciationInputs): Array<{
  period: number; periodMonth: CalendarDate; startsOn: CalendarDate; endsOn: CalendarDate; amount: Minor
}> {
  if (input.cost <= 0n || input.residualValue < 0n || input.residualValue > input.cost) {
    throw new RangeError('invalid existing asset cost or residual value')
  }
  if (!Number.isSafeInteger(input.usefulMonths) || input.usefulMonths < 1 || input.usefulMonths > 600) {
    throw new RangeError('existing asset useful months must be in 1..600')
  }
  if (!isCalendarDate(input.startsOn)) throw new RangeError('existing asset depreciation needs a real start date')
  const depreciable = input.cost - input.residualValue
  const base = depreciable / BigInt(input.usefulMonths)
  return Array.from({ length: input.usefulMonths }, (_, index) => ({
    period: index + 1,
    periodMonth: addMonths(monthStartFor(input.startsOn), index),
    startsOn: index === 0 ? input.startsOn : addMonths(monthStartFor(input.startsOn), index),
    endsOn: monthEndFor(addMonths(monthStartFor(input.startsOn), index)),
    amount: minor(index === input.usefulMonths - 1
      ? depreciable - base * BigInt(input.usefulMonths - 1) : base),
  }))
}

/** The approved baseline excludes previous accumulated depreciation from being counted twice. */
export function existingAssetCalculatedBookValue(input: ExistingDepreciationInputs & {
  accumulatedDepreciation: Minor
  recognitionAsOf: CalendarDate
  asOf: CalendarDate
  soldOn?: CalendarDate | null
}): Minor {
  if (input.accumulatedDepreciation < 0n || input.accumulatedDepreciation > input.cost - input.residualValue) {
    throw new RangeError('accumulated depreciation exceeds the depreciable cost')
  }
  const baseline = input.cost - input.accumulatedDepreciation
  if (input.asOf < input.recognitionAsOf) throw new RangeError('book value predates the approved baseline')
  const end = input.soldOn && input.soldOn < input.asOf ? input.soldOn : input.asOf
  const schedule = existingAssetDepreciationSchedule(input)
  let calculated = 0n
  for (const row of schedule) {
    // Disposal stops future months. The sale month itself is excluded by this explicit policy.
    if (input.soldOn && row.periodMonth >= monthStartFor(input.soldOn)) continue
    if (row.periodMonth > input.recognitionAsOf && row.periodMonth <= monthStartFor(end)) calculated += row.amount
  }
  const value = baseline - calculated
  return minor(value < input.residualValue ? input.residualValue : value)
}
