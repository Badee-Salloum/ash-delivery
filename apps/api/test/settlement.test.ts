import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { minor } from '@ash/domain'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'
import {
  SYSTEM_SHORTAGE_RECEIVABLE_REASON_NOT_PROVIDED,
  SYSTEM_VARIANCE_REASON_NOT_PROVIDED,
} from '../src/shifts.service.ts'

/** HTTP acceptance tests for the fixed-40 cash-close policy. */
let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>
type Settlement = {
  policyCode: 'fixed_40_cash_close_v2_receivable'
  driverRateBps: 4000
  deliveryFeeTotal: string
  fixedDriverShare: string
  manualDriverShare: string
  grossDriverShare: string
  cashDeductionTotal: string
  baseDriverShare: string
  expectedTotal: string
  actualCash: string
  actualWallet: string
  actualTotal: string
  variance: string
  varianceDirection: 'surplus' | 'shortage' | 'balanced'
  finalEmployeeCash: string
  cashClaimToOffice: string
  walletClaimToOffice: string
  cashReceivableDeferred: string
  walletReceivableDeferred: string
  maximumCashShortageReceivable: string
  cashShortageReceivable: string
  walletToOffice: string
  cashToOffice: string
  walletAction: 'collect' | 'fund' | 'none'
  walletAmount: string
  cashAction: 'collect' | 'pay' | 'none'
  cashAmount: string
  settlementHash: string
}

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const post = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Payload): Promise<LightMyRequestResponse> =>
  url.endsWith('/end-package')
    ? await h.submitEndPackage(token, url.split('/')[2]!, payload)
    : await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

interface ShiftOptions {
  actualCash?: number
  actualWallet?: number
  deduction?: number
  manual?: { fee: number; driverShare: number; companyShare: number }
  archivedPayment?: number
}

async function setCanonicalFinancialFixture(
  driver: string,
  shiftId: string,
  deduction: number | undefined,
): Promise<void> {
  const current = await get(driver, `/shifts/${shiftId}/close-draft`)
  expect(current.statusCode, current.body).toBe(200)
  const draft = current.json() as { revision: number }
  const patched = await h.app.inject({
    method: 'PATCH',
    url: `/shifts/${shiftId}/close-draft`,
    headers: { cookie: h.cookie(driver) },
    payload: {
      expectedRevision: draft.revision,
      operations: {
        manualOrders: [{
          clientKey: `settlement-order-${shiftId}`,
          providerOrderNo: 'YAL-1',
          payMode: 'cash',
          fee: sypStr(10_000),
          occurredDate: '2026-07-21',
          occurredMinute: '08:00',
          pointA: 'A',
          pointB: 'B',
        }],
        manualCashDeductions: deduction === undefined ? [] : [{
          clientKey: `settlement-deduction-${shiftId}`,
          operationKey: `settlement-deduction-${shiftId}`,
          amount: sypStr(deduction),
          occurredDate: '2026-07-21',
          occurredMinute: '08:00',
          pointA: 'A',
          pointB: 'B',
        }],
      },
    },
  })
  expect(patched.statusCode, patched.body).toBe(200)
}

/**
 * Base case: float 10,000 + wallet top-up 5,000 + one 10,000 cash Yallago delivery.
 * Expected cash is 20,000, expected wallet is 3,000, and fixed share is 4,000.
 */
