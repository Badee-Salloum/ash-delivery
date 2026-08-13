import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { Deps, SessionRecord, UserRecord } from '@ash/contracts'
import { type Actor, base32Encode, requires2fa, verifyTotp } from '@ash/domain'

/**
 * Authentication, to SRS §7 and A-1:
 *   • bcrypt password hashes
 *   • account lock after 5 failed attempts
 *   • idle-sliding sessions
 *   • opaque DB-backed sessions, so revocation is immediate
 *
 * A stateless JWT cannot honour an *idle* timeout or instant revocation without a server-side
 * blocklist — which is a session table wearing a disguise. So: sessions.
 */

/**
 * How long a session survives with no activity. **Idle**, not absolute — every authenticated
 * request slides it forward, so this is the gap between actions, never the length of a shift.
 *
 * RAISED FROM 30 MINUTES on the owner's instruction: «يجب ان يصبح مدة الجلسة اطول». Thirty minutes
 * was read off SRS §7 for an office console, and a driver is not at a console. He opens the app to
 * start his shift, rides for hours, and comes back to a login screen at the branch counter with a
 * manager waiting — having lost an unsent close package to a timer that was protecting a phone
 * already locked by its own PIN.
 *
 * Eight hours covers a shift end to end. It is a real loosening and worth naming as one: a stolen
 * unlocked phone stays signed in for a working day rather than half an hour. Two things bound the
 * damage — a driver holds `shift.operate` scoped to his OWN shift and can see nobody else's money,
 * and sessions are DB-backed, so revoking one is immediate rather than a wait for expiry.
 */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000
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

export type LoginResult =
  | { ok: true; user: UserRecord; session: SessionRecord; token: string }
  | { ok: false; failure: LoginFailure }

/** RFC 6238 requires HMAC-SHA1. The domain takes it as a value so it stays dependency-free. */
export const hmacSha1 = (key: Uint8Array, msg: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac('sha1', Buffer.from(key)).update(Buffer.from(msg)).digest())

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
    // A session is second-factor-satisfied UNLESS the user is an admin role that has enrolled a
    // TOTP secret. Password-only for a driver, or an admin who has not yet enrolled, is `true`
    // here — the enrolment gate is a separate, softer nudge (see `mfaEnrollmentRequired`).
    mfaSatisfied: !(requires2fa(user.roleKey) && user.mfaSecret !== null),
    createdAtMs: now,
    lastSeenAtMs: now,
    expiresAtMs: now + SESSION_IDLE_MS,
    revokedAtMs: null,
  }
  await deps.sessions.create(session)
  return { ok: true, user, session, token }
}

/** True when an admin role should be pushed to enrol 2FA but has not (SRS §7). */
export function mfaEnrollmentRequired(user: UserRecord): boolean {
  return requires2fa(user.roleKey) && user.mfaSecret === null
}

export type SecondFactorResult =
  | { ok: true; session: SessionRecord }
  | { ok: false; reason: 'no_pending_session' | 'not_enrolled' | 'bad_code' }

/**
 * Complete the second factor on a half-satisfied session.
 *
 * The password step already minted the session (cookie set, `mfaSatisfied=false`), so this is a
 * flag flip guarded by the TOTP check — no separate "pending token" to leak or mismanage. The
 * RBAC preHandler refuses every protected route until this succeeds.
 */
export async function verifySecondFactor(deps: Deps, token: string | undefined, code: string): Promise<SecondFactorResult> {
  if (!token) return { ok: false, reason: 'no_pending_session' }
  const session = await deps.sessions.findByTokenHash(hashToken(token))
  if (!session || session.revokedAtMs !== null || session.expiresAtMs <= deps.clock.nowMs()) {
    return { ok: false, reason: 'no_pending_session' }
  }
  const user = await deps.users.findById(session.userId)
  if (!user || user.mfaSecret === null) return { ok: false, reason: 'not_enrolled' }

  if (!verifyTotp(user.mfaSecret, code, deps.clock.nowMs(), hmacSha1)) {
    return { ok: false, reason: 'bad_code' }
  }

  const satisfied: SessionRecord = { ...session, mfaSatisfied: true }
  await deps.sessions.update(satisfied)
  return { ok: true, session: satisfied }
}

export interface EnrollmentChallenge {
  secret: string
  /** otpauth:// URI an authenticator app scans. */
  otpauthUri: string
}

/**
 * Begin 2FA enrolment: generate a secret and the provisioning URI. The secret is NOT stored yet
 * — the caller confirms a code from it first (`confirmEnrollment`), which proves the phone and
 * the server agree before anything is persisted. Otherwise a mistyped scan locks the user out.
 */
export function beginEnrollment(deps: Deps, user: UserRecord, issuer = 'ASH Delivery'): EnrollmentChallenge {
  const secret = base32Encode(randomBytes(20))
  const label = encodeURIComponent(`${issuer}:${user.username}`)
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return { secret, otpauthUri: `otpauth://totp/${label}?${params.toString()}` }
}

export async function confirmEnrollment(deps: Deps, user: UserRecord, secret: string, code: string): Promise<boolean> {
  if (!verifyTotp(secret, code, deps.clock.nowMs(), hmacSha1)) return false
  await deps.users.update({ ...user, mfaSecret: secret, mfaEnrolledAtMs: deps.clock.nowMs() })
  return true
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
