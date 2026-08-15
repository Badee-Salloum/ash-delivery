import { describe, expect, it } from 'vitest'
import {
  type DraftOrder,
  cashDeductionMagnitude,
  cashDeductionOperationKey,
  cashDeductionsAreValid,
  cloudRowsToScannedOrders,
  healCashDeductionDetails,
  inferMissingOrderDates,
  mergeScannedCashDeductions,
  reconcileLocalCashDeductions,
  resumedOrderWindowState,
  syncRecordedCashDeductions,
  allProblems,
  br1DifferencePresentation,
  br1Verdict,
  driverPhaseFor,
  groupThousands,
  isComplete,
  mergeScannedMovements,
  mergeScannedOrders,
  nextPayMode,
  previewBr1,
  toApiPayloads,
  unsentOrders,
  validateRow,
} from '../src/order-entry.ts'

describe('BR1 difference direction', () => {
  it('names a positive declared-minus-expected difference as a surplus', () => {
    expect(br1DifferencePresentation('528.50')).toEqual({ direction: 'surplus', amountText: '528.50' })
  })

  it('names a negative declared-minus-expected difference as a shortage and displays its magnitude', () => {
    expect(br1DifferencePresentation('-528.50')).toEqual({ direction: 'shortage', amountText: '528.50' })
  })

  it('keeps zero as the balanced state', () => {
    expect(br1DifferencePresentation('0.00')).toEqual({ direction: 'balanced', amountText: '0.00' })
  })
})

describe('resumed order window safety', () => {
  it('excludes a legacy unknown row until a manager supplies the audited decision marker', () => {
    expect(resumedOrderWindowState({
      included: true,
      windowStatus: 'unknown',
      decisionReason: null,
      decidedBy: null,
      decidedAt: null,
    })).toEqual({ included: false, timeReviewRequired: true })
  })

  it.each([true, false])('preserves an audited manager unknown decision: included=%s', (included) => {
    expect(resumedOrderWindowState({
      included,
      windowStatus: 'unknown',
      decisionReason: 'manager verified the original screenshot',
      decidedBy: 'u-bm',
      decidedAt: '2026-08-15T00:01:00.000Z',
    })).toEqual({ included })
  })

  it('preserves deterministic in-window inclusion without requiring a manager decision', () => {
    expect(resumedOrderWindowState({
      included: true,
      windowStatus: 'in_window',
      decisionReason: null,
      decidedBy: null,
      decidedAt: null,
    })).toEqual({ included: true })
  })
})

