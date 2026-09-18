import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const login = readFileSync(new URL('../src/screens/Login.tsx', import.meta.url), 'utf8')
const registration = readFileSync(new URL('../src/screens/Register.tsx', import.meta.url), 'utf8')

describe('driver registration screen wiring', () => {
  it('switches from login to registration and provides a back action', () => {
    expect(login).toContain('<Register onBack={() => setRegistering(false)} />')
    expect(login).toContain('setRegistering(true)')
    expect(registration).toContain('t.auth.backToLogin')
  })

  it('loads public branches and submits no password confirmation field', () => {
    expect(registration).toContain('api.registrationBranches()')
    expect(registration).toContain('<select')
    expect(registration).toContain('api.registerDriver({ fullNameAr: fullNameAr.trim(), branchId, username, password })')
    expect(registration).not.toContain('api.registerDriver({ fullNameAr: fullNameAr.trim(), branchId, username, password, confirmation')
  })

  it('maps named localized errors and enters the authenticated flow through /me', () => {
    for (const code of [
      'duplicate_username',
      'duplicate_driver_code',
      'unknown_branch',
      'registration_disabled',
      'registration_rate_limited',
    ]) expect(registration).toContain(code)
    expect(registration).toContain('t.auth.registrationNetworkFailure')
    expect(registration).toContain('await refreshSession()')
  })
})
