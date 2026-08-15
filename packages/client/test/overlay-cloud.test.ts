import { describe, expect, it } from 'vitest'
import {
  cloudRowsToScannedMovements,
  cloudRowsToScannedOrders,
  mergeScannedMovements,
  mergeScannedOrders,
  overlayCloudAmounts,
  reconcileUnverifiedOrderTimes,
} from '../src/order-entry.ts'

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

describe('when the phone reads nothing at all', () => {
  const newId = (() => { let n = 0; return () => `x-${++n}` })()

  /** Verbatim shape of what gpt-5.5 returns for an orders screen. */
  const cloudOrder = (value: string | null, time: string, pointA: string, cancelled = false) => ({
    printed: value ?? '',
    value,
    cancelled,
    time,
    dateIso: '2026-08-06',
    pointA,
    pointB: null,
  })

  it('turns the cloud rows into a list the merge can use', () => {
    /*
     * THE REAL FAILURE. On a live close, page 4 came back
     *   «لم تُضَف أي عملية من هذه الصورة · ٤٠ صفوف لم تُقرأ بثقة»
     * — the phone saw forty candidate rows and confidently read none, while the cloud had read the
     * screen's four deliveries correctly and been billed for them. `overlayCloudAmounts` compares
     * lengths, 0 !== 4 is trivially true, and it handed back the empty local list. Four deliveries
     * the driver was paid for, discarded in silence, after paying to read them.
     */
    const rows = cloudRowsToScannedOrders([
      cloudOrder('130', '14:20', 'كرم فروت - الميدان'),
      cloudOrder('150', '01:16', 'نادي بردى'),
      cloudOrder('75', '00:32', 'ZAITOUNE SWEETS'),
      cloudOrder('350', '23:16', 'بانزو'),
    ])
    expect(rows).toHaveLength(4)
    expect(mergeScannedOrders([], rows, newId)).toHaveLength(4)
  })

  it('preserves negative Recent Orders values for cash-deduction partitioning', () => {
    const rows = cloudRowsToScannedOrders([cloudOrder('-144.15', '19:29', 'Branch')])
    expect(rows[0]!.fee).toBe('-144.15')
    expect(mergeScannedOrders([], rows, newId)).toEqual([])
  })

  it('keeps a timeless deduction when its day and route still give it an identity', () => {
    const rows = cloudRowsToScannedOrders([
      { ...cloudOrder('-50', '19:29', 'Branch'), time: null },
    ])
    expect(rows).toMatchObject([{ fee: '-50', time: '', dateIso: '2026-08-06', pointA: 'Branch' }])
  })

  it('keeps a cancelled card as a row with no fee', () => {
    // It is a delivery that happened and the screen still shows it. Dropped here, the driver
    // re-adds it by hand — as a PAID order, because nothing told him it was cancelled.
    const rows = cloudRowsToScannedOrders([cloudOrder(null, '14:20', 'المزة', true)])
    expect(rows).toEqual([{ dateIso: '2026-08-06', time: '14:20', fee: null, cancelled: true, pointA: 'المزة' }])
  })

  it('keeps a priced row whose clock AI refused, with evidence provenance for safe review', () => {
    // Money that AI read correctly must not disappear merely because the independent time vote
    // failed. The empty minute reaches the API as null and the server classifies it `unknown`.
    const rows = cloudRowsToScannedOrders([
      { printed: '', value: '500', cancelled: false, time: null, dateIso: '2026-08-06', pointA: null, pointB: null },
      cloudOrder('130', '14:20', 'المزة'),
    ], undefined, 'dashboard-3')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      fee: '500',
      time: '',
      dateIso: '2026-08-06',
      scanProvenance: 'dashboard-3:0',
    })
    const draft = mergeScannedOrders([], rows, () => 'unknown-time')
    expect(draft[0]).toMatchObject({
      feeText: '500',
      feeOcrText: '500',
      timeText: '',
      dateText: '2026-08-06',
      scanProvenance: 'dashboard-3:0',
      included: false,
      timeReviewRequired: true,
    })
  })

  it.each([
    ['25:00', '2026-08-15'],
    ['00:30', '2026-02-30'],
  ])('keeps a priced row excluded when %s / %s is not a valid boundary', (time, dateIso) => {
    const [draft] = mergeScannedOrders([], [{
      time,
      dateIso,
      fee: '155',
      scanProvenance: 'invalid-boundary:0',
    }], () => 'invalid-boundary')
    expect(draft).toMatchObject({ included: false, timeReviewRequired: true })
  })

  it('keeps a cancellation-contested card with refused money and time beside valid rows', () => {
    const rows = cloudRowsToScannedOrders([
      {
        printed: '240',
        value: '240',
        cancelled: false,
        time: '23:21',
        dateIso: '2026-08-14',
      },
      {
        printed: 'Cancelled / 155',
        value: null,
        cancelled: false,
        reviewRequired: true,
        time: null,
        dateIso: '2026-08-15',
      },
    ], undefined, 'dashboard-cancel-conflict')

    expect(rows).toMatchObject([
      { fee: '240', time: '23:21' },
      { fee: null, time: '', dateIso: '2026-08-15', scanProvenance: 'dashboard-cancel-conflict:1' },
    ])
    let id = 0
    const draft = mergeScannedOrders([], rows, () => `visible-row-${++id}`)
    expect(draft[1]).toMatchObject({
      localId: 'visible-row-2',
      feeText: '',
      feeRefused: true,
      timeText: '',
    })
  })

  it('dedupes an unknown-time retry of one photo but retains uncertain rows from another photo', () => {
    const cloud = [
      { printed: '500', value: '500', cancelled: false, time: null, dateIso: '2026-08-06', pointA: 'A', pointB: 'B' },
    ]
    const firstScan = cloudRowsToScannedOrders(cloud, undefined, 'dashboard-3')
    const existing = mergeScannedOrders([], firstScan, () => 'first')
    expect(mergeScannedOrders(existing, firstScan, () => 'retry')).toEqual([])

    const overlappingOtherPhoto = cloudRowsToScannedOrders(cloud, undefined, 'dashboard-4')
    expect(mergeScannedOrders(existing, overlappingOtherPhoto, () => 'needs-review')).toHaveLength(1)
  })

  it('enriches the same unknown row when its retry verifies 00:30 instead of appending money', () => {
    const firstScan = cloudRowsToScannedOrders([
      {
        printed: '155',
        value: '155',
        cancelled: false,
        time: null,
        dateIso: null,
        pointA: 'verified route A',
        pointB: 'verified route B',
      },
    ], undefined, 'dashboard-7')
    const existing = mergeScannedOrders([], firstScan, () => 'original-local-id')
    const originalProviderNo = existing[0]!.providerOrderNo

    const retry = cloudRowsToScannedOrders([
      {
        printed: '155',
        value: '155',
        cancelled: false,
        time: '00:30',
        dateIso: '2026-08-15',
        pointA: 'verified route A',
        pointB: 'verified route B',
      },
    ], undefined, 'dashboard-7')
    const reconciled = reconcileUnverifiedOrderTimes(existing, retry)
    const appended = mergeScannedOrders(reconciled, retry, () => 'must-not-be-used')

    expect(appended).toEqual([])
    expect(reconciled).toHaveLength(1)
    expect(reconciled[0]).toMatchObject({
      localId: 'original-local-id',
      providerOrderNo: originalProviderNo,
      timeText: '00:30',
      dateText: '2026-08-15',
      feeText: '155',
      feeOcrText: '155',
      pointA: 'verified route A',
      pointB: 'verified route B',
      scanProvenance: 'dashboard-7:0',
      included: true,
      timeReviewRequired: false,
    })

    const otherSlotUnknown = cloudRowsToScannedOrders([
      {
        printed: '155',
        value: '155',
        cancelled: false,
        time: null,
        dateIso: '2026-08-15',
        pointA: 'verified route A',
        pointB: 'verified route B',
      },
    ], undefined, 'dashboard-8')
    expect(mergeScannedOrders(reconciled, otherSlotUnknown, () => 'separate-unknown')).toHaveLength(1)
  })

  it('does not swallow a different known row that moved into the same slot position', () => {
    const first = cloudRowsToScannedOrders([
      {
        printed: '155',
        value: '155',
        cancelled: false,
        time: '00:03',
        dateIso: '2026-08-15',
        pointA: 'A',
        pointB: 'B',
      },
    ], undefined, 'dashboard-shifted')
    const existing = mergeScannedOrders([], first, () => '00:03-row')
    const shiftedRetry = cloudRowsToScannedOrders([
      {
        printed: '155',
        value: '155',
        cancelled: false,
        time: '00:30',
        dateIso: '2026-08-15',
        pointA: 'A',
        pointB: 'B',
      },
    ], undefined, 'dashboard-shifted')

    expect(mergeScannedOrders(existing, shiftedRetry, () => '00:30-row')).toMatchObject([
      { localId: '00:30-row', timeText: '00:30', feeText: '155' },
    ])
  })

  it('keeps both rows visible when same-position unknown and retry fees conflict', () => {
    const first = cloudRowsToScannedOrders([
      {
        printed: '155',
        value: '155',
        cancelled: false,
        time: null,
        dateIso: '2026-08-15',
        pointA: 'A',
        pointB: 'B',
      },
    ], undefined, 'dashboard-conflict')
    const existing = mergeScannedOrders([], first, () => 'unknown-155')
    const conflictingRetry = cloudRowsToScannedOrders([
      {
        printed: '240',
        value: '240',
        cancelled: false,
        time: '00:30',
        dateIso: '2026-08-15',
        pointA: 'A',
        pointB: 'B',
      },
    ], undefined, 'dashboard-conflict')
    const reconciled = reconcileUnverifiedOrderTimes(existing, conflictingRetry)
    const added = mergeScannedOrders(reconciled, conflictingRetry, () => 'timed-240')

    expect(reconciled).toMatchObject([
      { localId: 'unknown-155', timeText: '', feeText: '155' },
    ])
    expect(added).toMatchObject([
      { localId: 'timed-240', timeText: '00:30', feeText: '240' },
    ])
  })

  it('does not heal a moved same-fee row from slot position when no route proves identity', () => {
    const first = cloudRowsToScannedOrders([{
      printed: '155',
      value: '155',
      cancelled: false,
      time: null,
      dateIso: '2026-08-15',
      pointA: null,
      pointB: null,
    }], undefined, 'dashboard-same-fee')
    const existing = mergeScannedOrders([], first, () => 'unknown-first-155')
    const movedRetry = cloudRowsToScannedOrders([{
      printed: '155',
      value: '155',
      cancelled: false,
      time: '00:30',
      dateIso: '2026-08-15',
      pointA: null,
      pointB: null,
    }], undefined, 'dashboard-same-fee')

    const reconciled = reconcileUnverifiedOrderTimes(existing, movedRetry)
    const added = mergeScannedOrders(reconciled, movedRetry, () => 'timed-second-155')

    expect(reconciled).toMatchObject([
      { localId: 'unknown-first-155', timeText: '', feeText: '155' },
    ])
    expect(added).toMatchObject([
      { localId: 'timed-second-155', timeText: '00:30', feeText: '155' },
    ])
  })

  it('uses same-photo provenance when a verified-time retry has no repeated day header', () => {
    const first = cloudRowsToScannedOrders([
      {
        printed: '155',
        value: '155',
        cancelled: false,
        time: null,
        dateIso: '2026-08-15',
        pointA: 'A',
        pointB: 'B',
      },
    ], undefined, 'dashboard-9')
    const existing = mergeScannedOrders([], first, () => 'held')
    const retry = cloudRowsToScannedOrders([
      {
        printed: '155',
        value: '155',
        cancelled: false,
        time: '00:30',
        dateIso: null,
        pointA: 'A',
        pointB: 'B',
      },
    ], undefined, 'dashboard-9')
    const reconciled = reconcileUnverifiedOrderTimes(existing, retry)

    expect(reconciled[0]).toMatchObject({
      localId: 'held',
      timeText: '00:30',
      dateText: '2026-08-15',
    })
    expect(mergeScannedOrders(reconciled, retry, () => 'duplicate')).toEqual([])
  })

  it('carries the route through, so the same delivery is not counted twice across pages', () => {
    // Page 4: the phone read nothing, the cloud supplied the list. Page 5 overlaps and the phone
    // works this time. Both rows must key identically — (day, minute, route) — or one delivery
    // becomes two.
    const fromCloud = cloudRowsToScannedOrders([cloudOrder('130', '14:20', 'كرم فروت - الميدان')])
    const existing = mergeScannedOrders([], fromCloud, newId)
    expect(existing).toHaveLength(1)

    const fromPhone = [{ dateIso: '2026-08-06', time: '14:20', fee: '130', pointA: 'كرم فروت - الميدان' }]
    expect(mergeScannedOrders(existing, fromPhone, newId), 'one delivery, two readers').toHaveLength(0)
  })

  it('converts payments-log rows, which need only a signed amount and a clock', () => {
    const rows = cloudRowsToScannedMovements([
      { value: '+153', time: '17:42' },
      { value: '-42', time: '17:42' },
      { value: null, time: '17:42' },
    ])
    expect(rows).toEqual([
      { amount: '+153', time: '17:42' },
      { amount: '-42', time: '17:42' },
    ])
    // Both survive the merge: one delivery's credit and its Yallago cut share a minute by design.
    expect(mergeScannedMovements([], rows, newId)).toHaveLength(2)
  })
})

