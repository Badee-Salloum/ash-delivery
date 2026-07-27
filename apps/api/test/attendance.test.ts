import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Harness, makeHarness } from './harness.ts'

/**
 * Admin-staff attendance (SRS B-4 / س41) — «نفس تسجيل الدخول اليومي».
 *
 * The daily login IS the attendance record. What matters: a branch staffer's request stamps one
 * row per day (a second request bumps last-seen, it does not add a row); drivers are NOT recorded
 * here (their shifts are their record); and an organisation-wide role, having no branch, stamps
 * nothing. The read is branch-scoped and permissioned like the rest of the branch surface.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

describe('attendance (SRS B-4 / س41)', () => {
  it('records a branch manager’s daily login, resolved to his name', async () => {
    const manager = await h.loginAs('manager')
    const res = await get(manager, '/attendance')
    expect(res.statusCode, res.body).toBe(200)
    const rows = res.json().attendance as Array<{ userId: string; name: string }>
    expect(rows.find((r) => r.userId === 'u-bm')).toBeTruthy()
  })

  it('stamps one row per day — a second request bumps last-seen, it does not add a row', async () => {
    const manager = await h.loginAs('manager')
    await get(manager, '/notifications')
    await get(manager, '/notifications')
    await get(manager, '/notifications')
    const forManager = h.deps.attendance.rows.filter((r) => r.userId === 'u-bm')
    expect(forManager).toHaveLength(1)
  })

  it('does NOT record a driver — his shifts are his attendance, not his logins', async () => {
    const driver = await h.loginAs('driver1')
    await get(driver, '/notifications') // an endpoint a driver may reach
    expect(h.deps.attendance.rows.some((r) => r.userId === 'u-d1')).toBe(false)
  })

  it('does NOT record an organisation-wide role — it has no branch to stamp', async () => {
    const gm = await h.loginAs('gm')
    await get(gm, '/notifications')
    expect(h.deps.attendance.rows.some((r) => r.userId === 'u-gm')).toBe(false)
  })

  it('the read is refused to a driver, like the rest of the branch surface', async () => {
    const driver = await h.loginAs('driver1')
    expect((await get(driver, '/attendance')).statusCode).toBe(403)
  })
})