describe('negative Recent Orders operations', () => {
  const scanned = (over: Partial<{ dateIso: string | null; time: string; fee: string | null; pointA: string | null; pointB: string | null }> = {}) => ({
    dateIso: '2026-08-14',
    time: '19:29',
    fee: '-144.15',
    pointA: 'Branch',
    pointB: 'Cash desk',
    ...over,
  })

  it('turns a negative fee into one positive-magnitude deduction, never an order', () => {
    const nextId = () => 'deduction-local'
    const row = scanned()
    const deductions = mergeScannedCashDeductions([], [row], nextId)
    expect(deductions).toMatchObject([
      {
        amountText: '144.15',
        amountOcrText: '144.15',
        dateText: '2026-08-14',
        timeText: '19:29',
        pointA: 'Branch',
        pointB: 'Cash desk',
        source: 'ocr',
      },
    ])
    expect(mergeScannedOrders([], [row], nextId)).toEqual([])
    expect(mergeScannedCashDeductions(deductions, [row], nextId)).toEqual([])
  })

  it('keeps -50 unknown until time and date are both verified, then heals one identity', () => {
    const firstPage = cloudRowsToScannedOrders([
      {
        value: '175',
        cancelled: false,
        time: '20:09',
        dateIso: '2026-08-15',
        pointA: 'Known pickup',
        pointB: 'Known dropoff',
      },
      {
        value: '-50',
        cancelled: false,
        reviewRequired: true,
        time: null,
        dateIso: null,
        pointA: null,
        pointB: null,
      },
    ], undefined, 'dashboard-6')

    expect(firstPage).toHaveLength(2)
    expect(firstPage[1]).toMatchObject({
      fee: '-50',
      time: '',
      dateIso: null,
      scanProvenance: 'dashboard-6:1',
    })

    const orders = mergeScannedOrders([], firstPage, () => 'known-order')
    const deductions = mergeScannedCashDeductions([], firstPage, () => 'unknown-minus-50')
    expect(orders).toHaveLength(1)
    expect(deductions).toMatchObject([{
      localId: 'unknown-minus-50',
      amountText: '50',
      amountOcrText: '50',
      timeText: '',
      dateText: '',
      included: false,
      timeReviewRequired: true,
      scanProvenance: 'dashboard-6:1',
    }])
    expect(mergeScannedCashDeductions(deductions, firstPage, () => 'same-retry-duplicate')).toEqual([])

    const otherPhotoUnknown = cloudRowsToScannedOrders([{
      value: '-50',
      cancelled: false,
      reviewRequired: true,
      time: null,
      dateIso: null,
      pointA: null,
      pointB: null,
    }], undefined, 'dashboard-7')
    expect(mergeScannedCashDeductions(deductions, otherPhotoUnknown, () => 'separate-review-row')).toMatchObject([{
      localId: 'separate-review-row',
      included: false,
      scanProvenance: 'dashboard-7:0',
    }])

    const withoutDeduction = previewBr1({ floatText: '100', topupText: '0', orders })
    const whileUnknown = previewBr1({
      floatText: '100',
      topupText: '0',
      orders,
      cashDeductions: deductions,
    })
    expect(whileUnknown?.expectedCashText).toBe(withoutDeduction?.expectedCashText)

    const timeOnlyPage = cloudRowsToScannedOrders([
      {
        value: '175',
        cancelled: false,
        time: '20:09',
        dateIso: '2026-08-15',
        pointA: 'Known pickup',
        pointB: 'Known dropoff',
      },
      {
        value: '-50',
        cancelled: false,
        reviewRequired: true,
        time: '22:36',
        dateIso: null,
        pointA: 'G777+4GP, Al Qanawat',
        pointB: 'G78P+J3M, Al Mouhajrin',
      },
    ], undefined, 'dashboard-6')
    expect(mergeScannedCashDeductions(deductions, timeOnlyPage, () => 'must-not-append-time-only')).toEqual([])
    const timeOnlyPatches = healCashDeductionDetails(deductions, timeOnlyPage)
    const timeOnly = reconcileLocalCashDeductions(
      deductions.map((row) => ({ ...row, ...timeOnlyPatches[0]! })),
    )
    expect(timeOnly).toHaveLength(1)
    expect(timeOnly[0]).toMatchObject({
      localId: 'unknown-minus-50',
      operationKey: deductions[0]!.operationKey,
      timeText: '22:36',
      dateText: '',
      included: false,
      timeReviewRequired: true,
      scanProvenance: 'dashboard-6:1',
    })
    expect(previewBr1({
      floatText: '100',
      topupText: '0',
      orders,
      cashDeductions: timeOnly,
    })?.expectedCashText).toBe(withoutDeduction?.expectedCashText)

    const retryPage = cloudRowsToScannedOrders([
      {
        value: '175',
        cancelled: false,
        time: '20:09',
        dateIso: '2026-08-15',
        pointA: 'Known pickup',
        pointB: 'Known dropoff',
      },
      {
        value: '-50',
        cancelled: false,
        time: '22:36',
        dateIso: '2026-08-15',
        pointA: 'G777+4GP, Al Qanawat',
        pointB: 'G78P+J3M, Al Mouhajrin',
      },
    ], undefined, 'dashboard-6')

    expect(mergeScannedCashDeductions(timeOnly, retryPage, () => 'must-not-append')).toEqual([])
    const patches = healCashDeductionDetails(timeOnly, retryPage)
    expect(patches).toMatchObject([{
      localId: 'unknown-minus-50',
      timeText: '22:36',
      dateText: '2026-08-15',
      included: true,
      timeReviewRequired: false,
      scanProvenance: 'dashboard-6:1',
    }])

    const healed = reconcileLocalCashDeductions(timeOnly.map((row) => ({ ...row, ...patches[0]! })))
    expect(healed).toHaveLength(1)
    expect(healed[0]).toMatchObject({
      localId: 'unknown-minus-50',
      operationKey: deductions[0]!.operationKey,
      timeText: '22:36',
      included: true,
      timeReviewRequired: false,
    })
    expect(mergeScannedCashDeductions(healed, retryPage, () => 'must-still-not-append')).toEqual([])
  })

  it('consumes a recorded deduction retry without mutating server-owned details', () => {
    const unknown = {
      fee: '-50',
      time: '',
      dateIso: null,
      pointA: null,
      pointB: null,
      scanProvenance: 'dashboard-recorded:0',
    }
    const [draft] = mergeScannedCashDeductions([], [unknown], () => 'recorded-minus-50')
    const recorded = { ...draft!, recorded: true }
    const before = structuredClone(recorded)
    const verifiedRetry = {
      fee: '-50',
      time: '22:36',
      dateIso: '2026-08-15',
      pointA: 'Verified pickup',
      pointB: 'Verified dropoff',
      scanProvenance: 'dashboard-recorded:0',
    }

    // The row consumes both sightings in this response, so no duplicate is materialised.
    expect(mergeScannedCashDeductions(
      [recorded],
      [verifiedRetry, verifiedRetry],
      () => 'must-not-append-recorded',
    )).toEqual([])
    // Fresh OCR cannot rewrite persisted ledger truth on the phone.
    expect(healCashDeductionDetails([recorded], [verifiedRetry])).toEqual([])
    expect(recorded).toEqual(before)
  })

  it('does not duplicate a negative row created by a cached legacy PWA after upgrade', () => {
    const row = scanned({ fee: '-50', time: '20:01', pointA: 'A', pointB: 'B' })
    const legacy = {
      localId: 'deduction-server',
      operationKey: 'legacy:OLD-NEGATIVE',
      amountText: '50',
      amountOcrText: '50',
      timeText: '20:01',
      dateText: '2026-08-14',
      pointA: 'A',
      pointB: 'B',
      source: 'ocr' as const,
      included: true,
    }
    expect(mergeScannedCashDeductions([legacy], [row], () => 'duplicate')).toEqual([])
  })

  it('keeps the source operation key stable when an overlap enriches its minute, date and route', () => {
    expect(cashDeductionOperationKey(scanned({ dateIso: null, time: '', pointA: null, pointB: 'Cash desk' }))).toBe(
      cashDeductionOperationKey(scanned()),
    )
  })

  it('heals a missing date and route without appending or re-keying the same timed cash operation', () => {
    const partial = scanned({ dateIso: null, time: '19:29', pointA: null, pointB: 'Cash desk' })
    const existing = mergeScannedCashDeductions([], [partial], () => 'deduction-local')
    const key = existing[0]!.operationKey

    expect(mergeScannedCashDeductions(existing, [scanned()], () => 'duplicate')).toEqual([])
    expect(healCashDeductionDetails(existing, [scanned()])).toEqual([
      {
        localId: 'deduction-local',
        timeText: '19:29',
        dateText: '2026-08-14',
        pointA: 'Branch',
        pointB: 'Cash desk',
        included: true,
        timeReviewRequired: false,
      },
    ])
    expect(existing[0]!.operationKey).toBe(key)
  })

  it('reconciles the same -50 edge row when one overlapping screenshot has no day', () => {
    const partial = scanned({
      fee: '-50',
      time: '22:36',
      dateIso: null,
      pointA: 'G777+4GP, Al Qanawat',
      pointB: null,
    })
    const complete = scanned({
      fee: '-50',
      time: '22:36',
      dateIso: '2026-08-13',
      pointA: 'G77V+4GP, Al Qanawat',
      pointB: 'G78P+J3M, Al Mouhajrin',
    })
    const existing = mergeScannedCashDeductions([], [partial], () => 'partial-edge-row')

    expect(mergeScannedCashDeductions(existing, [complete], () => 'duplicate')).toEqual([])
    expect(healCashDeductionDetails(existing, [complete])).toEqual([
      {
        localId: 'partial-edge-row',
        timeText: '22:36',
        dateText: '2026-08-13',
        pointA: 'G77V+4GP, Al Qanawat',
        pointB: 'G78P+J3M, Al Mouhajrin',
        included: true,
        timeReviewRequired: false,
      },
    ])
  })

  it('collapses partial and complete -50 sightings returned in one AI response by timing', () => {
    const partial = scanned({
      fee: '-50',
      time: '22:36',
      dateIso: null,
      pointA: 'G777+4GP, Al Qanawat',
      pointB: null,
    })
    const complete = scanned({
      fee: '-50',
      time: '22:36',
      dateIso: '2026-08-13',
      pointA: 'G77V+4GP, Al Qanawat',
      pointB: 'G78P+J3M, Al Mouhajrin',
    })
    let ids = 0

    expect(mergeScannedCashDeductions([], [partial, complete], () => `operation-${++ids}`)).toMatchObject([
      {
        localId: 'operation-1',
        amountText: '50',
        timeText: '22:36',
        dateText: '2026-08-13',
        pointA: 'G77V+4GP, Al Qanawat',
        pointB: 'G78P+J3M, Al Mouhajrin',
        included: true,
        timeReviewRequired: false,
      },
    ])
    expect(ids).toBe(1)
  })

  it('reuses one existing partial deduction across partial and complete sightings in the same AI response', () => {
    const partial = scanned({
      fee: '-50',
      time: '22:36',
      dateIso: null,
      pointA: 'G777+4GP, Al Qanawat',
      pointB: '',
    })
    const complete = scanned({
      fee: '-50',
      time: '22:36',
      dateIso: '2026-08-13',
      pointA: 'G77V+4GP, Al Qanawat',
      pointB: 'G78P+J3M, Al Mouhajrin',
    })
    const existing = mergeScannedCashDeductions([], [partial], () => 'existing-edge-row')

    expect(mergeScannedCashDeductions(existing, [partial, complete], () => 'duplicate')).toEqual([])
    expect(healCashDeductionDetails(existing, [partial, complete])).toEqual([
      {
        localId: 'existing-edge-row',
        timeText: '22:36',
        dateText: '2026-08-13',
        pointA: 'G77V+4GP, Al Qanawat',
        pointB: 'G78P+J3M, Al Mouhajrin',
        included: true,
        timeReviewRequired: false,
      },
    ])
  })

  it('reconciles already-present local OCR duplicates into the richer row under the first stable identity', () => {
    const [partial] = mergeScannedCashDeductions(
      [],
      [
        scanned({
          fee: '-50',
          time: '22:36',
          dateIso: null,
          pointA: 'G777+4GP, Al Qanawat',
          pointB: '',
        }),
      ],
      () => 'first-stable-local-id',
    )
    const richer = {
      ...partial!,
      localId: 'later-duplicate-id',
      operationKey: `${partial!.operationKey}~2`,
      dateText: '2026-08-13',
      pointA: 'G77V+4GP, Al Qanawat',
      pointB: 'G78P+J3M, Al Mouhajrin',
    }
    const input = [partial!, richer]
    const before = structuredClone(input)

    expect(reconcileLocalCashDeductions(input)).toEqual([
      {
        ...partial!,
        localId: 'first-stable-local-id',
        operationKey: partial!.operationKey,
        dateText: '2026-08-13',
        pointA: 'G77V+4GP, Al Qanawat',
        pointB: 'G78P+J3M, Al Mouhajrin',
        included: true,
        timeReviewRequired: false,
      },
    ])
    expect(input).toEqual(before)
  })

  it('reconciles complete/conflicting OCR sightings but preserves manual and server-restored rows', () => {
    const [complete] = mergeScannedCashDeductions(
      [],
      [scanned({ fee: '-50', time: '22:36', pointA: 'Shared pickup', pointB: 'Destination A' })],
      () => 'first',
    )
    const completeTwin = { ...complete!, localId: 'twin', operationKey: `${complete!.operationKey}~2` }
    const conflicting = {
      ...complete!,
      localId: 'conflicting',
      operationKey: `${complete!.operationKey}~3`,
      pointB: 'Destination B',
    }
    const partialManual = { ...complete!, localId: 'manual', operationKey: 'manual', pointB: null, source: 'manual' as const }
    const partialRecorded = {
      ...complete!,
      localId: 'recorded',
      operationKey: 'recorded',
      pointB: null,
      recorded: true,
    }
    const rows = [complete!, completeTwin, conflicting, partialManual, partialRecorded]

    expect(reconcileLocalCashDeductions(rows)).toEqual([complete!, partialManual, partialRecorded])
  })

  it('preserves corrected OCR money and rows without a printed minute', () => {
    const [original] = mergeScannedCashDeductions(
      [],
      [scanned({ fee: '-50', time: '22:36' })],
      () => 'original',
    )
    const corrected = {
      ...original!,
      localId: 'corrected',
      operationKey: `${original!.operationKey}~2`,
      amountText: '55',
    }
    expect(reconcileLocalCashDeductions([original!, corrected])).toEqual([original!, corrected])
    expect(mergeScannedCashDeductions(
      [corrected],
      [scanned({ fee: '-50', time: '22:36' })],
      () => 'new-ocr-row',
    )).toHaveLength(1)

    const noMinute = scanned({ fee: '-60', time: '', pointA: 'A', pointB: 'B' })
    let ids = 0
    expect(mergeScannedCashDeductions([], [noMinute, noMinute], () => `no-minute-${++ids}`)).toHaveLength(2)
  })

  it('keeps equal -50 deductions at 22:36 distinct when both known dates differ', () => {
    const first = scanned({
      fee: '-50',
      time: '22:36',
      dateIso: '2026-08-14',
      pointA: 'Shared pickup',
      pointB: 'Destination A',
    })
    const second = scanned({
      fee: '-50',
      time: '22:36',
      dateIso: '2026-08-13',
      pointA: 'Shared pickup',
      pointB: 'Destination B',
    })
    const existing = mergeScannedCashDeductions([], [first], () => 'first-operation')
    const added = mergeScannedCashDeductions(existing, [second], () => 'second-operation')

    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      localId: 'second-operation',
      amountText: '50',
      timeText: '22:36',
      pointA: 'Shared pickup',
      pointB: 'Destination B',
    })
    expect(added[0]!.operationKey).not.toBe(existing[0]!.operationKey)
  })

  it('collapses complete sightings with conflicting Plus Codes at the same date and minute', () => {
    const first = scanned({
      fee: '-50',
      time: '22:36',
      pointA: 'G777+4GP, Al Qanawat',
      pointB: 'G78P+J3M, Al Mouhajrin',
    })
    const second = scanned({
      fee: '-50',
      time: '22:36',
      pointA: 'G77V+4GP, Al Qanawat',
      pointB: 'G78P+J3M, Al Mouhajrin',
    })
    const existing = mergeScannedCashDeductions([], [first], () => 'first-complete')
    expect(mergeScannedCashDeductions(existing, [second], () => 'second-complete')).toEqual([])
    const duplicateDraft = {
      ...existing[0]!,
      localId: 'second-complete',
      operationKey: `${existing[0]!.operationKey}~2`,
      pointA: second.pointA,
    }
    expect(reconcileLocalCashDeductions([...existing, duplicateDraft])).toEqual(existing)
  })

  it('ignores route OCR conflicts but keeps a different printed minute distinct', () => {
    const partial = scanned({
      fee: '-50',
      time: '22:36',
      pointA: 'G777+4GP, Al Qanawat',
      pointB: null,
    })
    const differentTail = scanned({
      fee: '-50',
      time: '22:36',
      pointA: 'G77V+4GP, Al Midan',
      pointB: 'Destination',
    })
    const twoCodeCharacters = scanned({
      fee: '-50',
      time: '22:36',
      pointA: 'G7VV+4GP, Al Qanawat',
      pointB: 'Destination',
    })
    const differentMinute = scanned({
      fee: '-50',
      time: '22:37',
      pointA: 'G77V+4GP, Al Qanawat',
      pointB: 'Destination',
    })
    const existing = mergeScannedCashDeductions([], [partial], () => 'partial')

    expect(mergeScannedCashDeductions(existing, [differentTail], () => 'tail-conflict')).toEqual([])
    expect(mergeScannedCashDeductions(existing, [twoCodeCharacters], () => 'code-conflict')).toEqual([])
    expect(mergeScannedCashDeductions(existing, [differentMinute], () => 'minute-conflict')).toHaveLength(1)
  })

  it('does not use any route glyph difference as cash-deduction identity', () => {
    const partial = scanned({
      fee: '-50',
      time: '22:36',
      pointA: 'G77W+4GP, Al Qanawat',
      pointB: null,
    })
    const complete = scanned({
      fee: '-50',
      time: '22:36',
      pointA: 'G77V+4GP, Al Qanawat',
      pointB: 'Destination',
    })
    const existing = mergeScannedCashDeductions([], [partial], () => 'partial')

    expect(mergeScannedCashDeductions(existing, [complete], () => 'distinct')).toEqual([])
  })

  it('replaces a submitted duplicate draft with the canonical server survivor', () => {
    const current = [
      {
        localId: 'partial-local',
        operationKey: 'recent-orders:aaaaaaaaaaaaaaaa',
        amountText: '50.00',
        amountOcrText: '50.00',
        timeText: '22:36',
        dateText: '2026-08-13',
        pointA: 'G777+4GP, Al Qanawat',
        pointB: null,
        source: 'ocr' as const,
      },
      {
        localId: 'richer-local',
        operationKey: 'recent-orders:aaaaaaaaaaaaaaaa~2',
        amountText: '50.00',
        amountOcrText: '50.00',
        amountStrip: 'data:image/png;base64,sample',
        timeText: '22:36',
        dateText: '2026-08-13',
        pointA: 'G77V+4GP, Al Qanawat',
        pointB: 'G78P+J3M, Al Mouhajrin',
        source: 'ocr' as const,
      },
    ]

    expect(syncRecordedCashDeductions(current, [{
      id: 'server-richer',
      operationKey: 'recent-orders:aaaaaaaaaaaaaaaa~2',
      amount: '50.00',
      amountOcr: '50.00',
      occurredMinute: '22:36',
      occurredDate: '2026-08-13',
      source: 'ocr',
      pointA: 'G77V+4GP, Al Qanawat',
      pointB: 'G78P+J3M, Al Mouhajrin',
      included: true,
    }])).toEqual([expect.objectContaining({
      localId: 'richer-local',
      operationKey: 'recent-orders:aaaaaaaaaaaaaaaa~2',
      amountStrip: 'data:image/png;base64,sample',
      recorded: true,
    })])
  })

  it('keeps a resumed unknown deduction out of preview but preserves an audited manager decision', () => {
    const stored = {
      id: 'unknown-deduction',
      operationKey: 'recent-orders:unknown',
      amount: '50.00',
      amountOcr: '50.00',
      occurredMinute: null,
      occurredDate: null,
      source: 'ocr' as const,
      pointA: null,
      pointB: null,
      included: true,
      windowStatus: 'unknown',
      decisionReason: null,
      decidedBy: null,
      decidedAt: null,
    }
    expect(syncRecordedCashDeductions([], [stored])).toEqual([
      expect.objectContaining({ included: false, timeReviewRequired: true, recorded: true }),
    ])

    expect(syncRecordedCashDeductions([], [{
      ...stored,
      decisionReason: 'manager verified original evidence',
      decidedBy: 'u-bm',
      decidedAt: '2026-08-15T00:01:00.000Z',
    }])).toEqual([
      expect.objectContaining({ included: true, recorded: true }),
    ])
    expect(syncRecordedCashDeductions([], [{
      ...stored,
      included: false,
      decisionReason: 'manager excluded duplicate evidence',
      decidedBy: 'u-bm',
      decidedAt: '2026-08-15T00:02:00.000Z',
    }])[0]).not.toHaveProperty('timeReviewRequired')
  })

  it('keeps a complete equal deduction repeated on another day even when its route also repeats', () => {
    const first = scanned({ fee: '-50', time: '22:36', dateIso: '2026-08-14' })
    const nextDay = scanned({ fee: '-50', time: '22:36', dateIso: '2026-08-13' })
    const existing = mergeScannedCashDeductions([], [first], () => 'first-day')
    const added = mergeScannedCashDeductions(existing, [nextDay], () => 'second-day')

    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ localId: 'second-day', dateText: '2026-08-13' })
  })

  it('collapses two OCR deductions that share a known date, minute and amount', () => {
    const rows = [scanned({ pointB: 'Desk A' }), scanned({ pointB: 'Desk B' })]
    const first = mergeScannedCashDeductions([], rows, () => crypto.randomUUID())
    expect(first).toHaveLength(1)
    expect(mergeScannedCashDeductions(first, rows, () => 'duplicate')).toEqual([])
  })

  it('subtracts included deductions from expected cash without creating an order', () => {
    const deductions = mergeScannedCashDeductions([], [scanned({ fee: '-20' })], () => 'deduction-local')
    const preview = previewBr1({ floatText: '100', topupText: '0', orders: [], cashDeductions: deductions })
    expect(preview?.expectedCashText).toBe('80.00')
    expect(preview?.expectedWalletText).toBe('0.00')
  })

  it('normalizes the Unicode minus but does not reinterpret positive fees', () => {
    expect(cashDeductionMagnitude('−١')).toBeNull()
    expect(cashDeductionMagnitude('−1')).toBe('1')
    expect(cashDeductionMagnitude('1')).toBeNull()
  })

  it('validates even a read-only excluded row because every deduction remains in the payload', () => {
    const [deduction] = mergeScannedCashDeductions([], [scanned()], () => 'deduction-local')
    expect(cashDeductionsAreValid([{ ...deduction!, included: false, amountText: '' }])).toBe(false)
  })

  it('infers only a blank run enclosed by the same known date', () => {
    expect(
      inferMissingOrderDates([
        scanned({ dateIso: '2026-08-14' }),
        scanned({ dateIso: null, time: '18:00' }),
        scanned({ dateIso: '2026-08-14', time: '17:00' }),
      ])[1]!.dateIso,
    ).toBe('2026-08-14')

    const uncertain = inferMissingOrderDates([
      scanned({ dateIso: null, time: '20:00' }),
      scanned({ dateIso: '2026-08-14' }),
      scanned({ dateIso: null, time: '18:00' }),
      scanned({ dateIso: '2026-08-13', time: '17:00' }),
      scanned({ dateIso: null, time: '16:00' }),
    ])
    expect(uncertain.map((row) => row.dateIso)).toEqual([null, '2026-08-14', null, '2026-08-13', null])
  })
})

