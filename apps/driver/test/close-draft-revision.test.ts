import { describe, expect, it } from 'vitest'
import type { CloseDraftAttachment, CloseDraftView } from '@ash/client'
import {
  isStaleCloseDraftView,
  ownsPendingCloseDraftRead,
  preservePendingCloseDraftReads,
} from '../src/close-draft-revision.ts'
import { rebaseCloseDraft } from '../src/screens/Shift.tsx'

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

describe('close-draft response ordering', () => {
  it('keeps the exact newer state object when an older response finishes late', () => {
    const current = {
      closeDraftRevision: 12,
      marker: 'new attachment and rows',
    }
    const lateResponse = { revision: 11 }

    // The stale guard runs before rebase reads any other draft/view property. This deliberately
    // minimal fixture proves a late response is a no-op, not merely an overlay of some local fields.
    expect(rebaseCloseDraft(current as never, lateResponse as never)).toBe(current)
  })

  it('accepts an initial, equal or newer revision and rejects only a rewind', () => {
    expect(isStaleCloseDraftView(null, 1)).toBe(false)
    expect(isStaleCloseDraftView(7, 7)).toBe(false)
    expect(isStaleCloseDraftView(7, 8)).toBe(false)
    expect(isStaleCloseDraftView(7, 6)).toBe(true)
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
