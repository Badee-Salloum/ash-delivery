import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * The notification bell (SRS A-6). A shift awaiting a manager rings the branch bell; the manager
 * sees it, marks it read, and the counter falls.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

async function submitForOpenApproval(): Promise<string> {
  const driver = await h.loginAs('driver1')
  const created = await h.app.inject({
    method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
    payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
  })
  const id = created.json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await h.app.inject({
    method: 'PUT', url: `/shifts/${id}/start-package`, headers: { cookie: h.cookie(driver) },
    payload: { odometerKm: 1, batteryPercent: 90, floatTranches: [sypStr(1_000)], topupTranches: [sypStr(1_000)] },
  })
  return id
}

describe('the branch bell', () => {
  it('rings the branch when a shift is submitted for approval', async () => {
    const shiftId = await submitForOpenApproval()
    const manager = await h.loginAs('manager')

    const bell = await h.app.inject({ method: 'GET', url: '/notifications', headers: { cookie: h.cookie(manager) } })
    expect(bell.statusCode).toBe(200)
    expect(bell.json().unreadCount).toBe(1)
    const n = (bell.json().notifications as Array<{ kind: string; payload: { shiftId: string } }>)[0]
    expect(n?.kind).toBe('shift_awaiting_open_approval')
    expect(n?.payload.shiftId).toBe(shiftId)
  })

  it('does not stack the counter when a shift is re-submitted (dedupe)', async () => {
    // A re-shoot request and re-submit is one pending item, not two.
    const shiftId = await submitForOpenApproval()
    const driver = await h.loginAs('driver1')
    // Re-submitting the same package fires the same (shift, kind) notification.
    await h.app.inject({
      method: 'PUT', url: `/shifts/${shiftId}/start-package`, headers: { cookie: h.cookie(driver) },
      payload: { odometerKm: 2, batteryPercent: 88, floatTranches: [sypStr(1_000)], topupTranches: [sypStr(1_000)] },
    })

    const manager = await h.loginAs('manager')
    const bell = await h.app.inject({ method: 'GET', url: '/notifications', headers: { cookie: h.cookie(manager) } })
    expect(bell.json().unreadCount).toBe(1)
  })

  it('another branch does not see it', async () => {
    await submitForOpenApproval()
    const aleppo = await h.loginAs('manager2')
    const bell = await h.app.inject({ method: 'GET', url: '/notifications', headers: { cookie: h.cookie(aleppo) } })
    expect(bell.json().unreadCount).toBe(0)
  })

  it('marks a notification read and drops the counter', async () => {
    await submitForOpenApproval()
    const manager = await h.loginAs('manager')

    const bell = await h.app.inject({ method: 'GET', url: '/notifications', headers: { cookie: h.cookie(manager) } })
    const id = (bell.json().notifications as Array<{ id: number }>)[0]!.id

    await h.app.inject({ method: 'POST', url: `/notifications/${id}/read`, headers: { cookie: h.cookie(manager) } })

    const after = await h.app.inject({
      method: 'GET', url: '/notifications?unreadOnly=true', headers: { cookie: h.cookie(manager) },
    })
    expect(after.json().unreadCount).toBe(0)
    expect(after.json().notifications).toHaveLength(0)
  })

  it('requires authentication', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/notifications' })).statusCode).toBe(401)
  })

  it('rings again on close submission', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await submitForOpenApproval()
    await h.app.inject({
      method: 'POST', url: `/shifts/${shiftId}/approve-open`, headers: { cookie: h.cookie(manager) },
      payload: { floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] },
    })
    await h.app.inject({
      method: 'POST', url: `/shifts/${shiftId}/orders`, headers: { cookie: h.cookie(driver) },
      payload: { providerOrderNo: 'N-1', payMode: 'cash', fee: sypStr(5_000), zone: null },
    })
    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, shiftId, 'end', slot)
    await h.app.inject({
      method: 'PUT', url: `/shifts/${shiftId}/end-package`, headers: { cookie: h.cookie(driver) },
      payload: { odometerKm: 5, batteryPercent: 40, cashDeclared: sypStr(6_000), walletDeclared: sypStr(0) },
    })

    const bell = await h.app.inject({ method: 'GET', url: '/notifications', headers: { cookie: h.cookie(manager) } })
    const kinds = (bell.json().notifications as Array<{ kind: string }>).map((n) => n.kind)
    expect(kinds).toContain('shift_awaiting_close_approval')
  })
})