/**
 * The driver order-entry model. This is the screen the product is judged on, so its logic is
 * tested in isolation from any DOM.
 */

const row = (over: Partial<DraftOrder> = {}): DraftOrder => ({
  localId: Math.random().toString(36).slice(2),
  providerOrderNo: 'YAL-1',
  payMode: 'cash',
  feeText: '5000.00',
  ...over,
})

describe('row validation', () => {
  it('flags an empty order number', () => {
    const orders = [row({ providerOrderNo: '  ' })]
    expect(validateRow(orders, 0)).toEqual({ kind: 'empty_order_no' })
  })

  it('detects a duplicate as you type, pointing at the first occurrence', () => {
    // The single most common data-entry slip: the same Yallago number twice.
    const orders = [row({ providerOrderNo: 'YAL-7' }), row({ providerOrderNo: 'YAL-7' })]
    expect(validateRow(orders, 0)).toBeNull()
    expect(validateRow(orders, 1)).toEqual({ kind: 'duplicate_order_no', firstIndex: 0 })
  })

  it('rejects a non-numeric fee', () => {
    expect(validateRow([row({ feeText: 'abc' })], 0)).toEqual({ kind: 'bad_fee' })
  })

  it('rejects a negative fee', () => {
    expect(validateRow([row({ feeText: '-100' })], 0)).toEqual({ kind: 'negative_fee' })
  })

  it('accepts a clean row', () => {
    expect(validateRow([row()], 0)).toBeNull()
  })

  it('allProblems keys by localId and isComplete reflects it', () => {
    const orders = [row({ localId: 'a' }), row({ localId: 'b', providerOrderNo: '' })]
    const problems = allProblems(orders)
    expect(problems.has('b')).toBe(true)
    expect(problems.has('a')).toBe(false)
    expect(isComplete(orders)).toBe(false)
    expect(isComplete([row()])).toBe(true)
    expect(isComplete([])).toBe(false) // an empty shift is not "complete"
  })
})

