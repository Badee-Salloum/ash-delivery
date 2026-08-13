import { describe, expect, it } from 'vitest'
import { overlayCloudAmounts } from '../src/order-entry.ts'

/**
 * The join between two readers, and the one rule that keeps it safe.
 *
 * Two readers look at the same screenshot. Only one list is ever merged into the draft, because
 * merging both would double every delivery they disagreed about — and they disagree exactly where
 * the second reader was worth adding. So the local reader owns the LIST (it cut the fee strips,
 * found the addresses, knows which cards the screen edge sliced) and the cloud owns the NUMBERS.
 *
 * Joining by position is only meaningful when both saw the same rows. These pin that.
 */

const cloud = (...values: Array<string | null>) => values.map((value) => ({ value, cancelled: false }))

describe('overlayCloudAmounts', () => {
  it('replaces a fee the local reader got wrong', () => {
    // The real failure from the corpus: the glyph reader dropped a leading digit.
    const local = [{ fee: '75' }, { fee: '350' }]
    const { rows, overlaid } = overlayCloudAmounts(local, cloud('750', '350'), 'fee')
    expect(rows).toEqual([{ fee: '750' }, { fee: '350' }])
    expect(overlaid, 'only the row that actually changed counts').toBe(1)
  })

  it('fills a row the local reader REFUSED', () => {
    // A refusal is the local reader's honest answer when the ٢/٣ margin is too thin. It is also
    // the row most worth filling, because it is the one the driver would otherwise type.
    const local = [{ fee: null }, { fee: '200' }]
    const { rows, overlaid } = overlayCloudAmounts(local, cloud('165', '200'), 'fee')
    expect(rows[0]).toEqual({ fee: '165' })
    expect(overlaid).toBe(1)
  })

  it('keeps the signed amount whole on a payments log', () => {
    // 13 of the local reader's 18 misreads are ONLY a dropped minus, on a log where that turns
    // money leaving into money arriving. The sign rides inside `value`.
    const local = [{ amount: '73' }, { amount: '-26' }]
    const { rows } = overlayCloudAmounts(local, cloud('-73', '-26'), 'amount')
    expect(rows).toEqual([{ amount: '-73' }, { amount: '-26' }])
  })

  it('CHANGES NOTHING when the row counts differ', () => {
    // The rule that makes the whole thing safe. With one row missing from either side every row
    // below it shifts up, and a positional join would silently reassign a dozen amounts to the
    // wrong deliveries — worse than the misreads it set out to fix.
    const local = [{ fee: '100' }, { fee: '200' }, { fee: '300' }]
    const { rows, overlaid } = overlayCloudAmounts(local, cloud('999', '888'), 'fee')
    expect(rows).toEqual(local)
    expect(overlaid).toBe(0)
  })

  it('changes nothing when either side is empty', () => {
    expect(overlayCloudAmounts([], cloud('100'), 'fee')).toEqual({ rows: [], overlaid: 0 })
    const local = [{ fee: '100' }]
    expect(overlayCloudAmounts(local, [], 'fee')).toEqual({ rows: local, overlaid: 0 })
  })

  it('never puts money on a cancelled row', () => {
    // The commonest way a reader invents money is copying the row above into a row that has none.
    const local = [{ fee: '500' }, { fee: '120' }]
    const said = [
      { value: null, cancelled: true },
      { value: '120', cancelled: false },
    ]
    const { rows } = overlayCloudAmounts(local, said, 'fee')
    expect(rows[0]).toEqual({ fee: null })
    expect(rows[1]).toEqual({ fee: '120' })
  })

  it('leaves a row alone when the cloud declined to read it', () => {
    // A null from the cloud is not an instruction to erase what the phone read.
    const local = [{ fee: '450' }]
    const { rows, overlaid } = overlayCloudAmounts(local, cloud(null), 'fee')
    expect(rows).toEqual([{ fee: '450' }])
    expect(overlaid).toBe(0)
  })

  it('does not mutate the rows it was given', () => {
    // The draft is React state; a mutated row would not re-render, and worse, would survive a
    // failed submit as though it had been accepted.
    const local = [{ fee: '75' }]
    const copy = structuredClone(local)
    const { rows } = overlayCloudAmounts(local, cloud('750'), 'fee')
    expect(local).toEqual(copy)
    expect(rows[0]).not.toBe(local[0])
  })

  it('preserves every other field on the row', () => {
    // The local row carries the addresses, the time and the fee strip. The overlay touches one key.
    const local = [{ fee: '75', time: '13:10', pointA: 'المزة', dateIso: '2026-08-07' }]
    const { rows } = overlayCloudAmounts(local, cloud('750'), 'fee')
    expect(rows[0]).toEqual({ fee: '750', time: '13:10', pointA: 'المزة', dateIso: '2026-08-07' })
  })
})
