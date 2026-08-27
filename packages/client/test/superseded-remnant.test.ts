import { describe, expect, it } from 'vitest'
import type { DraftOrder } from '../src/order-entry.ts'
import { isSupersededRemnant, withoutSupersededRemnants } from '../src/close-draft.ts'

/**
 * Shift d0a5a7ec, 2026-08-27. The driver's screen read «محسوبة 10 من 21» — ten deliveries, each
 * drawn twice, one green «محسوبة» beside one amber «بانتظار المدير».
 *
 * He retook the dashboard photos. The attachment token rotated, the old rows lost every sighting,
 * and because he had also hand-corrected their times they became `source: 'manual'` with a null
 * `matchKey`. Identity here is what decision 16 says it is: the printed time and the cost.
 */

const sighting = () => ({
  readId: 'r1',
  observationId: 'o1',
  rowIndex: 0,
  dateSection: '2026-08-27',
  evidence: { mediaId: 'm1', attachmentToken: 't1', slot: 'dashboard' },
})

const row = (over: Partial<DraftOrder> & { localId: string }): DraftOrder => ({
  providerOrderNo: over.providerOrderNo ?? `YAL-${over.localId}`,
  payMode: 'cash',
  feeText: over.feeText ?? '225.00',
  timeText: over.timeText ?? '14:39',
  dateText: over.dateText ?? '2026-08-27',
  ...over,
})

/** The pair as production holds it: same printed identity, one evidenced, one stranded. */
const evidenced = row({ localId: 'live', sightings: [sighting()], included: true })
const stranded = row({
  localId: 'stale',
  sightings: [],
  included: false,
  timeReviewRequired: true,
  draftSource: 'manual', // what hand-correcting a scanned row's TIME turns it into
})

