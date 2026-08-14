import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DRIVER_ID,
  NOW_MS,
  type Harness,
  VEHICLE_ID,
  makeHarness,
  syp,
  sypStr,
} from './harness.ts'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (
  token: string,
  url: string,
  payload: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })

const put = async (
  token: string,
  url: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

async function openShift(): Promise<{ id: string; driver: string; manager: string }> {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')
  const created = await post(driver, '/shifts', {
    driverId: DRIVER_ID,
    vehicleId: VEHICLE_ID,
    shiftNo: 1,
  })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  expect((await put(driver, `/shifts/${id}/start-package`, {
    odometerKm: 100,
    batteryPercent: null,
  })).statusCode).toBe(200)
  expect((await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches: [sypStr(1_000)],
    topupTranches: [sypStr(1_000)],
  })).statusCode).toBe(200)
  return { id, driver, manager }
}

async function submitEnd(
  id: string,
  driver: string,
  cashDeclared: number,
  walletDeclared: number,
): Promise<LightMyRequestResponse> {
  for (const slot of ['dashboard', 'wallet', 'odometer']) {
    await h.uploadPhoto(driver, id, 'end', slot)
  }
  h.deps.clock.set(NOW_MS + 6 * 60 * 60_000)
  return await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 200,
    batteryPercent: null,
    cashDeclared: sypStr(cashDeclared),
    walletDeclared: sypStr(walletDeclared),
  })
}

const bulkRow = (
  providerOrderNo: string,
  fee: number,
  occurredMinute: string,
): Record<string, unknown> => ({
  providerOrderNo,
  payMode: 'cash',
  fee: sypStr(fee),
  feeOcr: sypStr(fee),
  source: 'ocr',
  occurredDate: '2026-07-21',
  occurredMinute,
})

async function expectOnlyOrder(id: string, providerOrderNo: string): Promise<void> {
  expect((await h.deps.orders.listByShift(id)).filter((row) => row.providerOrderNo === providerOrderNo))
    .toHaveLength(1)
  expect((await h.deps.cashDeductions.listByShift(id)).filter(
    (row) => row.operationKey === `legacy:${providerOrderNo}`,
  )).toHaveLength(0)
}

async function expectOnlyDeduction(id: string, providerOrderNo: string): Promise<void> {
  expect((await h.deps.orders.listByShift(id)).filter((row) => row.providerOrderNo === providerOrderNo))
    .toHaveLength(0)
  expect((await h.deps.cashDeductions.listByShift(id)).filter(
    (row) => row.operationKey === `legacy:${providerOrderNo}`,
  )).toHaveLength(1)
}

