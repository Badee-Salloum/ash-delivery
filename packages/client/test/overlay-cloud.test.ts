import { describe, expect, it } from 'vitest'
import { mergeScannedMovements, mergeScannedOrders, overlayCloudAmounts } from '../src/order-entry.ts'

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
  it('replaces a fee the local reader got wrong, and remembers what it replaced', () => {
    // The real failure from the corpus: the glyph reader dropped a leading digit.
    const local = [{ fee: '75' }, { fee: '350' }]
    const { rows, overlaid } = overlayCloudAmounts(local, cloud('750', '350'), 'fee')
    // `scannedAs` is the phone's own reading, kept as the stable half of a merge key. An untouched
    // row does not get one — there is nothing to remember.
    expect(rows).toEqual([{ fee: '750', scannedAs: '75' }, { fee: '350' }])
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
    expect(rows).toEqual([{ amount: '-73', scannedAs: '73' }, { amount: '-26' }])
  })

  it('pins the merge identity to the phone, so one movement never becomes two', () => {
    /*
     * The regression this exists to prevent, spelled out.
     *
     * The dashboard is photographed page by page and the pages overlap, so one movement is
     * commonly read twice. If the cloud answers on page 1 and times out on page 2, the amount
     * differs between the two sightings — and `mergeScannedMovements` keys on the amount, because
     * a payments-log minute routinely holds two rows. Without `scannedAs` the driver is credited
     * twice for one delivery, and nothing on his screen says so.
     */
    const page1 = overlayCloudAmounts([{ amount: '73' }], cloud('-73'), 'amount').rows[0]!
    const page2 = overlayCloudAmounts([{ amount: '73' }], [], 'amount').rows[0]! // cloud timed out

    expect(page1).toEqual({ amount: '-73', scannedAs: '73' })
    expect(page2).toEqual({ amount: '73' })
    // Different displayed amounts, ONE identity — which is what the merge keys on.
    expect(page1.scannedAs ?? page1.amount).toBe(page2.scannedAs ?? page2.amount)
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
    expect(rows[0]).toEqual({
      fee: '750',
      scannedAs: '75',
      time: '13:10',
      pointA: 'المزة',
      dateIso: '2026-08-07',
    })
  })
})

describe('scanning overlapping pages with two readers', () => {
  const newId = (() => { let n = 0; return () => `id-${++n}` })()

  it('does NOT duplicate an order when the cloud answers on one page and not the other', () => {
    /*
     * THE REGRESSION THIS WHOLE CHANGE EXISTS FOR.
     *
     * The dashboard is photographed page by page and the pages overlap, so one delivery is
     * commonly read twice. Before the fee left the key:
     *
     *   page 1   local ٧٥, cloud corrects to 750   →  key …|750|route
     *   page 2   local ٧٥, cloud times out         →  key …|75 |route
     *
     * Two keys, one delivery, appended twice. The driver is paid once and credited twice, and BR1
     * then refuses the close for a reason nobody can see on the screen.
     */
    const page1 = overlayCloudAmounts(
      [{ dateIso: '2026-08-07', time: '13:10', fee: '75', pointA: 'المزة', pointB: 'الشعلان' }],
      [{ value: '750', cancelled: false }],
      'fee',
    ).rows
    const existing = mergeScannedOrders([], page1, newId)
    expect(existing).toHaveLength(1)

    // Same delivery on the next page. The cloud did not answer this time.
    const page2 = [{ dateIso: '2026-08-07', time: '13:10', fee: '75', pointA: 'المزة', pointB: 'الشعلان' }]
    const added = mergeScannedOrders(existing, page2, newId)
    expect(added, 'one delivery, seen twice, is still one delivery').toHaveLength(0)
  })

  it('still counts two REAL deliveries that share a minute but not a route', () => {
    // Measured: 0 of 26 corpus order rows share a (date, minute). But the route is in the key
    // anyway, so even a genuine same-minute pair survives as two rows.
    const scanned = [
      { dateIso: '2026-08-07', time: '13:10', fee: '500', pointA: 'المزة', pointB: 'الشعلان' },
      { dateIso: '2026-08-07', time: '13:10', fee: '500', pointA: 'المزة', pointB: 'أبو رمانة' },
    ]
    expect(mergeScannedOrders([], scanned, newId)).toHaveLength(2)
  })

  it('does NOT duplicate a movement when the cloud answers on one page and not the other', () => {
    // The log keeps the amount in its key — a minute there routinely holds two rows — so identity
    // is pinned to `scannedAs` instead.
    const page1 = overlayCloudAmounts([{ amount: '73', time: '17:42' }], [{ value: '-73', cancelled: false }], 'amount').rows
    const existing = mergeScannedMovements([], page1, newId)
    expect(existing).toHaveLength(1)
    expect(existing[0]!.amountText, 'the CLOUD value is what is kept and submitted').toBe('-73')

    const page2 = [{ amount: '73', time: '17:42' }] // cloud timed out on this page
    expect(mergeScannedMovements(existing, page2, newId)).toHaveLength(0)
  })

  it('still counts a delivery’s credit and its Yallago cut as two movements', () => {
    // «+153» and «−42» both at 17:42 — one delivery, two rows, structurally. 8 of 22 corpus log
    // rows share a minute like this. Collapsing them would destroy the wallet reconciliation.
    const scanned = [
      { amount: '153', time: '17:42' },
      { amount: '-42', time: '17:42' },
    ]
    expect(mergeScannedMovements([], scanned, newId)).toHaveLength(2)
  })
})
