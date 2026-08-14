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
  syp,
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

  it('stores one -50 when the first HTTP batch contains the partial and richer overlap together', async () => {
    const { id, driver } = await openShift({ float: 3_500, topup: 0 })
    const operationKey = 'recent-orders:0e0e0e0e0e0e0e0e'
    const result = await put(driver, `/shifts/${id}/operations`, {
      orders: [],
      cashDeductions: [
        {
          operationKey,
          amount: '50.00',
          amountOcr: '50.00',
          occurredDate: '2026-08-13',
          occurredMinute: '22:36',
          pointA: 'G777+4GP, Al Qanawat',
          pointB: null,
          source: 'ocr',
        },
        {
          operationKey: `${operationKey}~2`,
          amount: '50.00',
          amountOcr: '50.00',
          occurredDate: '2026-08-13',
          occurredMinute: '22:36',
          pointA: 'G77V+4GP, Al Qanawat',
          pointB: 'G78P+J3M, Al Mouhajrin',
          source: 'ocr',
        },
      ],
      movements: [],
    })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().br1).toMatchObject({
      cashDeductionTotal: '50.00',
      expectedTotal: '3450.00',
    })
    expect(result.json().cashDeductions).toEqual([
      expect.objectContaining({
        operationKey,
        amount: '50.00',
        pointA: 'G77V+4GP, Al Qanawat',
      }),
    ])
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual([
      expect.objectContaining({
        operationKey,
        amount: 5_000n,
        pointA: 'G77V+4GP, Al Qanawat',
        pointB: 'G78P+J3M, Al Mouhajrin',
      }),
    ])

    const retried = await put(driver, `/shifts/${id}/operations`, {
      orders: [],
      cashDeductions: [{
        operationKey,
        amount: '50.00',
        amountOcr: '50.00',
        occurredDate: '2026-08-13',
        occurredMinute: '22:36',
        pointA: 'G777+4GP, Al Qanawat',
        pointB: null,
        source: 'ocr',
      }],
      movements: [],
    })
    expect(retried.statusCode, retried.body).toBe(200)
    expect(retried.json().br1.cashDeductionTotal).toBe('50.00')
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual([
      expect.objectContaining({
        operationKey,
        pointA: 'G77V+4GP, Al Qanawat',
        pointB: 'G78P+J3M, Al Mouhajrin',
      }),
    ])
  })

  it('uses OCR amount plus nonblank timing, not route text, for a fresh batch', async () => {
    const { id, driver } = await openShift({ float: 1_000, topup: 0 })
    const row = (
      operationKey: string,
      amount: string,
      occurredMinute: string | null,
      occurredDate: string | null,
      pointA: string,
      pointB: string | null,
    ) => ({
      operationKey,
      amount,
      amountOcr: amount,
      occurredDate,
      occurredMinute,
      pointA,
      pointB,
      source: 'ocr',
    })
    const deductions = [
      // Thaer's exact 22:36 shape: route OCR conflicts, but timing and -50 magnitude identify one.
      row('recent-orders:1010101010101010', '50.00', '22:36', '2026-08-13', 'G777+4GP, Al Qanawat', null),
      row('recent-orders:1010101010101010~2', '50.00', '22:36', '2026-08-13', 'G77V+4GP, Different place', 'Dropoff'),
      // A missing printed minute is never deduplicated.
      row('recent-orders:2020202020202020', '60.00', null, '2026-08-13', 'A', null),
      row('recent-orders:2020202020202020~2', '60.00', null, '2026-08-13', 'B', 'C'),
      // Minute, known date and OCR amount each remain real identity boundaries.
      row('recent-orders:3030303030303030', '70.00', '22:37', '2026-08-13', 'A', 'B'),
      row('recent-orders:3030303030303030~2', '70.00', '22:38', '2026-08-13', 'C', 'D'),
      row('recent-orders:4040404040404040', '80.00', '22:39', '2026-08-13', 'A', 'B'),
      row('recent-orders:4040404040404040~2', '80.00', '22:39', '2026-08-14', 'C', 'D'),
      row('recent-orders:5050505050505050', '90.00', '22:40', '2026-08-13', 'A', 'B'),
      row('recent-orders:6060606060606060', '91.00', '22:40', '2026-08-13', 'C', 'D'),
      // A missing date can be healed; two missing dates can still match inside this shift.
      row('recent-orders:7070707070707070', '40.00', '22:41', null, 'A', null),
      row('recent-orders:7070707070707070~2', '40.00', '22:41', '2026-08-13', 'C', 'D'),
      row('recent-orders:8080808080808080', '30.00', '22:42', null, 'A', null),
      row('recent-orders:8080808080808080~2', '30.00', '22:42', null, 'C', 'D'),
    ]
    const result = await put(driver, `/shifts/${id}/operations`, {
      orders: [], cashDeductions: deductions, movements: [],
    })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().br1.cashDeductionTotal).toBe('721.00')
    const stored = await h.deps.cashDeductions.listByShift(id)
    expect(stored).toHaveLength(11)
    expect(stored.find((item) => item.operationKey === 'recent-orders:7070707070707070'))
      .toMatchObject({ occurredDate: '2026-08-13', pointA: 'C', pointB: 'D' })
  })

  it('atomically heals the historical partial/full OCR overlap to one -50 deduction', async () => {
    const { id, driver } = await openShift({ float: 3_500, topup: 0 })
    const operationKey = 'recent-orders:0f0f0f0f0f0f0f0f'
    const partial = {
      operationKey,
      amount: '50.00',
      amountOcr: '50.00',
      occurredDate: null,
      occurredMinute: '22:36',
      pointA: 'G777+4GP, Al Qanawat',
      pointB: null,
      source: 'ocr',
    }
    expect((await put(driver, `/shifts/${id}/operations`, {
      orders: [],
      cashDeductions: [partial],
      movements: [],
    })).statusCode).toBe(200)

    // Reproduce the already-persisted production shape created by the older client: the first
    // screenshot held a route fragment and its overlap inserted the complete card under `~2`.
    const [persistedPartial] = await h.deps.cashDeductions.listByShift(id)
    await h.deps.cashDeductions.create({
      ...persistedPartial!,
      id: 'historical-rich-deduction',
      operationKey: `${operationKey}~2`,
      occurredDate: '2026-08-13',
      included: true,
      windowStatus: 'in_window',
      pointA: 'G77V+4GP, Al Qanawat',
      pointB: 'G78P+J3M, Al Mouhajrin',
    }, 'u-d1')
    expect(await h.deps.cashDeductions.listByShift(id)).toHaveLength(2)

    const healed = await put(driver, `/shifts/${id}/operations`, {
      orders: [],
      cashDeductions: [
        partial,
        {
          ...partial,
          operationKey: `${operationKey}~2`,
          occurredDate: '2026-08-13',
          pointA: 'G77V+4GP, Al Qanawat',
          pointB: 'G78P+J3M, Al Mouhajrin',
        },
      ],
      movements: [],
    })
    expect(healed.statusCode, healed.body).toBe(200)
    expect(healed.json().br1).toMatchObject({
      cashDeductionTotal: '50.00',
      expectedTotal: '3450.00',
    })
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual([
      expect.objectContaining({
        id: persistedPartial!.id,
        operationKey,
        amount: 5_000n,
        occurredDate: '2026-08-13',
        windowStatus: 'in_window',
        included: true,
        pointA: 'G77V+4GP, Al Qanawat',
        pointB: 'G78P+J3M, Al Mouhajrin',
      }),
    ])
  })

  it('does not heal a missing date from a same-key row with a different minute or OCR amount', async () => {
    const { id, driver } = await openShift({ float: 1_000, topup: 0 })
    const operationKey = 'recent-orders:date-heal-safety'
    const original = {
      operationKey,
      amount: '50.00',
      amountOcr: '50.00',
      occurredDate: null,
      occurredMinute: '22:36',
      pointA: 'A',
      pointB: null,
      source: 'ocr',
    }
    expect((await put(driver, `/shifts/${id}/operations`, {
      orders: [], cashDeductions: [original], movements: [],
    })).statusCode).toBe(200)

    for (const stale of [
      { ...original, occurredDate: '2026-08-13', occurredMinute: '22:37' },
      { ...original, amount: '60.00', amountOcr: '60.00', occurredDate: '2026-08-13' },
    ]) {
      const result = await put(driver, `/shifts/${id}/operations`, {
        orders: [], cashDeductions: [stale], movements: [],
      })
      expect(result.statusCode, result.body).toBe(200)
      expect(await h.deps.cashDeductions.listByShift(id)).toEqual([
        expect.objectContaining({
          operationKey,
          occurredDate: null,
          occurredMinute: '22:36',
          windowStatus: 'unknown',
        }),
      ])
    }
  })

  it('heals route conflicts but preserves edited, manual, foreign, decided, and omitted rows', async () => {
    const { id, driver } = await openShift({ float: 1_000, topup: 0 })
    const template = {
      id: '',
      shiftId: id,
      operationKey: '',
      amount: syp(50),
      occurredDate: '2026-08-13' as const,
      occurredMinute: '22:36',
      source: 'ocr' as const,
      amountOcr: syp(50),
      pointA: 'Pickup',
      pointB: null,
      included: true,
      windowStatus: 'in_window' as const,
      decisionReason: null,
      decidedBy: null,
      decidedAt: null,
      createdBy: 'u-d1',
    }
    const rows = [
      // Complete, conflicting route OCR is one timed sighting.
      { ...template, id: 'timed-1', operationKey: 'recent-orders:1111111111111111', pointA: 'Route OCR A', pointB: 'Dropoff A' },
      {
        ...template,
        id: 'timed-2',
        operationKey: 'recent-orders:1111111111111111~2',
        pointA: 'Completely different OCR',
        pointB: 'Dropoff B',
      },
      // Corrected money is no longer untouched OCR, even if the other row still is.
      {
        ...template,
        id: 'edited-1',
        operationKey: 'recent-orders:2222222222222222',
        amount: syp(60),
        amountOcr: syp(55),
        occurredMinute: '22:37',
      },
      {
        ...template,
        id: 'edited-2',
        operationKey: 'recent-orders:2222222222222222~2',
        amount: syp(60),
        amountOcr: syp(60),
        occurredMinute: '22:37',
        pointB: 'Dropoff',
      },
      // Neither a manual record nor evidence owned by somebody else is driver-OCR cleanup scope.
      {
        ...template,
        id: 'manual-1',
        operationKey: 'recent-orders:3333333333333333',
        amount: syp(70),
        amountOcr: null,
        occurredMinute: '22:38',
        source: 'manual' as const,
      },
      {
        ...template,
        id: 'manual-2',
        operationKey: 'recent-orders:3333333333333333~2',
        amount: syp(70),
        amountOcr: syp(70),
        occurredMinute: '22:38',
        pointB: 'Dropoff',
      },
      {
        ...template,
        id: 'foreign-1',
        operationKey: 'recent-orders:4444444444444444',
        amount: syp(80),
        amountOcr: syp(80),
        occurredMinute: '22:39',
        createdBy: 'u-bm',
      },
      {
        ...template,
        id: 'foreign-2',
        operationKey: 'recent-orders:4444444444444444~2',
        amount: syp(80),
        amountOcr: syp(80),
        occurredMinute: '22:39',
        pointB: 'Dropoff',
      },
      // One attributed decision protects the apparent pair from automatic deletion.
      {
        ...template,
        id: 'decided-1',
        operationKey: 'recent-orders:5555555555555555',
        amount: syp(90),
        amountOcr: syp(90),
        occurredMinute: '22:40',
      },
      {
        ...template,
        id: 'decided-2',
        operationKey: 'recent-orders:5555555555555555~2',
        amount: syp(90),
        amountOcr: syp(90),
        occurredMinute: '22:40',
        pointB: 'Dropoff',
        decisionReason: 'manager verified this row',
        decidedBy: 'u-bm',
        decidedAt: '2026-08-13T20:00:00.000Z',
      },
      // Even an otherwise-healable pair is permanent when this PUT omits it.
      {
        ...template,
        id: 'omitted-1',
        operationKey: 'recent-orders:7777777777777777',
        amount: syp(100),
        amountOcr: syp(100),
        occurredMinute: '22:41',
      },
      {
        ...template,
        id: 'omitted-2',
        operationKey: 'recent-orders:7777777777777777~2',
        amount: syp(100),
        amountOcr: syp(100),
        occurredMinute: '22:41',
        pointB: 'Dropoff',
      },
    ]
    for (const row of rows) await h.deps.cashDeductions.create(row, row.createdBy)

    const unchanged = await put(driver, `/shifts/${id}/operations`, {
      orders: [],
      cashDeductions: rows
        .filter((row) => !row.id.startsWith('omitted-'))
        .map((row) => ({
          operationKey: row.operationKey,
          amount: `${Number(row.amount) / 100}.00`,
          amountOcr: row.amountOcr === null ? null : `${Number(row.amountOcr) / 100}.00`,
          occurredDate: row.occurredDate,
          occurredMinute: row.occurredMinute,
          source: row.source,
          pointA: row.pointA,
          pointB: row.pointB,
        })),
      movements: [],
    })
    expect(unchanged.statusCode, unchanged.body).toBe(200)
    const stored = await h.deps.cashDeductions.listByShift(id)
    expect(stored).toHaveLength(rows.length - 1)
    expect(stored.some((row) => row.operationKey === 'recent-orders:1111111111111111')).toBe(true)
    expect(stored.some((row) => row.operationKey === 'recent-orders:1111111111111111~2')).toBe(false)
    for (const protectedPrefix of ['edited-', 'manual-', 'foreign-', 'decided-', 'omitted-']) {
      expect(stored.filter((row) => row.id.startsWith(protectedPrefix))).toHaveLength(2)
    }
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