describe('operation sign flips keep one accounting identity', () => {
  it('replaces an undecided legacy POST row in both directions and keeps its first window evidence', async () => {
    const { id, driver } = await openShift()
    const url = `/shifts/${id}/orders`

    const negative = await post(driver, url, {
      providerOrderNo: 'POST-FLIP',
      payMode: 'cash',
      fee: sypStr(-100),
      feeOcr: sypStr(-110),
      source: 'ocr',
      occurredMinute: '08:05',
      zone: null,
    })
    expect(negative.statusCode, negative.body).toBe(201)
    await expectOnlyDeduction(id, 'POST-FLIP')
    const firstDeduction = (await h.deps.cashDeductions.listByShift(id))[0]!
    h.deps.cashDeductions.rows.set(firstDeduction.id, { ...firstDeduction, createdBy: 'legacy-import' })

    const positive = await post(driver, url, {
      providerOrderNo: 'POST-FLIP',
      payMode: 'cash',
      fee: sypStr(200),
      feeOcr: sypStr(210),
      source: 'ocr',
      occurredMinute: '07:59',
      zone: 'new scan',
    })
    expect(positive.statusCode, positive.body).toBe(201)
    await expectOnlyOrder(id, 'POST-FLIP')
    expect((await h.deps.orders.listByShift(id))[0]).toMatchObject({
      providerOrderNo: 'POST-FLIP',
      fee: syp(200),
      feeOcr: syp(210),
      occurredDate: '2026-07-21',
      occurredMinute: '08:05',
      windowStatus: 'in_window',
      included: true,
      createdBy: 'legacy-import',
    })

    const negativeAgain = await post(driver, url, {
      providerOrderNo: 'POST-FLIP',
      payMode: 'cash',
      fee: sypStr(-75),
      feeOcr: sypStr(-80),
      source: 'refused',
      occurredMinute: '10:30',
      zone: null,
    })
    expect(negativeAgain.statusCode, negativeAgain.body).toBe(201)
    await expectOnlyDeduction(id, 'POST-FLIP')
    expect((await h.deps.cashDeductions.listByShift(id))[0]).toMatchObject({
      operationKey: 'legacy:POST-FLIP',
      amount: syp(75),
      amountOcr: syp(80),
      // `refused` is retained only by the OCR-training sample; stored money rows call it manual.
      source: 'manual',
      occurredDate: '2026-07-21',
      occurredMinute: '08:05',
      windowStatus: 'in_window',
      included: true,
      createdBy: 'legacy-import',
    })

    const br1 = await put(driver, `/shifts/${id}/operations`, { orders: [], movements: [] })
    expect(br1.statusCode, br1.body).toBe(200)
    expect(br1.json().br1).toMatchObject({
      expectedCash: '925.00',
      expectedWallet: '1000.00',
      expectedTotal: '1925.00',
      cashDeductionTotal: '75.00',
    })
  })

  it('bulk-converts a legacy deduction into the fifteenth order and uses fixed 40%', async () => {
    const { id, driver, manager } = await openShift()
    const base = Array.from({ length: 14 }, (_, index) =>
      bulkRow(`BULK-${String(index + 1).padStart(2, '0')}`, 100, `08:${String(index + 10).padStart(2, '0')}`))

    const first = await put(driver, `/shifts/${id}/operations`, {
      orders: [...base, bulkRow('BULK-FLIP', -75, '08:05')],
      movements: [],
    })
    expect(first.statusCode, first.body).toBe(200)
    await expectOnlyDeduction(id, 'BULK-FLIP')

    const retry = await put(driver, `/shifts/${id}/operations`, {
      orders: [...base, bulkRow('BULK-FLIP', 100, '07:59')],
      movements: [],
    })
    expect(retry.statusCode, retry.body).toBe(200)
    await expectOnlyOrder(id, 'BULK-FLIP')
    expect(await h.deps.orders.listByShift(id)).toHaveLength(15)
    expect((await h.deps.orders.findByProviderNo('BULK-FLIP'))).toMatchObject({
      fee: syp(100),
      feeOcr: syp(100),
      occurredDate: '2026-07-21',
      occurredMinute: '08:05',
      windowStatus: 'in_window',
      included: true,
    })
    expect(retry.json().br1).toMatchObject({
      expectedCash: '2500.00',
      expectedWallet: '700.00',
      expectedTotal: '3200.00',
      cashDeductionTotal: '0.00',
    })

    const ended = await submitEnd(id, driver, 2_500, 700)
    expect(ended.statusCode, ended.body).toBe(200)
    const settlement = await get(manager, `/shifts/${id}/settlement`)
    expect(settlement.statusCode, settlement.body).toBe(200)
    expect(settlement.json()).toMatchObject({
      grossDriverShare: '600.00',
      cashDeductionTotal: '0.00',
      baseDriverShare: '600.00',
    })
  })

  it('bulk-converts an undecided order into a deduction without retaining it in BR1 or the tier basis', async () => {
    const { id, driver } = await openShift()
    const first = await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('BULK-REVERSE', 100, '08:05')],
      movements: [],
    })
    expect(first.statusCode, first.body).toBe(200)
    await expectOnlyOrder(id, 'BULK-REVERSE')

    const retry = await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('BULK-REVERSE', -75, '07:59')],
      movements: [],
    })
    expect(retry.statusCode, retry.body).toBe(200)
    await expectOnlyDeduction(id, 'BULK-REVERSE')
    expect((await h.deps.cashDeductions.listByShift(id))[0]).toMatchObject({
      amount: syp(75),
      amountOcr: syp(75),
      occurredDate: '2026-07-21',
      occurredMinute: '08:05',
      windowStatus: 'in_window',
      included: true,
    })
    expect(retry.json().br1).toMatchObject({
      expectedCash: '925.00',
      expectedWallet: '1000.00',
      expectedTotal: '1925.00',
      cashDeductionTotal: '75.00',
    })
  })

  it('detaches a newly submitted order-linked movement when that order flips to a deduction', async () => {
    const { id, driver } = await openShift()
    expect((await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('FLIP-WITH-MOVEMENT', 100, '08:05')],
      movements: [],
    })).statusCode).toBe(200)

    const flipped = await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('FLIP-WITH-MOVEMENT', -75, '08:05')],
      movements: [{
        amount: sypStr(-20),
        occurredMinute: '08:06',
        role: 'yalago_cut',
        providerOrderNo: 'FLIP-WITH-MOVEMENT',
        included: true,
        ambiguous: false,
      }],
    })
    expect(flipped.statusCode, flipped.body).toBe(200)
    await expectOnlyDeduction(id, 'FLIP-WITH-MOVEMENT')
    expect(await h.deps.movements.listByShift(id)).toEqual([
      expect.objectContaining({
        amount: syp(-20),
        orderId: null,
        role: 'unmatched',
        included: false,
        ambiguous: true,
      }),
    ])
  })

  it('treats a padded provider number as the same exact identity throughout a bulk sign flip', async () => {
    const { id, driver } = await openShift()
    expect((await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow(' PADDED-NO ', 100, '08:05')],
      movements: [],
    })).statusCode).toBe(200)

    const flipped = await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow(' PADDED-NO ', -75, '08:05')],
      movements: [],
    })
    expect(flipped.statusCode, flipped.body).toBe(200)
    await expectOnlyDeduction(id, ' PADDED-NO ')
  })
})

