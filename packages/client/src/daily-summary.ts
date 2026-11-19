import { serializeMoney } from '@ash/contracts'
import { minor, parseMinor } from '@ash/domain'

export interface DailySummaryOrder {
  included?: boolean
  fee: string | null
  occurredDate?: string | null
}

function validDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

/** Suggest from the dated orders/business day, never from the upload clock. No implicit save. */
export function suggestDailySummaryDate(orders: readonly DailySummaryOrder[], businessDate: string | null): string | null {
  const dates = [...new Set(orders.filter(order => order.included !== false)
    .map(order => order.occurredDate).filter(validDate))]
  return dates.length === 1 ? dates[0]! : validDate(businessDate) ? businessDate : null
}

/** A calendar-day comparison. Missing dates are explicit partial coverage. */
export function compareDailySummary(
  fields: Readonly<Record<string, string | null>>,
  photoDate: string | null,
  orders: readonly DailySummaryOrder[],
) {
  const decimal = (key: string): string | null => {
    const raw = fields[key]
    if (raw == null) return null
    const digits = raw.trim().replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632))
      .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776))
      .replace(/٫/g, '.')
    if (/[٬,،]/.test(digits) && !/^-?\d{1,3}(?:[٬,،]\d{3})+(?:\.\d{1,2})?$/.test(digits)) return null
    const normalized = digits.replace(/[٬,،]/g, '')
    return /^-?\d{1,12}(?:\.\d{1,2})?$/.test(normalized) ? normalized : null
  }
  const included = orders.filter((order) => order.included !== false)
  const hasDate = validDate(photoDate)
  const dated = hasDate ? included.filter((order) => order.occurredDate === photoDate) : []
  const undatedOrderCount = included.filter(order => !validDate(order.occurredDate)).length
  const outside = hasDate ? included.filter(order => validDate(order.occurredDate) && order.occurredDate !== photoDate) : []
  const validFee = (fee: string | null): fee is string => fee !== null && /^\d{1,16}(?:\.\d{1,2})?$/.test(fee)
  const invalidFeeCount = dated.filter(order => !validFee(order.fee)).length
  const total = dated.reduce((sum, order) => sum + (validFee(order.fee) ? parseMinor(order.fee) : 0n), 0n)
  const grossTotal = decimal('grossTotal')
  const tripsText = decimal('trips')
  const trips = tripsText !== null && /^\d+$/.test(tripsText) ? Number(tripsText) : null
  const canCompare = hasDate && undatedOrderCount === 0 && invalidFeeCount === 0
  const difference = canCompare && grossTotal !== null ? serializeMoney(minor(parseMinor(grossTotal) - total)) : null
  const countDifference = canCompare && trips !== null ? trips - dated.length : null
  const partial = !canCompare || outside.length > 0 || grossTotal === null || trips === null
  const status = !hasDate ? 'date_required' : !canCompare || grossTotal === null || trips === null ? 'incomplete'
    : outside.length > 0 ? 'partial' : difference === '0.00' && countDifference === 0 ? 'match' : 'difference'
  return {
    blueTotal: decimal('blueTotal'), grossTotal, trips,
    distanceKm: decimal('distanceKm'), onlineMinutes: decimal('onlineMinutes'),
    orderTotal: hasDate && invalidFeeCount === 0 ? serializeMoney(minor(total)) : null,
    orderCount: hasDate ? dated.length : null,
    difference, countDifference, partial, status,
    outsideOrderCount: outside.length, undatedOrderCount, invalidFeeCount,
  }
}
