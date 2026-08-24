import { describe, expect, it } from 'vitest'
import { openedShiftState } from '../src/opened-shift.ts'

describe('entering a pre-approved running shift', () => {
  it('creates complete local shift state when approval happens on the first response', () => {
    expect(openedShiftState(null, {
      shiftId: 'shift-auto',
      floatText: '110000.00',
      topupText: '53000.00',
      businessDate: '2026-08-24',
      odoStart: 12_345,
    })).toEqual({
      id: 'shift-auto',
      floatText: '110000.00',
      topupText: '53000.00',
      businessDate: '2026-08-24',
      odoStart: 12_345,
    })
  })

  it('preserves the restored opening odometer when a later approval poll completes', () => {
    expect(openedShiftState({ odoStart: 12_345 }, {
      shiftId: 'shift-polled',
      floatText: '100.00',
      topupText: '20.00',
      businessDate: '2026-08-24',
      odoStart: null,
    }).odoStart).toBe(12_345)
  })
})
