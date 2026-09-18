import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, COMPANY_BRANCH, VEHICLE_ID, type Harness, makeHarness } from './harness.ts'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const payload = (username = 'newdriver') => ({
  fullNameAr: 'سائق جديد',
  branchId: BRANCH,
  username,
  password: 'password8',
})

const address = (ip: string) => ({ 'x-forwarded-for': ip })

describe('public driver self-registration', () => {
  it('lists only operating branches without requiring a session', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/auth/register/branches' })
    expect(response.statusCode).toBe(200)
    const ids = response.json().branches.map((branch: { id: string }) => branch.id)
    expect(ids).toContain(BRANCH)
    expect(ids).not.toContain(COMPANY_BRANCH)
  })

  it('creates an active driver, signs in, and can immediately use the normal driver flow', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: address('198.51.100.10'),
      payload: payload('  newdriver  '),
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ branchId: BRANCH, roleKey: 'driver', businessDate: '2026-07-21' })
    const cookie = String(response.headers['set-cookie']).split(';')[0]!
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly')

    const me = await h.app.inject({ method: 'GET', url: '/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ roleKey: 'driver', driverId: response.json().driverId, branchId: BRANCH })

    const shift = await h.app.inject({
      method: 'POST',
      url: '/shifts',
      headers: { cookie },
      payload: { driverId: response.json().driverId, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    expect(shift.statusCode).toBe(201)
  })

  it('rejects HQ, unknown branches, and attempts to inject authority', async () => {
    const hq = await h.app.inject({
      method: 'POST', url: '/auth/register', headers: address('198.51.100.11'), payload: { ...payload(), branchId: COMPANY_BRANCH },
    })
    expect(hq.statusCode).toBe(422)
    expect(hq.json().error).toBe('unknown_branch')

    const unknown = await h.app.inject({
      method: 'POST', url: '/auth/register', headers: address('198.51.100.12'), payload: { ...payload(), branchId: 'missing' },
    })
    expect(unknown.statusCode).toBe(422)
    expect(unknown.json().error).toBe('unknown_branch')

    for (const extra of [{ roleKey: 'system_admin' }, { active: false }, { id: 'picked' }]) {
      const response = await h.app.inject({
        method: 'POST', url: '/auth/register', headers: address('198.51.100.13'), payload: { ...payload(), ...extra },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('invalid_request')
    }
  })

  it('names duplicate usernames and driver codes', async () => {
    const username = await h.app.inject({
      method: 'POST', url: '/auth/register', headers: address('198.51.100.20'), payload: payload('driver1'),
    })
    expect(username.statusCode).toBe(409)
    expect(username.json().error).toBe('duplicate_username')

    h.deps.directory.drivers.set('orphan-code', {
      id: 'orphan-code', branchId: BRANCH, code: 'orphan', fullNameAr: 'قديم', active: true,
    })
    const code = await h.app.inject({
      method: 'POST', url: '/auth/register', headers: address('198.51.100.21'), payload: payload('orphan'),
    })
    expect(code.statusCode).toBe(409)
    expect(code.json().error).toBe('duplicate_driver_code')
    expect(await h.deps.users.findByUsername('orphan')).toBeNull()
  })

  it('allows only one winner when the same account is submitted concurrently', async () => {
    const requests = await Promise.all([
      h.app.inject({ method: 'POST', url: '/auth/register', headers: address('198.51.100.30'), payload: payload('race') }),
      h.app.inject({ method: 'POST', url: '/auth/register', headers: address('198.51.100.31'), payload: payload('race') }),
    ])
    expect(requests.map((response) => response.statusCode).sort()).toEqual([201, 409])
    expect((await h.deps.users.list()).filter((user) => user.username === 'race')).toHaveLength(1)
  })

  it('rejects an authenticated caller and can be disabled at boot', async () => {
    const token = await h.loginAs('driver1')
    const authenticated = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { cookie: h.cookie(token), ...address('198.51.100.40') },
      payload: payload('another'),
    })
    expect(authenticated.statusCode).toBe(409)
    expect(authenticated.json().error).toBe('already_authenticated')

    await h.app.close()
    h = await makeHarness({ driverSelfRegistrationEnabled: false })
    const branches = await h.app.inject({ method: 'GET', url: '/auth/register/branches' })
    expect(branches.statusCode).toBe(503)
    expect(branches.json().error).toBe('registration_disabled')
    const disabled = await h.app.inject({
      method: 'POST', url: '/auth/register', headers: address('198.51.100.41'), payload: payload('disabled'),
    })
    expect(disabled.statusCode).toBe(503)
    expect(disabled.json().error).toBe('registration_disabled')
  })

  it('supports lost-response recovery through ordinary login', async () => {
    const created = await h.app.inject({
      method: 'POST', url: '/auth/register', headers: address('198.51.100.50'), payload: payload('recoverable'),
    })
    expect(created.statusCode).toBe(201)
    const login = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'recoverable', password: 'password8' },
    })
    expect(login.statusCode).toBe(200)
    expect(login.json().roleKey).toBe('driver')
  })

  it('counts three schema-valid business outcomes, then returns a stable Retry-After', async () => {
    const headers = address('198.51.100.60')
    const malformed = await h.app.inject({
      method: 'POST', url: '/auth/register', headers, payload: { ...payload(), password: 'short' },
    })
    expect(malformed.statusCode).toBe(400)

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await h.app.inject({
        method: 'POST', url: '/auth/register', headers, payload: { ...payload(`attempt-${attempt}`), branchId: 'missing' },
      })
      expect(response.statusCode).toBe(422)
    }
    const limited = await h.app.inject({ method: 'POST', url: '/auth/register', headers, payload: payload('fourth') })
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: 'registration_rate_limited', retryAfterSeconds: 3600 })
    expect(limited.headers['retry-after']).toBe('3600')

    h.deps.clock.advance(1_000)
    const stillLimited = await h.app.inject({ method: 'POST', url: '/auth/register', headers, payload: payload('fifth') })
    expect(stillLimited.statusCode).toBe(429)
    expect(stillLimited.json().retryAfterSeconds).toBe(3599)

    h.deps.clock.advance(3_599_001)
    const expired = await h.app.inject({ method: 'POST', url: '/auth/register', headers, payload: payload('after-window') })
    expect(expired.statusCode).toBe(201)
  })

  it('keeps addresses separate and groups IPv6 privacy addresses by /64', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await h.app.inject({
        method: 'POST',
        url: '/auth/register',
        headers: address(`2001:db8:abcd:42::${attempt + 1}`),
        payload: { ...payload(`v6-${attempt}`), branchId: 'missing' },
      })
    }
    const same64 = await h.app.inject({
      method: 'POST', url: '/auth/register', headers: address('2001:db8:abcd:42:ffff::9'), payload: payload('same64'),
    })
    expect(same64.statusCode).toBe(429)
    const other64 = await h.app.inject({
      method: 'POST', url: '/auth/register', headers: address('2001:db8:abcd:43::1'), payload: payload('other64'),
    })
    expect(other64.statusCode).toBe(201)
  })
})
