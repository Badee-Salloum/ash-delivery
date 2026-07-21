import { createHash, randomBytes } from 'node:crypto'
import type { Deps, SessionRecord, UserRecord } from '@ash/contracts'
import type { Actor } from '@ash/domain'

/**
 * Authentication, to SRS §7 and A-1:
 *   • bcrypt password hashes
 *   • account lock after 5 failed attempts
 *   • 30-minute sessions, idle-sliding
 *   • opaque DB-backed sessions, so revocation is immediate
 *
 * A stateless JWT cannot honour a 30-minute *idle* timeout or instant revocation without a
 * server-side blocklist — which is a session table wearing a disguise. So: sessions.
 */

export const SESSION_IDLE_MS = 30 * 60 * 1000
export const MAX_FAILED_ATTEMPTS = 5
export const LOCKOUT_MS = 15 * 60 * 1000
export const SESSION_COOKIE = 'ash_session'

/** Only the hash is stored. A database dump must not yield usable session tokens. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export const newToken = (): string => randomBytes(32).toString('base64url')

export type LoginFailure =
  | { kind: 'invalid_credentials' }
  | { kind: 'locked'; untilMs: number }
  | { kind: 'inactive' }

export type LoginResult = { ok: true; user: UserRecord; session: SessionRecord; token: string } | { ok: false; failure: LoginFailure }

export async function login(deps: Deps, username: string, password: string): Promise<LoginResult> {
  const now = deps.clock.nowMs()
  const user = await deps.users.findByUsername(username)

  if (!user) {
    // Verify against a dummy hash anyway so a missing username and a wrong password take
    // comparable time — otherwise the response time enumerates valid usernames.
    await deps.hasher.verify(password, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv')
    return { ok: false, failure: { kind: 'invalid_credentials' } }
  }

  if (user.lockedUntilMs !== null && user.lockedUntilMs > now) {
    return { ok: false, failure: { kind: 'locked', untilMs: user.lockedUntilMs } }
  }
  if (!user.active) return { ok: false, failure: { kind: 'inactive' } }

  const valid = await deps.hasher.verify(password, user.passwordHash)
  if (!valid) {
    const failedAttempts = user.failedAttempts + 1
    const locked = failedAttempts >= MAX_FAILED_ATTEMPTS
    // NOTE: this write happens on the UNAUTHENTICATED path — there is no actor. The audit
    // trigger must tolerate that (it records actor_kind='anonymous'); a trigger that raised
    // here would make the lockout impossible and turn every failed login into a 500.
    await deps.users.update({
      ...user,
      failedAttempts: locked ? 0 : failedAttempts,
      lockedUntilMs: locked ? now + LOCKOUT_MS : user.lockedUntilMs,
    })
    return locked
      ? { ok: false, failure: { kind: 'locked', untilMs: now + LOCKOUT_MS } }
      : { ok: false, failure: { kind: 'invalid_credentials' } }
  }

  if (user.failedAttempts !== 0 || user.lockedUntilMs !== null) {
    await deps.users.update({ ...user, failedAttempts: 0, lockedUntilMs: null })
  }

  const token = deps.ids.token()
  const session: SessionRecord = {
    id: deps.ids.uuid(),
    userId: user.id,
    tokenHash: hashToken(token),
    createdAtMs: now,
    lastSeenAtMs: now,
    expiresAtMs: now + SESSION_IDLE_MS,
    revokedAtMs: null,
  }
  await deps.sessions.create(session)
  return { ok: true, user, session, token }
}

export type SessionCheck =
  | { ok: true; actor: Actor; user: UserRecord; session: SessionRecord }
  | { ok: false; reason: 'no_session' | 'expired' | 'revoked' | 'user_gone' }

/**
 * Resolve a token to an actor, sliding the idle window forward.
 *
 * The window slides on activity rather than being absolute, which is what "30-minute sessions"
 * means operationally: a branch manager reviewing shifts for an hour is not logged out mid-review,
 * but a tablet left on a desk is.
 */
export async function resolveSession(deps: Deps, token: string | undefined): Promise<SessionCheck> {
  if (!token) return { ok: false, reason: 'no_session' }
  const now = deps.clock.nowMs()

  const session = await deps.sessions.findByTokenHash(hashToken(token))
  if (!session) return { ok: false, reason: 'no_session' }
  if (session.revokedAtMs !== null) return { ok: false, reason: 'revoked' }
  if (session.expiresAtMs <= now) return { ok: false, reason: 'expired' }

  const user = await deps.users.findById(session.userId)
  if (!user || !user.active) return { ok: false, reason: 'user_gone' }

  const slid: SessionRecord = { ...session, lastSeenAtMs: now, expiresAtMs: now + SESSION_IDLE_MS }
  await deps.sessions.update(slid)

  return {
    ok: true,
    user,
    session: slid,
    actor: { userId: user.id, roleKey: user.roleKey, branchId: user.branchId, driverId: user.driverId },
  }
}

export async function logout(deps: Deps, token: string | undefined): Promise<void> {
  if (!token) return
  const session = await deps.sessions.findByTokenHash(hashToken(token))
  if (session) await deps.sessions.update({ ...session, revokedAtMs: deps.clock.nowMs() })
}
