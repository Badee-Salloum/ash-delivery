import type { Catalog } from './i18n/ar.ts'

/** Only an explicit password rejection is a password error. Timeouts are not credentials. */
export function loginErrorMessage(error: unknown, copy: Catalog['auth']): string {
  const code = (error as { error?: string } | null)?.error
  if (code === 'invalid_credentials') return copy.invalidCredentials
  if (code === 'locked') return copy.locked
  if (code === 'inactive') return copy.inactiveAccount
  if (code === 'unauthenticated') return copy.sessionUnavailable
  return copy.loginUnavailable
}