describe('manager-attributed operation kinds survive rephoto retries', () => {
  it('preserves a decided deduction on same- and opposite-sign cached replays', async () => {
    const { id, driver, manager } = await openShift()
    const submitted = await put(driver, `/shifts/${id}/operations`, {
      orders: [
        bulkRow('DECIDED-ANCHOR', 100, '08:04'),
        bulkRow('DECIDED-DEDUCTION', -100, '08:05'),
      ],
      movements: [],
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    const ended = await submitEnd(id, driver, 1_000, 980)
    expect(ended.statusCode, ended.body).toBe(200)

    const [deduction] = await h.deps.cashDeductions.listByShift(id)
    const decided = await post(manager, `/shifts/${id}/operations/revise`, {
      cashDeductions: [{
        id: deduction!.id,
        included: false,
        occurredDate: '2026-07-21',
        occurredMinute: '07:59',
        reason: 'manager verified this row predates the shift',
      }],
    })
    expect(decided.statusCode, decided.body).toBe(200)
    const managerRow = (await h.deps.cashDeductions.listByShift(id))[0]!
    expect(managerRow).toMatchObject({
      amount: syp(100),
      occurredMinute: '07:59',
      windowStatus: 'pre_open',
      included: false,
      decisionReason: 'manager verified this row predates the shift',
      decidedBy: 'u-bm',
    })

    expect((await post(manager, `/shifts/${id}/request-rephoto`, {
      notes: 'read the operations page again',
    })).statusCode).toBe(200)

    const sameSign = await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('DECIDED-DEDUCTION', -999, '12:30')],
      movements: [],
    })
    expect(sameSign.statusCode, sameSign.body).toBe(200)
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual([managerRow])
    expect(sameSign.json().br1).toMatchObject({
      expectedTotal: '2080.00',
      cashDeductionTotal: '0.00',
    })

    const flip = await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('DECIDED-DEDUCTION', 999, '12:30')],
      movements: [],
    })
    expect(flip.statusCode, flip.body).toBe(200)
    await expectOnlyDeduction(id, 'DECIDED-DEDUCTION')
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual([managerRow])
  })

  it('preserves a decided order on same- and opposite-sign cached replays', async () => {
    const { id, driver, manager } = await openShift()
    const submitted = await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('DECIDED-ORDER', 100, '08:05')],
      movements: [],
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    const ended = await submitEnd(id, driver, 1_100, 980)
    expect(ended.statusCode, ended.body).toBe(200)

    const decided = await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{
        providerOrderNo: 'DECIDED-ORDER',
        included: false,
        occurredDate: '2026-07-21',
        occurredMinute: '07:59',
        reason: 'manager verified this row predates the shift',
      }],
    })
    expect(decided.statusCode, decided.body).toBe(200)
    const managerRow = (await h.deps.orders.listByShift(id))[0]!
    expect(managerRow).toMatchObject({
      fee: syp(100),
      occurredMinute: '07:59',
      windowStatus: 'pre_open',
      included: false,
      decisionReason: 'manager verified this row predates the shift',
      decidedBy: 'u-bm',
    })

    expect((await post(manager, `/shifts/${id}/request-rephoto`, {
      notes: 'read the operations page again',
    })).statusCode).toBe(200)

    const sameSign = await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('DECIDED-ORDER', 999, '12:30')],
      movements: [],
    })
    expect(sameSign.statusCode, sameSign.body).toBe(200)
    expect(await h.deps.orders.listByShift(id)).toEqual([managerRow])
    expect(sameSign.json().br1).toMatchObject({
      expectedTotal: '2000.00',
      cashDeductionTotal: '0.00',
    })

    const flip = await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('DECIDED-ORDER', -999, '12:30')],
      movements: [],
    })
    expect(flip.statusCode, flip.body).toBe(200)
    await expectOnlyOrder(id, 'DECIDED-ORDER')
    expect(await h.deps.orders.listByShift(id)).toEqual([managerRow])
  })

  it('returns a named conflict rather than choosing between two manager-decided representations', async () => {
    const { id, driver } = await openShift()
    expect((await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('DOUBLE-DECIDED', 100, '08:05')],
      movements: [],
    })).statusCode).toBe(200)

    const decidedAt = new Date(h.deps.clock.nowMs()).toISOString()
    const order = (await h.deps.orders.listByShift(id))[0]!
    const decidedOrder = {
      ...order,
      decisionReason: 'manager accepted the order representation',
      decidedBy: 'u-bm',
      decidedAt,
    }
    await h.deps.orders.update(decidedOrder, 'u-bm')
    const decidedDeduction = {
      id: h.deps.ids.uuid(),
      shiftId: id,
      operationKey: 'legacy:DOUBLE-DECIDED',
      amount: syp(75),
      occurredDate: '2026-07-21' as const,
      occurredMinute: '08:05',
      source: 'manual' as const,
      amountOcr: null,
      pointA: null,
      pointB: null,
      included: true,
      windowStatus: 'in_window' as const,
      decisionReason: 'manager accepted the deduction representation',
      decidedBy: 'u-bm',
      decidedAt,
      createdBy: 'u-d1',
    }
    await h.deps.cashDeductions.create(decidedDeduction, 'u-bm')

    const retry = await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('DOUBLE-DECIDED', -90, '09:30')],
      movements: [],
    })
    expect(retry.statusCode, retry.body).toBe(409)
    expect(retry.json().error).toBe('operation_kind_conflict_requires_manager')
    expect(await h.deps.orders.listByShift(id)).toEqual([decidedOrder])
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual([decidedDeduction])
  })

  it('maps a manager decision racing an opposite-kind replacement to a retryable 409', async () => {
    const { id, driver } = await openShift()
    expect((await put(driver, `/shifts/${id}/operations`, {
      orders: [bulkRow('RACING-DECISION', -100, '08:05')],
      movements: [],
    })).statusCode).toBe(200)

    const originalApply = h.deps.operationBatches.apply.bind(h.deps.operationBatches)
    const decidedAt = new Date(h.deps.clock.nowMs() + 1).toISOString()
    let managerRow = (await h.deps.cashDeductions.listByShift(id))[0]!
    h.deps.operationBatches.apply = async (shiftId, batch, actorId) => {
      managerRow = {
        ...managerRow,
        decisionReason: 'manager decision won the race',
        decidedBy: 'u-bm',
        decidedAt,
      }
      await h.deps.cashDeductions.update(managerRow, 'u-bm')
      return await originalApply(shiftId, batch, actorId)
    }

    let retry: LightMyRequestResponse
    try {
      retry = await put(driver, `/shifts/${id}/operations`, {
        orders: [bulkRow('RACING-DECISION', 100, '09:30')],
        movements: [],
      })
    } finally {
      h.deps.operationBatches.apply = originalApply
    }
    expect(retry.statusCode, retry.body).toBe(409)
    expect(retry.json().error).toBe('operations_changed_concurrently')
    await expectOnlyDeduction(id, 'RACING-DECISION')
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual([managerRow])
  })
})
