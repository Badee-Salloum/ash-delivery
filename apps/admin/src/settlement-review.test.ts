import { describe, expect, it } from 'vitest'
import type { ShiftSettlementView } from '@ash/client'
import {
  activeForcePreparation,
  closeApprovalRequest,
  forceCloseApprovalReady,
  forceCloseConfirmationReady,
  forceCloseFiguresComplete,
  forceClosePreparationReady,
  isKnownSettlementAction,
  settlementApprovalReady,
  settlementHasVariance,
  settlementVarianceMagnitude,
} from './settlement-review.ts'

const HASH = 'a'.repeat(64)

const settlement = (over: Partial<ShiftSettlementView> = {}): ShiftSettlementView => ({
  policyCode: 'fixed_40_cash_close_v1',
  driverRateBps: 4000,
  deliveryFeeTotal: '1000.00',
  fixedDriverShare: '400.00',
  manualDriverShare: '0.00',
  grossDriverShare: '400.00',
  cashDeductionTotal: '0.00',
  baseDriverShare: '400.00',
  expectedTotal: '1800.00',
  actualCash: '1300.00',
  actualWallet: '500.00',
  actualTotal: '1800.00',
  variance: '0.00',
  varianceDirection: 'balanced',
  finalEmployeeCash: '400.00',
  walletToOffice: '500.00',
  cashToOffice: '900.00',
  walletAction: 'collect',
  walletAmount: '500.00',
  cashAction: 'collect',
  cashAmount: '900.00',
  settlementHash: HASH,
  ...over,
})

describe('manager settlement confirmation', () => {
  it('activates a force preparation only for the current submitted boundary', () => {
    const old = { gate: 'close', decision: 'force_close_prepared', decidedAt: '2026-08-14T10:00:01.000Z', notes: 'old' }
    const current = { gate: 'close', decision: 'force_close_prepared', decidedAt: '2026-08-14T11:00:01.000Z', notes: 'current' }
    expect(activeForcePreparation('2026-08-14T11:00:00.000Z', [current, old])).toEqual(current)
    expect(activeForcePreparation('2026-08-14T10:30:00.000Z', [old])).toBeNull()
    expect(activeForcePreparation(null, [current])).toBeNull()
    expect(activeForcePreparation('2026-08-14T11:00:00.000Z', [
      { gate: 'close', decision: 'rephoto_requested', decidedAt: current.decidedAt, notes: null },
      current,
    ])).toBeNull()
  })

  it('requires both physical confirmations even when the variance is zero', () => {
    const s = settlement()
    expect(settlementApprovalReady(s, {
      walletTransferConfirmed: true,
      cashSettlementConfirmed: false,
      varianceReason: '',
    })).toBe(false)
    expect(settlementApprovalReady(s, {
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      varianceReason: '',
    })).toBe(true)
  })

  it.each([
    ['surplus', '25.00'],
    ['shortage', '-25.00'],
  ] as const)('requires a reason for a %s and trims it into the request', (direction, variance) => {
    const hash = (direction === 'surplus' ? 'b' : 'c').repeat(64)
    const s = settlement({ varianceDirection: direction, variance, settlementHash: hash })
    expect(settlementHasVariance(s)).toBe(true)
    expect(settlementApprovalReady(s, {
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      varianceReason: '   ',
    })).toBe(false)

    expect(closeApprovalRequest('orders-hash', s, {
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      varianceReason: '  counted with the employee  ',
    })).toEqual({
      reviewedOrdersHash: 'orders-hash',
      reviewedSettlementHash: hash,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      varianceReason: 'counted with the employee',
    })
  })

  it('presents surplus and shortage as labelled absolute magnitudes', () => {
    expect(settlementVarianceMagnitude(settlement({ varianceDirection: 'surplus', variance: '25.00' }))).toBe('25.00')
    expect(settlementVarianceMagnitude(settlement({ varianceDirection: 'shortage', variance: '-25.00' }))).toBe('25.00')
  })

  it('sends a null reason for a balanced settlement and rejects a missing snapshot hash', () => {
    const draft = { walletTransferConfirmed: true, cashSettlementConfirmed: true, varianceReason: 'ignored' }
    expect(closeApprovalRequest('orders-hash', settlement(), draft).varianceReason).toBeNull()
    expect(settlementApprovalReady(settlement({ settlementHash: '' }), draft)).toBe(false)
  })

  it('accepts only the wallet and cash directions the manager UI can explain', () => {
    expect(isKnownSettlementAction(settlement({ walletAction: 'fund', cashAction: 'pay' }))).toBe(true)
    expect(isKnownSettlementAction(settlement({ walletAction: 'none', cashAction: 'none' }))).toBe(true)
  })

  it('requires both actual figures and both physical confirmations for force-close', () => {
    expect(forceCloseFiguresComplete('', '')).toBe(false)
    expect(forceCloseConfirmationReady('', '', true, true)).toBe(false)
    expect(forceCloseFiguresComplete('100.00', '')).toBe(false)
    expect(forceCloseConfirmationReady('100.00', '', true, false)).toBe(false)
    expect(forceCloseConfirmationReady('100.00', '25.00', true, false)).toBe(false)
    expect(forceCloseConfirmationReady('100.00', '25.00', true, true)).toBe(true)
    expect(forceClosePreparationReady('100.00', '-25.00')).toBe(true)
    expect(forceClosePreparationReady('-100.00', '25.00')).toBe(false)
    expect(forceCloseFiguresComplete('-100.00', '25.00')).toBe(false)
  })

  it('blocks force-close until a valid, decision-complete settlement preview is loaded', () => {
    const preview = settlement({ settlementHash: 'f'.repeat(64) })
    expect(forceCloseApprovalReady('100.00', '25.00', null, true, true)).toBe(false)
    expect(forceCloseApprovalReady('100.00', '25.00', preview, false, true)).toBe(false)
    expect(forceCloseApprovalReady('100.', '25.00', preview, true, true)).toBe(false)
    expect(forceCloseApprovalReady('100.00', '25.00', preview, true, true)).toBe(true)
    expect(forceCloseApprovalReady('100.00', '-25.00', preview, true, true)).toBe(true)
  })
})
