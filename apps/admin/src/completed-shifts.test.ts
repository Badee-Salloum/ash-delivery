/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { SHIFT_TARGET_MINUTES } from '@ash/domain'
import {
  MAX_COMPLETED_SHIFT_RANGE_DAYS,
  classifyShiftHistory,
  completedShiftFinancialTotals,
  completedShiftDates,
  defaultCompletedShiftRange,
  type CompletedShiftFinancial,
} from './completed-shifts.ts'

const appSource = readFileSync(new URL('./AdminApp.tsx', import.meta.url), 'utf8')
const screenSource = readFileSync(new URL('./screens/CompletedShifts.tsx', import.meta.url), 'utf8')
const timeRangeBarSource = readFileSync(new URL('./components/TimeRangeBar.tsx', import.meta.url), 'utf8')

describe('completed shift history date range', () => {
  it('defaults to the latest seven business dates, including the session business date', () => {
    expect(defaultCompletedShiftRange('2026-08-24')).toEqual({ from: '2026-08-18', to: '2026-08-24' })
  })

  it('computes dates through the domain, never through Date (P2)', () => {
    const helperSource = readFileSync(new URL('./completed-shifts.ts', import.meta.url), 'utf8')
    expect(helperSource).not.toContain('Date.parse')
    expect(helperSource).not.toContain('new Date(')
    expect(helperSource).toContain("import { addDays, daysBetween, formatMinor, isCalendarDate, parseMinor, sum } from '@ash/domain'")
    expect(completedShiftDates('2026-01-01', '2027-02-04', 400)).toMatchObject({ ok: true })
    expect(completedShiftDates('2026-01-01', '2027-02-05', 400)).toEqual({ ok: false, reason: 'range_too_large' })
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

describe('completed shift financial totals', () => {
  const financial = (overrides: Partial<CompletedShiftFinancial>): CompletedShiftFinancial => ({
    policyCode: 'fixed_40_cash_close_v2_receivable',
    deliveryFees: '0.00',
    companyShare: '0.00',
    yalagoShare: '0.00',
    grossDriverShare: '0.00',
    deductions: '0.00',
    netDriverShare: '0.00',
    expectedTotal: '0.00',
    actualCash: '0.00',
    actualWallet: '0.00',
    actualTotal: '0.00',
    variance: '0.00',
    varianceDirection: 'balanced',
    finalEmployeeCash: '0.00',
    cashClaimToOffice: '0.00',
    walletClaimToOffice: '0.00',
    cashReceivableDeferred: '0.00',
    walletReceivableDeferred: '0.00',
    cashShortageReceivable: '0.00',
    cashToOffice: '0.00',
    walletToOffice: '0.00',
    officeReturn: '0.00',
    ...overrides,
  })

  it('sums decimal strings in minor units and preserves signed variance', () => {
    expect(completedShiftFinancialTotals([
      { financial: financial({
        deliveryFees: '13000.00', companyShare: '5800.00', netDriverShare: '4700.00',
        deductions: '500.00', variance: '-100.00', officeReturn: '20800.00',
        cashShortageReceivable: '100.00',
      }) },
      { financial: financial({
        deliveryFees: '7000.00', companyShare: '2800.00', netDriverShare: '2800.00',
        variance: '200.00', officeReturn: '11000.00',
        cashShortageReceivable: '0.00',
      }) },
      { financial: null },
      {}, // additive rollout: an older API omits the field entirely
    ])).toEqual({
      availableCount: 2,
      missingCount: 2,
      deliveryFees: '20000.00',
      companyShare: '8600.00',
      netDriverShare: '7500.00',
      deductions: '500.00',
      variance: '100.00',
      cashShortageReceivable: '100.00',
      officeReturn: '31800.00',
    })
  })

  it('returns exact zero strings for an empty period', () => {
    expect(completedShiftFinancialTotals([])).toEqual({
      availableCount: 0,
      missingCount: 0,
      deliveryFees: '0.00',
      companyShare: '0.00',
      netDriverShare: '0.00',
      deductions: '0.00',
      variance: '0.00',
      cashShortageReceivable: '0.00',
      officeReturn: '0.00',
    })
  })

  it('does not lose minor units above the JavaScript safe-integer boundary', () => {
    const total = completedShiftFinancialTotals([
      { financial: financial({ deliveryFees: '9007199254740991.00' }) },
      { financial: financial({ deliveryFees: '0.01' }) },
    ])
    expect(total.deliveryFees).toBe('9007199254740991.01')
  })
})

describe('completed shift history screen wiring', () => {
  it('is reachable from the admin rail and opens a completed shift in the existing detail view', () => {
    expect(appSource).toContain("'completedShifts',")
    // Asserted WITHOUT the surrounding braces: the claim is that the rail wires this key to this
    // label, not that the entry never gains another field. Pinning the whole object literal made
    // this fail the day nav items grew an icon, which is not what the test is about.
    expect(appSource).toContain("key: 'completedShifts', label: t.completedShifts.title")
    // P2: mounted with the params the link carried, keyed so a different link starts it afresh.
    expect(appSource).toContain('<CompletedShifts key={mountKey} initial={liveParams.current} onOpen={setOpenShift} />')
    expect(screenSource).toContain('onClick={() => onOpen(shift.id)}')
  })

  it('reads the whole period in ONE branch-scoped request, not one per business date', () => {
    // This walked the range a date at a time, seven in parallel: 33 `no-store` requests to cover a
    // month, each returning every state so the browser could discard most of it. The range read the
    // Sunday close already relies on covers it in one. The negative assertions are the point — a
    // reinstated loop would still satisfy the positive one.
    // P2: a range longer than the branch cap hands the driver/vehicle to the server as well.
    expect(screenSource).toContain(
      '`/shifts?from=${encodeURIComponent(shown.from)}&to=${encodeURIComponent(shown.to)}${narrowQuery}`',
    )
    expect(screenSource).toContain("{ cache: 'no-store', signal: controller.signal }")
    expect(screenSource).not.toContain('READ_BATCH_SIZE')
    expect(screenSource).not.toContain('/shifts?date=')
    // The cap still guards the request; it is now the SERVER's scan it bounds, not the fan-out. The
    // custom form lives in the shared time filter and refuses a period longer than the screen's cap.
    expect(timeRangeBarSource).toContain('validateCustom(from, to, maxDays)')
    expect(screenSource).toContain('maxDays={maxDays}')
    expect(screenSource).toContain('completedShiftDates(shown.from, shown.to, maxDays)')
    // A period longer than the cap shows its most recent days instead of an empty page.
    expect(screenSource).toContain('capped ? cappedRange(applied, maxDays) : applied')
    expect(screenSource).toContain('t.completedShifts.rangeCapShown')
    expect(screenSource).toContain('narrowed ? MAX_NARROWED_SHIFT_RANGE_DAYS : MAX_COMPLETED_SHIFT_RANGE_DAYS')
    // «today» is the server's, never the session's stale stamp or the browser clock.
    expect(screenSource).not.toContain('session?.businessDate')
    expect(screenSource).toContain('resolveSelection(selection, meta)')
    expect(timeRangeBarSource).toContain("'/dashboard/meta'")
    expect(timeRangeBarSource).not.toContain('new Date(')
  })

  it('identifies a shift by its clock, because a business date alone cannot', () => {
    // Thirteen shifts ran on 2026-09-06 and every row read «2026-09-06» and «#1». The screen now
    // shows the branch-local start→end, so the nine day shifts and four evening ones are separable.
    expect(screenSource).toContain('damascusParts(new Date(row.windowOpensAt))')
    expect(screenSource).toContain('damascusParts(new Date(row.submittedAt))')
    // A night shift carries the PREVIOUS date by design (the business day ends at 04:00), which looks
    // like an off-by-one until the screen says so.
    expect(screenSource).toContain('t.completedShifts.businessDayNote')
    // Operational times use stable Latin digits in both language modes.
    expect(ar.completedShifts.businessDayNote).toContain('04:00')
  })

  it('judges each pattern against its own target, so a full shift is not read as overtime', () => {
    // A double covers both slots, so it is held to the owner's twelve hours (2026-09-17), not one
    // slot's eight. The table is the domain's, shared with the dashboard: each screen used to keep
    // its own copy with `full: 16 * 60`, so a change of rule had to be found and made twice.
    expect(screenSource).toContain("import { SHIFT_TARGET_MINUTES, type ShiftPattern, type ShiftSlot, shortfallMinutes } from '@ash/domain'")
    expect(screenSource).toContain('SHIFT_TARGET_MINUTES[row.worked.pattern]')
    expect(screenSource).not.toContain('const TARGET_MINUTES')
    expect(screenSource).not.toContain('16 * 60')
    expect(SHIFT_TARGET_MINUTES).toEqual({ day: 480, evening: 480, full: 720, unknown: null })
    expect(screenSource).toContain('shortfallMinutes(row.worked, target)')
    // The badge shows the pattern WITH its target: «صباحية · 8س», «دبل · 12س».
    expect(screenSource).toContain('shiftPatternLabel(shift.worked, t.completedShifts)')
    expect(ar.completedShifts.patternDay).toBe('صباحية')
    expect(ar.completedShifts.patternWithTarget).toBe('{pattern} · {h}س')
    // …and nothing is judged that cannot be judged honestly.
    expect(screenSource).toContain('t.completedShifts.notClosedOnTime')
  })

  it('shows an exact period summary and the core financial columns without per-row detail reads', () => {
    expect(screenSource).toContain('completedShiftFinancialTotals(history.completed)')
    expect(screenSource).toContain('shift.financial.deliveryFees')
    expect(screenSource).toContain('shift.financial.companyShare')
    expect(screenSource).toContain('shift.financial.netDriverShare')
    expect(screenSource).toContain('shift.financial.deductions')
    expect(screenSource).toContain('shift.financial.variance')
    expect(screenSource).toContain('shift.financial.officeReturn')
    expect(screenSource).toContain('shift.financial.cashShortageReceivable')
    expect(screenSource).toContain('financialTotals.cashShortageReceivable')
  })

  it('has matching Arabic-first and English copy for completed and separately cancelled shifts', () => {
    expect(ar.completedShifts.title).toBe('النوبات المنتهية')
    expect(ar.completedShifts.cancelledHint).toContain('تظهر منفصلة')
    expect(en.completedShifts.title).toBe('Completed shifts')
    expect(en.completedShifts.cancelledHint).toContain('Shown separately')
  })
})
