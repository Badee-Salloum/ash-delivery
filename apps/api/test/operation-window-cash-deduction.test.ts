import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { classifyOperationWindow } from '../src/shifts.service.ts'
import {
  BRANCH,
  DRIVER2_ID,
  DRIVER_ID,
  type Harness,
  VEHICLE_ID,
  makeHarness,
  sypStr,
} from './harness.ts'

const OPEN_MS = Date.UTC(2026, 7, 13, 16, 49, 30) // 2026-08-13 19:49 Damascus
const CLOSE_MS = Date.UTC(2026, 7, 13, 22, 30, 45) // 2026-08-14 01:30 Damascus

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
  h.deps.clock.set(OPEN_MS - 10 * 60_000)
})
afterEach(async () => {
  await h.app.close()
})

const post = async (token: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

async function openShift(input: {
  driverName?: 'driver1' | 'driver2'
  driverId?: string
  vehicleId?: string
  shiftNo?: number
  odometerKm?: number
  float?: number
  topup?: number
} = {}): Promise<{ id: string; driver: string; manager: string }> {
  const driver = await h.loginAs(input.driverName ?? 'driver1')
  const manager = await h.loginAs('manager')
  const created = await post(driver, '/shifts', {
    driverId: input.driverId ?? DRIVER_ID,
    vehicleId: input.vehicleId ?? VEHICLE_ID,
    shiftNo: input.shiftNo ?? 1,
  })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  const started = await put(driver, `/shifts/${id}/start-package`, {
    odometerKm: input.odometerKm ?? 6_030,
    batteryPercent: null,
  })
  expect(started.statusCode, started.body).toBe(200)
  h.deps.clock.set(OPEN_MS)
  const opened = await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches: [sypStr(input.float ?? 3_000)],
    topupTranches: input.topup === 0 ? [] : [sypStr(input.topup ?? 500)],
  })
  expect(opened.statusCode, opened.body).toBe(200)
  return { id, driver, manager }
}

async function uploadEnd(driver: string, id: string): Promise<void> {
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
}

describe('operation minute window', () => {
  const base = {
    openApprovedAt: new Date(OPEN_MS).toISOString(),
    submittedAt: new Date(CLOSE_MS).toISOString(),
    timeZone: 'Asia/Damascus',
    offsetMinutes: 180,
  }

  it.each([
    ['2026-08-13', '19:48', 'pre_open'],
    ['2026-08-13', '19:49', 'open_minute_boundary'],
    ['2026-08-13', '23:59', 'in_window'],
    ['2026-08-14', '00:00', 'in_window'],
    ['2026-08-14', '01:30', 'close_minute_boundary'],
    ['2026-08-14', '01:31', 'post_close'],
  ] as const)('classifies %s %s as %s', (occurredDate, occurredMinute, expected) => {
    expect(classifyOperationWindow({ ...base, occurredDate, occurredMinute })).toBe(expected)
  })

  it('preserves uncertainty when either the operation or canonical open time is missing', () => {
    expect(classifyOperationWindow({ ...base, occurredDate: null, occurredMinute: '20:00' })).toBe('unknown')
    expect(classifyOperationWindow({ ...base, occurredDate: '2026-08-13', occurredMinute: null })).toBe('unknown')
    expect(classifyOperationWindow({ ...base, occurredDate: '2026-08-13', occurredMinute: '20:00', openApprovedAt: null })).toBe('unknown')
  })
})

