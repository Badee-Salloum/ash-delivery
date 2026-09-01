import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type ScannedPage,
  type ScannedPageRow,
  detectScannedPageOverlap,
  detectScannedPageOverlaps,
} from '../../src/shift/page-overlap.ts'
import { minor } from '../../src/money/minor.ts'

const row = (
  rowRef: string,
  rowIndex: number,
  amount: number | null,
  extra: Partial<Pick<ScannedPageRow, 'occurredDate' | 'occurredMinute' | 'pointA' | 'pointB'>> = {},
): ScannedPageRow => ({
  rowRef,
  rowIndex,
  amount: amount === null ? null : minor(BigInt(amount)),
  occurredDate: extra.occurredDate ?? null,
  occurredMinute: extra.occurredMinute ?? null,
  pointA: extra.pointA ?? null,
  pointB: extra.pointB ?? null,
})

const page = (pageRef: string, rows: ScannedPageRow[]): ScannedPage => ({ pageRef, rows })

// Shift 4f40640e, 2026-08-25. One dashboard photographed twice while scrolling: the second capture
// starts on the last two rows of the first, and lost its date header, so no row carried a clock.
const DASHBOARD_2 = page('a', [
  row('a0', 0, 15_000, { occurredDate: '2026-08-26', occurredMinute: '01:00', pointA: 'Omaya', pointB: 'Amro' }),
  row('a1', 1, 21_500, { occurredDate: '2026-08-26', occurredMinute: '00:37', pointA: 'Roud', pointB: 'G8R4' }),
  row('a2', 2, -5_000, { occurredDate: '2026-08-25', occurredMinute: '23:48', pointA: 'Juzour', pointB: 'Muhi' }),
  row('a3', 3, 13_000, { occurredDate: '2026-08-25', occurredMinute: '22:47', pointA: 'Golden', pointB: 'Mastaba' }),
  row('a4', 4, 12_500, { occurredDate: '2026-08-25', occurredMinute: '22:21' }),
])
const DASHBOARD = page('b', [
  row('b0', 0, 13_000),
  row('b1', 1, 12_500),
  row('b2', 2, 13_000),
  row('b3', 3, 28_000),
  row('b4', 4, 27_000),
])

const DASHBOARD_2_NO_CLOCKS = DASHBOARD_2
const DASHBOARD_NO_CLOCKS = DASHBOARD

