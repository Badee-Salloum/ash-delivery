import { describe, expect, it } from 'vitest'
import {
  type SupersedableRow,
  isSupersededScanRow,
  withoutSupersededScanRows,
} from '../../src/shift/superseded.ts'

/** Shift d0a5a7ec, 2026-08-27: 21 rows for 10 deliveries after the dashboard photos were retaken. */
// `??` would swallow an explicit null and hand back the default, which quietly turned the
// "identity is incomplete" cases into identical rows. Presence, not nullishness, decides.
type Fixture = { id?: string; occurredDate?: string | null; occurredMinute?: string | null; fee?: string | null; included?: boolean; sightingCount?: number }

/** The driver-side identity, spelled out so the tests read like the screen they describe. */
const printed = (over: Fixture): string | null => {
  const date = 'occurredDate' in over ? over.occurredDate : '2026-08-27'
  const minute = 'occurredMinute' in over ? over.occurredMinute : '14:39'
  const fee = 'fee' in over ? over.fee : '225.00'
  if (!date || !minute || !fee) return null
  return `${date}|${minute}|${fee}`
}

const row = (over: Fixture = {}): SupersedableRow & { id: string; occurredMinute: string | null } => ({
  id: over.id ?? 'r',
  identity: printed(over),
  occurredMinute: 'occurredMinute' in over ? over.occurredMinute! : '14:39',
  included: over.included ?? false,
  sightingCount: over.sightingCount ?? 0,
})

const witness = row({ id: 'witness', sightingCount: 2, included: true })
const stranded = row({ id: 'stranded' })

describe('isSupersededScanRow', () => {
  it('names the copy a retake left behind', () => {
    expect(isSupersededScanRow(stranded, [witness, stranded])).toBe(true)
  })

  it('never touches the copy that still holds the photo', () => {
    expect(isSupersededScanRow(witness, [witness, stranded])).toBe(false)
  })

  it('chooses the survivor by evidence, not by position', () => {
    // If order decided it, the driver would lose the row carrying the screenshot — and with it the
    // evidence his manager needs to review the shift.
    const shown = withoutSupersededScanRows([stranded, witness])
    expect(shown).toHaveLength(1)
    expect(shown[0]!.id).toBe('witness')
  })

  it('keeps one row when every copy has lost its evidence', () => {
    // The driver must still be told a delivery lost its page — once, never zero times.
    const a = row({ id: 'a' })
    const b = row({ id: 'b' })
    const shown = withoutSupersededScanRows([a, b])
    expect(shown).toHaveLength(1)
    expect(shown[0]!.id).toBe('a')
  })

  it('keeps a second evidenced copy rather than hiding it behind the first', () => {
    const alsoEvidenced = row({ id: 'second', sightingCount: 1, included: false })
    expect(isSupersededScanRow(alsoEvidenced, [witness, alsoEvidenced])).toBe(false)
  })

  it('never hides a row that counts for money', () => {
    const counted = row({ id: 'counted', included: true })
    expect(isSupersededScanRow(counted, [witness, counted])).toBe(false)
  })

  it('needs the whole printed identity — day, minute and cost', () => {
    for (const differing of [
      { occurredDate: '2026-08-26' },
      { occurredMinute: '14:40' },
      { fee: '226.00' },
    ]) {
      const other = row({ id: 'other', ...differing })
      expect(isSupersededScanRow(other, [witness, other])).toBe(false)
    }
  })

  it('never groups rows whose identity is incomplete', () => {
    // A page whose date header scrolled out of frame must not have its rows collapsed together.
    for (const missing of [{ occurredMinute: null }, { occurredDate: null }, { fee: null }]) {
      const a = row({ id: 'a', ...missing })
      const b = row({ id: 'b', ...missing })
      expect(isSupersededScanRow(a, [a, b])).toBe(false)
      expect(withoutSupersededScanRows([a, b])).toHaveLength(2)
    }
  })

  it('leaves a lone delivery alone', () => {
    const lone = row({ id: 'lone', occurredMinute: '09:15', fee: '77.00' })
    expect(isSupersededScanRow(lone, [witness, stranded, lone])).toBe(false)
  })
})

describe('the identity belongs to the caller, and choosing wrong is catastrophic', () => {
  it('keeps twenty deliveries that share a minute and a fare when identity is per-order', () => {
    // An ordinary day: twenty 5,000 fares all stamped 08:00, each its own order. The server passes
    // `providerOrderNo` as the identity precisely so this cannot collapse. Passing the printed time
    // and cost here instead would delete nineteen real orders from the submission — it did, in the
    // dashboard fixture, before this test existed.
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `D-${i + 1}`,
      identity: `D-${i + 1}`,
      included: true,
      sightingCount: 0,
    }))
    expect(withoutSupersededScanRows(rows)).toHaveLength(20)
  })

  it('collapses the same twenty when they are given ONE identity', () => {
    // The same rows, keyed as if they were one order — the mistake, made visible. Nineteen vanish.
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `D-${i + 1}`,
      identity: 'same',
      included: false,
      sightingCount: 0,
    }))
    expect(withoutSupersededScanRows(rows)).toHaveLength(1)
  })
})

describe('withoutSupersededScanRows', () => {
  it('reduces the real shift from 21 rows to its 10 deliveries', () => {
    const rows: (SupersedableRow & { id: string; occurredMinute: string | null })[] = []
    const times = ['14:39', '14:05', '13:17', '12:02', '11:34', '18:08', '17:33', '16:37', '16:07']
    for (const [i, minute] of times.entries()) {
      rows.push(row({ id: `live-${i}`, occurredMinute: minute, sightingCount: 1, included: true }))
      rows.push(row({ id: `stale-${i}`, occurredMinute: minute }))
    }
    // The 15:19 delivery: one evidenced copy and two stranded ones — the trio production holds.
    rows.push(row({ id: 'l', occurredMinute: '15:19', fee: '125.00', sightingCount: 2, included: true }))
    rows.push(row({ id: 's1', occurredMinute: '15:19', fee: '125.00' }))
    rows.push(row({ id: 's2', occurredMinute: '15:19', fee: '125.00' }))
    expect(rows).toHaveLength(21)

    const shown = withoutSupersededScanRows(rows)
    expect(shown).toHaveLength(10)
    expect(shown.every((r) => r.sightingCount > 0)).toBe(true)
    expect(shown.filter((r) => r.occurredMinute === '15:19')).toHaveLength(1)
  })
})
