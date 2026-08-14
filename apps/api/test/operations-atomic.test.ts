import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OperationBatch, OperationBatchResult } from '@ash/contracts'
import { minor } from '@ash/domain'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

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

async function openShift(): Promise<{ id: string; driver: string }> {
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
    floatTranches: [sypStr(100)],
    topupTranches: [sypStr(20)],
  })).statusCode).toBe(200)
  return { id, driver }
}

const completePage = {
  orders: [{
    providerOrderNo: 'ATOMIC-ORDER',
    payMode: 'cash',
    fee: '10.00',
    occurredDate: '2026-07-21',
    occurredMinute: '08:05',
  }],
  cashDeductions: [{
    operationKey: 'atomic-deduction',
    amount: '2.00',
    occurredDate: '2026-07-21',
    occurredMinute: '08:06',
  }],
  movements: [{ amount: '3.00', occurredMinute: '08:07' }],
}

type Apply = (
  shiftId: string,
  batch: OperationBatch,
  actorId: string | null,
) => Promise<OperationBatchResult>

const replaceApply = (replacement: Apply): Apply => {
  const original = h.deps.operationBatches.apply.bind(h.deps.operationBatches)
  h.deps.operationBatches.apply = replacement
  return original
}

describe('atomic operation submission conflicts', () => {
  it('preserves a racing manager decision and maps its stale decidedAt guard to 409', async () => {
    const { id, driver } = await openShift()
    expect((await put(driver, `/shifts/${id}/operations`, {
      orders: [completePage.orders[0]],
      movements: [],
    })).statusCode).toBe(200)

    const managerDecidedAt = new Date(h.deps.clock.nowMs() + 1_000).toISOString()
    const originalApply = h.deps.operationBatches.apply.bind(h.deps.operationBatches)
    h.deps.operationBatches.apply = async (shiftId, batch, actorId) => {
      const current = (await h.deps.orders.listByShift(id)).find(
        (row) => row.providerOrderNo === 'ATOMIC-ORDER',
      )!
      await h.deps.orders.update({
        ...current,
        fee: minor(9_00n),
        decisionReason: null,
        decidedBy: 'u-bm',
        decidedAt: managerDecidedAt,
      }, 'u-bm')
      return await originalApply(shiftId, batch, actorId)
    }

    const pageWithAnEarlierCreate = {
      ...completePage,
      orders: [
        completePage.orders[0],
        {
          providerOrderNo: 'ATOMIC-ORDER-NEW',
          payMode: 'cash',
          fee: '4.00',
          occurredDate: '2026-07-21',
          occurredMinute: '08:04',
        },
      ],
    }
    let response: LightMyRequestResponse
    try {
      response = await put(driver, `/shifts/${id}/operations`, pageWithAnEarlierCreate)
    } finally {
      h.deps.operationBatches.apply = originalApply
    }

    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error).toBe('operations_changed_concurrently')
    expect(await h.deps.orders.listByShift(id)).toEqual([
      expect.objectContaining({
        providerOrderNo: 'ATOMIC-ORDER',
        fee: minor(9_00n),
        decidedBy: 'u-bm',
        decidedAt: managerDecidedAt,
      }),
    ])
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual([])
    expect(await h.deps.movements.listByShift(id)).toEqual([])
  })

  it('maps a racing duplicate cash deduction to a 409 retry response', async () => {
    const { id, driver } = await openShift()
    const originalApply = replaceApply(async () => {
      throw Object.assign(new Error('racing cash deduction insert'), {
        code: 'DUPLICATE_CASH_DEDUCTION',
      })
    })

    let response: LightMyRequestResponse
    try {
      response = await put(driver, `/shifts/${id}/operations`, completePage)
    } finally {
      h.deps.operationBatches.apply = originalApply
    }

    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error).toBe('operations_changed_concurrently')
    expect(await h.deps.orders.listByShift(id)).toEqual([])
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual([])
    expect(await h.deps.movements.listByShift(id)).toEqual([])
  })

  it('maps a same-shift duplicate order won by a racing batch to 409', async () => {
    const { id, driver } = await openShift()
    const originalApply = replaceApply(async (_shiftId, batch) => {
      await h.deps.orders.create(batch.orderCreates[0]!, 'racing-driver')
      throw Object.assign(new Error('racing order insert'), { code: 'DUPLICATE_ORDER_NO' })
    })

    let response: LightMyRequestResponse
    try {
      response = await put(driver, `/shifts/${id}/operations`, completePage)
    } finally {
      h.deps.operationBatches.apply = originalApply
    }

    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error).toBe('operations_changed_concurrently')
    expect((await h.deps.orders.listByShift(id)).map((row) => row.providerOrderNo)).toEqual([
      'ATOMIC-ORDER',
    ])
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual([])
    expect(await h.deps.movements.listByShift(id)).toEqual([])
  })
})

describe('operation dates at the wire boundary', () => {
  it.each([
    {
      label: 'order',
      payload: {
        orders: [{
          providerOrderNo: 'IMPOSSIBLE-DATE',
          payMode: 'cash',
          fee: '10.00',
          occurredDate: '2026-02-31',
          occurredMinute: '08:05',
        }],
        movements: [],
      },
    },
    {
      label: 'cash deduction',
      payload: {
        orders: [],
        cashDeductions: [{
          operationKey: 'impossible-date',
          amount: '2.00',
          occurredDate: '2026-02-31',
          occurredMinute: '08:06',
        }],
        movements: [],
      },
    },
  ])('rejects an impossible $label occurredDate as invalid_request before persistence', async ({ payload }) => {
    const { id, driver } = await openShift()
    const response = await put(driver, `/shifts/${id}/operations`, payload)

    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().error).toBe('invalid_request')
    expect(await h.deps.orders.listByShift(id)).toEqual([])
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual([])
  })
})
