import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.app.close() })

const post = async (token: string, url: string, payload: Record<string, unknown> = {}) =>
  h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Record<string, unknown>) =>
  h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })
const get = async (token: string, url: string) =>
  h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

async function openShift(driver: string, manager: string): Promise<string> {
  const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  expect((await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })).statusCode).toBe(200)
  const approved = await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)],
  })
  expect(approved.statusCode, approved.body).toBe(200)
  return id
}

describe('driver breaks', () => {
  it('keeps the shift open past its global allowance, records excess and snapshots setting changes', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const admin = await h.loginAs('sysadmin')
    const id = await openShift(driver, manager)
    const firstId = crypto.randomUUID()

    expect((await get(admin, '/settings')).json().breakLimitMinutes).toBe(60)
    const started = await post(driver, `/shifts/${id}/break/start`, { breakId: firstId })
    expect(started.statusCode, started.body).toBe(200)
    expect(started.json().activeBreak.id).toBe(firstId)
    expect((await h.deps.shifts.findById(id))?.state).toBe('open')

    h.deps.clock.advance(65 * 60_000)
    const active = (await get(driver, `/shifts/${id}/state`)).json().break
    expect(active.totalBreakMs).toBe(65 * 60_000)
    expect(active.overLimitMs).toBe(5 * 60_000)
    expect(active.activeBreak.id).toBe(firstId)
    expect(active.activeBreak.endedAtMs).toBeNull()

    const resumed = await post(driver, `/shifts/${id}/break/${firstId}/resume`)
    expect(resumed.statusCode, resumed.body).toBe(200)
    expect(resumed.json().activeBreak).toBeNull()
    expect(resumed.json().breaks[0]).toMatchObject({ endReason: 'driver_resumed', limitMinutes: 60, overLimitMs: 5 * 60_000 })

    const changed = await put(admin, '/settings', { breakLimitMinutes: 90 })
    expect(changed.statusCode, changed.body).toBe(200)
    expect((await get(driver, `/shifts/${id}/break`)).json().limitMinutes).toBe(90)
    h.deps.clock.advance(30 * 60_000) // actual work between the two pauses
    const secondId = crypto.randomUUID()
    await post(driver, `/shifts/${id}/break/start`, { breakId: secondId })
    h.deps.clock.advance(30 * 60_000)
    const second = (await get(driver, `/shifts/${id}/break`)).json()
    expect(second.limitMinutes).toBe(90)
    expect(second.totalBreakMs).toBe(95 * 60_000)
    expect(second.overLimitMs).toBe(5 * 60_000)
    expect(second.breaks.map((entry: { limitMinutes: number }) => entry.limitMinutes)).toEqual([60, 90])
    expect((await h.deps.shifts.findById(id))?.state).toBe('open')

    await post(driver, `/shifts/${id}/break/${secondId}/resume`)
    const shift = (await h.deps.shifts.findById(id))!
    await h.deps.shifts.update({ ...shift, state: 'pending_review', submittedAt: new Date(h.deps.clock.nowMs()).toISOString() }, 'u-d1')
    const list = await get(manager, `/shifts?date=${shift.businessDate}`)
    expect(list.statusCode, list.body).toBe(200)
    const listed = list.json().shifts.find((row: { id: string }) => row.id === id)
    expect(listed.break.totalBreakMs).toBe(95 * 60_000)
    expect(listed.worked.minutes).toBe(30)
  })

  it('retries start and resume without opening or ending another break', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    const firstId = crypto.randomUUID()
    expect((await post(driver, `/shifts/${id}/break/start`, { breakId: firstId })).statusCode).toBe(200)
    expect((await post(driver, `/shifts/${id}/break/start`, { breakId: firstId })).json().breaks).toHaveLength(1)
    const different = await post(driver, `/shifts/${id}/break/start`, { breakId: crypto.randomUUID() })
    expect(different.statusCode).toBe(409)
    expect(different.json().error).toBe('break_already_active')

    h.deps.clock.advance(15 * 60_000)
    expect((await post(driver, `/shifts/${id}/break/${firstId}/resume`)).statusCode).toBe(200)
    expect((await post(driver, `/shifts/${id}/break/${firstId}/resume`)).json().totalBreakMs).toBe(15 * 60_000)
    expect((await post(driver, `/shifts/${id}/break/start`, { breakId: firstId })).json().breaks).toHaveLength(1)
    const nextId = crypto.randomUUID()
    expect((await post(driver, `/shifts/${id}/break/start`, { breakId: nextId })).json().activeBreak.id).toBe(nextId)
    // A late retry for the old resume must leave the new active break untouched.
    expect((await post(driver, `/shifts/${id}/break/${firstId}/resume`)).json().activeBreak.id).toBe(nextId)
  })

  it('blocks normal close and records a manager suspension as the break end', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    const breakId = crypto.randomUUID()
    await post(driver, `/shifts/${id}/break/start`, { breakId })
    h.deps.clock.advance(12 * 60_000)

    const close = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 120, batteryPercent: 50, cashDeclared: sypStr(100_000), walletDeclared: sypStr(50_000),
    })
    expect(close.statusCode).toBe(409)
    expect(close.json().error).toBe('break_active')

    const suspended = await post(manager, `/shifts/${id}/suspend`, { notes: 'incident' })
    expect(suspended.statusCode, suspended.body).toBe(200)
    const after = (await get(driver, `/shifts/${id}/state`)).json().break
    expect(after.activeBreak).toBeNull()
    expect(after.breaks[0]).toMatchObject({ endReason: 'manager_suspended', endedAtMs: h.deps.clock.nowMs() })
    expect((await post(driver, `/shifts/${id}/break/start`, { breakId: crypto.randomUUID() })).statusCode).toBe(409)
  })

  it('ends a live break when the manager voids the shift, with an auditable reason', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    await post(driver, `/shifts/${id}/break/start`, { breakId: crypto.randomUUID() })
    h.deps.clock.advance(10 * 60_000)
    const voided = await post(manager, `/shifts/${id}/void`, { reason: 'Vehicle unavailable' })
    expect(voided.statusCode, voided.body).toBe(200)
    const records = await h.deps.breaks.listByShift(id)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ endReason: 'manager_voided', endedAtMs: h.deps.clock.nowMs() })
  })

  it('ends a live break at the manager force-close boundary', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    await post(driver, `/shifts/${id}/break/start`, { breakId: crypto.randomUUID() })
    h.deps.clock.advance(10 * 60_000)
    const boundary = await post(manager, `/shifts/${id}/force-close`, {
      prepareOnly: true,
      reason: 'Driver phone unavailable',
      odometerKm: 110,
      cashDeclared: sypStr(100_000),
      walletDeclared: sypStr(50_000),
    })
    expect(boundary.statusCode, boundary.body).toBe(200)
    expect(boundary.json()).toMatchObject({ state: 'pending_review', prepared: true })
    expect((await h.deps.breaks.listByShift(id))[0]).toMatchObject({
      endReason: 'manager_force_closed', endedAtMs: h.deps.clock.nowMs(),
    })
  })

  it('serializes a driver resume against a manager void', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    const breakId = crypto.randomUUID()
    await post(driver, `/shifts/${id}/break/start`, { breakId })
    const [resumed, voided] = await Promise.all([
      post(driver, `/shifts/${id}/break/${breakId}/resume`),
      post(manager, `/shifts/${id}/void`, { reason: 'Shift cancelled by manager' }),
    ])
    expect(resumed.statusCode, resumed.body).toBe(200)
    expect(voided.statusCode, voided.body).toBe(200)
    expect((await h.deps.shifts.findById(id))?.state).toBe('cancelled')
    const rows = await h.deps.breaks.listByShift(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.endedAtMs).not.toBeNull()
    expect(['driver_resumed', 'manager_voided']).toContain(rows[0]?.endReason)
  })
})