describe('detectScannedPageOverlap', () => {
  it('finds the two rows photographed twice, and says the match is amount-only', () => {
    const overlap = detectScannedPageOverlap(DASHBOARD_2, DASHBOARD)
    expect(overlap).not.toBeNull()
    expect(overlap!.earlierPageRef).toBe('a')
    expect(overlap!.laterPageRef).toBe('b')
    expect(overlap!.length).toBe(2)
    expect(overlap!.pairs.map((pair) => [pair.earlierRowRef, pair.laterRowRef])).toEqual([
      ['a3', 'b0'],
      ['a4', 'b1'],
    ])
    expect(overlap!.causes).toContain('scan_overlap_suffix_prefix')
    // Nothing but the printed amount agreed: the second page carried no clock and no route. The
    // manager must be told that, because it is the difference between a hint and a conclusion.
    expect(overlap!.causes).toContain('scan_overlap_amount_only')
  })

  it('does not care which page it is handed first', () => {
    const forward = detectScannedPageOverlap(DASHBOARD_2, DASHBOARD)
    const backward = detectScannedPageOverlap(DASHBOARD, DASHBOARD_2)
    expect(backward).toEqual(forward)
  })

  it('takes the maximal overlap, not the first one it finds', () => {
    const a = page('a', [row('a0', 0, 13_000), row('a1', 1, 12_500), row('a2', 2, 13_000)])
    const b = page('b', [row('b0', 0, 13_000), row('b1', 1, 12_500), row('b2', 2, 13_000), row('b3', 3, 28_000)])
    expect(detectScannedPageOverlap(a, b)?.length).toBe(3)
  })

  it('returns null when nothing lines up', () => {
    const a = page('a', [row('a0', 0, 10_000)])
    const b = page('b', [row('b0', 0, 20_000)])
    expect(detectScannedPageOverlap(a, b)).toBeNull()
  })

  it('is refuted by a printed clock that disagrees', () => {
    const a = page('a', [row('a0', 0, 13_000, { occurredDate: '2026-08-25', occurredMinute: '22:47' })])
    const b = page('b', [row('b0', 0, 13_000, { occurredDate: '2026-08-25', occurredMinute: '21:00' })])
    expect(detectScannedPageOverlap(a, b)).toBeNull()
  })

  it('is refuted by a route that disagrees', () => {
    const a = page('a', [row('a0', 0, 13_000, { pointA: 'Golden', pointB: 'Mastaba' })])
    const b = page('b', [row('b0', 0, 13_000, { pointA: 'Golden', pointB: 'Shaalan' })])
    expect(detectScannedPageOverlap(a, b)).toBeNull()
  })

  it('corroborates with the clock and the route when both pages carry them', () => {
    const fields = { occurredDate: '2026-08-25', occurredMinute: '22:47', pointA: 'Golden', pointB: 'Mastaba' }
    const overlap = detectScannedPageOverlap(
      page('a', [row('a0', 0, 13_000, fields)]),
      page('b', [row('b0', 0, 13_000, fields)]),
    )
    expect(overlap!.pairs[0]!.causes).toEqual(expect.arrayContaining([
      'scan_overlap_pair_amount_agrees',
      'scan_overlap_pair_minute_agrees',
      'scan_overlap_pair_route_agrees',
    ]))
    expect(overlap!.causes).not.toContain('scan_overlap_amount_only')
  })

  it('never matches an unread amount to anything', () => {
    const a = page('a', [row('a0', 0, null)])
    const b = page('b', [row('b0', 0, null)])
    expect(detectScannedPageOverlap(a, b)).toBeNull()
  })

  it('keeps a deduction distinct from an order of the same magnitude', () => {
    const a = page('a', [row('a0', 0, -5_000)])
    const b = page('b', [row('b0', 0, 5_000)])
    expect(detectScannedPageOverlap(a, b)).toBeNull()
  })

  it('carries a deduction inside the overlap with its sign intact', () => {
    const a = page('a', [row('a0', 0, 13_000), row('a1', 1, -5_000)])
    const b = page('b', [row('b0', 0, 13_000), row('b1', 1, -5_000), row('b2', 2, 28_000)])
    const overlap = detectScannedPageOverlap(a, b)
    expect(overlap!.length).toBe(2)
    expect(overlap!.pairs.map((pair) => pair.laterRowRef)).toEqual(['b0', 'b1'])
  })

  it('says so when it cannot tell which page came first', () => {
    const a = page('a', [row('a0', 0, 13_000), row('a1', 1, 13_000)])
    const b = page('b', [row('b0', 0, 13_000), row('b1', 1, 13_000)])
    const overlap = detectScannedPageOverlap(a, b)
    expect(overlap!.causes).toContain('scan_overlap_direction_ambiguous')
    // Deterministic even when ambiguous: the same two pages must never alternate their answer.
    expect(detectScannedPageOverlap(b, a)).toEqual(overlap)
  })

  it('emits cause codes only, never a human-facing string', () => {
    const overlap = detectScannedPageOverlap(DASHBOARD_2, DASHBOARD)!
    for (const cause of overlap.causes) expect(cause).toMatch(/^[a-z0-9_]+$/)
    for (const pair of overlap.pairs) {
      for (const cause of pair.causes) expect(cause).toMatch(/^[a-z0-9_]+$/)
    }
  })

  it('reports every overlapping pair across a set of pages, longest first', () => {
    const third = page('c', [row('c0', 0, 27_000), row('c1', 1, 31_000)])
    const all = detectScannedPageOverlaps([DASHBOARD_2, DASHBOARD, third])
    expect(all.map((overlap) => [overlap.earlierPageRef, overlap.laterPageRef, overlap.length])).toEqual([
      ['a', 'b', 2],
      ['b', 'c', 1],
    ])
  })

  it('never reports a page as overlapping itself', () => {
    expect(detectScannedPageOverlaps([DASHBOARD, DASHBOARD])).toEqual([])
  })

  // Shift 7be4dbb5, 2026-08-26. Two scans of one list that genuinely share a row, and the first
  // detector missed them: the shared row sits behind a row the screenshot cut in half, so the
  // contiguous run broke at the very first comparison. Both pages carry clocks here, so the printed
  // date and minute identify the row directly — which is what the merge already keys on.
  describe('matching on the printed date and minute', () => {
    const DASHBOARD_2 = page('e9fbc614', [
      row('b0', 0, null, { occurredDate: '2026-08-27', occurredMinute: '00:55' }),
      row('b1', 1, 15_000, { occurredDate: '2026-08-27', occurredMinute: '00:40' }),
      row('b2', 2, 18_000, { occurredDate: '2026-08-26', occurredMinute: '23:40' }),
      row('b3', 3, 13_500, { occurredDate: '2026-08-26', occurredMinute: '23:04' }),
      row('b4', 4, 13_000, { occurredDate: '2026-08-26', occurredMinute: '22:26' }),
    ])
    const DASHBOARD = page('d155c437', [
      row('a0', 0, null),
      row('a1', 1, 13_000, { occurredDate: '2026-08-26', occurredMinute: '22:26' }),
      row('a2', 2, 13_000, { occurredDate: '2026-08-26', occurredMinute: '21:03' }),
      row('a3', 3, 15_000, { occurredDate: '2026-08-26', occurredMinute: '20:30' }),
      row('a4', 4, -5_000, { occurredDate: '2026-08-26', occurredMinute: '19:24' }),
      row('a5', 5, null),
    ])

    it('finds the shared row that the contiguous run could not reach', () => {
      const overlap = detectScannedPageOverlap(DASHBOARD_2, DASHBOARD)
      expect(overlap).not.toBeNull()
      expect(overlap!.length).toBe(1)
      expect(overlap!.pairs.map((pair) => [pair.earlierRowRef, pair.laterRowRef])).toEqual([['b4', 'a1']])
      expect(overlap!.causes).toContain('scan_overlap_timed_match')
      expect(overlap!.pairs[0]!.causes).toContain('scan_overlap_pair_minute_agrees')
      // The clock agreed, so this is not the weak amount-only coincidence.
      expect(overlap!.causes).not.toContain('scan_overlap_amount_only')
    })

    it('puts the page whose shared rows sit at the bottom first', () => {
      // The list is newest-first, so the page still showing newer orders above the shared row is
      // the one captured earlier. Getting this backwards would name the wrong row as the repeat.
      const overlap = detectScannedPageOverlap(DASHBOARD_2, DASHBOARD)
      expect(overlap!.earlierPageRef).toBe('e9fbc614')
      expect(overlap!.laterPageRef).toBe('d155c437')
      expect(detectScannedPageOverlap(DASHBOARD, DASHBOARD_2)).toEqual(overlap)
    })

    it('needs the amount to agree too — a shared minute is not enough', () => {
      const a = page('a', [row('a0', 0, 13_000, { occurredDate: '2026-08-26', occurredMinute: '22:26' })])
      const b = page('b', [row('b0', 0, 99_000, { occurredDate: '2026-08-26', occurredMinute: '22:26' })])
      expect(detectScannedPageOverlap(a, b)).toBeNull()
    })

    it('needs the date too — the same minute on a different day is a different delivery', () => {
      const a = page('a', [row('a0', 0, 13_000, { occurredDate: '2026-08-26', occurredMinute: '22:26' })])
      const b = page('b', [row('b0', 0, 13_000, { occurredDate: '2026-08-25', occurredMinute: '22:26' })])
      expect(detectScannedPageOverlap(a, b)).toBeNull()
    })

    it('is still refuted by a route that disagrees on an otherwise perfect timed match', () => {
      const when = { occurredDate: '2026-08-26', occurredMinute: '22:26' }
      const a = page('a', [row('a0', 0, 13_000, { ...when, pointA: 'Golden', pointB: 'Mastaba' })])
      const b = page('b', [row('b0', 0, 13_000, { ...when, pointA: 'Golden', pointB: 'Shaalan' })])
      expect(detectScannedPageOverlap(a, b)).toBeNull()
    })

    it('pairs each row at most once when a page repeats the same amount and minute', () => {
      const when = { occurredDate: '2026-08-26', occurredMinute: '22:26' }
      const a = page('a', [row('a0', 0, 13_000, when), row('a1', 1, 13_000, when)])
      const b = page('b', [row('b0', 0, 13_000, when)])
      const overlap = detectScannedPageOverlap(a, b)
      expect(overlap!.length).toBe(1)
      expect(overlap!.pairs.map((pair) => pair.laterRowRef)).toEqual(['b0'])
    })

    it('still falls back to the contiguous run when no row carries a clock', () => {
      // Shift 4f40640e is the reason this feature exists: its second page lost the date header, so
      // every row had a null clock and no timed match is possible. That path must not regress.
      const overlap = detectScannedPageOverlap(DASHBOARD_2_NO_CLOCKS, DASHBOARD_NO_CLOCKS)
      expect(overlap!.length).toBe(2)
      expect(overlap!.causes).toContain('scan_overlap_suffix_prefix')
    })
  })

  describe('properties', () => {
    const amounts = fc.array(fc.integer({ min: -50_000, max: 50_000 }), { minLength: 0, maxLength: 6 })

    it('pairs are a contiguous suffix/prefix run of equal amounts', () => {
      fc.assert(fc.property(amounts, amounts, (left, right) => {
        const a = page('a', left.map((value, index) => row(`a${index}`, index, value)))
        const b = page('b', right.map((value, index) => row(`b${index}`, index, value)))
        const overlap = detectScannedPageOverlap(a, b)
        if (overlap === null) return true
        expect(overlap.length).toBe(overlap.pairs.length)
        expect(overlap.length).toBeLessThanOrEqual(Math.min(left.length, right.length))
        const earlier = overlap.earlierPageRef === 'a' ? a : b
        const later = overlap.laterPageRef === 'a' ? a : b
        const suffix = earlier.rows.slice(earlier.rows.length - overlap.length)
        const prefix = later.rows.slice(0, overlap.length)
        expect(overlap.pairs.map((pair) => pair.earlierRowRef)).toEqual(suffix.map((each) => each.rowRef))
        expect(overlap.pairs.map((pair) => pair.laterRowRef)).toEqual(prefix.map((each) => each.rowRef))
        for (const [index, pair] of overlap.pairs.entries()) {
          expect(suffix[index]!.amount).toBe(prefix[index]!.amount)
          expect(pair.causes).toContain('scan_overlap_pair_amount_agrees')
        }
        return true
      }))
    })

    it('is symmetric in its arguments', () => {
      fc.assert(fc.property(amounts, amounts, (left, right) => {
        const a = page('a', left.map((value, index) => row(`a${index}`, index, value)))
        const b = page('b', right.map((value, index) => row(`b${index}`, index, value)))
        expect(detectScannedPageOverlap(b, a)).toEqual(detectScannedPageOverlap(a, b))
        return true
      }))
    })
  })
})