async function pendingShift(options: ShiftOptions = {}): Promise<{
  driver: string
  manager: string
  shiftId: string
  reviewHash: string
}> {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')
  const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })
  expect(created.statusCode, created.body).toBe(201)
  const shiftId = created.json().id as string

  await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
  expect((await put(driver, `/shifts/${shiftId}/start-package`, {
    odometerKm: 1_000,
    batteryPercent: 90,
  })).statusCode).toBe(200)
  expect((await post(manager, `/shifts/${shiftId}/approve-open`, {
    floatTranches: [sypStr(10_000)],
    topupTranches: [sypStr(5_000)],
  })).statusCode).toBe(200)

  if (options.manual) {
    const manual = options.manual
    const added = await post(manager, `/shifts/${shiftId}/orders/manual`, {
      providerOrderNo: 'MAN-1',
      payMode: 'cash',
      fee: sypStr(manual.fee),
      kind: 'manual',
      driverShare: sypStr(manual.driverShare),
      companyShare: sypStr(manual.companyShare),
      notes: 'manager-priced branch delivery',
      points: [
        { role: 'start', label: 'A', lat: null, lng: null },
        { role: 'end', label: 'B', lat: null, lng: null },
      ],
    })
    expect(added.statusCode, added.body).toBe(201)
  }

  await setCanonicalFinancialFixture(driver, shiftId, options.deduction)

  if (options.archivedPayment !== undefined) {
    await h.deps.movements.merge(
      shiftId,
      [{ amount: minor(BigInt(options.archivedPayment) * 100n), occurredMinute: '08:00' }],
      'u-d1',
    )
  }

  for (const slot of ['dashboard', 'wallet', 'odometer']) {
    await h.uploadPhoto(driver, shiftId, 'end', slot)
  }
  const expectedCash = 20_000 + (options.manual?.fee ?? 0) - (options.deduction ?? 0)
  const submitted = await put(driver, `/shifts/${shiftId}/end-package`, {
    odometerKm: 1_040,
    batteryPercent: null,
    cashDeclared: sypStr(options.actualCash ?? expectedCash),
    walletDeclared: sypStr(options.actualWallet ?? 3_000),
  })
  expect(submitted.statusCode, submitted.body).toBe(200)
  expect(submitted.json().state).toBe('pending_review')

  const unresolved = await get(manager, `/shifts/${shiftId}/review`)
  expect(unresolved.statusCode, unresolved.body).toBe(200)
  const deductionRows = unresolved.json().cashDeductions as Array<{ id: string }>
  const verified = await post(manager, `/shifts/${shiftId}/operations/revise`, {
    orders: [{
      providerOrderNo: 'YAL-1',
      included: true,
      occurredDate: '2026-07-21',
      occurredMinute: '08:00',
      reason: 'manager verified the explicit settlement fixture',
    }],
    cashDeductions: options.deduction === undefined ? [] : [{
      id: deductionRows[0]!.id,
      included: true,
      occurredDate: '2026-07-21',
      occurredMinute: '08:00',
      reason: 'manager verified the explicit settlement deduction fixture',
    }],
  })
  expect(verified.statusCode, verified.body).toBe(200)

  const review = await get(manager, `/shifts/${shiftId}/review`)
  expect(review.statusCode, review.body).toBe(200)
  return { driver, manager, shiftId, reviewHash: review.json().br1.ordersHash as string }
}

