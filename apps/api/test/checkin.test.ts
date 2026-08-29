import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, type Harness, makeHarness, today } from './harness.ts'

/**
 * «التفقّد» (owner request, 2026-08-29) — the branch manager proving he was AT the branch at the
 * times he is expected there: «تسجيل الدخول عالساعة 1 و 5 و 10».
 *
 * Two properties are load-bearing and are asserted here rather than assumed:
 *
 *   • **It never blocks.** A manager outside the fence, outside the window, or with no window at
 *     all still gets a 201 and a recorded row. A check-in that could stop a manager working would
 *     be one GPS outage away from stopping the branch.
 *   • **Drivers are excluded**, per «هذه ستطبق على حساب مدير الفرع و ليس السائقين».
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
const post = async (token: string, url: string, payload: unknown = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload: payload as object })
const put = async (token: string, url: string, payload: unknown = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload: payload as object })
const del = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'DELETE', url, headers: { cookie: h.cookie(token) } })

/** Damascus. The harness clock stands at 08:00 branch-local, i.e. minute 480. */
const BRANCH_LAT = 33.5138
const BRANCH_LNG = 36.2765
const AT_BRANCH = { lat: BRANCH_LAT, lng: BRANCH_LNG, accuracyM: 12, note: null }
/** ~7 km north — well outside any plausible fence, and not a rounding artefact. */
const AWAY = { lat: 33.5768, lng: BRANCH_LNG, accuracyM: 12, note: null }
const NOW_MINUTE = 480

const placeBranch = async (radius = 150): Promise<void> => {
  const admin = await h.loginAs('sysadmin')
  const res = await put(admin, '/branch-location', {
    branchId: BRANCH,
    lat: BRANCH_LAT,
    lng: BRANCH_LNG,
    checkinRadiusM: radius,
  })
  expect(res.statusCode, res.body).toBe(200)
}

const addWindow = async (atMinute: number, over: Record<string, unknown> = {}): Promise<string> => {
  const admin = await h.loginAs('sysadmin')
  const res = await post(admin, '/checkin-windows', {
    branchId: BRANCH,
    userId: 'u-bm',
    atMinute,
    toleranceMinutes: 30,
    label: null,
    ...over,
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json().id as string
}

describe('the rota', () => {
  it('names a user, not a role, so a stand-in does not silently inherit the round', async () => {
    const id = await addWindow(60, { label: 'الجولة الأولى' })
    const manager = await h.loginAs('manager')
    const res = await get(manager, '/checkin-windows')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().windows).toEqual([
      { id, userId: 'u-bm', atMinute: 60, toleranceMinutes: 30, label: 'الجولة الأولى' },
    ])
  })

  it('refuses a driver, who is on the road, so a rota of office rounds is a queue of misses', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/checkin-windows', {
      branchId: BRANCH,
      userId: 'u-d1',
      atMinute: 60,
      toleranceMinutes: 30,
      label: null,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('checkin_not_for_drivers')
  })

  it('refuses a user from another branch', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/checkin-windows', {
      branchId: BRANCH,
      userId: 'u-bm2',
      atMinute: 60,
      toleranceMinutes: 30,
      label: null,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('user_in_another_branch')
  })

  it('refuses the same time twice, so one 01:00 is answered by one check-in', async () => {
    await addWindow(60)
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/checkin-windows', {
      branchId: BRANCH,
      userId: 'u-bm',
      atMinute: 60,
      toleranceMinutes: 45,
      label: null,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('checkin_window_exists')
  })

  it('retires a round without erasing it, so yesterday still explains itself', async () => {
    const id = await addWindow(60)
    const admin = await h.loginAs('sysadmin')
    expect((await del(admin, `/checkin-windows/${id}?branchId=${BRANCH}`)).statusCode).toBe(200)
    const manager = await h.loginAs('manager')
    expect((await get(manager, '/checkin-windows')).json().windows).toEqual([])
    // Retired, not deleted.
    expect(h.deps.checkIns.windows.find((w) => w.id === id)?.active).toBe(false)
  })
})

describe('pressing the check-in button', () => {
  it('records on_time from inside the fence during the window', async () => {
    await placeBranch()
    const windowId = await addWindow(NOW_MINUTE)
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/checkins', { branchId: BRANCH, ...AT_BRANCH })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({
      userId: 'u-bm',
      businessDate: today,
      windowId,
      insideArea: true,
      minutesFromTarget: 0,
      verdict: 'on_time',
    })
    expect(res.json().distanceM).toBeLessThan(5)
  })

  it('records rather than refuses when the manager is far away', async () => {
    await placeBranch()
    await addWindow(NOW_MINUTE)
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/checkins', { branchId: BRANCH, ...AWAY })
    // 201, NOT 4xx. The row is the point: refusing it would lose the evidence it exists to keep.
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().verdict).toBe('outside_area')
    expect(res.json().insideArea).toBe(false)
    expect(res.json().distanceM).toBeGreaterThan(6_000)
  })

  it('records outside_window when no round is open, instead of throwing it away', async () => {
    await placeBranch()
    await addWindow(60) // 01:00 — seven hours from the harness clock.
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/checkins', { branchId: BRANCH, ...AT_BRANCH })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ verdict: 'outside_window', windowId: null, minutesFromTarget: null })
  })

  it('refuses only when the branch has no location, because measuring against (0,0) would be a lie', async () => {
    const admin = await h.loginAs('sysadmin')
    await put(admin, '/branch-location', { branchId: BRANCH, lat: null, lng: null, checkinRadiusM: 150 })
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/checkins', { branchId: BRANCH, ...AT_BRANCH })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('branch_location_not_set')
  })

  it('attributes the check-in to the caller, never to a user named in the body', async () => {
    await placeBranch()
    await addWindow(NOW_MINUTE)
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/checkins', { branchId: BRANCH, ...AT_BRANCH, userId: 'u-gm' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().userId).toBe('u-bm')
  })
})

