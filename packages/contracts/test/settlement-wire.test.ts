import { describe, expect, it } from 'vitest'
import {
  approveCloseRequest,
  fixedSettlementConfirmationSchema,
  forceCloseRequest,
  shiftSettlementViewSchema,
} from '../src/wire.ts'

const HASH = 'a'.repeat(64)

describe('fixed settlement wire contract', () => {
  it('keeps every response amount as decimal text', () => {
    const parsed = shiftSettlementViewSchema.parse({
      policyCode: 'fixed_40_cash_close_v1',
      driverRateBps: 4_000,
      deliveryFeeTotal: '100000.00',
      fixedDriverShare: '40000.00',
      manualDriverShare: '0.00',
      grossDriverShare: '40000.00',
      cashDeductionTotal: '0.00',
      baseDriverShare: '40000.00',
      expectedTotal: '230000.00',
      actualCash: '240000.00',
      actualWallet: '-10000.00',
      actualTotal: '230000.00',
      variance: '0.00',
      varianceDirection: 'balanced',
      finalEmployeeCash: '40000.00',
      walletToOffice: '-10000.00',
      cashToOffice: '200000.00',
      walletAction: 'fund',
      walletAmount: '10000.00',
      cashAction: 'collect',
      cashAmount: '200000.00',
      settlementHash: HASH,
    })
    expect(parsed.actualWallet).toBe('-10000.00')
    expect(typeof parsed.actualWallet).toBe('string')
  })

  it('parses an old approve payload but leaves explicit confirmation enforcement to the service', () => {
    const parsed = approveCloseRequest.parse({ reviewedOrdersHash: 'orders' })
    expect(parsed.payShareNow).toBeUndefined()
    expect(parsed.reviewedSettlementHash).toBeUndefined()
    expect(parsed.walletTransferConfirmed).toBe(false)
    expect(parsed.cashSettlementConfirmed).toBe(false)
  })

  it('offers a strict confirmation schema for the fixed-policy approval path', () => {
    expect(
      fixedSettlementConfirmationSchema.parse({
        reviewedSettlementHash: HASH,
        walletTransferConfirmed: true,
        cashSettlementConfirmed: true,
      }),
    ).toMatchObject({ reviewedSettlementHash: HASH, varianceReason: null })
    expect(() =>
      fixedSettlementConfirmationSchema.parse({
        reviewedSettlementHash: HASH,
        walletTransferConfirmed: false,
        cashSettlementConfirmed: true,
      }),
    ).toThrow()
  })

  it('separates boundary preparation from the confirmed force-close', () => {
    expect(() =>
      forceCloseRequest.parse({
        reason: 'verified',
        reviewedSettlementHash: HASH,
        walletTransferConfirmed: true,
        cashSettlementConfirmed: true,
      }),
    ).toThrow()
    expect(() =>
      forceCloseRequest.parse({
        reason: 'verified',
        cashDeclared: '100.00',
        walletDeclared: '20.00',
        reviewedSettlementHash: HASH,
      }),
    ).toThrow()
    expect(
      forceCloseRequest.parse({
        prepareOnly: true,
        reason: 'verified',
        cashDeclared: '100.00',
        walletDeclared: '20.00',
      }),
    ).toMatchObject({ prepareOnly: true, cashDeclared: 10_000n, walletDeclared: 2_000n })
    expect(
      forceCloseRequest.parse({
        reason: 'verified',
        cashDeclared: '100.00',
        walletDeclared: '20.00',
        reviewedSettlementHash: HASH,
        walletTransferConfirmed: true,
        cashSettlementConfirmed: true,
      }),
    ).toMatchObject({ walletTransferConfirmed: true, cashSettlementConfirmed: true })
  })
})
