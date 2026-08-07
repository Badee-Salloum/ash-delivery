import { describe, expect, it } from 'vitest'
import { slotLabel, splitSlot } from '../src/slot-label.ts'
import { ar } from '../src/i18n/ar.ts'
import { en } from '../src/i18n/en.ts'

/**
 * Naming an evidence slot. Shared by the driver's tile and the manager's thumbnail so the two can
 * never disagree about what a photo is.
 */
const names = ar.shift.slotNames as unknown as Record<string, string>

describe('splitting a slot name', () => {
  it('reads a page number off the end', () => {
    expect(splitSlot('dashboard_3')).toEqual({ base: 'dashboard', n: 3 })
    expect(splitSlot('bms_2')).toEqual({ base: 'bms', n: 2 })
  })

  it('treats an un-numbered slot as page one — which is what makes the old rows still correct', () => {
    expect(splitSlot('dashboard')).toEqual({ base: 'dashboard', n: 1 })
    expect(splitSlot('payments_log')).toEqual({ base: 'payments_log', n: 1 })
  })
})

describe('labelling a slot', () => {
  it('names the screens that used to render as raw keys', () => {
    // These have been showing literally as `payments_log` and `bms_1` on the manager's review for
    // as long as the slots have existed: the catalogue only ever held un-numbered names.
    expect(slotLabel('payments_log', names, 'ar')).toBe('سجل المدفوعات')
    expect(slotLabel('bms_1', names, 'ar')).toBe('البطارية ١')
  })

  it('leaves a single page un-numbered', () => {
    expect(slotLabel('dashboard', names, 'ar')).toBe('الداشبورد')
    expect(slotLabel('wallet', names, 'ar')).toBe('المحفظة')
  })

  it('numbers the later pages of a scrollable screen', () => {
    expect(slotLabel('dashboard_2', names, 'ar')).toBe('الداشبورد ٢')
    expect(slotLabel('payments_log_3', names, 'ar')).toBe('سجل المدفوعات ٣')
  })

  it('uses ASCII digits in English and Arabic-Indic in Arabic', () => {
    const enNames = en.shift.slotNames as unknown as Record<string, string>
    expect(slotLabel('dashboard_2', enNames, 'en')).toBe('Dashboard 2')
    expect(slotLabel('dashboard_2', names, 'ar')).toBe('الداشبورد ٢')
  })

  it('falls back to the raw slot rather than an empty tile', () => {
    // A name nobody translated is still something a manager can act on; a blank one is not.
    expect(slotLabel('cash_drop_7', names, 'ar')).toBe('cash_drop_7')
  })
})