describe('one-tap pay-mode cycling', () => {
  it('cycles cash → electronic → free → cash', () => {
    expect(nextPayMode('cash')).toBe('electronic')
    expect(nextPayMode('electronic')).toBe('free')
    expect(nextPayMode('free')).toBe('cash')
  })
})

describe('the live BR1 preview — the driver fixes his own mistakes', () => {
  const twentyOrders = (): DraftOrder[] => {
    const out: DraftOrder[] = []
    for (let i = 0; i < 12; i++) out.push(row({ localId: `c${i}`, providerOrderNo: `C${i}`, payMode: 'cash' }))
    for (let i = 0; i < 6; i++) out.push(row({ localId: `e${i}`, providerOrderNo: `E${i}`, payMode: 'electronic' }))
    for (let i = 0; i < 2; i++) out.push(row({ localId: `f${i}`, providerOrderNo: `F${i}`, payMode: 'free' }))
    return out
  }

  it('reproduces the §2.3 expectations before the driver even enters his figures', () => {
    const p = previewBr1({ floatText: '100000', topupText: '50000', orders: twentyOrders() })
    expect(p).not.toBeNull()
    expect(p!.expectedCashText).toBe('160000.00')
    expect(p!.expectedWalletText).toBe('70000.00')
    expect(p!.expectedTotalText).toBe('230000.00')
    expect(p!.blockText).toBe('80000.00')
    expect(p!.differenceText).toBeNull() // no declared figures yet
    expect(p!.balanced).toBeNull()
  })

  it('once he declares, it shows the difference and whether it balances', () => {
    const p = previewBr1({
      floatText: '100000',
      topupText: '50000',
      orders: twentyOrders(),
      declaredCashText: '160000',
      declaredWalletText: '70000',
    })
    expect(p!.differenceText).toBe('0.00')
    expect(p!.balanced).toBe(true)
  })

  it('a wrong declared figure shows immediately as a non-zero difference', () => {
    const p = previewBr1({
      floatText: '100000',
      topupText: '50000',
      orders: twentyOrders(),
      declaredCashText: '155000', // 5,000 short
      declaredWalletText: '70000',
    })
    expect(p!.balanced).toBe(false)
    expect(p!.differenceText).toBe('-5000.00')
  })

  it('ignores half-typed invalid rows rather than flickering to nonsense', () => {
    const orders = [row({ providerOrderNo: 'A', feeText: '5000' }), row({ providerOrderNo: '', feeText: '' })]
    const p = previewBr1({ floatText: '0', topupText: '0', orders })
    // Only the one valid cash order contributes: expected cash = 0 float + 5000.
    expect(p!.expectedCashText).toBe('5000.00')
  })

  it('returns null on an unparseable float rather than throwing', () => {
    expect(previewBr1({ floatText: 'xyz', topupText: '0', orders: [] })).toBeNull()
  })
})

