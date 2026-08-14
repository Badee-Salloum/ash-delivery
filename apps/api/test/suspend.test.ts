import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, DRIVER_ID, type Harness, VEHICLE_ID, approveFixedClose, makeHarness, sypStr } from './harness.ts'

/**
 * Suspended / mid-shift incident (SRS C-1 / س29). A manager puts a live shift on hold; the driver
 * resumes it from his phone. Orders still record while suspended, and a suspended shift closes
 * under the SAME BR1 — a suspension is never a way around the zero equation. The driver can't
 * suspend himself (that's a manager act) — he reports the incident, which rings the branch bell.
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

async function openShift(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 15_320, batteryPercent: 95 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] })
  return id
}

let seq = 0
async function addOrder(driver: string, id: string, payMode: string): Promise<LightMyRequestResponse> {
  seq += 1
  return await post(driver, `/shifts/${id}/orders`, { providerOrderNo: `YAL-${seq}`, payMode, fee: sypStr(5_000), zone: 'المزة' })
}
async function addOrders(driver: string, id: string, payMode: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) expect((await addOrder(driver, id, payMode)).statusCode).toBe(201)
}

/** The SRS §2.3 balanced end package (160,000 cash · 70,000 wallet) after 12 cash / 6 electronic / 2 free. */
async function submitBalancedEnd(driver: string, id: string): Promise<LightMyRequestResponse> {
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  return await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 15_412,
    batteryPercent: 22,
    cashDeclared: sypStr(160_000),
    walletDeclared: sypStr(70_000),
  })
}

async function approveClose(manager: string, id: string): Promise<LightMyRequestResponse> {
  const hash = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash as string
  return await approveFixedClose(h, manager, id, hash)
}

describe('suspended shifts (C-1)', () => {
  beforeEach(() => {
    seq = 0
  })

  it('a manager suspends an open shift; orders still record; the driver resumes and closes at zero', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    await addOrders(driver, id, 'cash', 12)

    const suspended = await post(manager, `/shifts/${id}/suspend`, { notes: 'عطل في الدراجة' })
    expect(suspended.statusCode, suspended.body).toBe(200)
    expect(suspended.json().state).toBe('suspended')

    // The driver is told his shift was put on hold — not a silent freeze.
    const note = h.deps.notifications.rows.find((n) => n.kind === 'shift_suspended' && n.recipientId === 'u-d1')
    expect(note?.payload).toMatchObject({ shiftId: id, notes: 'عطل في الدراجة' })

    // Orders keep recording while suspended (the data is completed later under the same equation).
    await addOrders(driver, id, 'electronic', 6)
    await addOrders(driver, id, 'free', 2)

    const resumed = await post(driver, `/shifts/${id}/resume`)
    expect(resumed.statusCode, resumed.body).toBe(200)
    expect(resumed.json().state).toBe('open')

    const end = await submitBalancedEnd(driver, id)
    expect(end.statusCode, end.body).toBe(200)
    expect(end.json().state).toBe('pending_review')
    expect(end.json().br1.balanced).toBe(true)

    const closed = await approveClose(manager, id)
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().state).toBe('approved')
  })

  it('a suspended shift closes directly (suspended → pending_review) under the same BR1', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    await addOrders(driver, id, 'cash', 12)
    await addOrders(driver, id, 'electronic', 6)
    await addOrders(driver, id, 'free', 2)

    expect((await post(manager, `/shifts/${id}/suspend`, { notes: null })).json().state).toBe('suspended')

    // No resume: the driver submits the end package straight from suspended.
    const end = await submitBalancedEnd(driver, id)
    expect(end.statusCode, end.body).toBe(200)
    expect(end.json().state).toBe('pending_review')
    expect(end.json().br1.balanced).toBe(true)

    expect((await approveClose(manager, id)).json().state).toBe('approved')
  })

  it('a driver may not suspend; a manager may not resume — the permissions are the mirror of each other', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    // suspend is shift.approve — the driver is refused.
    expect((await post(driver, `/shifts/${id}/suspend`, { notes: null })).statusCode).toBe(403)

    expect((await post(manager, `/shifts/${id}/suspend`, { notes: null })).json().state).toBe('suspended')

    // resume is shift.operate — the manager is refused; only the driver resumes his own shift.
    expect((await post(manager, `/shifts/${id}/resume`)).statusCode).toBe(403)
    expect((await post(driver, `/shifts/${id}/resume`)).json().state).toBe('open')
  })

  it('a driver reports a mid-shift incident — the branch bell rings with the note', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    const res = await post(driver, `/shifts/${id}/report-incident`, { notes: 'حادث بسيط، بانتظار الشرطة' })
    expect(res.statusCode, res.body).toBe(202)

    const note = h.deps.notifications.rows.find((n) => n.kind === 'shift_incident_reported' && n.recipientId === `branch:${BRANCH}`)
    expect(note?.payload).toMatchObject({ shiftId: id, driverId: DRIVER_ID, notes: 'حادث بسيط، بانتظار الشرطة' })
  })
})
