import { describe, expect, it } from 'vitest'
import { EMPTY_PACK, type PackState, restorePacks } from '../src/screens/BatteryPanel.tsx'

/**
 * THE CRASH THAT LEFT A DRIVER ON THE «ASH» SPLASH.
 *
 * «Cannot read properties of undefined (reading 'percent')», thrown on the close screen of any
 * resumed shift that already had a battery reading. محمد عقيل, 02:18, an open shift he was
 * mid-closing: the app died before it painted, so it looked exactly like a slow connection.
 *
 * `Shift.tsx` rebuilt the panel's state as `{ ...prior, percent: '41' }` — the charge at the TOP
 * level instead of inside `values` — and silenced the compiler with `as EndDraft['packs']`.
 * `BatteryPanel.stateOf` is `packs[id] ?? EMPTY_PACK`, so the malformed entry was TRUTHY, the
 * fallback never ran, and `.values.percent` threw.
 *
 * The shape now has one owner and these tests hold it there. Every case below asserts the property
 * the crash violated: whatever comes back MUST be a whole `PackState`.
 */

const whole = (state: PackState): void => {
  expect(state.values, 'values must exist — this is the exact field that was undefined').toBeDefined()
  expect(typeof state.values.percent).toBe('string')
  expect(typeof state.values.cycleCount).toBe('string')
  expect(state).toHaveProperty('outcome')
  expect(state).toHaveProperty('fieldsFound')
  expect(typeof state.unavailable).toBe('boolean')
}

describe('restoring battery readings onto a resumed shift', () => {
  it('puts the stored charge INSIDE values, where the panel reads it', () => {
    const packs = restorePacks([{ batteryId: 'pack-1', percent: 41 }], {})
    whole(packs['pack-1']!)
    expect(packs['pack-1']!.values.percent).toBe('41')
  })

  it('produces a state the panel can read without a fallback — the regression itself', () => {
    const packs = restorePacks([{ batteryId: 'pack-1', percent: 41 }], {})
    // Precisely what `stateOf(id).values.percent.trim()` does, which is what threw.
    expect(() => packs['pack-1']!.values.percent.trim()).not.toThrow()
  })

  it('keeps what the driver already typed, and takes only the charge from the server', () => {
    const prior: Record<string, PackState> = {
      'pack-1': {
        ...EMPTY_PACK,
        values: { percent: '99', cycleCount: '312' },
        outcome: 'ok',
        fieldsFound: 2,
        text: 'raw ocr text',
      },
    }
    const packs = restorePacks([{ batteryId: 'pack-1', percent: 41 }], prior)
    expect(packs['pack-1']!.values.percent).toBe('41') // the server confirmed this one
    expect(packs['pack-1']!.values.cycleCount).toBe('312') // his typing survives
    expect(packs['pack-1']!.outcome).toBe('ok')
    expect(packs['pack-1']!.text).toBe('raw ocr text')
  })

  /** A pack with no reading yet must not be invented — an empty entry would look answered. */
  it('skips a pack whose charge is null', () => {
    const packs = restorePacks(
      [
        { batteryId: 'pack-1', percent: null },
        { batteryId: 'pack-2', percent: 88 },
      ],
      {},
    )
    expect(packs['pack-1']).toBeUndefined()
    expect(packs['pack-2']!.values.percent).toBe('88')
  })

  it('restores a null-charge unavailable declaration after the closing screen remounts', () => {
    const packs = restorePacks(
      [{ batteryId: 'pack-1', percent: null, unavailable: true }],
      {},
    )

    whole(packs['pack-1']!)
    expect(packs['pack-1']).toMatchObject({ unavailable: true, values: { percent: '' } })
  })

  it('restores unavailable independently for each pack on a two-pack bike', () => {
    const packs = restorePacks(
      [
        { batteryId: 'pack-1', percent: null, unavailable: true },
        { batteryId: 'pack-2', percent: 63, unavailable: false },
      ],
      {},
    )

    expect(packs['pack-1']).toMatchObject({ unavailable: true, values: { percent: '' } })
    expect(packs['pack-2']).toMatchObject({ unavailable: false, values: { percent: '63' } })
  })

  /** محمد عقيل's real shape: two packs fitted, only one read. The other must survive untouched. */
  it('leaves a pack the server said nothing about exactly as it was', () => {
    const prior: Record<string, PackState> = {
      'pack-2': { ...EMPTY_PACK, values: { percent: '77', cycleCount: '' } },
    }
    const packs = restorePacks([{ batteryId: 'pack-1', percent: 41 }], prior)
    whole(packs['pack-1']!)
    whole(packs['pack-2']!)
    expect(packs['pack-2']!.values.percent).toBe('77')
  })

  it('is a no-op on a shift with no readings at all', () => {
    expect(restorePacks([], {})).toEqual({})
  })

  it('does not mutate what it was given', () => {
    const prior: Record<string, PackState> = { 'pack-1': { ...EMPTY_PACK } }
    const before = JSON.stringify(prior)
    restorePacks([{ batteryId: 'pack-1', percent: 41 }], prior)
    expect(JSON.stringify(prior)).toBe(before)
  })
})