describe('Thaer regression: six orders and the -50 recent-order row', () => {
  it('crosses midnight, reduces 4,736 to 4,686, and leaves tier/Yallago order arithmetic unchanged', async () => {
    const { id, driver, manager } = await openShift()
    const fees = [425, 240, 370, 175, 145, 190]
    const times = [
      ['2026-08-13', '19:49'],
      ['2026-08-13', '20:15'],
      ['2026-08-13', '22:10'],
      ['2026-08-13', '23:58'],
      ['2026-08-14', '00:12'],
      ['2026-08-14', '01:10'],
    ] as const

    const operations = await put(driver, `/shifts/${id}/operations`, {
      orders: fees.map((fee, index) => ({
        providerOrderNo: `THAER-${index + 1}`,
        payMode: 'cash',
        fee: sypStr(fee),
        included: false, // A driver checkbox cannot exclude a known in-window row.
        occurredDate: times[index]![0],
        occurredMinute: times[index]![1],
        pointA: `A${index + 1}`,
        pointB: `B${index + 1}`,
        source: 'ocr',
      })),
      cashDeductions: [{
        operationKey: 'thaer:2026-08-13:22:36:-50',
        amount: '50.00',
        amountOcr: '50.00',
        occurredDate: '2026-08-13',
        occurredMinute: '22:36',
        pointA: 'A-',
        pointB: 'B-',
        source: 'ocr',
      }],
      movements: [],
    })
    expect(operations.statusCode, operations.body).toBe(200)
    expect(operations.json().br1.cashDeductionTotal).toBe('50.00')

    await uploadEnd(driver, id)
    h.deps.clock.set(CLOSE_MS)
    const ended = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 6_100,
      odometerKmOcr: 6_100,
      batteryPercent: null,
      cashDeclared: '4495.00',
      walletDeclared: '191.00',
    })
    expect(ended.statusCode, ended.body).toBe(200)
    expect(ended.json().br1).toMatchObject({
      expectedCash: '4495.00',
      expectedWallet: '191.00',
      expectedTotal: '4686.00',
      difference: '0.00',
      cashDeductionTotal: '50.00',
    })

    const review = await get(manager, `/shifts/${id}/review`)
    expect(review.statusCode, review.body).toBe(200)
    expect(review.json().openApprovedAt).toBe(new Date(OPEN_MS).toISOString())
    expect(review.json().submittedAt).toBe(new Date(CLOSE_MS).toISOString())
    expect(review.json().orders).toHaveLength(6)
    expect(review.json().orders.every((order: { included: boolean }) => order.included)).toBe(true)
    expect(review.json().orders[0].windowStatus).toBe('open_minute_boundary')
    expect(review.json().orders[4].windowStatus).toBe('in_window')
    expect(review.json().cashDeductions).toHaveLength(1)
    expect(review.json().cashDeductions[0]).toMatchObject({ amount: '50.00', included: true, windowStatus: 'in_window' })

    const settlement = await get(manager, `/shifts/${id}/settlement?payShareNow=false`)
    expect(settlement.statusCode, settlement.body).toBe(200)
    expect(settlement.json()).toMatchObject({
      grossDriverShare: '540.75',
      cashDeductionTotal: '50.00',
      netDriverShare: '490.75',
      deductionReceivable: '0.00',
    })

    const approved = await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: review.json().br1.ordersHash,
    })
    expect(approved.statusCode, approved.body).toBe(200)
    const entries = await h.deps.ledger.listByShift(id)
    expect(entries.filter((entry) => entry.eventType === 'order_fee')).toHaveLength(6)
    expect(entries.filter((entry) => entry.eventType === 'yalago_cut')).toHaveLength(6)
    expect(entries.filter((entry) => entry.eventType === 'driver_cash_deduction')).toHaveLength(1)
    const [storedDeduction] = await h.deps.cashDeductions.listByShift(id)
    expect(entries.find((entry) => entry.eventType === 'driver_cash_deduction')?.occurrenceKey)
      .toBe(`cash-deduction:${storedDeduction!.id}`)
  })
})

