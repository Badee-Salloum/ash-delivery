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
