import type { OperationWindowStatus } from './ports.ts'

/** A branch-local minute key whose lexical order is chronological. */
function localMinuteKey(instant: string | null, timeZone: string | undefined, offsetMinutes: number): string | null {
  if (instant === null) return null
  const epochMs = Date.parse(instant)
  if (!Number.isFinite(epochMs)) return null
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(epochMs)
      const value = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
        parts.find((part) => part.type === type)?.value
      const [year, month, day, hour, minute] = [value('year'), value('month'), value('day'), value('hour'), value('minute')]
      if (year && month && day && hour && minute) return `${year}-${month}-${day} ${hour}:${minute}`
    } catch {
      // Invalid legacy timezone data uses the injected fixed offset, matching SystemClock.
    }
  }
  const local = new Date(epochMs + offsetMinutes * 60_000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
}

function operationMinuteKey(date: string | null, minute: string | null): string | null {
  if (date === null || minute === null || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(minute)) return null
  // Calendar dates arrive through a strict wire schema or a PostgreSQL DATE. This check still keeps
  // the pure helper safe for adapter tests and direct callers.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const check = new Date(Date.UTC(year, month - 1, day))
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() + 1 !== month
    || check.getUTCDate() !== day
  ) return null
  return `${date} ${minute}`
}

/** Classify a printed operation minute against the inclusive approved-open/submitted-close window. */
export function classifyOperationWindow(input: {
  occurredDate: string | null
  occurredMinute: string | null
  openApprovedAt: string | null
  submittedAt: string | null
  timeZone?: string
  offsetMinutes?: number
}): OperationWindowStatus {
  const operation = operationMinuteKey(input.occurredDate, input.occurredMinute)
  const opened = localMinuteKey(input.openApprovedAt, input.timeZone, input.offsetMinutes ?? 0)
  if (operation === null || opened === null) return 'unknown'
  if (operation < opened) return 'pre_open'
  if (operation === opened) return 'open_minute_boundary'
  const submitted = localMinuteKey(input.submittedAt, input.timeZone, input.offsetMinutes ?? 0)
  if (submitted !== null) {
    if (operation > submitted) return 'post_close'
    if (operation === submitted) return 'close_minute_boundary'
  }
  return 'in_window'
}

/** Only a verified operation minute counts automatically; unknown rows require a manager decision. */
export const includedByOperationWindow = (status: OperationWindowStatus): boolean =>
  status === 'in_window'
  || status === 'open_minute_boundary'
  || status === 'close_minute_boundary'
