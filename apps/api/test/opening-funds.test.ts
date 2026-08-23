import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })

async function awaitingOpen(driver: string): Promise<string> {
  const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })
  const id = created.json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  const submitted = await h.app.inject({
    method: 'PUT',
    url: `/shifts/${id}/start-package`,
    headers: { cookie: h.cookie(driver) },
    payload: { odometerKm: 100, batteryPercent: 90 },
  })
  expect(submitted.statusCode, submitted.body).toBe(200)
  return id
}

describe('opening fund tranches', () => {
  it('opens with both zero-value inputs represented by empty arrays', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await awaitingOpen(driver)

    const response = await post(manager, `/shifts/${id}/approve-open`, {
      floatTranches: [],
      topupTranches: [],
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().state).toBe('open')
    expect((await h.deps.shifts.findById(id))?.floatTranches).toEqual([])
    expect((await h.deps.shifts.findById(id))?.topupTranches).toEqual([])
    expect(h.deps.ledger.entries.filter((entry) =>
      entry.eventType === 'float_out' || entry.eventType === 'wallet_topup')).toEqual([])
  })

  it('opens with positive float and top-up values', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await awaitingOpen(driver)

    const response = await post(manager, `/shifts/${id}/approve-open`, {
      floatTranches: [sypStr(100_000)],
      topupTranches: [sypStr(50_000)],
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'float_out')).toHaveLength(1)
    expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'wallet_topup')).toHaveLength(1)
  })

  it.each([
    ['blank float element', { floatTranches: [''], topupTranches: [] }],
    ['blank top-up element', { floatTranches: [], topupTranches: [''] }],
    ['zero float element', { floatTranches: ['0'], topupTranches: [] }],
    ['zero top-up element', { floatTranches: [], topupTranches: ['0.00'] }],
    ['both zero elements', { floatTranches: ['0'], topupTranches: ['0'] }],
    ['negative element', { floatTranches: ['-1.00'], topupTranches: [] }],
    ['mixed valid and zero elements', { floatTranches: [sypStr(10), '0'], topupTranches: [] }],
    ['zero carried element', { floatTranches: [], topupTranches: [], carriedTranches: ['0'] }],
  ])('rejects %s at the request boundary', async (_case, payload) => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await awaitingOpen(driver)

    const response = await post(manager, `/shifts/${id}/approve-open`, payload)

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_request')
    expect((await h.deps.shifts.findById(id))?.state).toBe('awaiting_open_approval')
    expect(h.deps.ledger.entries).toEqual([])
  })
})
