import { describe, expect, it } from 'vitest'
import type { DraftOrder } from '../src/order-entry.ts'
import { isSupersededRemnant, withoutSupersededRemnants } from '../src/close-draft.ts'

/**
 * Shift d0a5a7ec, 2026-08-27. The driver's screen read «محسوبة 10 من 21»: 21 rows over 11 provider
 * order numbers, ten deliveries written down twice.
 *
 * He had retaken the dashboard photos. The attachment token rotated, the old rows lost every
 * sighting, and because he had also hand-corrected their times they had become `source: 'manual'`
 * with a null `matchKey`. Both the canonical merge and a printed date/clock/amount heuristic are
 * blind to that shape — the provider's own order number is not.
 */

const sighting = () => ({
  readId: 'r1',
  observationId: 'o1',
  rowIndex: 0,
  dateSection: '2026-08-27',
  evidence: { mediaId: 'm1', attachmentToken: 't1', slot: 'dashboard' },
})

const row = (over: Partial<DraftOrder> & { providerOrderNo: string }): DraftOrder => ({
  localId: over.localId ?? over.providerOrderNo,
  payMode: 'cash',
  feeText: over.feeText ?? '225.00',
  timeText: over.timeText ?? '14:39',
  dateText: over.dateText ?? '2026-08-27',
  ...over,
})

/** The pair exactly as production holds it: same provider number, one evidenced, one stranded. */
const evidenced = row({ providerOrderNo: 'YAL-cca8', localId: 'live', sightings: [sighting()], included: true })
const stranded = row({
  providerOrderNo: 'YAL-cca8',
  localId: 'stale',
  sightings: [],
  included: false,
  timeReviewRequired: true,
  draftSource: 'manual', // what a hand-corrected TIME turns a scanned row into
})

describe('isSupersededRemnant', () => {
  it('recognises the pair that showed Taha 21 rows for 11 orders', () => {
    expect(isSupersededRemnant(stranded, [evidenced, stranded])).toBe(true)
  })

  it('is not fooled by the stranded copy being marked manual', () => {
    // `source: 'manual'` here means "a scanned row whose time a human corrected", NOT "a row the
    // driver added himself". Treating the two as the same thing is what made the first version of
    // this predicate a no-op on the real shift.
    expect(stranded.draftSource).toBe('manual')
    expect(isSupersededRemnant(stranded, [evidenced, stranded])).toBe(true)
  })

  it('never hides the row that still holds the photo', () => {
    expect(isSupersededRemnant(evidenced, [evidenced, stranded])).toBe(false)
  })

  it('keeps one copy when a delivery has lost ALL of its evidence', () => {
    // Taha has exactly one of these: provider YAL-efd2, 125.00, both copies stranded. The driver
    // must still be told a delivery lost its page — once, not twice, and never zero times.
    const a = row({ providerOrderNo: 'YAL-efd2', localId: 'a', feeText: '125.00', sightings: [], included: false })
    const b = row({ providerOrderNo: 'YAL-efd2', localId: 'b', feeText: '125.00', sightings: [], included: false })
    const shown = withoutSupersededRemnants([a, b])
    expect(shown).toHaveLength(1)
    expect(shown[0]!.localId).toBe('a')
  })

  it('leaves a lone order alone, evidence or not', () => {
    const lone = row({ providerOrderNo: 'YAL-baa4', localId: 'lone', sightings: [], included: false })
    expect(isSupersededRemnant(lone, [evidenced, stranded, lone])).toBe(false)
  })

  it('never hides an included row', () => {
    const included = row({ providerOrderNo: 'YAL-cca8', localId: 'kept', sightings: [], included: true })
    expect(isSupersededRemnant(included, [evidenced, included])).toBe(false)
  })

  it('does not group two genuinely different orders that cost the same', () => {
    // Same money, same minute, different provider numbers — two real deliveries. The old
    // printed-identity heuristic would have merged these; the provider number does not.
    const one = row({ providerOrderNo: 'YAL-aaaa', localId: 'one', sightings: [sighting()], included: true })
    const two = row({ providerOrderNo: 'YAL-bbbb', localId: 'two', sightings: [], included: false })
    expect(isSupersededRemnant(two, [one, two])).toBe(false)
    expect(withoutSupersededRemnants([one, two])).toHaveLength(2)
  })

  it('ignores a row with no provider number rather than grouping it with others', () => {
    const blank = row({ providerOrderNo: '', localId: 'blank', sightings: [], included: false })
    const other = row({ providerOrderNo: '', localId: 'other', sightings: [], included: false })
    expect(isSupersededRemnant(blank, [blank, other])).toBe(false)
  })
})

describe('withoutSupersededRemnants on the real shift', () => {
  it('reduces Taha 21 rows to the 11 orders he actually has', () => {
    // Nine pairs where one copy kept its photo, one pair where neither did, and one lone evidenced
    // order — exactly the production shape.
    const rows: DraftOrder[] = []
    for (let i = 0; i < 9; i += 1) {
      const id = `YAL-pair-${i}`
      rows.push(row({ providerOrderNo: id, localId: `live-${i}`, sightings: [sighting()], included: true }))
      rows.push(row({ providerOrderNo: id, localId: `stale-${i}`, sightings: [], included: false, draftSource: 'manual' }))
    }
    rows.push(row({ providerOrderNo: 'YAL-lost', localId: 'lost-a', sightings: [], included: false }))
    rows.push(row({ providerOrderNo: 'YAL-lost', localId: 'lost-b', sightings: [], included: false, draftSource: 'manual' }))
    rows.push(row({ providerOrderNo: 'YAL-lone', localId: 'lone', sightings: [sighting()], included: true }))
    expect(rows).toHaveLength(21)

    const shown = withoutSupersededRemnants(rows)
    expect(shown).toHaveLength(11)
    expect(shown.filter((r) => r.localId.startsWith('stale-'))).toHaveLength(0)
    // The delivery that lost every photo survives exactly once — the driver must still see it.
    expect(shown.filter((r) => r.providerOrderNo === 'YAL-lost')).toHaveLength(1)
    expect(shown.filter((r) => r.included)).toHaveLength(10)
  })
})
