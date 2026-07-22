import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps, DriverRecord, UserRecord } from '@ash/contracts'
import { createUserRequest, updateUserRequest } from '@ash/contracts'
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
    action: 'INSERT' | 'UPDATE' = 'INSERT',
    before: unknown = null,
  ): Promise<void> => {
    await deps.audit.append({
      tableName: table,
      recordId,
      action,
      actorId: req.actor?.userId ?? null,
      actorKind: req.actor ? 'user' : 'system',
      branchId,
      requestId: req.requestId,
      before,
      after,
      occurredAtMs: deps.clock.nowMs(),
    })
  }

  /** What an account looks like on the wire — never the password hash or the MFA secret. */
  const publicUser = (u: UserRecord & { driverId?: string | null }) => ({
    id: u.id,
    username: u.username,
    roleKey: u.roleKey,
    fullNameAr: u.fullNameAr,
    branchId: u.branchId,
    driverId: u.driverId ?? null,
    active: u.active,
  })

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

  /**
   * Edit an account: rename, change role/branch, deactivate, or reset the password. Only the fields
   * sent change. Deactivating or resetting a password REVOKES the account's live sessions — leaving
   * a disabled user signed in would make "deactivate" a lie.
   */
  app.patch('/users/:id', { config: { permission: 'user.manage' } }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = updateUserRequest.parse(req.body)

    const before = await deps.users.findById(id)
    if (!before) throw new ServiceError(404, 'user_not_found')

    const roleKey = (body.roleKey ?? before.roleKey) as UserRecord['roleKey']
    const branchId = body.branchId === undefined ? before.branchId : body.branchId
    // The users table CHECKs this too, but a named 422 beats a constraint violation as a 500.
    if (BRANCH_SCOPED_ROLES.has(roleKey) && !branchId) {
      throw new ServiceError(422, 'branch_required', { hint: 'a driver or branch manager needs a branchId' })
    }

    const after: UserRecord = {
      ...before,
      fullNameAr: body.fullNameAr ?? before.fullNameAr,
      roleKey,
      branchId,
      active: body.active ?? before.active,
      passwordHash: body.password === undefined ? before.passwordHash : await deps.hasher.hash(body.password),
    }
    await deps.users.update(after)

    const deactivated = before.active && after.active === false
    if (deactivated || body.password !== undefined) {
      await deps.sessions.revokeAllForUser(id)
    }

    // Audit WHAT changed — never the password, not even that its hash differs beyond a flag.
    await audit(
      req,
      'users',
      id,
      branchId,
      { roleKey: after.roleKey, fullNameAr: after.fullNameAr, active: after.active, passwordReset: body.password !== undefined },
      'UPDATE',
      { roleKey: before.roleKey, fullNameAr: before.fullNameAr, active: before.active },
    )

    return publicUser(after)
  })
}
