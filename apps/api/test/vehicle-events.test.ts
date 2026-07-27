import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * The vehicle life log (SRS B-2 / س66) — «سجل حياة يجمع كل الأحداث والكلف».
 *
 * Three ways an entry lands in it, all proven here: a state change logs itself, a vehicle-cost
 * expense links itself in (cost + expenseId), and the manager records maintenance/incident/charge/
 * odometer by hand. The timeline reads newest-first, and «state_change» can never be typed by hand.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const post = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const patch = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PATCH', url, headers: { cookie: h.cookie(token) }, payload })

const events = async (token: string): Promise<Array<Record<string, unknown>>> =>
  (await get(token, `/vehicles/${VEHICLE_ID}/events`)).json().events

describe('vehicle life log (SRS B-2 / س66)', () => {
  it('a state change logs itself to the vehicle history', async () => {
    const manager = await h.loginAs('manager')
    expect((await patch(manager, `/vehicles/${VEHICLE_ID}`, { state: 'charging' })).statusCode).toBe(200)

    const log = await events(manager)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ kind: 'state_change', notes: 'ready → charging' })
  })

  it('a vehicle-cost expense links itself into the log, carrying its cost and id', async () => {
    const admin = await h.loginAs('sysadmin')
    const categoryId = (await post(admin, '/expense-categories', { code: 'TYRE', nameAr: 'إطار' })).json().id

    const manager = await h.loginAs('manager')
    const expense = await post(manager, '/expenses', {
      categoryId,
      costCenterKind: 'vehicle',
      vehicleId: VEHICLE_ID,
      amount: sypStr(7500),
      description: 'إطار خلفي',
    })
    expect(expense.statusCode, expense.body).toBe(201)

    const log = await events(manager)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ kind: 'maintenance', cost: sypStr(7500), expenseId: expense.json().id })
  })

  it('a manager records a maintenance event by hand — with cost and odometer', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, `/vehicles/${VEHICLE_ID}/events`, {
      kind: 'maintenance', odometerKm: 12_340, cost: sypStr(5000), notes: 'تبديل زيت',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ kind: 'maintenance', odometerKm: 12_340, cost: sypStr(5000), notes: 'تبديل زيت' })

    const rows = await h.deps.audit.list({ tableName: 'vehicle_events' })
    expect(rows.some((r) => r.actorId === 'u-bm')).toBe(true)
  })

  it('lists the whole history newest-first', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, `/vehicles/${VEHICLE_ID}/events`, { kind: 'charge', notes: 'first' })
    await post(manager, `/vehicles/${VEHICLE_ID}/events`, { kind: 'incident', notes: 'second' })

    const log = await events(manager)
    expect(log.map((e) => e.notes)).toEqual(['second', 'first'])
  })

  it('refuses «state_change» as a hand-typed event — that kind is automatic only', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, `/vehicles/${VEHICLE_ID}/events`, { kind: 'state_change', notes: 'nope' })
    expect(res.statusCode).toBe(400)
  })

  it('a driver may not write the fleet log; an unknown vehicle is refused, not served', async () => {
    const driver = await h.loginAs('driver1')
    expect((await post(driver, `/vehicles/${VEHICLE_ID}/events`, { kind: 'charge' })).statusCode).toBe(403)

    // A branch manager naming a vehicle that isn't his branch's (here, one that doesn't exist) is
    // refused by the scope guard before the handler — the same guard the whole fleet surface uses.
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/vehicles/does-not-exist/events', { kind: 'charge' })).statusCode).toBe(403)
  })
})
