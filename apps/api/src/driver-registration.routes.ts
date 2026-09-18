import type { FastifyInstance } from 'fastify'
import type { Deps, DriverRecord, SessionRecord, UserRecord } from '@ash/contracts'
import { registerDriverRequest } from '@ash/contracts'
import { SESSION_COOKIE, SESSION_IDLE_MS, hashToken } from './auth.ts'
import { registrationAddress, registrationAddressHash } from './registration-address.ts'
import { ServiceError, todayFor } from './shifts.service.ts'

const REGISTRATION_LIMIT = 3
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000

export function registerDriverRegistrationRoutes(
  app: FastifyInstance,
  deps: Deps,
  enabled: boolean,
): void {
  app.get('/auth/register/branches', { config: { permission: null } }, async () => {
    if (!enabled) throw new ServiceError(503, 'registration_disabled')
    const branches = await deps.directory.listBranches()
    return {
      branches: branches.map(({ id, code, nameAr, nameEn }) => ({ id, code, nameAr, nameEn })),
    }
  })

  app.post('/auth/register', { config: { permission: null } }, async (req, reply) => {
    // Parsing happens before the claim: malformed traffic cannot exhaust the three legitimate
    // submissions, while every schema-valid business outcome below consumes exactly one slot.
    const body = registerDriverRequest.parse(req.body)
    const attempt = await deps.driverAccounts.claimRegistrationAttempt({
      addressHash: registrationAddressHash(registrationAddress(req)),
      attemptedAtMs: deps.clock.nowMs(),
      limit: REGISTRATION_LIMIT,
      windowMs: REGISTRATION_WINDOW_MS,
    })
    if (!attempt.allowed) {
      return reply
        .header('Retry-After', String(attempt.retryAfterSeconds))
        .code(429)
        .send({ error: 'registration_rate_limited', retryAfterSeconds: attempt.retryAfterSeconds })
    }
    if (req.actor) throw new ServiceError(409, 'already_authenticated')
    if (!enabled) throw new ServiceError(503, 'registration_disabled')

    const branch = await deps.directory.branch(body.branchId)
    if (!branch || branch.kind !== 'branch') throw new ServiceError(422, 'unknown_branch')
    if (await deps.users.findByUsername(body.username)) {
      throw new ServiceError(409, 'duplicate_username')
    }

    const now = deps.clock.nowMs()
    const user: UserRecord = {
      id: deps.ids.uuid(),
      branchId: branch.id,
      roleKey: 'driver',
      username: body.username,
      fullNameAr: body.fullNameAr,
      passwordHash: await deps.hasher.hash(body.password),
      driverId: null,
      mfaSecret: null,
      mfaEnrolledAtMs: null,
      failedAttempts: 0,
      lockedUntilMs: null,
      active: true,
    }
    const driver: DriverRecord = {
      id: deps.ids.uuid(),
      branchId: branch.id,
      userId: user.id,
      code: body.username,
      fullNameAr: body.fullNameAr,
      active: true,
    }
    const token = deps.ids.token()
    const session: SessionRecord = {
      id: deps.ids.uuid(),
      userId: user.id,
      tokenHash: hashToken(token),
      mfaSatisfied: true,
      createdAtMs: now,
      lastSeenAtMs: now,
      expiresAtMs: now + SESSION_IDLE_MS,
      revokedAtMs: null,
    }

    try {
      await deps.driverAccounts.provision({
        user,
        driver,
        session,
        audit: {
          actorId: null,
          actorKind: 'anonymous',
          requestId: req.requestId,
          occurredAtMs: now,
        },
      })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'DUPLICATE_USERNAME') throw new ServiceError(409, 'duplicate_username')
      if (code === 'DUPLICATE_CODE') throw new ServiceError(409, 'duplicate_driver_code')
      throw error
    }

    return reply
      .setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: SESSION_IDLE_MS / 1000,
      })
      .code(201)
      .send({
        userId: user.id,
        driverId: driver.id,
        branchId: branch.id,
        roleKey: 'driver',
        businessDate: todayFor(deps),
      })
  })
}
