import { describe, expect, it } from 'vitest'
import type { CloseDraftAttachment, CloseDraftView } from '@ash/client'
import {
  isStaleCloseDraftView,
  ownsPendingCloseDraftRead,
  preservePendingCloseDraftReads,
} from '../src/close-draft-revision.ts'
import {
  closeDraftSaveNotice,
  ownsCloseDraftRefresh,
  rebaseCloseDraft,
  rebaseStoredCloseDraft,
  resolveCloseDraftMergeConflict,
} from '../src/screens/Shift.tsx'

const read = (readId: string, status: 'running' | 'complete' | 'failed', attempts = 1) => ({
  readId,
  status,
  field: 'orders' as const,
  failure: status === 'failed' ? 'timeout' as const : null,
  attempts,
})

const attachment = (
  attachmentToken: string,
  attachmentRead: CloseDraftAttachment['read'],
): CloseDraftAttachment => ({
  package: 'end',
  slot: 'dashboard',
  mediaId: `media-${attachmentToken}`,
  attachmentToken,
  read: attachmentRead,
})

const view = (
  revision: number,
  canonicalAttachment: CloseDraftAttachment,
): CloseDraftView => ({
  shiftId: 'shift-1',
  revision,
  draftHash: `hash-${revision}`,
  updatedAt: '2026-08-26T00:00:00.000Z',
  restored: false,
  figures: {
    odometerKm: null,
    odometerKmOcr: null,
    odometerAnomalyConfirmed: false,
    batteryPercent: null,
    cashDeclared: null,
    walletDeclared: null,
    walletDeclaredOcr: null,
  },
  attachments: [canonicalAttachment],
  operations: { orders: [], cashDeductions: [], movements: [] },
  submittedAt: null,
})

const draftWith = (revision: number, currentAttachment: CloseDraftAttachment) => ({
  closeDraftRevision: revision,
  closeDraftAttachments: { dashboard: currentAttachment },
  closeDraftRestored: true,
  persistedCashDeclared: null,
  persistedWalletDeclared: null,
  persistedOdometerKm: null,
  persistedOdometerAnomalyConfirmed: false,
  cash: '',
  wallet: '',
  walletHumanEdited: false,
  odo: '',
  odoConfirmed: false,
  dashboardPages: 1,
  logPages: 1,
  orders: [],
  cashDeductions: [],
  movements: [],
})

const manualOrder = (clientKey: string, providerOrderNo: string, fee = '100.00') => ({
  clientKey,
  providerOrderNo,
  payMode: 'cash' as const,
  fee,
  feeOcr: null,
  feeRefused: false,
  reviewRequired: true,
  reviewReasons: ['manual'] as never,
  included: false,
  occurredMinute: null,
  occurredDate: '2026-08-30',
  pointA: null,
  pointB: null,
  source: 'manual' as const,
  readId: null,
  observationId: null,
  rowIndex: null,
  dateSection: null,
  evidence: null,
  sightings: [],
  windowBasis: null,
  position: null,
})

const savedDraft = (operations: unknown, base?: { revision: number; draftHash: string }) => ({
  version: 2,
  ownerDriverId: 'driver-1', shiftId: 'shift-1', savedAt: 1, expiresAt: 9999999999999,
  fingerprint: 'saved', ...base && { baseRevision: base.revision, baseDraftHash: base.draftHash },
  persistedCashDeclared: null, persistedWalletDeclared: null, persistedOdometerKm: null,
  persistedOdometerAnomalyConfirmed: false,
  cash: '', wallet: '', walletOcr: null, walletHumanEdited: false,
  odo: '', odoOcr: null, odoAiAuthoritative: false, odoHumanEdited: false, odoConfirmed: false,
  operations,
})