describe('isSupersededRemnant', () => {
  it('recognises the pair that showed Taha two tiles for one delivery', () => {
    expect(isSupersededRemnant(stranded, [evidenced, stranded])).toBe(true)
  })

  it('is not fooled by the stranded copy being marked manual', () => {
    // `manual` here means "a scanned row whose time a human corrected", NOT "a row the driver
    // added himself". Exempting it made an earlier version of this predicate a no-op on the very
    // shift it was written for.
    expect(stranded.draftSource).toBe('manual')
    expect(isSupersededRemnant(stranded, [evidenced, stranded])).toBe(true)
  })

  it('groups by the printed identity, not by the synthesised provider number', () => {
    // `providerOrderNo` is `YAL-hash(shiftId, clientKey)` and clientKey is page-scoped, so one
    // delivery photographed on two evidence generations carries two different numbers. Keying on
    // it is what left 125.00 at 15:19 on the screen twice.
    const a = row({ localId: 'a', providerOrderNo: 'YAL-page1', feeText: '125.00', timeText: '15:19', sightings: [sighting()], included: true })
    const b = row({ localId: 'b', providerOrderNo: 'YAL-page2', feeText: '125.00', timeText: '15:19', sightings: [], included: false })
    expect(a.providerOrderNo).not.toBe(b.providerOrderNo)
    expect(isSupersededRemnant(b, [a, b])).toBe(true)
    expect(withoutSupersededRemnants([a, b])).toHaveLength(1)
  })

  it('never hides the copy that still holds the photo', () => {
    expect(isSupersededRemnant(evidenced, [evidenced, stranded])).toBe(false)
  })

  it('keeps one copy when a delivery has lost ALL of its evidence', () => {
    // The driver must still be told a delivery lost its page — once, not twice, and never zero
    // times. Swallowing it would hide a real delivery from him.
    const a = row({ localId: 'a', feeText: '125.00', timeText: '15:19', sightings: [], included: false })
    const b = row({ localId: 'b', feeText: '125.00', timeText: '15:19', sightings: [], included: false })
    const shown = withoutSupersededRemnants([a, b])
    expect(shown).toHaveLength(1)
    expect(shown[0]!.localId).toBe('a')
  })

  it('separates two deliveries whose printed identity genuinely differs', () => {
    const one = row({ localId: 'one', timeText: '14:39', sightings: [sighting()], included: true })
    const two = row({ localId: 'two', timeText: '14:40', sightings: [], included: false })
    expect(isSupersededRemnant(two, [one, two])).toBe(false)
    expect(withoutSupersededRemnants([one, two])).toHaveLength(2)
  })

  it('needs the whole identity — a different day or a different cost is a different order', () => {
    for (const differing of [{ dateText: '2026-08-26' }, { feeText: '226.00' }]) {
      const other = row({ localId: 'other', sightings: [], included: false, ...differing })
      expect(isSupersededRemnant(other, [evidenced, other])).toBe(false)
    }
  })

  it('never groups rows whose printed identity is incomplete', () => {
    // No clock means no identity. Two clockless rows must stay separate rather than collapse.
    const blank = row({ localId: 'blank', timeText: '', sightings: [], included: false })
    const other = row({ localId: 'other', timeText: '', sightings: [], included: false })
    expect(isSupersededRemnant(blank, [blank, other])).toBe(false)
    expect(withoutSupersededRemnants([blank, other])).toHaveLength(2)
  })

  it('never hides an included row', () => {
    const included = row({ localId: 'kept', sightings: [], included: true })
    expect(isSupersededRemnant(included, [evidenced, included])).toBe(false)
  })

  it('keeps the evidenced copy even when the stranded one comes first in the list', () => {
    // Order in the array must not decide which copy survives. If the stranded row were taken as the
    // survivor simply for being first, the driver would lose the row that still has the photo — and
    // with it the evidence the manager needs.
    const shown = withoutSupersededRemnants([stranded, evidenced])
    expect(shown).toHaveLength(1)
    expect(shown[0]!.localId).toBe('live')
  })

  it('keeps a second evidenced copy rather than hiding it behind the first', () => {
    // Excluded is not the same as evidence-less. This row was unchecked, but its screenshot still
    // exists and the manager may want to look at it and change his mind.
    const first = row({ localId: 'first', sightings: [sighting()], included: true })
    const alsoEvidenced = row({ localId: 'second', sightings: [sighting()], included: false })
    expect(isSupersededRemnant(alsoEvidenced, [first, alsoEvidenced])).toBe(false)
    expect(withoutSupersededRemnants([first, alsoEvidenced])).toHaveLength(2)
  })

  it('leaves a lone order alone, evidence or not', () => {
    const lone = row({ localId: 'lone', timeText: '09:15', feeText: '77.00', sightings: [], included: false })
    expect(isSupersededRemnant(lone, [evidenced, stranded, lone])).toBe(false)
  })
})

describe('withoutSupersededRemnants on the real shift', () => {
  it('reduces Taha 21 rows to the 10 deliveries he actually made', () => {
    const rows: DraftOrder[] = []
    const times = ['14:39', '14:05', '13:17', '12:02', '11:34', '18:08', '17:33', '16:37', '16:07']
    for (const [i, time] of times.entries()) {
      rows.push(row({ localId: `live-${i}`, timeText: time, sightings: [sighting()], included: true }))
      rows.push(row({ localId: `stale-${i}`, timeText: time, sightings: [], included: false, draftSource: 'manual' }))
    }
    // The 15:19 delivery: one evidenced copy and two stranded ones, each with its own synthesised
    // provider number — exactly the trio production holds.
    rows.push(row({ localId: 'l1519', timeText: '15:19', feeText: '125.00', sightings: [sighting()], included: true }))
    rows.push(row({ localId: 's1519a', timeText: '15:19', feeText: '125.00', sightings: [], included: false }))
    rows.push(row({ localId: 's1519b', timeText: '15:19', feeText: '125.00', sightings: [], included: false, draftSource: 'manual' }))
    expect(rows).toHaveLength(21)

    const shown = withoutSupersededRemnants(rows)
    expect(shown).toHaveLength(10)
    expect(shown.filter((r) => r.localId.startsWith('stale-'))).toHaveLength(0)
    expect(shown.filter((r) => r.timeText === '15:19')).toHaveLength(1)
    expect(shown.every((r) => r.included)).toBe(true)
  })
})