// Shift a3728815, 2026-09-01 — the misread that reached settlement.
//
// Two captures of one list. The FIRST row of page 2 was scrolled under the sticky header and
// rendered faded: the top of a ٣ was lost and the reader returned 230 where page 1 read 330, while
// the clock and both address lines survived on both sides. The amount is the anchor of
// `rowsMayBeTheSameOperation`, so the pair was refused; `suffixPrefixRun` then abandoned the run at
// that first position, taking the perfectly good 120⟷120 pair behind it. Zero hints, and no manager
// approved anything — the phantom simply raised `expectedTotal` by 0.8 × 230, turning a real 218.25
// surplus into 34.25 and making the shift look almost exact.
//
// Yallago's own payments log settles which reading is true: exactly one 20% deduction at 14:50,
// −66.00 = 20% of 330. There is no −46.00 anywhere in the log.
describe('a seam row whose amount the capture corrupted', () => {
  const ROUTE = { pointA: 'fulfulji, almuhajirin, nazim basha', pointB: 'almadkhal 6' }

  const PAGE_1 = page('dashboard', [
    row('p1r0', 0, 12_000, { occurredDate: '2026-09-01', occurredMinute: '17:48', pointA: 'Ibn Nafis', pointB: 'Salhiyeh' }),
    row('p1r1', 1, 13_000, { occurredDate: '2026-09-01', occurredMinute: '17:21', pointA: 'Barada', pointB: 'G7' }),
    row('p1r2', 2, 29_500, { occurredDate: '2026-09-01', occurredMinute: '16:00', pointA: 'Sham Sharif', pointB: 'H84J' }),
    row('p1r3', 3, 21_000, { occurredDate: '2026-09-01', occurredMinute: '15:24', pointA: 'Damascus', pointB: 'Adawi Zoo' }),
    // Read correctly here — the row is fully rendered.
    row('p1r4', 4, 33_000, { occurredDate: '2026-09-01', occurredMinute: '14:50', ...ROUTE }),
    // Cut by the BOTTOM edge: the amount survived, the clock and the route did not.
    row('p1r5', 5, 12_000, { occurredDate: '2026-09-01' }),
  ])

  const PAGE_2 = page('dashboard_2', [
    // The same delivery as `p1r4`, faded under the header: 33_000 read as 23_000.
    row('p2r0', 0, 23_000, { occurredDate: '2026-09-01', occurredMinute: '14:50', ...ROUTE }),
    row('p2r1', 1, 12_000, { occurredDate: '2026-09-01', occurredMinute: '14:00', pointA: 'G7FH', pointB: 'G78M' }),
    row('p2r2', 2, 28_000, { occurredDate: '2026-09-01', occurredMinute: '13:18', pointA: 'Midan', pointB: 'Rawda' }),
    row('p2r3', 3, 28_500, { occurredDate: '2026-09-01', occurredMinute: '12:20', pointA: 'Zahraa', pointB: 'Tamayoz' }),
    row('p2r4', 4, 19_500, { occurredDate: '2026-09-01', occurredMinute: '11:34', pointA: 'fulfulji', pointB: 'Ibn Jubayr' }),
  ])

  it('pairs the two readings of the row whose amount was corrupted', () => {
    const overlap = detectScannedPageOverlap(PAGE_1, PAGE_2)
    expect(overlap, 'this returned null in production and both rows were counted').not.toBeNull()
    const pair = overlap!.pairs.find((candidate) => candidate.earlierRowRef === 'p1r4')
    expect(pair, 'the 330/230 row must be paired').toBeDefined()
    expect(pair!.laterRowRef).toBe('p2r0')
    expect(pair!.causes).toContain('scan_overlap_pair_amount_disagrees')
    // What made it identifiable despite the money: the clock and the whole route agreed.
    expect(pair!.causes).toContain('scan_overlap_pair_minute_agrees')
    expect(pair!.causes).toContain('scan_overlap_pair_route_agrees')
    expect(overlap!.causes).toContain('scan_overlap_amount_disagrees')
  })

  it('carries the second seam row with it, which the abandoned run had dropped', () => {
    // `p1r5` lost its clock to the bottom edge, so nothing about it alone identifies it. The
    // alignment established by the misread row above does: it is `p2r1`, the 14:00 delivery.
    const overlap = detectScannedPageOverlap(PAGE_1, PAGE_2)
    const pair = overlap!.pairs.find((candidate) => candidate.earlierRowRef === 'p1r5')
    expect(pair, 'the clockless 120 belongs to the same seam').toBeDefined()
    expect(pair!.laterRowRef).toBe('p2r1')
    expect(pair!.causes).toContain('scan_overlap_pair_amount_agrees')
  })

  it('names the earlier page as the one still showing newer orders', () => {
    const overlap = detectScannedPageOverlap(PAGE_1, PAGE_2)
    expect(overlap!.earlierPageRef).toBe('dashboard')
    expect(overlap!.laterPageRef).toBe('dashboard_2')
  })

  it('reports the same overlap whichever way the caller passes the pages', () => {
    expect(detectScannedPageOverlap(PAGE_2, PAGE_1)).toEqual(detectScannedPageOverlap(PAGE_1, PAGE_2))
  })

  it('does not claim the rows outside the seam', () => {
    // Only the two shared rows. 11:34 and 17:48 are on one page each and must stay unpaired, or a
    // manager would be asked to choose between deliveries that never overlapped.
    const overlap = detectScannedPageOverlap(PAGE_1, PAGE_2)
    expect(overlap!.pairs.map((pair) => pair.earlierRowRef).sort()).toEqual(['p1r4', 'p1r5'])
  })

  it('counts the anchor but not what the sweep found behind it', () => {
    // `length` is what the winning strategy asserted, and it orders the hints a manager sees. The
    // anchor is one shared row, so 1. The second seam row came from the alignment rather than from
    // a strategy, and must not inflate the count — a hint that grew because a corrupted row was
    // reported would outrank a genuine four-row overlap for no reason a manager could name.
    const overlap = detectScannedPageOverlap(PAGE_1, PAGE_2)!
    expect(overlap.length).toBe(1)
    expect(overlap.pairs).toHaveLength(2)
  })

  it('refuses the pairing when the route differs', () => {
    // Same minute, different amounts, different route: two deliveries in one minute is ordinary and
    // must never be offered as a duplicate.
    const other = page('dashboard_2', [
      row('p2r0', 0, 23_000, { occurredDate: '2026-09-01', occurredMinute: '14:50', pointA: 'Somewhere', pointB: 'Else' }),
      ...PAGE_2.rows.slice(1),
    ])
    expect(detectScannedPageOverlap(PAGE_1, other)).toBeNull()
  })

  it('refuses the pairing when either route was never read', () => {
    // The amount is in doubt here, so the route has to carry the identity by itself. A missing one
    // proves nothing, and guessing would let one bad OCR pass retire a real delivery.
    const other = page('dashboard_2', [
      row('p2r0', 0, 23_000, { occurredDate: '2026-09-01', occurredMinute: '14:50' }),
      ...PAGE_2.rows.slice(1),
    ])
    expect(detectScannedPageOverlap(PAGE_1, other)).toBeNull()
  })
})