describe('API payloads', () => {
  it('trims order numbers and carries the fee text verbatim', () => {
    const payloads = toApiPayloads([row({ providerOrderNo: '  YAL-9  ', feeText: '5000.00' })])
    expect(payloads[0]).toEqual({ providerOrderNo: 'YAL-9', payMode: 'cash', fee: '5000.00', zone: null })
  })
})

/**
 * Folding a screenshot into a list that already has rows.
 *
 * Both screens scroll, so each arrives as several OVERLAPPING images: page two re-shows the bottom
 * of page one. Appending blindly doubles every row in the overlap and leaves the driver to find and
 * uncheck each duplicate himself — on a phone, at the end of a shift.
 */
describe('merging a scanned page into the list', () => {
  let n = 0
  const id = (): string => `id-${++n}`
  const scan = (time: string, fee: string) => ({ dateIso: '2026-08-04', time, fee })

  it('adds each order once across two overlapping pages', () => {
    const pageOne = [scan('18:06', '235'), scan('17:42', '210'), scan('17:22', '130')]
    const first = mergeScannedOrders([], pageOne, id)
    expect(first).toHaveLength(3)

    // Page two re-shows the last two of page one and brings two genuinely new ones.
    const pageTwo = [scan('17:42', '210'), scan('17:22', '130'), scan('17:07', '135'), scan('16:50', '170')]
    const second = mergeScannedOrders(first, pageTwo, id)
    expect(second.map((o) => o.feeText)).toEqual(['135', '170'])
  })

  it('merges the exact midnight incident: repeats 00:03 and 23:21, adds only 00:30', () => {
    const existing = mergeScannedOrders(
      [],
      [
        { dateIso: '2026-08-14', time: '20:09', fee: '370' },
        { dateIso: '2026-08-14', time: '21:19', fee: '425' },
        { dateIso: '2026-08-14', time: '22:27', fee: '225' },
        { dateIso: '2026-08-14', time: '23:21', fee: '240' },
        { dateIso: '2026-08-15', time: '00:03', fee: '155' },
      ],
      id,
    )
    const overlap = [
      {
        dateIso: '2026-08-15',
        time: '00:59',
        fee: null,
        cancelled: true,
        pointA: 'G78V+586, Damascus',
        pointB: 'G78V+586, Damascus',
      },
      {
        dateIso: '2026-08-15',
        time: '00:49',
        fee: null,
        cancelled: true,
        pointA: 'Al Halabouni',
        pointB: 'Old Damascus',
      },
      { dateIso: '2026-08-15', time: '00:30', fee: '155' },
      { dateIso: '2026-08-15', time: '00:03', fee: '155' },
      { dateIso: '2026-08-14', time: '23:21', fee: '240' },
    ]

    const added = mergeScannedOrders(existing, overlap, id)
    expect(added.filter((row) => row.cancelled !== true).map((row) => [row.timeText, row.feeText]))
      .toEqual([['00:30', '155']])
    expect(added.filter((row) => row.cancelled === true)).toMatchObject([
      { timeText: '00:59', feeText: '', included: false },
      { timeText: '00:49', feeText: '', included: false },
    ])
    expect(
      [...existing, ...added]
        .filter((row) => row.cancelled !== true && row.included !== false)
        .reduce((sum, row) => sum + Number(row.feeText), 0),
    ).toBe(1570)
  })

  it('keeps a genuine second delivery in the same minute, under its own key', () => {
    // Same minute, DIFFERENT fee — two real orders. `YAL-<date>-<HHMM>` alone gives them the same
    // key, and since provider_order_no is globally unique the second one silently vanishes.
    const both = mergeScannedOrders([], [scan('18:06', '235'), scan('18:06', '120')], id)
    expect(both).toHaveLength(2)
    expect(new Set(both.map((o) => o.providerOrderNo)).size).toBe(2)
  })

  it('treats same minute AND same fee as the overlap, not a second delivery', () => {
    const first = mergeScannedOrders([], [scan('18:06', '235')], id)
    expect(mergeScannedOrders(first, [scan('18:06', '235')], id)).toEqual([])
  })

  it('keeps two deliveries that share a minute AND a fee — a multiset, not a set', () => {
    // One page listing «١٢٠» twice means two deliveries cost 120. The old key walked an ordinal to
    // separate them; the merge now counts, which is the same answer without a derived key.
    const page = [scan('18:06', '120'), scan('18:06', '120')]
    expect(mergeScannedOrders([], page, id)).toHaveLength(2)
    // …and a second page re-showing only ONE of them consumes one and adds nothing.
    const held = mergeScannedOrders([], page, id)
    expect(mergeScannedOrders(held, [scan('18:06', '120')], id)).toEqual([])
  })

  it('dedupes on the minute and the fee even when the clock could not be read', () => {
    // The live path while the reader still refuses some clocks. Every row has time ''; the fee is
    // then the only thing separating them, and the count is what keeps both 235s.
    const noClock = [
      { dateIso: null, time: '', fee: '235' },
      { dateIso: null, time: '', fee: '120' },
      { dateIso: null, time: '', fee: '235' },
    ]
    const added = mergeScannedOrders([], noClock, id)
    expect(added.map((o) => o.feeText)).toEqual(['235', '120', '235'])
    expect(mergeScannedOrders(added, noClock, id)).toEqual([])
  })

  /**
   * `shift_orders.provider_order_no` is UNIQUE over the WHOLE TABLE — not per shift, not per driver,
   * not per day. Every key that was ever derived from what the screen shows therefore collides
   * between drivers and between days, and the loser is a 409 nobody can see or clear.
   */
  it('never derives the wire key from anything two orders could share', () => {
    const day = [scan('18:06', '120')]
    // Two bikes, same minute, same fee, same day — the exact case ten of them make weekly.
    const bikeOne = mergeScannedOrders([], day, id)
    const bikeTwo = mergeScannedOrders([], day, id)
    expect(bikeOne[0]!.providerOrderNo).not.toBe(bikeTwo[0]!.providerOrderNo)

    // And with no clock at all, where the fee used to become the key outright.
    const noClock = [{ dateIso: null, time: '', fee: '120' }]
    expect(mergeScannedOrders([], noClock, id)[0]!.providerOrderNo).not.toBe(
      mergeScannedOrders([], noClock, id)[0]!.providerOrderNo,
    )
  })

  it('gives every row a key the wire will accept', () => {
    // NOT NULL, min(1), max(64) — and generated, so an empty one is a bug rather than a typo.
    const rows = mergeScannedOrders([], [scan('18:06', '235'), { dateIso: null, time: '', fee: '120' }], () =>
      crypto.randomUUID(),
    )
    for (const r of rows) {
      expect(r.providerOrderNo.trim().length).toBeGreaterThan(0)
      expect(r.providerOrderNo.length).toBeLessThanOrEqual(64)
    }
  })

  it('carries the OCR fee as the D-3 baseline and defaults the mode to cash', () => {
    // The dashboard screen carries no pay mode. Cash is the safe default because it is the mode
    // that expects the driver to be HOLDING the money — the easiest claim to check.
    const [row] = mergeScannedOrders([], [scan('18:06', '235')], id)
    expect(row!.payMode).toBe('cash')
    expect(row!.feeOcrText).toBe('235')
    expect(row!.timeText).toBe('18:06')
    expect(row!.included).toBe(true)
  })

  it('re-reading a log page adds nothing', () => {
    const page = [
      { amount: '-47', time: '18:06' },
      { amount: '153', time: '17:42' },
    ]
    const first = mergeScannedMovements([], page, id)
    expect(first).toHaveLength(2)
    expect(mergeScannedMovements(first, page, id)).toEqual([])
  })

  it('keeps two identical amounts in one minute — both are real', () => {
    // A multiset merge, mirroring the server's. Matching by value alone would discard the second
    // of two genuine −24 cuts.
    const both = mergeScannedMovements([], [{ amount: '-24', time: '13:10' }, { amount: '-24', time: '13:10' }], id)
    expect(both).toHaveLength(2)
    // …and a page re-showing only ONE of them consumes one, leaving nothing new.
    expect(mergeScannedMovements(both, [{ amount: '-24', time: '13:10' }], id)).toEqual([])
  })

  it('keeps the sign — a withdrawal is not a credit', () => {
    const [row] = mergeScannedMovements([], [{ amount: '-1155.65', time: '18:33' }], id)
    expect(row!.amountText).toBe('-1155.65')
  })
})