describe('cash deduction compatibility and approval allocation', () => {
  it('heals deterministic old-API rows before review but leaves illegible timestamps unresolved', async () => {
    const { id, driver, manager } = await openShift({ float: 100, topup: 0 })
    await put(driver, `/shifts/${id}/operations`, {
      orders: [
        {
          providerOrderNo: 'OLD-API-PRE-OPEN',
          payMode: 'cash',
          fee: '10.00',
          occurredDate: '2026-08-13',
          occurredMinute: '19:48',
        },
        { providerOrderNo: 'OLD-API-UNKNOWN', payMode: 'cash', fee: '10.00' },
      ],
      cashDeductions: [{
        operationKey: 'old-api-post-close-deduction',
        amount: '5.00',
        occurredDate: '2026-08-14',
        occurredMinute: '01:31',
      }],
      movements: [],
    })
    await uploadEnd(driver, id)
    h.deps.clock.set(CLOSE_MS)
    expect((await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 6_050,
      batteryPercent: null,
      cashDeclared: '110.00',
      walletDeclared: '0.00',
    })).statusCode).toBe(200)

    // Reproduce DB-first rollout state: 0028's compatibility trigger stamped submittedAt for the
    // old API, but that binary did not know how to classify either table.
    for (const row of await h.deps.orders.listByShift(id)) {
      await h.deps.orders.update({ ...row, windowStatus: 'unknown', included: true }, null)
    }
    for (const row of await h.deps.cashDeductions.listByShift(id)) {
      await h.deps.cashDeductions.update({ ...row, windowStatus: 'unknown', included: true }, null)
    }

    const counts: Array<{ orders: number; cashDeductions: number }> = []
    const original = h.deps.operationWindows.reclassify.bind(h.deps.operationWindows)
    h.deps.operationWindows.reclassify = async (...args) => {
      const result = await original(...args)
      counts.push(result)
      return result
    }

    const first = await get(manager, `/shifts/${id}/review`)
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerOrderNo: 'OLD-API-PRE-OPEN', windowStatus: 'pre_open', included: false }),
      expect.objectContaining({ providerOrderNo: 'OLD-API-UNKNOWN', windowStatus: 'unknown', included: true }),
    ]))
    expect(first.json().cashDeductions[0]).toMatchObject({ windowStatus: 'post_close', included: false })

    const second = await get(manager, `/shifts/${id}/review`)
    expect(second.statusCode, second.body).toBe(200)
    expect(counts).toEqual([
      { orders: 1, cashDeductions: 1 },
      { orders: 0, cashDeductions: 0 },
    ])
    const blocked = await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: second.json().br1.ordersHash,
    })
    expect(blocked.statusCode, blocked.body).toBe(422)
    expect(blocked.json().error).toBe('operation_window_unresolved')
  })

  it('converts an old PWA negative fee, consumes this shift share, and makes only the overflow a cash receivable', async () => {
    const { id, driver, manager } = await openShift({ float: 100, topup: 20 })
    const operations = await put(driver, `/shifts/${id}/operations`, {
      orders: [
        {
          providerOrderNo: 'OLD-POSITIVE',
          payMode: 'cash',
          fee: '100.00',
          occurredDate: '2026-08-13',
          occurredMinute: '20:00',
        },
        {
          providerOrderNo: 'OLD-NEGATIVE',
          payMode: 'cash',
          fee: '-50.00',
          feeOcr: '-50.00',
          occurredDate: '2026-08-13',
          occurredMinute: '20:01',
          source: 'ocr',
        },
      ],
      movements: [],
    })
    expect(operations.statusCode, operations.body).toBe(200)
    expect(await h.deps.orders.listByShift(id)).toHaveLength(1)
    const deductions = await h.deps.cashDeductions.listByShift(id)
    expect(deductions).toHaveLength(1)
    expect(deductions[0]).toMatchObject({ operationKey: 'legacy:OLD-NEGATIVE', amount: 5_000n })

    await uploadEnd(driver, id)
    h.deps.clock.set(CLOSE_MS)
    const ended = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 6_050,
      batteryPercent: null,
      cashDeclared: '150.00',
      walletDeclared: '0.00',
    })
    expect(ended.statusCode, ended.body).toBe(200)
    const review = await get(manager, `/shifts/${id}/review`)
    const settlement = await get(manager, `/shifts/${id}/settlement?payShareNow=false`)
    expect(settlement.json()).toMatchObject({
      grossDriverShare: '35.00',
      cashDeductionTotal: '50.00',
      netDriverShare: '0.00',
      deductionReceivable: '15.00',
    })

    const approved = await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: review.json().br1.ordersHash,
    })
    expect(approved.statusCode, approved.body).toBe(200)
    expect(await h.deps.ledger.fundBalance(BRANCH, fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID })))
      .toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, fundCodeOf({ kind: 'driver_receivable_cash', driverId: DRIVER_ID })))
      .toBe(1_500n)
  })

  it('blocks unresolved rows until a manager supplies an audited reason and decision', async () => {
    const { id, driver, manager } = await openShift({ float: 100, topup: 20 })
    await put(driver, `/shifts/${id}/operations`, {
      orders: [{ providerOrderNo: 'TIME-UNKNOWN', payMode: 'cash', fee: '100.00' }],
      movements: [],
    })
    await uploadEnd(driver, id)
    h.deps.clock.set(CLOSE_MS)
    const ended = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 6_050,
      batteryPercent: null,
      cashDeclared: '200.00',
      walletDeclared: '0.00',
    })
    expect(ended.statusCode, ended.body).toBe(200)

    const before = await get(manager, `/shifts/${id}/review`)
    const blocked = await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: before.json().br1.ordersHash,
    })
    expect(blocked.statusCode, blocked.body).toBe(422)
    expect(blocked.json().error).toBe('operation_window_unresolved')

    // Correcting money versions the row so a cached driver cannot overwrite it, but does not say
    // when the operation happened. It must therefore remain an unresolved window row.
    const feeOnly = await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'TIME-UNKNOWN', fee: '100.00' }],
    })
    expect(feeOnly.statusCode, feeOnly.body).toBe(200)
    const afterFeeOnly = await get(manager, `/shifts/${id}/review`)
    expect(afterFeeOnly.json().orders[0]).toMatchObject({
      windowStatus: 'unknown',
      decisionReason: null,
      decidedBy: 'u-bm',
    })
    const stillBlocked = await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: afterFeeOnly.json().br1.ordersHash,
    })
    expect(stillBlocked.statusCode, stillBlocked.body).toBe(422)
    expect(stillBlocked.json().error).toBe('operation_window_unresolved')

    const noReason = await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{
        providerOrderNo: 'TIME-UNKNOWN',
        included: true,
        occurredDate: '2026-08-13',
        occurredMinute: '20:00',
      }],
    })
    expect(noReason.statusCode, noReason.body).toBe(422)
    expect(noReason.json().error).toBe('operation_decision_reason_required')

    const revised = await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{
        providerOrderNo: 'TIME-UNKNOWN',
        included: true,
        occurredDate: '2026-08-13',
        occurredMinute: '20:00',
        reason: 'verified against the original Yallago screenshot',
      }],
    })
    expect(revised.statusCode, revised.body).toBe(200)
    const after = await get(manager, `/shifts/${id}/review`)
    expect(after.json().orders[0]).toMatchObject({
      windowStatus: 'in_window',
      included: true,
      decisionReason: 'verified against the original Yallago screenshot',
      decidedBy: 'u-bm',
    })
    const approved = await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: after.json().br1.ordersHash,
    })
    expect(approved.statusCode, approved.body).toBe(200)
  })
})

