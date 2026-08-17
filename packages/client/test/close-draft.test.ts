import { describe, expect, it } from 'vitest'
import type { CloseDraftPatch, CloseDraftRowEdit, CloseDraftView } from '../src/api.ts'
import {
  applyCloseDraftOperationsOverlay,
  closeDraftOperations,
  closeDraftOperationsPatch,
  closeOperationsSummary,
  operationDecisionState,
} from '../src/close-draft.ts'

const emptyView = (): CloseDraftView => ({
  shiftId: 'shift-1',
  revision: 4,
  draftHash: 'hash',
  updatedAt: '2026-08-16T01:00:00.000Z',
  restored: true,
  figures: {
    odometerKm: null,
    odometerKmOcr: null,
    odometerAnomalyConfirmed: false,
    batteryPercent: null,
    cashDeclared: null,
    walletDeclared: null,
    walletDeclaredOcr: null,
  },
  attachments: [],
  operations: { orders: [], cashDeductions: [], movements: [] },
  submittedAt: null,
})

describe('durable close-draft view model', () => {
  it('exposes only the server allowlist for human PATCH fields', () => {
    type Figures = NonNullable<CloseDraftPatch['figures']>
    type ForbiddenFigure = Extract<keyof Figures, 'walletDeclaredOcr' | 'odometerKmOcr' | 'batteryPercent'>
    type OrderEdit = Extract<CloseDraftRowEdit, { kind: 'order' }>
    type ForbiddenOrderEdit = Extract<keyof OrderEdit, 'providerOrderNo' | 'payMode' | 'pointA' | 'pointB'>
    const figuresAreStrict: ForbiddenFigure extends never ? true : false = true
    const orderEditsAreStrict: ForbiddenOrderEdit extends never ? true : false = true
    expect(figuresAreStrict).toBe(true)
    expect(orderEditsAreStrict).toBe(true)
  })

  it('counts unknown-time rows as pending, never as included', () => {
    const orders = [
      { localId: 'a', providerOrderNo: 'a', payMode: 'cash' as const, feeText: '100', included: true },
      {
        localId: 'b',
        providerOrderNo: 'b',
        payMode: 'cash' as const,
        feeText: '200',
        included: true,
        timeReviewRequired: true,
      },
      { localId: 'c', providerOrderNo: 'c', payMode: 'cash' as const, feeText: '', included: false },
    ]
    const summary = closeOperationsSummary(orders, [])

    expect(summary.orders).toMatchObject({ total: 3, included: 1, pending: 1, excluded: 1, missingAmount: 1 })
    expect(operationDecisionState(orders[1]!)).toBe('pending')
  })

  it('retains every overlapping sighting while adapting canonical rows for the phone', () => {
    const view = emptyView()
    view.operations.orders.push({
      clientKey: 'row-1',
      providerOrderNo: '',
      payMode: 'cash',
      fee: '220',
      feeOcr: '220',
      feeRefused: false,
      reviewRequired: false,
      included: true,
      occurredMinute: '01:18',
      occurredDate: '2026-08-16',
      pointA: null,
      pointB: null,
      source: 'cloud_ocr',
      readId: 'read-1',
      observationId: 'obs-1',
      rowIndex: 2,
      dateSection: '2026-08-16',
      evidence: { mediaId: 'media-1', attachmentToken: 'token-1', slot: 'dashboard' },
      sightings: [
        {
          readId: 'read-1',
          observationId: 'obs-1',
          rowIndex: 2,
          dateSection: '2026-08-16',
          evidence: { mediaId: 'media-1', attachmentToken: 'token-1', slot: 'dashboard' },
        },
        {
          readId: 'read-2',
          observationId: 'obs-2',
          rowIndex: 0,
          dateSection: '2026-08-16',
          evidence: { mediaId: 'media-2', attachmentToken: 'token-2', slot: 'dashboard_2' },
        },
      ],
      windowBasis: 'screen_position',
      position: {
        lowerInstant: '2026-08-16T01:17:00+03:00',
        upperInstant: '2026-08-16T01:19:00+03:00',
        anchorObservationIds: ['anchor-a', 'anchor-b'],
      },
    })

    const [row] = closeDraftOperations(view).orders
    expect(row).toMatchObject({
      localId: 'row-1',
      feeText: '220',
      timeText: '01:18',
      windowBasis: 'screen_position',
    })
    expect(row?.sightings).toHaveLength(2)
  })

  it('sends only a real human amount edit for OCR rows and never resends their time/window proof', () => {
    const view = emptyView()
    view.operations.orders.push({
      clientKey: 'row-1',
      providerOrderNo: 'provider-1',
      payMode: 'cash',
      fee: '220',
      feeOcr: '220',
      feeRefused: false,
      reviewRequired: false,
      included: true,
      occurredMinute: '01:18',
      occurredDate: '2026-08-16',
      pointA: 'A',
      pointB: 'B',
      source: 'cloud_ocr',
      readId: 'read-1',
      observationId: 'obs-1',
      rowIndex: 2,
      dateSection: '2026-08-16',
      evidence: { mediaId: 'media-1', attachmentToken: 'token-1', slot: 'dashboard' },
      windowBasis: 'printed_time',
      position: null,
    })
    const operations = closeDraftOperations(view)

    expect(closeDraftOperationsPatch(operations.orders, [], []).rowEdits).toEqual([])
    operations.orders[0]!.feeText = '225'
    expect(closeDraftOperationsPatch(operations.orders, [], []).rowEdits).toEqual([
      { clientKey: 'row-1', kind: 'order', fee: '225' },
    ])
  })

  it('never sends a client-authored inclusion decision for a manual row', () => {
    const patch = closeDraftOperationsPatch(
      [
        {
          localId: 'manual-1',
          providerOrderNo: '',
          payMode: 'cash',
          feeText: '100',
          included: true,
          draftSource: 'manual',
        },
      ],
      [],
      [],
    )
    expect(patch.manualOrders?.[0]).not.toHaveProperty('included')
  })

  it('rebases only saved human deltas over a newer conflict snapshot', () => {
    const view = emptyView()
    view.operations.orders.push({
      clientKey: 'ocr-row',
      providerOrderNo: 'provider-1',
      payMode: 'electronic',
      fee: '230',
      feeOcr: '230',
      feeRefused: false,
      reviewRequired: false,
      included: true,
      occurredMinute: '01:18',
      occurredDate: '2026-08-16',
      pointA: 'new A',
      pointB: 'new B',
      source: 'cloud_ocr',
      readId: 'read-1',
      observationId: 'obs-1',
      rowIndex: 1,
      dateSection: '2026-08-16',
      evidence: { mediaId: 'media-1', attachmentToken: 'token-1', slot: 'dashboard' },
      windowBasis: 'printed_time',
      position: null,
    })
    const canonical = closeDraftOperations(view)
    const restored = applyCloseDraftOperationsOverlay(canonical, {
      manualOrders: [{
        clientKey: 'manual-1',
        providerOrderNo: '',
        payMode: 'cash',
        fee: '100',
        occurredMinute: null,
        occurredDate: null,
        pointA: null,
        pointB: null,
        source: 'manual',
      }],
      manualCashDeductions: [],
      manualMovements: [],
      rowEdits: [
        { clientKey: 'ocr-row', kind: 'order', fee: '225' },
        { clientKey: 'withdrawn-ocr-row', kind: 'order', fee: '999' },
      ],
    })

    expect(restored.orders).toHaveLength(2)
    expect(restored.orders[0]).toMatchObject({
      clientKey: 'ocr-row',
      feeText: '225',
      persistedFeeText: '230',
      payMode: 'electronic',
      pointA: 'new A',
      observationId: 'obs-1',
    })
    expect(restored.orders.some((row) => row.clientKey === 'withdrawn-ocr-row')).toBe(false)
    expect(restored.orders[1]).toMatchObject({
      clientKey: 'manual-1',
      feeText: '100',
      draftSource: 'manual',
    })
  })
})