/**
 * What the list does with the checkbox and the measured wallet amount — the two things that decide
 * money on the driver's own screen, and which must agree with the server's arithmetic exactly.
 */
describe('the live preview of the operations list', () => {
  const base = { floatText: '0', topupText: '0' }

  it('degrades to EXACTLY today’s arithmetic when nothing is measured', () => {
    // The property to protect, because it is what production actually looks like until the glyph
    // reader lands: no movements, no wallet amounts, every row checked.
    const orders = [row({ providerOrderNo: 'A', feeText: '5000' }), row({ providerOrderNo: 'B', payMode: 'electronic', feeText: '5000' })]
    const p = previewBr1({ ...base, orders, movements: [] })!
    expect(p.expectedCashText).toBe('5000.00')
    // BR2 takes the 20% out of the WALLET for every mode alike, so the cash order costs the wallet
    // 1,000 while putting nothing in: −1,000 + (5,000 − 1,000) = 3,000.
    expect(p.expectedWalletText).toBe('3000.00')
    expect(previewBr1({ ...base, orders })).toEqual(p)
  })

  it('drops an unchecked row from the equation', () => {
    const orders = [row({ providerOrderNo: 'A', feeText: '5000' }), row({ providerOrderNo: 'B', feeText: '5000', included: false })]
    expect(previewBr1({ ...base, orders })!.expectedCashText).toBe('5000.00')
  })

  it('splits a part-paid order between hand and wallet', () => {
    const orders = [row({ providerOrderNo: 'A', feeText: '5000', walletAmountText: '2000' })]
    const p = previewBr1({ ...base, orders })!
    expect(p.expectedCashText).toBe('3000.00')
    expect(p.expectedWalletText).toBe('1000.00')
  })

  it('keeps every payments-log movement out of the financial preview', () => {
    const orders = [row({ providerOrderNo: 'A', feeText: '5000' })]
    const movements = [
      { localId: '1', amountText: '-1000', timeText: '18:06', role: 'yalago_cut' as const },
      { localId: '2', amountText: '300', timeText: '09:24' },
      { localId: '3', amountText: '-50', timeText: '11:00' },
      { localId: '4', amountText: '900', timeText: '12:00', included: false },
    ]
    // The whole log is archival. Only the 1,000 Yallago cut derived from the order belongs here.
    expect(previewBr1({ ...base, orders, movements })!.expectedWalletText).toBe('-1000.00')
  })
})