async function preview(manager: string, shiftId: string): Promise<Settlement> {
  const response = await get(manager, `/shifts/${shiftId}/settlement`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as Settlement
}

async function approve(
  manager: string,
  shiftId: string,
  reviewHash: string,
  settlement: Settlement,
  varianceReason: string | null = settlement.variance === '0.00' ? null : 'verified at the counter',
): Promise<LightMyRequestResponse> {
  return await post(manager, `/shifts/${shiftId}/approve-close`, {
    reviewedOrdersHash: reviewHash,
    reviewedSettlementHash: settlement.settlementHash,
    walletTransferConfirmed: true,
    cashSettlementConfirmed: true,
    cashReceivableDeferred: settlement.cashReceivableDeferred,
    walletReceivableDeferred: settlement.walletReceivableDeferred,
    cashShortageReceivable: settlement.cashShortageReceivable,
    varianceReason,
  })
}

describe('fixed 40% settlement preview', () => {
  it('shows the balanced wallet sweep and one cash transaction without posting', async () => {
    const { manager, shiftId } = await pendingShift()
    const before = await h.deps.ledger.listByShift(shiftId)
    const settlement = await preview(manager, shiftId)

    expect(settlement).toMatchObject({
      policyCode: 'fixed_40_cash_close_v2_receivable',
      driverRateBps: 4000,
      deliveryFeeTotal: '10000.00',
      fixedDriverShare: '4000.00',
      manualDriverShare: '0.00',
      grossDriverShare: '4000.00',
      cashDeductionTotal: '0.00',
      baseDriverShare: '4000.00',
      expectedTotal: '23000.00',
      actualCash: '20000.00',
      actualWallet: '3000.00',
      actualTotal: '23000.00',
      variance: '0.00',
      varianceDirection: 'balanced',
      finalEmployeeCash: '4000.00',
      cashClaimToOffice: '16000.00',
      walletClaimToOffice: '3000.00',
      cashReceivableDeferred: '0.00',
      walletReceivableDeferred: '0.00',
      maximumCashShortageReceivable: '0.00',
      cashShortageReceivable: '0.00',
      walletToOffice: '3000.00',
      walletAction: 'collect',
      walletAmount: '3000.00',
      cashToOffice: '16000.00',
      cashAction: 'collect',
      cashAmount: '16000.00',
    })
    expect(settlement.settlementHash).toMatch(/^[0-9a-f]{64}$/)
    expect(await h.deps.ledger.listByShift(shiftId)).toEqual(before)
  })

  it.each([
    {
      title: 'cash surplus', actualCash: 21_000, actualWallet: 3_000,
      variance: '1000.00', direction: 'surplus', final: '5000.00', wallet: '3000.00', cash: '16000.00', cashAction: 'collect',
    },
    {
      title: 'wallet surplus', actualCash: 20_000, actualWallet: 4_000,
      variance: '1000.00', direction: 'surplus', final: '5000.00', wallet: '4000.00', cash: '15000.00', cashAction: 'collect',
    },
    {
      title: 'cash shortage', actualCash: 19_000, actualWallet: 3_000,
      variance: '-1000.00', direction: 'shortage', final: '3000.00', wallet: '3000.00', cash: '16000.00', cashAction: 'collect',
    },
    {
      title: 'wallet shortage', actualCash: 20_000, actualWallet: 2_000,
      variance: '-1000.00', direction: 'shortage', final: '3000.00', wallet: '2000.00', cash: '17000.00', cashAction: 'collect',
    },
    {
      title: 'combined cash and wallet surplus', actualCash: 20_500, actualWallet: 3_500,
      variance: '1000.00', direction: 'surplus', final: '5000.00', wallet: '3500.00', cash: '15500.00', cashAction: 'collect',
    },
    {
      title: 'combined cash and wallet shortage', actualCash: 19_500, actualWallet: 2_500,
      variance: '-1000.00', direction: 'shortage', final: '3000.00', wallet: '2500.00', cash: '16500.00', cashAction: 'collect',
    },
    {
      title: 'shortage exactly equal to the share', actualCash: 16_000, actualWallet: 3_000,
      variance: '-4000.00', direction: 'shortage', final: '0.00', wallet: '3000.00', cash: '16000.00', cashAction: 'collect',
    },
    {
      title: 'wallet exceeds branch entitlement', actualCash: 0, actualWallet: 25_000,
      variance: '2000.00', direction: 'surplus', final: '6000.00', wallet: '25000.00', cash: '-6000.00', cashAction: 'pay',
    },
    {
      title: 'zero wallet', actualCash: 23_000, actualWallet: 0,
      variance: '0.00', direction: 'balanced', final: '4000.00', wallet: '0.00', cash: '19000.00', cashAction: 'collect',
    },
    {
      title: 'negative wallet funded back to zero', actualCash: 24_000, actualWallet: -1_000,
      variance: '0.00', direction: 'balanced', final: '4000.00', wallet: '-1000.00', cash: '20000.00', cashAction: 'collect',
    },
  ] as const)(
    'assigns a $title to the employee and keeps the physical directions explicit',
    async ({ actualCash, actualWallet, variance, direction, final, wallet, cash, cashAction }) => {
      const { manager, shiftId } = await pendingShift({ actualCash, actualWallet })
      const settlement = await preview(manager, shiftId)
      expect(settlement).toMatchObject({
        variance,
        varianceDirection: direction,
        finalEmployeeCash: final,
        walletToOffice: wallet,
        walletAmount: wallet.replace('-', ''),
        walletAction: wallet === '0.00' ? 'none' : wallet.startsWith('-') ? 'fund' : 'collect',
        cashToOffice: cash,
        cashAmount: cash.replace('-', ''),
        cashAction,
      })
    },
  )

  it('counts a cash deduction once: it lowers expected cash and the employee share', async () => {
    const { manager, shiftId } = await pendingShift({ deduction: 500 })
    const settlement = await preview(manager, shiftId)

    expect(settlement).toMatchObject({
      fixedDriverShare: '4000.00',
      grossDriverShare: '4000.00',
      cashDeductionTotal: '500.00',
      baseDriverShare: '3500.00',
      expectedTotal: '22500.00',
      actualTotal: '22500.00',
      variance: '0.00',
      finalEmployeeCash: '3500.00',
      cashToOffice: '16000.00',
    })
  })

  it('adds the manager-priced manual share without putting its fee in the 40% basis', async () => {
    const { manager, shiftId } = await pendingShift({
      manual: { fee: 3_000, driverShare: 1_200, companyShare: 1_800 },
    })
    expect(await preview(manager, shiftId)).toMatchObject({
      deliveryFeeTotal: '10000.00',
      fixedDriverShare: '4000.00',
      manualDriverShare: '1200.00',
      grossDriverShare: '5200.00',
      baseDriverShare: '5200.00',
      expectedTotal: '26000.00',
      finalEmployeeCash: '5200.00',
      walletToOffice: '3000.00',
      cashToOffice: '17800.00',
    })
  })

  it('keeps payment-log rows archival and optional', async () => {
    const plain = await pendingShift()
    const plainSettlement = await preview(plain.manager, plain.shiftId)
    await h.app.close()

    h = await makeHarness()
    const archived = await pendingShift({ archivedPayment: 9_999 })
    const archivedSettlement = await preview(archived.manager, archived.shiftId)
    expect(archivedSettlement).toMatchObject({
      expectedTotal: plainSettlement.expectedTotal,
      actualTotal: plainSettlement.actualTotal,
      variance: plainSettlement.variance,
      fixedDriverShare: plainSettlement.fixedDriverShare,
      finalEmployeeCash: plainSettlement.finalEmployeeCash,
      walletToOffice: plainSettlement.walletToOffice,
      cashToOffice: plainSettlement.cashToOffice,
    })
  })
})

describe('fixed 40% approval', () => {
  it('lists the immutable close finances in one batched order and settlement read', async () => {
    const { manager, shiftId, reviewHash } = await pendingShift({
      deduction: 500,
      manual: { fee: 3_000, driverShare: 1_200, companyShare: 1_800 },
    })
    const settlement = await preview(manager, shiftId)
    const approved = await approve(manager, shiftId, reviewHash, settlement)
    expect(approved.statusCode, approved.body).toBe(200)

    const orderBatch = vi.spyOn(h.deps.orders, 'listByShiftIds')
    const settlementBatch = vi.spyOn(h.deps.settlements, 'listByShiftIds')
    const perShiftOrders = vi.spyOn(h.deps.orders, 'listByShift')
    const listed = await get(manager, '/shifts?date=2026-07-21')
    expect(listed.statusCode, listed.body).toBe(200)

    const row = (listed.json().shifts as Array<{ id: string; financial: Record<string, string> | null }>)
      .find((candidate) => candidate.id === shiftId)
    expect(row?.financial).toMatchObject({
      policyCode: 'fixed_40_cash_close_v2_receivable',
      deliveryFees: '13000.00',
      companyShare: '5800.00',
      yalagoShare: '2000.00',
      grossDriverShare: '5200.00',
      deductions: '500.00',
      netDriverShare: '4700.00',
      expectedTotal: '25500.00',
      actualCash: '22500.00',
      actualWallet: '3000.00',
      actualTotal: '25500.00',
      variance: '0.00',
      varianceDirection: 'balanced',
      finalEmployeeCash: '4700.00',
      cashToOffice: '17800.00',
      walletToOffice: '3000.00',
      officeReturn: '20800.00',
    })
    expect(orderBatch).toHaveBeenCalledTimes(1)
    expect(settlementBatch).toHaveBeenCalledTimes(1)
    expect(perShiftOrders).not.toHaveBeenCalled()
  })

  it('gives old clients a named refusal until both actions and the immutable hash are confirmed', async () => {
    const { manager, shiftId, reviewHash } = await pendingShift()
    const oldClient = await post(manager, `/shifts/${shiftId}/approve-close`, {
      reviewedOrdersHash: reviewHash,
    })
    expect(oldClient.statusCode, oldClient.body).toBe(422)
    expect(oldClient.json()).toMatchObject({
      error: 'settlement_confirmation_required',
      detail: {
        missing: expect.arrayContaining([
          'reviewedSettlementHash',
          'walletTransferConfirmed',
          'cashSettlementConfirmed',
        ]),
      },
    })
  })

  it('refuses a stale settlement hash when actual figures change but the orders hash still matches', async () => {
    const { manager, shiftId, reviewHash } = await pendingShift()
    const settlement = await preview(manager, shiftId)
    const shift = await h.deps.shifts.findById(shiftId)
    expect(shift).not.toBeNull()
    await h.deps.shifts.update({ ...shift!, endCashDeclared: minor(2_010_000n) }, 'u-bm')
    const stale = await post(manager, `/shifts/${shiftId}/approve-close`, {
      reviewedOrdersHash: reviewHash,
      reviewedSettlementHash: settlement.settlementHash,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      varianceReason: 'cash figure was corrected',
    })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error).toBe('settlement_changed_since_review')
  })

  it('audits an omitted variance reason with a deterministic marker and replays blank identically', async () => {
    const { manager, shiftId, reviewHash } = await pendingShift({ actualCash: 19_000, actualWallet: 3_000 })
    const settlement = await preview(manager, shiftId)
    expect(settlement).toMatchObject({ variance: '-1000.00', varianceDirection: 'shortage' })
    expect((await h.deps.shifts.findById(shiftId))?.state).toBe('pending_review')

    const payload = {
      reviewedOrdersHash: reviewHash,
      reviewedSettlementHash: settlement.settlementHash,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
    }
    const accepted = await post(manager, `/shifts/${shiftId}/approve-close`, payload)
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json().state).toBe('approved')
    expect(await h.deps.settlements.findByShift(shiftId)).toMatchObject({
      variance: minor(-100_000n),
      varianceReason: SYSTEM_VARIANCE_REASON_NOT_PROVIDED,
    })
    expect((await h.deps.ledger.listByShift(shiftId)).some(
      (entry) => entry.reason === SYSTEM_VARIANCE_REASON_NOT_PROVIDED,
    )).toBe(true)
    expect(await h.deps.decisions.listByShift(shiftId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'approved', notes: SYSTEM_VARIANCE_REASON_NOT_PROVIDED }),
    ]))

    const entriesAfterApproval = await h.deps.ledger.listByShift(shiftId)
    const replay = await post(manager, `/shifts/${shiftId}/approve-close`, {
      ...payload,
      varianceReason: ' \u200B\t',
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ state: 'approved', postings: 0 })
    expect(await h.deps.ledger.listByShift(shiftId)).toEqual(entriesAfterApproval)
  })

  it('persists the confirmed snapshot and clears cash, wallet, share, and close receivable', async () => {
    // A 5,000 shortage exceeds the 4,000 share. The employee pays 1,000 extra immediately.
    const { manager, shiftId, reviewHash } = await pendingShift({ actualCash: 15_000, actualWallet: 3_000 })
    const settlement = await preview(manager, shiftId)
    expect(settlement).toMatchObject({
      variance: '-5000.00',
      varianceDirection: 'shortage',
      finalEmployeeCash: '-1000.00',
      walletAction: 'collect',
      walletAmount: '3000.00',
      cashAction: 'collect',
      cashAmount: '16000.00',
    })

    const approved = await approve(manager, shiftId, reviewHash, settlement, '  employee paid the shortage  ')
    expect(approved.statusCode, approved.body).toBe(200)

    const snapshot = await h.deps.settlements.findByShift(shiftId)
    expect(snapshot).toMatchObject({
      policyCode: 'fixed_40_cash_close_v2_receivable',
      driverRateBps: 4000,
      variance: minor(-500_000n),
      finalEmployeeCash: minor(-100_000n),
      walletToOffice: minor(300_000n),
      cashToOffice: minor(1_600_000n),
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      confirmedBy: 'u-bm',
      confirmedAtMs: h.deps.clock.nowMs(),
      varianceReason: 'employee paid the shortage',
      settlementHash: settlement.settlementHash,
    })
    expect(await h.deps.shifts.findById(shiftId)).toMatchObject({
      keptAsReceivable: 0n,
      driverSharePaid: 0n,
    })

    for (const fund of [
      fundCodeOf({ kind: 'driver_cash', driverId: DRIVER_ID }),
      fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }),
      fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }),
      fundCodeOf({ kind: 'driver_receivable_cash', driverId: DRIVER_ID }),
    ]) {
      expect(await h.deps.ledger.fundBalance('branch-damascus', fund), fund).toBe(0n)
    }
  })

  it('re-reads a settled shift as a closing record: who signed it, when, and why the difference', async () => {
    /*
     * WHAT A COMPLETED SHIFT'S PAGE IS FOR.
     *
     * The route already returned every figure of the handover and none of its provenance: the five
     * snapshot columns naming the manager, the minute, the audited variance reason and the two
     * attestations were simply never listed in the response's explicit whitelist, so they existed
     * only inside the audit trigger's raw JSON. The console could show what was handed over and not
     * that anyone had signed for it.
     *
     * `confirmedBy` is resolved to a NAME here rather than in the browser: it is a uuid, and only
     * drivers are listable to the console — the manager who signs a close is not one.
     */
    const { manager, shiftId, reviewHash } = await pendingShift({ actualCash: 15_000, actualWallet: 3_000 })
    const settlement = await preview(manager, shiftId)

    // A PREVIEW MUST NOT LOOK LIKE A SIGNATURE. Nothing has been confirmed yet.
    expect(settlement).toMatchObject({
      confirmedAt: null,
      confirmedBy: null,
      confirmedByName: null,
      varianceReason: null,
      walletTransferConfirmed: false,
      cashSettlementConfirmed: false,
    })

    const approved = await approve(manager, shiftId, reviewHash, settlement, 'counted twice with the driver')
    expect(approved.statusCode, approved.body).toBe(200)

    const record = await get(manager, `/shifts/${shiftId}/settlement`)
    expect(record.statusCode, record.body).toBe(200)
    const closed = record.json() as Settlement & {
      confirmedAt: string | null
      confirmedBy: string | null
      confirmedByName: string | null
      varianceReason: string | null
      walletTransferConfirmed: boolean
      cashSettlementConfirmed: boolean
    }
    expect(closed).toMatchObject({
      confirmedBy: 'u-bm',
      varianceReason: 'counted twice with the driver',
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
    })
    expect(closed.confirmedByName).not.toBeNull()
    expect(closed.confirmedByName).not.toBe('u-bm')
    expect(Date.parse(closed.confirmedAt!)).toBe(h.deps.clock.nowMs())

    // …and it is the FROZEN snapshot, not a recomputation: the hash the manager signed survives.
    expect(closed.settlementHash).toBe(settlement.settlementHash)
    expect(closed.finalEmployeeCash).toBe(settlement.finalEmployeeCash)
  })

  it('converts a reviewed close shortage to ordinary debt without charging office cash twice', async () => {
    // A 5,000 total shortage consumes the 4,000 share; the remaining 1,000 is the only amount that
    // may be left unpaid. The 15,000 already in custody must be the complete physical cash receipt.
    const { manager, shiftId, reviewHash } = await pendingShift({ actualCash: 15_000, actualWallet: 3_000 })
    const immediate = await preview(manager, shiftId)
    expect(immediate).toMatchObject({
      finalEmployeeCash: '-1000.00',
      maximumCashShortageReceivable: '1000.00',
      cashShortageReceivable: '0.00',
      cashToOffice: '16000.00',
    })

    const partialResponse = await get(
      manager,
      `/shifts/${shiftId}/settlement?cashShortageReceivable=400.00`,
    )
    expect(partialResponse.statusCode, partialResponse.body).toBe(200)
    expect(partialResponse.json()).toMatchObject({
      maximumCashShortageReceivable: '1000.00',
      cashShortageReceivable: '400.00',
      cashToOffice: '15600.00',
    })

    const over = await get(manager, `/shifts/${shiftId}/settlement?cashShortageReceivable=1000.01`)
    expect(over.statusCode, over.body).toBe(422)
    expect(over.json()).toMatchObject({
      error: 'invalid_shortage_receivable_amount',
      detail: { maximumCashShortageReceivable: '1000.00' },
    })

    const fullResponse = await get(manager, `/shifts/${shiftId}/settlement?cashShortageReceivable=1000.00`)
    expect(fullResponse.statusCode, fullResponse.body).toBe(200)
    const full = fullResponse.json() as Settlement
    expect(full).toMatchObject({
      maximumCashShortageReceivable: '1000.00',
      cashShortageReceivable: '1000.00',
      cashToOffice: '15000.00',
      cashAction: 'collect',
      cashAmount: '15000.00',
    })
    expect(full.settlementHash).not.toBe(immediate.settlementHash)

    const stale = await post(manager, `/shifts/${shiftId}/approve-close`, {
      reviewedOrdersHash: reviewHash,
      reviewedSettlementHash: immediate.settlementHash,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      cashShortageReceivable: full.cashShortageReceivable,
      varianceReason: 'driver will pay the remaining shortage later',
    })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error).toBe('settlement_changed_since_review')

    const officeBeforeClose = await h.deps.ledger.fundBalance('branch-damascus', 'office_cash')
    const approved = await approve(
      manager,
      shiftId,
      reviewHash,
      full,
      'driver will pay the remaining shortage later',
    )
    expect(approved.statusCode, approved.body).toBe(200)
    expect(await h.deps.ledger.fundBalance('branch-damascus', 'office_cash')).toBe(
      officeBeforeClose + minor(1_500_000n),
    )
    expect(await h.deps.ledger.fundBalance(
      'branch-damascus',
      `driver_receivable_cash:${DRIVER_ID}`,
    )).toBe(minor(100_000n))
    expect(await h.deps.ledger.fundBalance(
      'branch-damascus',
      `driver_shift_funding_cash:${DRIVER_ID}`,
    )).toBe(0n)
    expect(await h.deps.settlements.findByShift(shiftId)).toMatchObject({
      maximumCashShortageReceivable: minor(100_000n),
      cashShortageReceivable: minor(100_000n),
      cashToOffice: minor(1_500_000n),
      varianceReason: 'driver will pay the remaining shortage later',
      settlementHash: full.settlementHash,
    })
    const closeEntries = await h.deps.ledger.listByShift(shiftId)
    expect(closeEntries.flatMap((entry) => entry.lines)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fundCode: `driver_receivable_cash:${DRIVER_ID}`,
        side: 'D',
        amount: minor(100_000n),
        role: 'cash_shortage_receivable',
      }),
    ]))

    const replay = await approve(
      manager,
      shiftId,
      reviewHash,
      full,
      'driver will pay the remaining shortage later',
    )
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().postings).toBe(0)
    expect(await h.deps.ledger.listByShift(shiftId)).toEqual(closeEntries)

    const officeBeforeCollection = await h.deps.ledger.fundBalance('branch-damascus', 'office_cash')
    const collected = await post(manager, '/receivables/events', {
      driverId: DRIVER_ID,
      receivableKind: 'ordinary',
      channel: 'cash',
      direction: 'collect',
      amount: '1000.00',
      reason: 'driver paid the shortage recorded by the completed shift',
      idempotencyKey: '00000000-0000-4000-8000-000000000901',
    })
    expect(collected.statusCode, collected.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(
      'branch-damascus',
      `driver_receivable_cash:${DRIVER_ID}`,
    )).toBe(0n)
    expect(await h.deps.ledger.fundBalance('branch-damascus', 'office_cash')).toBe(
      officeBeforeCollection + minor(100_000n),
    )
  })

  it('replaces the settled deduction debt with one shortage debt and audits a blank reason', async () => {
    // The 5,000 deduction first creates a 1,000 ordinary receivable beyond the 4,000 share. Close
    // settles that pre-existing balance, then preserves exactly one new 1,000 shortage receivable.
    const { manager, shiftId, reviewHash } = await pendingShift({ deduction: 5_000 })
    const base = await preview(manager, shiftId)
    expect(base).toMatchObject({
      variance: '0.00',
      baseDriverShare: '-1000.00',
      finalEmployeeCash: '-1000.00',
      maximumCashShortageReceivable: '1000.00',
    })

    const selectedResponse = await get(
      manager,
      `/shifts/${shiftId}/settlement?cashShortageReceivable=1000.00`,
    )
    expect(selectedResponse.statusCode, selectedResponse.body).toBe(200)
    const selected = selectedResponse.json() as Settlement
    const approved = await approve(manager, shiftId, reviewHash, selected, null)
    expect(approved.statusCode, approved.body).toBe(200)

    expect(await h.deps.ledger.fundBalance(
      'branch-damascus',
      `driver_receivable_cash:${DRIVER_ID}`,
    )).toBe(minor(100_000n))
    expect(await h.deps.settlements.findByShift(shiftId)).toMatchObject({
      cashShortageReceivable: minor(100_000n),
      varianceReason: SYSTEM_SHORTAGE_RECEIVABLE_REASON_NOT_PROVIDED,
    })
    expect((await h.deps.ledger.listByShift(shiftId)).some(
      (entry) => entry.reason === SYSTEM_SHORTAGE_RECEIVABLE_REASON_NOT_PROVIDED,
    )).toBe(true)
    expect(await h.deps.decisions.listByShift(shiftId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        decision: 'approved',
        notes: SYSTEM_SHORTAGE_RECEIVABLE_REASON_NOT_PROVIDED,
      }),
    ]))
  })

  it('supports combined partial cash/wallet deferral, exact replay, and immutable hash binding', async () => {
    const { manager, shiftId, reviewHash } = await pendingShift()
    const noDeferral = await preview(manager, shiftId)
    const deferredResponse = await get(
      manager,
      `/shifts/${shiftId}/settlement?cashReceivableDeferred=6000.00&walletReceivableDeferred=1000.00`,
    )
    expect(deferredResponse.statusCode, deferredResponse.body).toBe(200)
    const deferred = deferredResponse.json() as Settlement
    expect(deferred).toMatchObject({
      cashClaimToOffice: '16000.00',
      walletClaimToOffice: '3000.00',
      cashReceivableDeferred: '6000.00',
      walletReceivableDeferred: '1000.00',
      cashToOffice: '10000.00',
      walletToOffice: '2000.00',
      cashAction: 'collect',
      cashAmount: '10000.00',
      walletAction: 'collect',
      walletAmount: '2000.00',
    })
    expect(deferred.settlementHash).not.toBe(noDeferral.settlementHash)

    const stale = await post(manager, `/shifts/${shiftId}/approve-close`, {
      reviewedOrdersHash: reviewHash,
      reviewedSettlementHash: noDeferral.settlementHash,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      cashReceivableDeferred: deferred.cashReceivableDeferred,
      walletReceivableDeferred: deferred.walletReceivableDeferred,
    })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error).toBe('settlement_changed_since_review')

    const approved = await approve(manager, shiftId, reviewHash, deferred)
    expect(approved.statusCode, approved.body).toBe(200)
    // A deferral is money the driver still HOLDS and will spend on his next shift, so it lands in
    // the shift-funding funds the next open consumes — not in the ordinary debt funds, which are
    // cleared only by an explicit later collection and would leave the carried money invisible to
    // BR1. See `cashSettledReturnPostings` and the cross-shift test below.
    expect(await h.deps.ledger.fundBalance('branch-damascus', `driver_shift_funding_cash:${DRIVER_ID}`)).toBe(600_000n)
    expect(await h.deps.ledger.fundBalance('branch-damascus', `driver_shift_funding_wallet:${DRIVER_ID}`)).toBe(100_000n)
    expect(await h.deps.ledger.fundBalance('branch-damascus', `driver_receivable_cash:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance('branch-damascus', `driver_receivable_wallet:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.shifts.findById(shiftId)).toMatchObject({ keptAsReceivable: 600_000n })

    const entries = await h.deps.ledger.listByShift(shiftId)
    const replay = await approve(manager, shiftId, reviewHash, deferred)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().postings).toBe(0)
    expect(await h.deps.ledger.listByShift(shiftId)).toEqual(entries)
  })

  it('rejects deferral above either collectible claim and keeps deferred employee payout retired', async () => {
    const { manager, shiftId, reviewHash } = await pendingShift()
    for (const query of [
      'cashReceivableDeferred=16000.01',
      'walletReceivableDeferred=3000.01',
    ]) {
      const response = await get(manager, `/shifts/${shiftId}/settlement?${query}`)
      expect(response.statusCode, response.body).toBe(422)
      expect(response.json().error).toBe('invalid_receivable_amount')
    }

    const settlement = await preview(manager, shiftId)
    const response = await post(manager, `/shifts/${shiftId}/approve-close`, {
      reviewedOrdersHash: reviewHash,
      reviewedSettlementHash: settlement.settlementHash,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      payShareNow: false,
    })
    expect(response.statusCode, response.body).toBe(422)
    expect(response.json().error).toBe('fixed_cash_settlement_required')
  })

  it('does not let archived payments affect approval postings', async () => {
    const { manager, shiftId, reviewHash } = await pendingShift({ archivedPayment: 9_999 })
    const settlement = await preview(manager, shiftId)
    const response = await approve(manager, shiftId, reviewHash, settlement)
    expect(response.statusCode, response.body).toBe(200)
    expect(h.deps.ledger.entries.some((entry) => entry.eventType === 'wallet_adjustment')).toBe(false)
    expect(await h.deps.ledger.fundBalance('branch-damascus', 'cost_center:wallet_adjustment:branch-damascus')).toBe(0n)
  })
})
