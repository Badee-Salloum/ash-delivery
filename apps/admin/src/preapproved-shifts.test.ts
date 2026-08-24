import { describe, expect, it } from 'vitest'
import {
  canManagePreapprovedShifts,
  preapprovedRuleStatus,
  validatePreapprovedDraft,
} from './preapproved-shifts.ts'

const valid = {
  driverId: 'driver-1',
  dates: ['2026-08-24', '2026-08-27'],
  windowStart: '08:30',
  windowEnd: '10:00',
  cashFloat: '12500.00',
  walletTopup: '0.00',
}

describe('pre-approved shift UI rules', () => {
  it('offers management only to the three manager roles', () => {
    expect(canManagePreapprovedShifts('branch_manager')).toBe(true)
    expect(canManagePreapprovedShifts('general_manager')).toBe(true)
    expect(canManagePreapprovedShifts('system_admin')).toBe(true)
    expect(canManagePreapprovedShifts('driver')).toBe(false)
    expect(canManagePreapprovedShifts('accountant')).toBe(false)
  })

  it('accepts several custom dates, a same-day window, and zero-valued funding', () => {
    expect(validatePreapprovedDraft(valid)).toBeNull()
  })

  it('rejects duplicate dates, overnight windows, and invalid money strings', () => {
    expect(validatePreapprovedDraft({ ...valid, dates: ['2026-08-24', '2026-08-24'] })).toBe('dates')
    const tooManyDates = Array.from({ length: 63 }, (_, day) =>
      new Date(Date.UTC(2026, 8, day + 1)).toISOString().slice(0, 10),
    )
    expect(validatePreapprovedDraft({ ...valid, dates: tooManyDates })).toBe('dates')
    expect(validatePreapprovedDraft({ ...valid, windowStart: '22:00', windowEnd: '02:00' })).toBe('window')
    expect(validatePreapprovedDraft({ ...valid, cashFloat: '-1.00' })).toBe('money')
    expect(validatePreapprovedDraft({ ...valid, walletTopup: '1.001' })).toBe('money')
  })

  it('shows a consumed rule as consumed even after the server deactivates it', () => {
    expect(preapprovedRuleStatus({ active: true, consumedByShiftId: null })).toBe('active')
    expect(preapprovedRuleStatus({ active: false, consumedByShiftId: 'shift-1' })).toBe('consumed')
    expect(preapprovedRuleStatus({ active: false, consumedByShiftId: null })).toBe('inactive')
  })
})
