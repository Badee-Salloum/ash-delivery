import type { Deps, ShiftBreakEndReason, ShiftBreakRecord } from '@ash/contracts'
import type { Actor } from '@ash/domain'
import { ServiceError } from './shifts.service.ts'

export const BREAK_LIMIT_SETTING_KEY = 'shift.break_limit_minutes'
export const DEFAULT_BREAK_LIMIT_MINUTES = 60

export interface BreakSummary {
  breaks: ShiftBreakRecord[]
  activeBreak: ShiftBreakRecord | null
  totalBreakMs: number
  limitMinutes: number
  overLimitMs: number
  serverNowMs: number
}

export async function breakLimitMinutes(deps: Deps): Promise<number> {
  const stored = await deps.settings.get(BREAK_LIMIT_SETTING_KEY)
  if (stored === null || stored === undefined) return DEFAULT_BREAK_LIMIT_MINUTES
  const parsed = Number(stored)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1440) {
    throw new Error(`invalid ${BREAK_LIMIT_SETTING_KEY} setting`)
  }
  return parsed
}

export function summarizeBreaks(
  breaks: readonly ShiftBreakRecord[],
  nowMs: number,
  defaultLimitMinutes: number = DEFAULT_BREAK_LIMIT_MINUTES,
): BreakSummary {
  const projected = breaks.map((entry) => {
    if (entry.endedAtMs !== null) return { ...entry }
    const duration = Math.max(0, nowMs - entry.startedAtMs)
    return {
      ...entry,
      overLimitMs: Math.max(0, entry.consumedBeforeMs + duration - entry.limitMinutes * 60_000),
    }
  })
  const activeBreak = projected.find((entry) => entry.endedAtMs === null) ?? null
  // A running break keeps its start-time snapshot. Between breaks, show the current central
  // allowance so the driver knows what the next break will receive after a settings change.
  const limitMinutes = activeBreak?.limitMinutes ?? defaultLimitMinutes
  const totalBreakMs = projected.reduce(
    (total, entry) => total + Math.max(0, (entry.endedAtMs ?? nowMs) - entry.startedAtMs), 0,
  )
  return {
    breaks: projected,
    activeBreak,
    totalBreakMs,
    limitMinutes,
    // Keep an earlier recorded violation visible when a later break starts under a raised limit.
    overLimitMs: projected.reduce((largest, entry) => Math.max(largest, entry.overLimitMs), 0),
    serverNowMs: nowMs,
  }
}

export async function breakSummary(deps: Deps, shiftId: string): Promise<BreakSummary> {
  if (!(await deps.shifts.findById(shiftId))) throw new ServiceError(404, 'shift_not_found')
  const [breaks, limitMinutes] = await Promise.all([
    deps.breaks.listByShift(shiftId),
    breakLimitMinutes(deps),
  ])
  return summarizeBreaks(breaks, deps.clock.nowMs(), limitMinutes)
}

/** The close unit of work owns the shift row lock before this is called. */
export async function endActiveBreakLocked(
  deps: Deps,
  shiftId: string,
  reason: Exclude<ShiftBreakEndReason, 'driver_resumed'>,
  actorId: string,
): Promise<void> {
  const active = (await deps.breaks.listByShift(shiftId)).find((entry) => entry.endedAtMs === null)
  if (!active) return
  const endedAtMs = Math.max(active.startedAtMs, deps.clock.nowMs())
  const overLimitMs = Math.max(0, active.consumedBeforeMs + endedAtMs - active.startedAtMs - active.limitMinutes * 60_000)
  await deps.breaks.end(active.id, endedAtMs, reason, overLimitMs, actorId)
}

export async function startBreak(deps: Deps, actor: Actor, shiftId: string, breakId: string): Promise<BreakSummary> {
  return deps.closeUnitOfWork.run({ shiftId, actorId: actor.userId }, async (transaction) => {
    const locked: Deps = { ...deps, ...transaction }
    const shift = await locked.shifts.findById(shiftId)
    if (!shift) throw new ServiceError(404, 'shift_not_found')
    const previous = await locked.breaks.findById(breakId)
    if (previous) {
      if (previous.shiftId !== shiftId) throw new ServiceError(409, 'break_id_already_used')
      return breakSummary(locked, shiftId)
    }
    if (shift.state !== 'open' || shift.submittedAt !== null) {
      throw new ServiceError(409, 'shift_not_operational', { state: shift.state })
    }
    const rows = await locked.breaks.listByShift(shiftId)
    if (rows.some((entry) => entry.endedAtMs === null)) throw new ServiceError(409, 'break_already_active')
    const startedAtMs = deps.clock.nowMs()
    const consumedBeforeMs = rows.reduce(
      (total, entry) => total + Math.max(0, (entry.endedAtMs ?? startedAtMs) - entry.startedAtMs), 0,
    )
    const limitMinutes = await breakLimitMinutes(deps)
    await locked.breaks.create({
      id: breakId,
      shiftId,
      startedAtMs,
      endedAtMs: null,
      endReason: null,
      limitMinutes,
      consumedBeforeMs,
      overLimitMs: 0,
    }, actor.userId)
    return breakSummary(locked, shiftId)
  })
}

export async function resumeBreak(deps: Deps, actor: Actor, shiftId: string, breakId: string): Promise<BreakSummary> {
  return deps.closeUnitOfWork.run({ shiftId, actorId: actor.userId }, async (transaction) => {
    const locked: Deps = { ...deps, ...transaction }
    const shift = await locked.shifts.findById(shiftId)
    if (!shift) throw new ServiceError(404, 'shift_not_found')
    const record = await locked.breaks.findById(breakId)
    if (!record || record.shiftId !== shiftId) throw new ServiceError(404, 'break_not_found')
    if (record.endedAtMs !== null) return breakSummary(locked, shiftId)
    if (shift.state !== 'open' || shift.submittedAt !== null) {
      throw new ServiceError(409, 'shift_not_operational', { state: shift.state })
    }
    const endedAtMs = Math.max(record.startedAtMs, deps.clock.nowMs())
    const overLimitMs = Math.max(0, record.consumedBeforeMs + endedAtMs - record.startedAtMs - record.limitMinutes * 60_000)
    await locked.breaks.end(breakId, endedAtMs, 'driver_resumed', overLimitMs, actor.userId)
    return breakSummary(locked, shiftId)
  })
}
