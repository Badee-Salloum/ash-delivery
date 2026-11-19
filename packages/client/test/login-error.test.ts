import { describe, expect, it } from 'vitest'
import { loginErrorMessage } from '../src/login-error.ts'
import { ar } from '../src/i18n/ar.ts'

describe('login failure classification', () => {
  it('reports only explicit invalid credentials as a password rejection', () => {
    expect(loginErrorMessage({ error: 'invalid_credentials', status: 401 }, ar.auth)).toBe(ar.auth.invalidCredentials)
    expect(loginErrorMessage({ error: 'locked' }, ar.auth)).toBe(ar.auth.locked)
    expect(loginErrorMessage({ error: 'inactive' }, ar.auth)).toBe(ar.auth.inactiveAccount)
    expect(loginErrorMessage({ error: 'unauthenticated' }, ar.auth)).toBe(ar.auth.sessionUnavailable)
    for (const failure of [new TypeError('Failed to fetch'), { status: 504, error: 'http_504' }, { status: 408, error: 'request_timeout' }, null]) {
      expect(loginErrorMessage(failure, ar.auth)).toBe(ar.auth.loginUnavailable)
    }
  })
})
