import { describe, expect, it } from 'vitest'
import type { DraftOrder } from '../src/order-entry.ts'
import { isSupersededRemnant, withoutSupersededRemnants } from '../src/close-draft.ts'

/**
 * Shift d0a5a7ec, 2026-08-27. The driver's screen read «محسوبة 10 من 21» and showed every delivery
 * twice — a green «محسوبة» beside a red «بانتظار المدير» at the same minute for the same amount.
 *
 * The red ten were remnants of an earlier evidence generation: he retook the dashboard photos, the
 * attachment token rotated, and the old rows lost every sighting. They carry `human_time_edit`, and
 * any row with `timeReviewRequired` renders as a manager decision — but there is no photo behind
 * them and nothing anyone could look at.
 */

const sighting = (slot: string) => ({
  readId: 'r1',
  observationId: 'o1',
  rowIndex: 0,
  dateSection: '2026-08-27',
  evidence: { mediaId: 'm1', attachmentToken: 't1', slot },
})

const row = (over: Partial<DraftOrder> = {}): DraftOrder => ({
  localId: over.localId ?? 'l1',
  providerOrderNo: over.providerOrderNo ?? 'YAL-1',
  payMode: 'cash',
  feeText: over.feeText ?? '225.00',
  timeText: over.timeText ?? '14:39',
  dateText: over.dateText ?? '2026-08-27',
  ...over,
})

/** The evidenced row that survived the retake. */
const evidenced = row({ localId: 'live', sightings: [sighting('dashboard')], included: true })

/** Its remnant: same printed identity, no evidence left, excluded, flagged for time review. */
const remnant = row({
  localId: 'stale',
  providerOrderNo: 'YAL-2',
  sightings: [],
  included: false,
  timeReviewRequired: true,
})

describe('isSupersededRemnant', () => {
  it('recognises the shape that showed Taha 21 deliveries instead of 10', () => {
    expect(isSupersededRemnant(remnant, [evidenced, remnant])).toBe(true)
  })

  it('leaves a row that still holds evidence alone', () => {
    expect(isSupersededRemnant(evidenced, [evidenced, remnant])).toBe(false)
  })

  it('keeps a lost row the driver must actually retake', () => {
    // No evidenced twin carries this identity, so the row is a real `evidence_removed` case. Hiding
    // it would hide the one signal telling him to photograph that delivery again.
    const orphan = row({ localId: 'orphan', feeText: '999.00', sightings: [], included: false, timeReviewRequired: true })
    expect(isSupersededRemnant(orphan, [evidenced, orphan])).toBe(false)
  })

  it('never treats a hand-typed order as a remnant', () => {
    // A manual row is the driver's own testimony. A reader that happens to match it does not get to
    // erase it from his screen.
    const manual = row({ localId: 'manual', draftSource: 'manual', sightings: [], included: false })
    expect(isSupersededRemnant(manual, [evidenced, manual])).toBe(false)
  })

  it('needs the whole printed identity — date, clock and amount', () => {
    for (const differing of [
      { dateText: '2026-08-26' },
      { timeText: '14:40' },
      { feeText: '226.00' },
    ]) {
      const other = row({ localId: 'other', sightings: [], included: false, timeReviewRequired: true, ...differing })
      expect(isSupersededRemnant(other, [evidenced, other])).toBe(false)
    }
  })

  it('does not supersede an included row, whatever else matches it', () => {
    const included = row({ localId: 'kept', sightings: [], included: true })
    expect(isSupersededRemnant(included, [evidenced, included])).toBe(false)
  })

  it('does not let two evidence-less rows erase each other', () => {
    // Neither has a photo, so neither can supersede the other. Without this the pair would cancel
    // out and a delivery would vanish from the screen entirely.
    const twinA = row({ localId: 'a', providerOrderNo: 'A', sightings: [], included: false, timeReviewRequired: true })
    const twinB = row({ localId: 'b', providerOrderNo: 'B', sightings: [], included: false, timeReviewRequired: true })
    expect(isSupersededRemnant(twinA, [twinA, twinB])).toBe(false)
    expect(isSupersededRemnant(twinB, [twinA, twinB])).toBe(false)
    expect(withoutSupersededRemnants([twinA, twinB])).toHaveLength(2)
  })

  it('keeps an excluded row that still has its photo', () => {
    // Excluded is not the same as evidence-less. This row was unchecked by a human but the
    // screenshot behind it still exists, so the manager can look at it and change his mind.
    const excludedButEvidenced = row({
      localId: 'unchecked',
      providerOrderNo: 'UNCHECKED',
      sightings: [sighting('dashboard_2')],
      included: false,
      timeReviewRequired: true,
    })
    expect(isSupersededRemnant(excludedButEvidenced, [evidenced, excludedButEvidenced])).toBe(false)
    expect(withoutSupersededRemnants([evidenced, excludedButEvidenced])).toHaveLength(2)
  })

  it('is not fooled by a row matching itself', () => {
    expect(isSupersededRemnant(remnant, [remnant])).toBe(false)
  })
})

describe('withoutSupersededRemnants', () => {
  it('collapses Taha shift to the ten deliveries he actually made', () => {
    const rows: DraftOrder[] = []
    const fees = ['225.00', '210.00', '305.00', '135.00', '120.00', '210.00', '120.00', '135.00', '135.00', '125.00']
    const times = ['14:39', '14:05', '13:17', '12:02', '11:34', '18:08', '17:33', '16:37', '16:07', '15:19']
    for (const [i, fee] of fees.entries()) {
      rows.push(row({ localId: `live-${i}`, providerOrderNo: `L${i}`, feeText: fee, timeText: times[i]!, sightings: [sighting('dashboard')], included: true }))
      rows.push(row({ localId: `stale-${i}`, providerOrderNo: `S${i}`, feeText: fee, timeText: times[i]!, sightings: [], included: false, timeReviewRequired: true }))
    }
    // Plus the one genuine orphan his shift also carries: no twin, so it must survive.
    rows.push(row({ localId: 'real-orphan', providerOrderNo: 'ORPH', feeText: '125.00', timeText: '15:19', dateText: '2026-08-26', sightings: [], included: false, timeReviewRequired: true }))

    const shown = withoutSupersededRemnants(rows)
    expect(shown).toHaveLength(11)
    expect(shown.filter((r) => r.localId.startsWith('stale-'))).toHaveLength(0)
    expect(shown.some((r) => r.localId === 'real-orphan')).toBe(true)
  })

  it('returns the list untouched when nothing is superseded', () => {
    const rows = [evidenced]
    expect(withoutSupersededRemnants(rows)).toEqual(rows)
  })
})