describe('the clock, when the phone reads a fee but not a time', () => {
  it('fills a blank time and date from the cloud', () => {
    /*
     * FROM A LIVE CLOSE. The phone produced four rows off «الطلبات الحديثة» with their clocks
     * blank — it reads «١٠:٣١ م» far less reliably than it reads a fee — while the cloud had
     * returned 22:31 and 2026-08-05 for every one. The overlay carried the amount and nothing
     * else, so all four cards showed «/» where the time should be.
     */
    const local = [{ fee: '130', time: '', dateIso: null }]
    const said = [{ value: '130', cancelled: false, time: '22:31', dateIso: '2026-08-05' }]
    const { rows } = overlayCloudAmounts(local, said, 'fee')
    expect(rows[0]).toEqual({ fee: '130', time: '22:31', dateIso: '2026-08-05' })
  })

  it('NEVER overwrites a time the phone did read', () => {
    // Identity is (day, minute, route). Changing a clock the phone read would change the row's
    // identity between one page and the next depending on whether the cloud answered — the exact
    // instability that took the fee out of the key. Blank→value is monotonic; value→value is not.
    const local = [{ fee: '130', time: '22:31', dateIso: '2026-08-05' }]
    const said = [{ value: '130', cancelled: false, time: '09:99', dateIso: '1999-01-01' }]
    const { rows } = overlayCloudAmounts(local, said, 'fee')
    expect(rows[0]).toEqual({ fee: '130', time: '22:31', dateIso: '2026-08-05' })
  })

  it('makes two sightings of one delivery AGREE rather than disagree', () => {
    const newId = (() => { let n = 0; return () => `c-${++n}` })()
    // Page A: the phone missed the clock, the cloud supplied it.
    const pageA = overlayCloudAmounts(
      [{ fee: '130', time: '', dateIso: '', pointA: 'مأكولات الشام' }],
      [{ value: '130', cancelled: false, time: '22:31', dateIso: '2026-08-05' }],
      'fee',
    ).rows
    const existing = mergeScannedOrders([], pageA, newId)
    expect(existing).toHaveLength(1)

    // Page B overlaps and the phone reads the clock this time. Same delivery, same key.
    const pageB = [{ dateIso: '2026-08-05', time: '22:31', fee: '130', pointA: 'مأكولات الشام' }]
    expect(mergeScannedOrders(existing, pageB, newId), 'one delivery, not two').toHaveLength(0)
  })

  it('leaves a row untouched when the cloud has no clock either', () => {
    const local = [{ fee: '130', time: '', dateIso: null }]
    const said = [{ value: '130', cancelled: false, time: null, dateIso: null }]
    const { rows } = overlayCloudAmounts(local, said, 'fee')
    expect(rows[0]).toEqual({ fee: '130', time: '', dateIso: null })
  })
})