/**
 * The driver can step back out of the closing package to add a delivery he forgot, so this list is
 * submitted more than once. Every row already on the server must be filtered out of the second
 * submit: `provider_order_no` is globally unique, and a 409 here shows up as "my orders failed" on
 * a list where nothing is wrong and no amount of retrying will clear it.
 */
describe('re-submitting the list after stepping back', () => {
  it('sends nothing when every row is already recorded', () => {
    const orders = [row({ providerOrderNo: 'YAL-1', recorded: true }), row({ providerOrderNo: 'YAL-2', recorded: true })]
    expect(unsentOrders(orders, orders)).toEqual([])
  })

  it('sends only the order added after coming back', () => {
    const sent = [row({ providerOrderNo: 'YAL-1', recorded: true })]
    const added = row({ providerOrderNo: 'YAL-2' })
    expect(unsentOrders([...sent, added], sent).map((o) => o.providerOrderNo)).toEqual(['YAL-2'])
  })

  it('still filters a row the server holds but that is not yet flagged', () => {
    // The window between the resumed list arriving and its rows being marked. The flag alone would
    // let these through, and every one of them would come back a 409.
    const onServer = [row({ providerOrderNo: 'YAL-1' })]
    expect(unsentOrders([row({ providerOrderNo: ' YAL-1 ' })], onServer)).toEqual([])
  })

  it('sends everything on a first submit, with nothing recorded yet', () => {
    const orders = [row({ providerOrderNo: 'YAL-1' }), row({ providerOrderNo: 'YAL-2' })]
    expect(unsentOrders(orders)).toHaveLength(2)
  })
})

