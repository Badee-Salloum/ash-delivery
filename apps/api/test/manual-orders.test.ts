import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * Manual orders (Section C, new). A missing order is a cause BR1 ranks at close, but only the
 * operating driver could add one, and only while open. Now a higher-level manager can add a manual
 * order to RECONCILE a shift — through pending_review, forcing a re-review — and a driver can
 * REQUEST one when he can no longer add it himself.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
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

async function toPendingReview(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  await post(driver, `/shifts/${id}/orders`, { providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000), zone: null })
  for (const slot of ['dashboard', 'wallet', 'odometer', 'wallet_zeroed']) await h.uploadPhoto(driver, id, 'end', slot)
  await put(driver, `/shifts/${id}/end-package`, { odometerKm: 110, batteryPercent: 50, cashDeclared: sypStr(105_000), walletDeclared: sypStr(0) })
  return id
}

describe('manual orders', () => {
  it('a manager reconciles a shift under review by adding a manual order, forcing a re-review', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toPendingReview(driver, manager)

    const hashBefore = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash as string

    const added = await post(manager, `/shifts/${id}/orders/manual`, { providerOrderNo: 'MISSED-9', payMode: 'cash', fee: sypStr(5_000), zone: null })
    expect(added.statusCode, added.body).toBe(201)

    const review = (await get(manager, `/shifts/${id}/review`)).json()
    expect((review.orders as Array<{ providerOrderNo: string }>).some((o) => o.providerOrderNo === 'MISSED-9')).toBe(true)
    // The orders hash moved, so approving on the reviewed-before hash is refused — the manager must
    // re-review the reconciled numbers before he can approve.
    expect(review.br1.ordersHash).not.toBe(hashBefore)

    // It is audited — it moved money into BR1.
    const audited = await h.deps.audit.list({ tableName: 'shift_orders', recordId: added.json().id })
    expect(audited.some((a) => a.actorId === 'u-bm')).toBe(true)
  })

  it('a driver requests a manual order — the branch bell rings with the proposal', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toPendingReview(driver, manager)

    const res = await post(driver, `/shifts/${id}/orders/request`, { providerOrderNo: 'FORGOT-3', payMode: 'electronic', fee: sypStr(5_000), zone: null })
    expect(res.statusCode, res.body).toBe(202)

    const note = h.deps.notifications.rows.find((n) => n.kind === 'manual_order_requested' && n.recipientId === 'branch:branch-damascus')
    expect(note?.payload).toMatchObject({ shiftId: id, providerOrderNo: 'FORGOT-3', fee: sypStr(5_000) })
  })

  it('a driver may not add a manager manual order; a duplicate order number is refused', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toPendingReview(driver, manager)

    expect((await post(driver, `/shifts/${id}/orders/manual`, { providerOrderNo: 'X-1', payMode: 'cash', fee: sypStr(1_000), zone: null })).statusCode).toBe(403)

    // 'A-1' already exists on this shift (the driver recorded it).
    const dup = await post(manager, `/shifts/${id}/orders/manual`, { providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000), zone: null })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error).toBe('duplicate_order_no')
  })
})