// The variant that is worse than the shift above, because its hint looks healthy.
describe('a corrupted row inside an overlap that otherwise matched cleanly', () => {
  const day = { occurredDate: '2026-09-01' }
  const EARLIER = page('one', [
    row('e0', 0, 50_000, { ...day, occurredMinute: '18:00', pointA: 'A0', pointB: 'B0' }),
    row('e1', 1, 40_000, { ...day, occurredMinute: '17:00', pointA: 'A1', pointB: 'B1' }),
    row('e2', 2, 30_000, { ...day, occurredMinute: '16:00', pointA: 'A2', pointB: 'B2' }),
    row('e3', 3, 20_000, { ...day, occurredMinute: '15:00', pointA: 'A3', pointB: 'B3' }),
  ])
  const LATER = page('two', [
    row('l0', 0, 40_000, { ...day, occurredMinute: '17:00', pointA: 'A1', pointB: 'B1' }),
    // The corrupted one, in the middle of an otherwise clean run.
    row('l1', 1, 33_000, { ...day, occurredMinute: '16:00', pointA: 'A2', pointB: 'B2' }),
    row('l2', 2, 20_000, { ...day, occurredMinute: '15:00', pointA: 'A3', pointB: 'B3' }),
  ])

  it('does not let the clean pairs bury it', () => {
    // `timedMatches` returns as soon as it has any pair and never reaches the run search, so before
    // the window sweep this reported length 2 and the third row was counted twice behind a hint
    // that looked entirely healthy — harder to catch than a shift with no hint at all.
    const overlap = detectScannedPageOverlap(EARLIER, LATER)
    expect(overlap!.length).toBe(2)
    const pair = overlap!.pairs.find((candidate) => candidate.earlierRowRef === 'e2')
    expect(pair, 'the corrupted row sits inside the overlap and must be reported').toBeDefined()
    expect(pair!.laterRowRef).toBe('l1')
    expect(pair!.causes).toContain('scan_overlap_pair_amount_disagrees')
    expect(overlap!.causes).toContain('scan_overlap_amount_disagrees')
  })
})
