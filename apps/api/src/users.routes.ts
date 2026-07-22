import type { FastifyInstance } from 'fastify'
import type { Deps, DriverRecord, UserRecord } from '@ash/contracts'
import { createUserRequest } from '@ash/contracts'
import { ServiceError } from './shifts.service.ts'

/**
 * Account management (SRS A-2): create and list login accounts.
 *
 * The §3 matrix grants `user.manage` to the system admin and the general manager only, both
 * organisation-wide — so these routes need no branch subject. A driver-role account also gets a
 * linked `drivers` row in the same act, because a driver login with no driver record can sign in
 * but has nothing to operate (the PWA would show no assignment).
 *
 * Passwords are hashed here and never leave: no endpoint returns a hash, and the audit log records
 * the username and role, not the secret.
 */
const BRANCH_SCOPED_ROLES = new Set(['driver', 'branch_manager'])

export function registerUserRoutes(app: FastifyInstance, deps: Deps): void {
  const audit = async (
    req: { actor?: { userId: string }; requestId: string },
    table: string,
    recordId: string,
    branchId: string | null,
    after: unknown,
  ): Promise<void> => {
    await deps.audit.append({
      tableName: table,
      recordId,
      action: 'INSERT',
      actorId: req.actor?.userId ?? null,
      actorKind: req.actor ? 'user' : 'system',
      branchId,
      requestId: req.requestId,
      before: null,
      after,
      occurredAtMs: deps.clock.nowMs(),
    })
  }

  app.get('/branches', { config: { permission: 'user.manage' } }, async () => {
    return { branches: await deps.directory.listBranches() }
  })

  app.get('/users', { config: { permission: 'user.manage' } }, async () => {
    const users = await deps.users.list()
    // Never the password hash or the MFA secret.
    return {
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        roleKey: u.roleKey,
        fullNameAr: u.fullNameAr,
        branchId: u.branchId,
        driverId: u.driverId,
        active: u.active,
      })),
    }
  })

  app.post('/users', { config: { permission: 'user.manage' } }, async (req, reply) => {
    const body = createUserRequest.parse(req.body)
    const branchScoped = BRANCH_SCOPED_ROLES.has(body.roleKey)
    const branchId = branchScoped ? (body.branchId ?? null) : null
    if (branchScoped && !branchId) {
      throw new ServiceError(422, 'branch_required', { hint: 'a driver or branch manager needs a branchId' })
    }
    if (await deps.users.findByUsername(body.username)) {
      throw new ServiceError(409, 'duplicate_username', { username: body.username })
    }

    const user: UserRecord = {
      id: deps.ids.uuid(),
      branchId,
      roleKey: body.roleKey,
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
    try {
      await deps.users.create(user)
    } catch (err) {
      if ((err as { code?: string }).code === 'DUPLICATE_USERNAME') {
        throw new ServiceError(409, 'duplicate_username', { username: body.username })
      }
      throw err
    }
    await audit(req, 'users', user.id, branchId, { username: user.username, roleKey: user.roleKey })

    // A driver account is only useful with a driver record to bind shifts to. The code defaults
    // to the username, which is already unique — the manager can rename it in Fleet later.
    let driverId: string | null = null
    if (body.roleKey === 'driver' && branchId) {
      const driver: DriverRecord = {
        id: deps.ids.uuid(),
        branchId,
        userId: user.id,
        code: body.username,
        fullNameAr: body.fullNameAr,
        active: true,
      }
      try {
        await deps.directory.createDriver(driver)
      } catch (err) {
        if ((err as { code?: string }).code === 'DUPLICATE_CODE') {
          throw new ServiceError(409, 'duplicate_driver_code', { code: body.username })
        }
        throw err
      }
      driverId = driver.id
      await audit(req, 'drivers', driver.id, branchId, driver)
    }

    return reply.code(201).send({
      id: user.id,
      username: user.username,
      roleKey: user.roleKey,
      fullNameAr: user.fullNameAr,
      branchId,
      driverId,
    })
  })
}