/**
 * The DAY belongs in the merge key.
 *
 * «الطلبات الحديثة» scrolls back through previous days, so one screenshot routinely shows two of
 * them — and a delivery repeats its fee and its minute across days far more often than within one.
 */
describe('merging across days', () => {
  let n = 0
  const id = (): string => `day-${++n}`
  const on = (dateIso: string, time: string, fee: string) => ({ dateIso, time, fee })

  it(`keeps yesterday's 13:10 apart from today's`, () => {
    const both = mergeScannedOrders([], [on('2026-08-06', '13:10', '120'), on('2026-08-05', '13:10', '120')], id)
    expect(both).toHaveLength(2)
    expect(both.map((o) => o.dateText)).toEqual(['2026-08-06', '2026-08-05'])
  })

  it('still treats a genuine overlap as one row', () => {
    const first = mergeScannedOrders([], [on('2026-08-06', '13:10', '120')], id)
    expect(mergeScannedOrders(first, [on('2026-08-06', '13:10', '120')], id)).toEqual([])
  })

  it('does not merge a dated row into an undated one', () => {
    // A page whose header scrolled off gives no date. It is a DIFFERENT observation from a row
    // that has one, and collapsing them loses a delivery.
    const undated = mergeScannedOrders([], [{ dateIso: null, time: '13:10', fee: '120' }], id)
    expect(mergeScannedOrders(undated, [on('2026-08-06', '13:10', '120')], id)).toHaveLength(1)
  })
})

/**
 * The verdict a manager signs against.
 *
 * The scalar difference is blind to a pay-mode error — flip one order cash↔electronic and it stays
 * exactly 0 while cash is short by the fee and the wallet is over by it. The approval screen used
 * to render `balanced` alone, so the single case the equation exists to catch was the one it
 * showed in green with a live approve button.
 */
describe('reading the BR1 verdict', () => {
  it('is balanced when the total agrees', () => {
    expect(br1Verdict({ balanced: true, splitBalanced: true })).toEqual({ verdict: 'balanced', off: false })
  })

  it('no longer flags the equal-and-opposite swap — there is no pay mode left to contradict', () => {
    // This used to warn amber: the total is right but the money is in the wrong pocket. Knowing
    // that required a pay mode on every delivery, and the owner retired BR3 (decision 8). With the
    // input gone, `expectedCash` is computed as though everything were cash, so on a perfectly
    // honest shift where the driver took some electronically the legs disagree by exactly the
    // amount that moved — and the warning would fire on every correct close.
    expect(br1Verdict({ balanced: true, splitBalanced: false })).toEqual({ verdict: 'balanced', off: false })
  })

  it('a wrong total is wrong whatever the legs say', () => {
    expect(br1Verdict({ balanced: false, splitBalanced: true })).toEqual({ verdict: 'not_balanced', off: true })
    expect(br1Verdict({ balanced: false, splitBalanced: false })).toEqual({ verdict: 'not_balanced', off: true })
  })

  it('never reports a shift as clean while THE TOTAL is off', () => {
    // The invariant used to be "clean only if both the total and the split agree". The split is no
    // longer an input the system has — pay mode was retired (decision 8) — so the honest invariant
    // is about the one number that is still computed from something real.
    for (const balanced of [true, false]) {
      for (const splitBalanced of [true, false]) {
        expect(br1Verdict({ balanced, splitBalanced }).off).toBe(!balanced)
      }
    }
  })
})

describe('grouping money for the eye', () => {
  it('separates thousands and keeps the minor units', () => {
    expect(groupThousands('1500000.00')).toBe('1,500,000.00')
    expect(groupThousands('150000.00')).toBe('150,000.00')
    expect(groupThousands('999.99')).toBe('999.99')
  })

  it('keeps the sign, which is what tells money-out from money-in', () => {
    expect(groupThousands('-1155.65')).toBe('-1,155.65')
    expect(groupThousands('+87.50')).toBe('+87.50')
  })

  it('returns anything it does not recognise untouched, never a mangled figure', () => {
    // A half-typed field must not become something that looks like a different number.
    expect(groupThousands('')).toBe('')
    expect(groupThousands('abc')).toBe('abc')
    expect(groupThousands('1,500.00')).toBe('1,500.00')
  })
})

/**
 * Following the server while a shift is in flight.
 *
 * Reported from the field: «بالرغم من الغاء النوبة من عند المدير لم تنهى بشكل تلقائي عند السائق».
 */
describe('what the driver screen does when the shift changes under him', () => {
  it('ends the shift on the phone when the manager cancels it', () => {
    for (const current of ['orders', 'end', 'suspended'] as const) {
      expect(driverPhaseFor('cancelled', current)).toEqual({ gone: 'cancelled', phase: null })
    }
  })

  it('treats a manager force-close as finished, not as cancelled', () => {
    // Different outcomes for the driver: one means his work is void, the other that it is done.
    expect(driverPhaseFor('approved', 'orders')).toEqual({ gone: 'closed', phase: 'done' })
    expect(driverPhaseFor('week_locked', 'end')).toEqual({ gone: 'closed', phase: 'done' })
  })

  it('follows a suspend, and follows the resume back', () => {
    expect(driverPhaseFor('suspended', 'orders').phase).toBe('suspended')
    expect(driverPhaseFor('suspended', 'end').phase).toBe('suspended')
    expect(driverPhaseFor('open', 'suspended').phase).toBe('orders')
  })

  it('NEVER drags him backwards out of the screen he is working in', () => {
    // The server says `open` for the whole close: he moves himself from the running screen to the
    // closing package, and a poll that "corrected" him would throw away everything he had typed.
    expect(driverPhaseFor('open', 'end').phase).toBe(null)
    expect(driverPhaseFor('open', 'orders').phase).toBe(null)
    expect(driverPhaseFor('draft', 'orders').phase).toBe(null)
  })

  it('moves to the done screen once the close is actually submitted', () => {
    expect(driverPhaseFor('pending_review', 'end').phase).toBe('done')
    // …but a shift already showing done is left alone rather than re-announced.
    expect(driverPhaseFor('pending_review', 'done').phase).toBe(null)
  })
})