describe('end odometer evidence', () => {
  it('requires explicit confirmation below the start and persists the independent OCR baseline', async () => {
    const { id, driver, manager } = await openShift({ float: 100, topup: 2, odometerKm: 6_030 })
    const operations = await put(driver, `/shifts/${id}/operations`, {
      orders: [{
        providerOrderNo: 'ODO-GATE-ORDER',
        payMode: 'cash',
        fee: '10.00',
        occurredDate: '2026-08-13',
        occurredMinute: '20:00',
      }],
      movements: [],
    })
    expect(operations.statusCode, operations.body).toBe(200)
    await uploadEnd(driver, id)
    h.deps.clock.set(CLOSE_MS)
    const body = {
      odometerKm: 6_028,
      odometerKmOcr: 6_027,
      batteryPercent: null,
      cashDeclared: '110.00',
      walletDeclared: '0.00',
    }
    const refused = await put(driver, `/shifts/${id}/end-package`, body)
    expect(refused.statusCode, refused.body).toBe(422)
    expect(refused.json().error).toBe('odometer_anomaly_confirmation_required')

    const accepted = await put(driver, `/shifts/${id}/end-package`, {
      ...body,
      odometerAnomalyConfirmed: true,
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    const review = await get(manager, `/shifts/${id}/review`)
    expect(review.json().endPackage).toMatchObject({
      odometerKm: 6_028,
      odometerKmOcr: 6_027,
      odometerAnomalyConfirmedBy: expect.any(String),
      odometerAnomalyConfirmedAt: expect.any(String),
    })
  })
})

describe('whole operations submission validation', () => {
  it('prevalidates a cross-shift conflict before inserting an earlier row from the same payload', async () => {
    const first = await openShift({ driverName: 'driver1', driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })
    await put(first.driver, `/shifts/${first.id}/operations`, {
      orders: [{
        providerOrderNo: 'ALREADY-OWNED',
        payMode: 'cash',
        fee: '10.00',
        occurredDate: '2026-08-13',
        occurredMinute: '20:00',
      }],
      movements: [],
    })

    h.deps.clock.set(OPEN_MS + 60_000)
    const second = await openShift({
      driverName: 'driver2',
      driverId: DRIVER2_ID,
      vehicleId: 'vehicle-2',
      shiftNo: 1,
      float: 100,
      topup: 0,
    })
    const conflict = await put(second.driver, `/shifts/${second.id}/operations`, {
      orders: [
        {
          providerOrderNo: 'WOULD-BE-PARTIAL',
          payMode: 'cash',
          fee: '10.00',
          occurredDate: '2026-08-13',
          occurredMinute: '20:01',
        },
        {
          providerOrderNo: 'ALREADY-OWNED',
          payMode: 'cash',
          fee: '10.00',
          occurredDate: '2026-08-13',
          occurredMinute: '20:02',
        },
      ],
      movements: [],
    })
    expect(conflict.statusCode, conflict.body).toBe(409)
    expect(conflict.json().error).toBe('order_belongs_to_other_shift')
    expect((await h.deps.orders.listByShift(second.id)).map((order) => order.providerOrderNo))
      .not.toContain('WOULD-BE-PARTIAL')
  })
})
