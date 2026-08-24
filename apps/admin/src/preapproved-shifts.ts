import type { PreapprovedShiftRuleView } from '@ash/client'

export type PreapprovedDraftError = 'driver' | 'dates' | 'window' | 'money'
export type PreapprovedRuleStatus = 'active' | 'consumed' | 'inactive'

const MANAGER_ROLES = new Set(['branch_manager', 'general_manager', 'system_admin'])
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const MONEY = /^\d+(?:\.\d{1,2})?$/

export function canManagePreapprovedShifts(roleKey: string): boolean {
  return MANAGER_ROLES.has(roleKey)
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Validate the form without coercing either money string to a floating-point number. */
export function validatePreapprovedDraft(input: {
  driverId: string
  dates: readonly string[]
  windowStart: string
  windowEnd: string
  cashFloat: string
  walletTopup: string
}): PreapprovedDraftError | null {
  if (input.driverId === '') return 'driver'
  if (
    input.dates.length === 0 ||
    input.dates.length > 62 ||
    input.dates.some((date) => !isCalendarDate(date)) ||
    new Set(input.dates).size !== input.dates.length
  ) {
    return 'dates'
  }
  if (!TIME.test(input.windowStart) || !TIME.test(input.windowEnd) || input.windowStart >= input.windowEnd) {
    return 'window'
  }
  if (!MONEY.test(input.cashFloat) || !MONEY.test(input.walletTopup)) return 'money'
  return null
}

export function preapprovedRuleStatus(
  rule: Pick<PreapprovedShiftRuleView, 'active' | 'consumedByShiftId'>,
): PreapprovedRuleStatus {
  if (rule.consumedByShiftId !== null) return 'consumed'
  return rule.active ? 'active' : 'inactive'
}
