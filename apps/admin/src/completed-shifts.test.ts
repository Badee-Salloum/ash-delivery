/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import {
  MAX_COMPLETED_SHIFT_RANGE_DAYS,
  classifyShiftHistory,
  completedShiftDates,
  defaultCompletedShiftRange,
} from './completed-shifts.ts'

const appSource = readFileSync(new URL('./AdminApp.tsx', import.meta.url), 'utf8')
const screenSource = readFileSync(new URL('./screens/CompletedShifts.tsx', import.meta.url), 'utf8')

describe('completed shift history date range', () => {
  it('defaults to the latest seven business dates, including the session business date', () => {
    expect(defaultCompletedShiftRange('2026-08-24')).toEqual({ from: '2026-08-18', to: '2026-08-24' })
  })

  it('enumerates an inclusive range without browser-timezone date arithmetic', () => {
    expect(completedShiftDates('2028-02-28', '2028-03-01')).toEqual({
      ok: true,
      dates: ['2028-02-28', '2028-02-29', '2028-03-01'],
    })
  })

  it('rejects missing, reversed, impossible, and unbounded ranges', () => {
    expect(completedShiftDates('', '2026-08-24')).toEqual({ ok: false, reason: 'dates_required' })
    expect(completedShiftDates('2026-02-31', '2026-03-01')).toEqual({ ok: false, reason: 'dates_required' })
    expect(completedShiftDates('2026-08-24', '2026-08-23')).toEqual({ ok: false, reason: 'date_order' })
    expect(completedShiftDates('2026-01-01', '2026-02-01')).toEqual({ ok: false, reason: 'range_too_large' })
    expect(MAX_COMPLETED_SHIFT_RANGE_DAYS).toBe(31)
  })
})

describe('completed shift terminal-state semantics', () => {
  const row = (id: string, state: string, businessDate: string, shiftNo: number) => ({
    id,
    state,
    businessDate,
    shiftNo,
  })

  it('shows approved and week-locked settlements as completed, newest first', () => {
    const result = classifyShiftHistory([
      row('old-locked', 'week_locked', '2026-08-20', 1),
      row('live', 'open', '2026-08-24', 1),
      row('new-second', 'approved', '2026-08-23', 2),
      row('new-first', 'approved', '2026-08-23', 1),
      row('waiting', 'pending_review', '2026-08-24', 2),
    ])

    expect(result.completed.map((item) => item.id)).toEqual(['new-second', 'new-first', 'old-locked'])
  })

  it('keeps cancelled shifts separate because they have no completed financial settlement', () => {
    const result = classifyShiftHistory([
      row('approved', 'approved', '2026-08-23', 1),
      row('cancelled', 'cancelled', '2026-08-24', 1),
    ])

    expect(result.completed.map((item) => item.id)).toEqual(['approved'])
    expect(result.cancelled.map((item) => item.id)).toEqual(['cancelled'])
  })
})

describe('completed shift history screen wiring', () => {
  it('is reachable from the admin rail and opens a completed shift in the existing detail view', () => {
    expect(appSource).toContain("'completedShifts',")
    expect(appSource).toContain("{ key: 'completedShifts', label: t.completedShifts.title }")
    expect(appSource).toContain('<CompletedShifts onOpen={setOpenShift} />')
    expect(screenSource).toContain('onClick={() => onOpen(shift.id)}')
  })

  it('reads every selected business date through the branch-scoped API client and bounds fan-out', () => {
    expect(screenSource).toContain('completedShiftDates(applied.from, applied.to)')
    expect(screenSource).toContain('index += READ_BATCH_SIZE')
    expect(screenSource).toContain('`/shifts?date=${encodeURIComponent(date)}`')
    expect(screenSource).toContain("{ cache: 'no-store', signal: controller.signal }")
  })

  it('has matching Arabic-first and English copy for completed and separately cancelled shifts', () => {
    expect(ar.completedShifts.title).toBe('النوبات المنتهية')
    expect(ar.completedShifts.cancelledHint).toContain('تظهر منفصلة')
    expect(en.completedShifts.title).toBe('Completed shifts')
    expect(en.completedShifts.cancelledHint).toContain('Shown separately')
  })
})