describe('the roll-call for the day', () => {
  it('shows the round nobody answered, the row a report of what happened cannot have', async () => {
    await placeBranch()
    await addWindow(NOW_MINUTE)
    const missedId = await addWindow(1_200) // 20:00, still ahead of the harness clock.
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/checkins', { branchId: BRANCH, ...AT_BRANCH })).statusCode).toBe(201)

    const res = await get(manager, '/checkins')
    expect(res.statusCode, res.body).toBe(200)
    const rounds = res.json().people.find((p: { userId: string }) => p.userId === 'u-bm').rounds
    expect(rounds).toHaveLength(2)
    expect(rounds[0]).toMatchObject({ atMinute: NOW_MINUTE, status: 'on_time' })
    expect(rounds[1]).toMatchObject({ windowRef: missedId, atMinute: 1_200, status: 'missed', distanceMetres: null })
  })

  it('lets the best answer stand when he checked in from the road, then from the office', async () => {
    await placeBranch()
    await addWindow(NOW_MINUTE)
    const manager = await h.loginAs('manager')
    await post(manager, '/checkins', { branchId: BRANCH, ...AWAY })
    await post(manager, '/checkins', { branchId: BRANCH, ...AT_BRANCH })

    const res = await get(manager, '/checkins')
    const rounds = res.json().people.find((p: { userId: string }) => p.userId === 'u-bm').rounds
    expect(rounds[0].status).toBe('on_time')
    // Both rows survive — the report summarises, the record of check-ins does not forget.
    expect(res.json().checkIns).toHaveLength(2)
  })

  it('reports the branch radius, so a reader can see what inside meant that day', async () => {
    await placeBranch(300)
    const manager = await h.loginAs('manager')
    expect((await get(manager, '/checkins')).json().radiusM).toBe(300)
  })
})

describe('the fence itself', () => {
  it('can be cleared, which switches the rounds off rather than leaving an unsatisfiable fence', async () => {
    await placeBranch()
    const admin = await h.loginAs('sysadmin')
    const res = await put(admin, '/branch-location', {
      branchId: BRANCH,
      lat: null,
      lng: null,
      checkinRadiusM: 150,
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ lat: null, lng: null })
  })

  it('is settings.write, so a branch manager cannot move his own goalposts', async () => {
    const manager = await h.loginAs('manager')
    const res = await put(manager, '/branch-location', {
      branchId: BRANCH,
      lat: BRANCH_LAT,
      lng: BRANCH_LNG,
      checkinRadiusM: 20_000,
    })
    expect(res.statusCode).toBe(403)
  })
})

/**
 * OWNER RULE (2026-08-29): «لا يجب ان يستطيع مدير الفرع تغير اعدادت التفقد فقط مدير النظام /
 * مدير الفرع فقط يسجل الدخول».
 *
 * The person being checked on must not own the check. Every write that DEFINES the check — when a
 * round is expected, whether it still stands, and where "here" is — is `settings.write`, which the
 * §3 matrix grants to the system admin alone; production's `role_permissions` was read on the day
 * this was written and holds exactly that one row. Everything the branch manager needs in order to
 * ANSWER a round is `branch_data.view`, which he already has.
 *
 * The general manager is refused too, and that is the point of testing him separately: he holds
 * `branch_data.view` at scope 'all', so an authorisation bug that leaked configuration to "whoever
 * can see the branch" would pass every branch-manager test above and still hand him the rota.
 */
describe('only the system admin defines the check', () => {
  const configWrites = (branch: string) =>
    [
      {
        what: 'adding a round',
        call: (token: string) =>
          post(token, '/checkin-windows', {
            branchId: branch,
            userId: 'u-bm',
            atMinute: 300,
            toleranceMinutes: 30,
            label: null,
          }),
      },
      {
        what: 'retiring a round',
        call: (token: string) => del(token, `/checkin-windows/some-id?branchId=${branch}`),
      },
      {
        what: 'moving the fence',
        call: (token: string) =>
          put(token, '/branch-location', {
            branchId: branch,
            lat: BRANCH_LAT,
            lng: BRANCH_LNG,
            checkinRadiusM: 20_000,
          }),
      },
    ] as const

  for (const { what, call } of configWrites(BRANCH)) {
    it(`refuses the branch manager: ${what}`, async () => {
      const res = await call(await h.loginAs('manager'))
      expect(res.statusCode, res.body).toBe(403)
    })

    it(`refuses the general manager: ${what}`, async () => {
      const res = await call(await h.loginAs('gm'))
      expect(res.statusCode, res.body).toBe(403)
    })

    it(`allows the system admin: ${what}`, async () => {
      const res = await call(await h.loginAs('sysadmin'))
      // 403 is the only forbidden answer. A 404 for the invented window id is a correct outcome
      // for a permitted caller, and asserting a single success code here would make this test
      // about the route's shape rather than about who may reach it.
      expect(res.statusCode, res.body).not.toBe(403)
    })
  }

  it('still lets the branch manager do the one thing he is for: answer a round', async () => {
    await placeBranch()
    await addWindow(NOW_MINUTE)
    const manager = await h.loginAs('manager')

    // Reading his own rota, and checking in against it. Both `branch_data.view`.
    expect((await get(manager, '/checkin-windows')).statusCode).toBe(200)
    expect((await post(manager, '/checkins', { branchId: BRANCH, ...AT_BRANCH })).statusCode).toBe(201)
    expect((await get(manager, '/checkins')).statusCode).toBe(200)
  })
})