describe('close-draft response ordering', () => {
  it('shows conflict choices even when no transport save failed', () => {
    expect(closeDraftSaveNotice(false, false, true)).toBe('conflict')
    expect(closeDraftSaveNotice(false, false, false)).toBe('saving')
    expect(closeDraftSaveNotice(false, true, false)).toBe('failed')
    expect(closeDraftSaveNotice(true, false, false)).toBe('saved')
  })

  it('rejects a conflict refresh after the active shift changes', () => {
    expect(ownsCloseDraftRefresh('shift-1', 'shift-1', 'shift-1')).toBe(true)
    expect(ownsCloseDraftRefresh('shift-2', 'shift-1', 'shift-1')).toBe(false)
    expect(ownsCloseDraftRefresh('shift-1', 'shift-1', 'shift-2')).toBe(false)
    expect(ownsCloseDraftRefresh(null, 'shift-1', 'shift-1')).toBe(false)
  })

  it('keeps the exact newer state object when an older response finishes late', () => {
    const latestSnapshot = { revision: 12 }
    const current = {
      closeDraftRevision: 12,
      closeDraftMergeConflict: true,
      closeDraftConflictCanonical: latestSnapshot,
      marker: 'new attachment and rows',
    }
    const lateResponse = { revision: 11 }

    // The stale guard runs before rebase reads any other draft/view property. This deliberately
    // minimal fixture proves a late response is a no-op, not merely an overlay of some local fields.
    expect(rebaseCloseDraft(current as never, lateResponse as never)).toBe(current)
    expect(current.closeDraftConflictCanonical).toBe(latestSnapshot)
  })

  it('accepts an initial, equal or newer revision and rejects only a rewind', () => {
    expect(isStaleCloseDraftView(null, 1)).toBe(false)
    expect(isStaleCloseDraftView(7, 7)).toBe(false)
    expect(isStaleCloseDraftView(7, 8)).toBe(false)
    expect(isStaleCloseDraftView(7, 6)).toBe(true)
  })

  it('does not invent a scalar conflict for equivalent money formatting', () => {
    const canonical = view(8, attachment('token-1', null))
    canonical.figures.cashDeclared = '600.00'
    canonical.figures.walletDeclared = '700.00'
    const current = {
      ...draftWith(7, attachment('token-1', null)),
      persistedCashDeclared: '500.00',
      persistedWalletDeclared: '650.00',
      cash: '500',
      wallet: '650.0',
    }

    const rebased = rebaseCloseDraft(current as never, canonical)
    expect(rebased.cash).toBe('600.00')
    expect(rebased.wallet).toBe('700.00')
    expect(rebased.closeDraftMergeConflict).toBe(false)
  })

  it('takes the first canonical row set without overlaying transient already-YAL state rows', () => {
    const providerOrderNo = 'YAL-903d7b56dcf5122968608a5154db16ce'
    const canonical = view(20, attachment('token-1', read('server-read', 'complete')))
    canonical.operations.orders.push({
      clientKey: 'orders:c1270421415835b2b13473b43ccf967e',
      providerOrderNo,
      payMode: 'cash',
      fee: '415.00',
      feeOcr: '415.00',
      feeRefused: false,
      reviewRequired: true,
      reviewReasons: ['missing_time'],
      included: false,
      occurredMinute: null,
      occurredDate: '2026-08-30',
      pointA: null,
      pointB: null,
      source: 'cloud_ocr',
      readId: 'server-read',
      observationId: 'observation-1',
      rowIndex: 6,
      dateSection: '2026-08-30',
      evidence: { mediaId: 'media-token-1', attachmentToken: 'token-1', slot: 'dashboard' },
      sightings: [{
        readId: 'server-read',
        observationId: 'observation-1',
        rowIndex: 6,
        dateSection: '2026-08-30',
        evidence: { mediaId: 'media-token-1', attachmentToken: 'token-1', slot: 'dashboard' },
      }],
      windowBasis: null,
      position: null,
    })
    const current = {
      ...draftWith(0, attachment('token-1', null)),
      closeDraftRevision: null,
      orders: [{
        localId: `already-${providerOrderNo}`,
        providerOrderNo,
        payMode: 'cash',
        feeText: '415.00',
        timeText: '',
        dateText: '2026-08-30',
        included: true,
        recorded: true,
      }],
    }

    const rebased = rebaseCloseDraft(current as never, canonical)
    expect(rebased.orders).toHaveLength(1)
    expect(rebased.orders[0]).toMatchObject({
      localId: 'orders:c1270421415835b2b13473b43ccf967e',
      providerOrderNo,
      draftSource: 'cloud_ocr',
    })
    expect(rebased.orders.some((row) => row.localId.startsWith('already-'))).toBe(false)
  })

  it('unions A+B without letting a stale full-replacement snapshot delete newer canonical work', () => {
    const canonical = view(8, attachment('token-1', null))
    canonical.operations.orders.push(manualOrder('server-new', 'YAL-new'))
    const saved = savedDraft({
      manualOrders: [manualOrder('phone-old', 'YAL-old')],
      manualCashDeductions: [], manualMovements: [], rowEdits: [],
    }, { revision: 7, draftHash: 'hash-7' })

    const rebased = rebaseStoredCloseDraft(
      draftWith(7, attachment('token-1', null)) as never,
      canonical,
      saved as never,
    )
    expect(rebased.orders.map((row) => row.clientKey)).toEqual(['server-new', 'phone-old'])
  })

  it('uses server-wins union for an autosave conflict and preserves both devices additions', () => {
    const canonical = view(8, attachment('token-1', null))
    canonical.operations.orders.push(manualOrder('device-b', 'YAL-b', '200.00'))
    const current = {
      ...draftWith(7, attachment('token-1', null)),
      orders: [{
        localId: 'device-a', clientKey: 'device-a', draftSource: 'manual',
        providerOrderNo: 'YAL-a', payMode: 'cash', feeText: '100.00', timeText: '',
        dateText: '2026-08-30', included: false,
      }],
    }
    const rebased = rebaseCloseDraft(current as never, canonical)
    expect(rebased.orders.map((row) => row.clientKey)).toEqual(['device-b', 'device-a'])
  })

  it('retains the visible phone value while adopting the newer conflict revision', () => {
    const canonical = view(8, attachment('token-1', null))
    canonical.operations.orders.push(manualOrder('shared', 'YAL-shared', '250.00'))
    const current = {
      ...draftWith(7, attachment('token-1', null)),
      orders: [{
        localId: 'shared', clientKey: 'shared', draftSource: 'manual',
        providerOrderNo: 'YAL-shared', payMode: 'cash', feeText: '100.00', timeText: '',
        dateText: '2026-08-30', included: false,
      }],
    }
    const rebased = rebaseCloseDraft(current as never, canonical)
    expect(rebased.orders).toHaveLength(1)
    expect(rebased.orders[0]?.feeText).toBe('100.00')
    expect(rebased.closeDraftRevision).toBe(8)
    expect(rebased.closeDraftMergeConflict).toBe(true)
    expect(rebased.closeDraftConflictCanonical).toBe(canonical)
  })

  it('requires an explicit choice and preserves disjoint additions whichever side wins', () => {
    const canonical = view(8, attachment('token-1', null))
    canonical.figures.cashDeclared = '80.00'
    canonical.operations.orders.push(
      manualOrder('shared', 'YAL-shared', '250.00'),
      manualOrder('server-only', 'YAL-server', '300.00'),
    )
    const current = {
      ...draftWith(7, attachment('token-1', null)),
      closeDraftMergeConflict: false,
      closeDraftConflictCanonical: null,
      persistedCashDeclared: '50.00',
      cash: '100.00',
      orders: [
        {
          localId: 'shared', clientKey: 'shared', draftSource: 'manual',
          providerOrderNo: 'YAL-shared', payMode: 'cash', feeText: '100.00',
          persistedFeeText: '50.00', timeText: '', persistedTimeText: '',
          dateText: '2026-08-30', persistedDateText: '2026-08-30', included: false,
        },
        {
          localId: 'phone-only', clientKey: 'phone-only', draftSource: 'manual',
          providerOrderNo: 'YAL-phone', payMode: 'cash', feeText: '75.00', timeText: '',
          dateText: '2026-08-30', included: false,
        },
      ],
    }
    const conflicted = rebaseCloseDraft(current as never, canonical)
    expect(conflicted.closeDraftMergeConflict).toBe(true)
    expect(conflicted.cash).toBe('100.00')
    expect(conflicted.orders.map((row) => row.clientKey)).toEqual([
      'shared', 'server-only', 'phone-only',
    ])

    const phone = resolveCloseDraftMergeConflict(conflicted, 'phone')
    expect(phone.closeDraftMergeConflict).toBe(false)
    expect(phone.closeDraftConflictCanonical).toBeNull()
    expect(phone.cash).toBe('100.00')
    expect(phone.orders.find((row) => row.clientKey === 'shared')?.feeText).toBe('100.00')

    const server = resolveCloseDraftMergeConflict(conflicted, 'server')
    expect(server.closeDraftMergeConflict).toBe(false)
    expect(server.closeDraftConflictCanonical).toBeNull()
    expect(server.cash).toBe('80.00')
    expect(server.orders.find((row) => row.clientKey === 'shared')?.feeText).toBe('250.00')
    expect(server.orders.map((row) => row.clientKey)).toEqual([
      'shared', 'server-only', 'phone-only',
    ])
  })

  it('advances the retained server choice when a newer canonical snapshot arrives', () => {
    const first = view(8, attachment('token-1', null))
    first.operations.orders.push(manualOrder('shared', 'YAL-shared', '250.00'))
    const current = {
      ...draftWith(7, attachment('token-1', null)),
      closeDraftMergeConflict: false,
      closeDraftConflictCanonical: null,
      orders: [{
        localId: 'shared', clientKey: 'shared', draftSource: 'manual',
        providerOrderNo: 'YAL-shared', payMode: 'cash', feeText: '100.00',
        persistedFeeText: '50.00', timeText: '', persistedTimeText: '',
        dateText: '2026-08-30', persistedDateText: '2026-08-30', included: false,
      }],
    }
    const conflicted = rebaseCloseDraft(current as never, first)

    const latest = view(9, attachment('token-1', null))
    latest.operations.orders.push(manualOrder('shared', 'YAL-shared', '300.00'))
    const advanced = rebaseCloseDraft(conflicted, latest)
    expect(advanced.closeDraftRevision).toBe(9)
    expect(advanced.closeDraftConflictCanonical).toBe(latest)
    expect(advanced.orders[0]?.feeText).toBe('100.00')

    const server = resolveCloseDraftMergeConflict(advanced, 'server')
    expect(server.closeDraftRevision).toBe(9)
    expect(server.orders[0]?.feeText).toBe('300.00')
  })

  it('accepts a successful PATCH response without misclassifying its higher revision as conflict', () => {
    const canonical = view(8, attachment('token-1', null))
    canonical.operations.orders.push(manualOrder('shared', 'YAL-shared', '500.00'))
    const current = {
      ...draftWith(7, attachment('token-1', null)),
      closeDraftMergeConflict: false,
      orders: [{
        localId: 'shared', clientKey: 'shared', draftSource: 'manual',
        providerOrderNo: 'YAL-shared', payMode: 'cash', feeText: '500', timeText: '',
        dateText: '2026-08-30', included: false,
      }],
    }
    const rebased = rebaseCloseDraft(current as never, canonical, false)
    expect(rebased.closeDraftRevision).toBe(8)
    expect(rebased.closeDraftMergeConflict).toBe(false)
    expect(rebased.orders[0]?.feeText).toBe('500.00')
  })

  it('treats legacy v2 as an unknown base and never re-seeds an already recovery artifact', () => {
    const providerOrderNo = 'YAL-legacy'
    const canonical = view(8, attachment('token-1', null))
    canonical.operations.orders.push({
      ...manualOrder('canonical-ocr', providerOrderNo, '415.00'),
      source: 'cloud_ocr', readId: 'read-1', observationId: 'observation-1', rowIndex: 0,
      evidence: { mediaId: 'm1', attachmentToken: 'token-1', slot: 'dashboard' },
      sightings: [{
        readId: 'read-1', observationId: 'observation-1', rowIndex: 0, dateSection: null,
        evidence: { mediaId: 'm1', attachmentToken: 'token-1', slot: 'dashboard' },
      }],
    })
    const saved = savedDraft({
      manualOrders: [{
        clientKey: `already-${providerOrderNo}`, providerOrderNo, payMode: 'cash', fee: '415',
        occurredMinute: null, occurredDate: '2026-08-30', pointA: null, pointB: null,
        source: 'manual',
      }],
      manualCashDeductions: [], manualMovements: [], rowEdits: [],
    })
    const rebased = rebaseStoredCloseDraft(
      draftWith(7, attachment('token-1', null)) as never,
      canonical,
      saved as never,
    )
    expect(rebased.orders).toHaveLength(1)
    expect(rebased.orders.some((row) => row.localId.startsWith('already-'))).toBe(false)
  })

  it('does not let read A erase read B ownership, then lets B apply', () => {
    const pendingA = 'pending-token-1-request-a'
    const pendingB = 'pending-token-1-request-b'
    const current = draftWith(7, attachment('token-1', read(pendingB, 'running')))

    // A finishes after the user has already retried. Its completion callback is no longer owner.
    const afterA = ownsPendingCloseDraftRead(
      current.closeDraftAttachments,
      'dashboard',
      'token-1',
      pendingA,
    )
      ? rebaseCloseDraft(
          current as never,
          view(8, attachment('token-1', read('server-read-a', 'complete'))),
        )
      : current
    expect(afterA).toBe(current)
    expect(afterA.closeDraftAttachments.dashboard?.read?.readId).toBe(pendingB)

    // B still owns the slot and can apply its terminal canonical result.
    const afterB = ownsPendingCloseDraftRead(
      afterA.closeDraftAttachments,
      'dashboard',
      'token-1',
      pendingB,
    )
      ? rebaseCloseDraft(
          afterA as never,
          view(8, attachment('token-1', read('server-read-b', 'complete', 2))),
        )
      : afterA
    expect(afterB.closeDraftAttachments.dashboard?.read).toMatchObject({
      readId: 'server-read-b',
      status: 'complete',
    })
  })

  it('keeps a pending request through a newer autosave revision', () => {
    const pendingB = read('pending-token-1-request-b', 'running')
    const current = draftWith(7, attachment('token-1', pendingB))
    const rebased = rebaseCloseDraft(
      current as never,
      view(8, attachment('token-1', null)),
    )

    expect(rebased.closeDraftRevision).toBe(8)
    expect(rebased.closeDraftAttachments.dashboard?.read).toEqual(pendingB)
  })

  it('lets a replacement token or a terminal result from the newer attempt supersede the marker', () => {
    const pending = { dashboard: attachment('token-1', read('pending-token-1-a', 'running')) }
    const replacement = { dashboard: attachment('token-2', null) }
    const terminal = { dashboard: attachment('token-1', read('server-read-a', 'failed', 2)) }

    expect(preservePendingCloseDraftReads(pending, replacement)).toBe(replacement)
    expect(preservePendingCloseDraftReads(pending, terminal)).toBe(terminal)
  })

  it('does not mistake the prior failed attempt in an autosave response for this retry', () => {
    const pendingRetry = {
      dashboard: attachment('token-1', read('pending-token-1-retry', 'running', 1)),
    }
    const priorFailure = {
      dashboard: attachment('token-1', read('server-read-prior', 'failed', 1)),
    }

    const merged = preservePendingCloseDraftReads(pendingRetry, priorFailure)
    expect(merged.dashboard?.read?.readId).toBe('pending-token-1-retry')
  })

  it('does not let an older same-token retry overwrite the newer local retry', () => {
    const pendingB = read('pending-token-1-request-b', 'running')
    const current = { dashboard: attachment('token-1', pendingB) }
    const lateA = { dashboard: attachment('token-1', read('server-read-a', 'running')) }

    const merged = preservePendingCloseDraftReads(current, lateA)
    expect(merged.dashboard?.read).toEqual(pendingB)
  })
})