describe('the cloud is the reader, the phone is the fallback', () => {
  const newId = (() => { let n = 0; return () => `p-${++n}` })()

  /** Verbatim from ocr_reads, 14:53 Damascus — the screen the owner photographed. */
  const CLOUD_PAGE = [
    // The card sliced by the TOP edge: addresses visible, fee off-screen. The cloud says so.
    { value: null, cancelled: false, time: null, dateIso: '2026-08-11', pointA: null, pointB: 'G8MC+3FC, دمشق', printed: '' },
    { value: '120', cancelled: false, time: '20:32', dateIso: '2026-08-11', pointA: 'صيدلية حاتوت Barzeh', pointB: 'مدرسة ام عمار', printed: '١٢٠' },
    { value: '275', cancelled: false, time: '20:12', dateIso: '2026-08-11', pointA: 'G7CR+PXR, Al Salhiyeh', pointB: 'Al Hurriya', printed: '٢٧٥' },
    { value: '140', cancelled: false, time: '01:39', dateIso: '2026-08-11', pointA: null, pointB: null, printed: '١٤٠' },
  ]

  /** What the phone made of the same image: three rows, one fee refused, two clocks missed. */
  const PHONE_PAGE = [
    { dateIso: '2026-08-11', time: '20:32', fee: null, feeStrip: null },
    { dateIso: null, time: '', fee: '275', feeStrip: 'strip-275' },
    { dateIso: null, time: '', fee: '140', feeStrip: 'strip-140' },
  ]

  it('uses the cloud reading even though the row counts disagree', () => {
    /*
     * THE FAILURE, EXACTLY AS IT HAPPENED. Four cloud rows against three phone rows — the sliced
     * card is one row to the cloud and none to the phone — so the positional join refused, the
     * phone's reading stood, and the driver saw «؟» for a fee the cloud had read as 120 and two
     * «11/08»s for clocks it had read as 20:12 and 01:39.
     */
    const rows = cloudRowsToScannedOrders(CLOUD_PAGE, PHONE_PAGE)
    // The timeless sliced card is dropped — it has no identity — leaving the three real rows.
    expect(rows.map((x) => [x.time, x.fee])).toEqual([
      ['20:32', '120'],
      ['20:12', '275'],
      ['01:39', '140'],
    ])
    expect(mergeScannedOrders([], rows, newId)).toHaveLength(3)
  })

  it('does not carry a fee strip across when the counts disagree', () => {
    // A strip attached to the wrong row is a mislabelled training example — worse than none.
    const local = [{ feeStrip: 'data:image/png;base64,AAA' }]
    const rows = cloudRowsToScannedOrders(CLOUD_PAGE, local)
    expect(rows.every((x) => x.feeStrip === undefined)).toBe(true)
  })

  it('carries each strip across when both readers saw the same cards', () => {
    // The common case, and the one that keeps the on-device reader trainable: same count, same
    // order, so the amount's own pixels ride along with the cloud's reading of it.
    const cloudRows = CLOUD_PAGE.slice(1)
    const local = [
      { feeStrip: 'strip-a' },
      { feeStrip: 'strip-b' },
      { feeStrip: null, pointBIsPin: true },
    ]
    const rows = cloudRowsToScannedOrders(cloudRows, local)
    expect(rows.map((x) => x.feeStrip)).toEqual(['strip-a', 'strip-b', undefined])
    expect(rows[2]!.pointBIsPin).toBe(true)
  })
})
