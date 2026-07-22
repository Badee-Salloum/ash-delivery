import { createHmac } from 'node:crypto'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { base32Encode, totpForCounter, base32Decode } from '@ash/domain'
import { NOW_MS, type Harness, makeHarness } from './harness.ts'

/**
 * 2FA / TOTP for administrative roles (SRS §7, A-1).
 *
 * The flow: password login (session created, but second-factor-unsatisfied) → present a code →
 * session is fully authenticated. Enrolment generates a secret, and a code is confirmed against
 * it before it is stored — so a mistyped scan never locks anyone out.
 */

const hmac = (key: Uint8Array, msg: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac('sha1', Buffer.from(key)).update(Buffer.from(msg)).digest())
const codeFor = (secretB32: string, ms: number): string =>
  totpForCounter(base32Decode(secretB32), Math.floor(ms / 1000 / 30), hmac)

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const sessionCookie = (res: LightMyRequestResponse): string => {
  const raw = res.headers['set-cookie']
  const str = Array.isArray(raw) ? raw[0] : raw
  return /ash_session=([^;]+)/.exec(String(str))?.[1] ?? ''
}

describe('enrolment', () => {
  it('an admin who has not enrolled is told to, but is not blocked from the app yet', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'secret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().enrollmentRequired).toBe(true)
    expect(res.json().secondFactorRequired).toBe(false) // no secret yet, so cannot enforce
  })

  it('enrolls a secret only after a code from it is confirmed', async () => {
    const login = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'secret' },
    })
    const cookie = `ash_session=${sessionCookie(login)}`

    const begin = await h.app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers: { cookie } })
    expect(begin.statusCode).toBe(200)
    const secret = begin.json().secret as string
    expect(begin.json().otpauthUri).toContain('otpauth://totp/')

    // A wrong code does NOT enrol.
    const bad = await h.app.inject({
      method: 'POST', url: '/auth/2fa/confirm', headers: { cookie }, payload: { secret, code: '000000' },
    })
    expect(bad.statusCode).toBe(401)
    expect((await h.deps.users.findByUsername('manager'))?.mfaSecret).toBeNull()

    // The right code enrols it.
    const good = await h.app.inject({
      method: 'POST', url: '/auth/2fa/confirm', headers: { cookie },
      payload: { secret, code: codeFor(secret, NOW_MS) },
    })
    expect(good.statusCode, good.body).toBe(200)
    expect((await h.deps.users.findByUsername('manager'))?.mfaSecret).toBe(secret)
  })
})

describe('login with 2FA enrolled', () => {
  const secret = base32Encode(new TextEncoder().encode('twenty-byte-secret!!'))

  beforeEach(() => {
    // An admin who has already enrolled.
    h.deps.users.seed({
      id: 'u-bm', branchId: 'branch-damascus', roleKey: 'branch_manager', username: 'manager',
      fullNameAr: 'manager', passwordHash: 'plain:secret', driverId: null,
      mfaSecret: secret, mfaEnrolledAtMs: NOW_MS - 1000,
      failedAttempts: 0, lockedUntilMs: null, active: true,
    })
  })

  it('a protected route is refused until the second factor is presented', async () => {
    const login = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'secret' },
    })
    expect(login.json().secondFactorRequired).toBe(true)
    const cookie = `ash_session=${sessionCookie(login)}`

    // Authenticated, but half a session: /me works...
    expect((await h.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).statusCode).toBe(200)
    // ...a permissioned route does not.
    const blocked = await h.app.inject({ method: 'GET', url: '/drivers', headers: { cookie } })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json().error).toBe('second_factor_required')
  })

  it('presenting the code unlocks the session', async () => {
    const login = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'secret' },
    })
    const cookie = `ash_session=${sessionCookie(login)}`

    const verify = await h.app.inject({
      method: 'POST', url: '/auth/2fa/verify', headers: { cookie },
      payload: { code: codeFor(secret, NOW_MS) },
    })
    expect(verify.statusCode, verify.body).toBe(200)

    // Now the same session reaches protected routes.
    expect((await h.app.inject({ method: 'GET', url: '/drivers', headers: { cookie } })).statusCode).toBe(200)
  })

  it('rejects a wrong code and keeps the session locked', async () => {
    const login = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'secret' },
    })
    const cookie = `ash_session=${sessionCookie(login)}`

    const verify = await h.app.inject({
      method: 'POST', url: '/auth/2fa/verify', headers: { cookie }, payload: { code: '000000' },
    })
    expect(verify.statusCode).toBe(401)
    expect(verify.json().error).toBe('bad_code')
    expect((await h.app.inject({ method: 'GET', url: '/drivers', headers: { cookie } })).statusCode).toBe(403)
  })
})

describe('the driver never needs a second factor', () => {
  it('logs in fully with password alone', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'driver1', password: 'secret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().secondFactorRequired).toBe(false)
    expect(res.json().enrollmentRequired).toBe(false)
  })
})
