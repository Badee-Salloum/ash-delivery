import { describe, expect, it } from 'vitest'
import {
  buildOrderDuplicateRevision,
  buildOrderTimingRevision,
  closeDraftReviewReasonLabel,
  closeWorkspaceApprovalReady,
  countAwaitingCloseBatteryReadings,
  deductionHasDashboardEvidenceOrigin,
  guardPhysicalSettlementConfirmations,
  orderHasDashboardEvidenceOrigin,
  orderNeedsAttention,
  positionEvidenceLabel,
  summarizeOrders,
} from './approval-workspace.ts'

describe('close approval workspace', () => {
  it('does not flag an accepted OCR row merely because AI read it', () => {
    expect(orderNeedsAttention({ fee: '155.00', source: 'ocr', feeOcr: '155.00', windowStatus: 'in_window' })).toBe(false)
    expect(orderNeedsAttention({ fee: '155.00', source: 'manual', windowStatus: 'in_window' })).toBe(false)
  })

  it.each([
    { fee: '155.00', included: false },
    { fee: '155.00', kind: 'manual' as const },
    { fee: '155.00', windowStatus: 'unknown' as const },
    { fee: '155.00', windowStatus: 'pre_open' as const },
    { fee: '155.00', windowStatus: 'post_close' as const },
    { fee: '155.00', feeOcr: '150.00' },
    { fee: '155.00', decisionReason: 'verified against screenshot' },
    { fee: '155.00', windowStatus: 'in_window' as const, windowBasis: 'screen_position' as const },
    { fee: '155.00', windowStatus: 'in_window' as const, closeDraftReviewReasons: ['cancelled_conflict'] as const },
  ])('flags a true exception: %#', (order) => {
    expect(orderNeedsAttention(order)).toBe(true)
  })

  it('shows positional evidence as an interval rather than a fabricated operation time', () => {
    expect(
      positionEvidenceLabel({
        lowerInstant: '2026-08-16T00:57',
        upperInstant: '2026-08-16T01:37',
      }),
    ).toBe('2026-08-16T00:57 → 2026-08-16T01:37')
    expect(positionEvidenceLabel({ lowerInstant: null, upperInstant: '2026-08-16T01:37' })).toBe(
      '… → 2026-08-16T01:37',
    )
    expect(positionEvidenceLabel(null)).toBeNull()
  })

  it('keeps included, excluded and unresolved counts and totals explicit', () => {
    expect(
      summarizeOrders([
        { fee: '155.00', included: true, windowStatus: 'in_window' },
        { fee: '240.00', included: true, windowStatus: 'unknown' },
        { fee: '370.00', included: false, windowStatus: 'post_close' },
      ]),
    ).toEqual({
      included: { count: 1, total: '155.00' },
      excluded: { count: 1, total: '370.00' },
      unresolved: { count: 1, total: '240.00' },
    })
  })

  it('uses mutually exclusive summary buckets even when an unknown row is currently included', () => {
    const summary = summarizeOrders([{ fee: '225.00', included: true, windowStatus: 'unknown' }])
    expect(summary).toEqual({
      included: { count: 0, total: '0.00' },
      excluded: { count: 0, total: '0.00' },
      unresolved: { count: 1, total: '225.00' },
    })
  })

  it('keeps an exact-time reader conflict in the unresolved bucket until a manager decides it', () => {
    expect(
      summarizeOrders([{
        fee: '220.00',
        included: false,
        windowStatus: 'in_window',
        closeDraftReviewReasons: ['cancelled_conflict'],
      }]),
    ).toEqual({
      included: { count: 0, total: '0.00' },
      excluded: { count: 0, total: '0.00' },
      unresolved: { count: 1, total: '220.00' },
    })
    expect(closeDraftReviewReasonLabel('cancelled_conflict', 'ar')).toBe('تعارض حول إلغاء الطلب')
    expect(closeDraftReviewReasonLabel('evidence_removed', 'en')).toBe('The row lost its last supporting image')
    expect(closeDraftReviewReasonLabel('human_money_edit', 'en')).toBe('Driver-entered amount needs approval')
  })

  it('moves an audited unknown-time decision into its selected financial bucket', () => {
    expect(
      summarizeOrders([
        {
          fee: '225.00',
          included: true,
          windowStatus: 'unknown',
          decisionReason: 'included after checking the original image',
        },
        {
          fee: '155.00',
          included: false,
          windowStatus: 'unknown',
          decisionReason: 'duplicate of the 00:03 order',
        },
      ]),
    ).toEqual({
      included: { count: 1, total: '225.00' },
      excluded: { count: 1, total: '155.00' },
      unresolved: { count: 0, total: '0.00' },
    })
  })

  it('blocks close only for end-pack readings explicitly handed to the manager and still empty', () => {
    expect(
      countAwaitingCloseBatteryReadings([
        { unavailable: true, percent: null },
        { unavailable: true, percent: 38 },
        { unavailable: false, percent: null },
        { percent: 71 },
      ]),
    ).toBe(1)
  })

  it('corrects row 6 atomically while preserving its duplicate exclusion', () => {
    expect(buildOrderTimingRevision(false, '2026-08-15', '00:03', 'duplicate')).toEqual({
      occurredDate: '2026-08-15',
      occurredMinute: '00:03',
      included: false,
    })
  })

  it('does not re-save a suspect OCR clock when only marking the row as duplicate', () => {
    expect(buildOrderDuplicateRevision('2026-08-15', '11:03', '2026-08-15', '11:03')).toEqual({ included: false })
    expect(buildOrderDuplicateRevision('2026-08-15', '11:03', '2026-08-15', '00:03')).toEqual({
      included: false,
      occurredDate: '2026-08-15',
      occurredMinute: '00:03',
    })
  })

  it('corrects and includes row 7 atomically after its verified midnight time', () => {
    expect(buildOrderTimingRevision(false, '2026-08-15', '00:30', 'include')).toEqual({
      occurredDate: '2026-08-15',
      occurredMinute: '00:30',
      included: true,
    })
  })

  it('never lets a timing-only save overturn the current inclusion decision', () => {
    expect(buildOrderTimingRevision(false, '2026-08-15', '00:03', 'preserve').included).toBe(false)
    expect(buildOrderTimingRevision(true, '2026-08-15', '00:30', 'preserve').included).toBe(true)
  })

  it('offers stored-image retry for refused dashboard rows but not manager/manual operations', () => {
    expect(orderHasDashboardEvidenceOrigin({ kind: 'yallago', decisionReason: null })).toBe(true)
    expect(orderHasDashboardEvidenceOrigin({ kind: 'manual', decisionReason: null })).toBe(false)
    expect(orderHasDashboardEvidenceOrigin({ kind: 'yallago', decisionReason: 'manager_manual_entry' })).toBe(false)

    // A refused deduction is persisted as manual, but its deterministic dashboard key survives.
    expect(deductionHasDashboardEvidenceOrigin({ source: 'manual', operationKey: 'recent-orders:abc123' })).toBe(true)
    expect(deductionHasDashboardEvidenceOrigin({ source: 'manual', operationKey: 'legacy:typed-negative' })).toBe(false)
    expect(deductionHasDashboardEvidenceOrigin({ source: 'ocr', operationKey: 'legacy:old-ocr' })).toBe(true)
  })

  it('blocks the close CTA while a copied AI timing draft is not audited yet', () => {
    const ready = {
      settlementReady: true,
      unresolvedOperationCount: 0,
      managerBatteryReadingCount: 0,
      refreshing: false,
    }
    expect(closeWorkspaceApprovalReady({ ...ready, pendingTimingDraftCount: 0 })).toBe(true)
    expect(closeWorkspaceApprovalReady({ ...ready, pendingTimingDraftCount: 1 })).toBe(false)
  })

  it('invalidates both physical handover confirmations while an unknown-time operation is unresolved', () => {
    expect(
      guardPhysicalSettlementConfirmations(1, {
        walletTransferConfirmed: true,
        cashSettlementConfirmed: true,
      }),
    ).toEqual({
      allowed: false,
      walletTransferConfirmed: false,
      cashSettlementConfirmed: false,
    })
  })

  it('preserves the current handover confirmations after every unknown-time operation is resolved', () => {
    expect(
      guardPhysicalSettlementConfirmations(0, {
        walletTransferConfirmed: true,
        cashSettlementConfirmed: false,
      }),
    ).toEqual({
      allowed: true,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: false,
    })
  })

  it('summarizes the incident as six included orders totalling 1,570 and one excluded duplicate', () => {
    expect(
      summarizeOrders([
        { fee: '370.00', included: true, windowStatus: 'in_window' },
        { fee: '425.00', included: true, windowStatus: 'in_window' },
        { fee: '225.00', included: true, windowStatus: 'in_window' },
        { fee: '240.00', included: true, windowStatus: 'in_window' },
        { fee: '155.00', included: true, windowStatus: 'in_window' },
        { fee: '155.00', included: false, windowStatus: 'in_window' },
        { fee: '155.00', included: true, windowStatus: 'in_window' },
      ]),
    ).toEqual({
      included: { count: 6, total: '1570.00' },
      excluded: { count: 1, total: '155.00' },
      unresolved: { count: 0, total: '0.00' },
    })
  })
})
