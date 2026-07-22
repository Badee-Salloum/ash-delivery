import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps, DocumentRecord, DriverRecord, VehicleRecord } from '@ash/contracts'
import {
  createAssignmentRequest,
  createDocumentRequest,
  createDriverRequest,
  createVehicleRequest,
  updateDriverRequest,
  updateVehicleRequest,
} from '@ash/contracts'
import type { AssignmentRecord } from '@ash/contracts'
import { addDays, canTransitionVehicle, documentStatusOn } from '@ash/domain'
import { ServiceError, todayFor } from './shifts.service.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'

/**
 * Fleet management (SRS §B): drivers, vehicles and their documents.
 *
 * Without these the platform cannot be used at all — there would be no way to create the people
 * and machines every shift is bound to. Everything is branch-scoped, and writes are restricted
 * to the roles the §3 matrix allows.
 */
export function registerFleetRoutes(app: FastifyInstance, deps: Deps): void {
  // The branch a request targets, from `?branchId=` or the body, else the actor's own session.
  // Shared so a read and a write resolve it identically — see branch-scope.ts for why a GET must
  // have a channel at all.
  const targetBranch = branchSubject
  const ownBranch = branchSubject
  const resolveBranch = resolveBranchId

  // ── Drivers (B-1) ───────────────────────────────────────────────────────────────────────

  app.get('/drivers', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const drivers = await deps.directory.listDrivers(branchId)
    const today = todayFor(deps)

    // Each driver carries his document status, because that is what decides whether he can be
    // assigned a shift at all (B-3) — and an expiry the office learns about on the morning of
    // is an expiry that has already cost a day.
    return {
      drivers: await Promise.all(
        drivers.map(async (d) => {
          const docs = await deps.directory.listDocuments({ driverId: d.id })
          return {
            ...d,
            documents: docs.map((doc) => ({
              id: doc.id,
              kind: doc.kind,
              expiresOn: doc.expiresOn,
              status: documentStatusOn(doc.expiresOn, today),
            })),
            blockedByDocuments: docs.some((doc) => documentStatusOn(doc.expiresOn, today) === 'expired'),
          }
        }),
      ),
    }
  })

  app.post('/drivers', { config: { permission: 'fleet.manage', subject: targetBranch } }, async (req, reply) => {
    const body = createDriverRequest.parse(req.body)
    const branchId = resolveBranch(req)
    const driver: DriverRecord = { id: deps.ids.uuid(), branchId, ...body, active: true }
    try {
      await deps.directory.createDriver(driver)
    } catch (err) {
      if ((err as { code?: string }).code === 'DUPLICATE_CODE') {
        throw new ServiceError(409, 'duplicate_driver_code', { code: body.code })
      }
      throw err
    }
    await audit(deps, req, 'drivers', driver.id, 'INSERT', null, driver)
    return reply.code(201).send(driver)
  })

  app.patch('/drivers/:id', { config: { permission: 'fleet.manage', subject: driverSubject(deps) } }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = updateDriverRequest.parse(req.body)
    const before = await deps.directory.driver(id)
    if (!before) throw new ServiceError(404, 'driver_not_found')

    const after: DriverRecord = {
      ...before,
      ...(body.fullNameAr === undefined ? {} : { fullNameAr: body.fullNameAr }),
      ...(body.active === undefined ? {} : { active: body.active }),
    }
    // Deactivating a driver mid-shift would strand a live shift nobody can close.
    if (before.active && after.active === false) {
      const live = await deps.shifts.listLiveForDriver(id)
      if (live.length > 0) throw new ServiceError(409, 'driver_has_live_shift', { shiftId: live[0]!.id })
    }
    await deps.directory.updateDriver(after)
    await audit(deps, req, 'drivers', id, 'UPDATE', before, after)
    return after
  })

  // ── Vehicles (B-2) ──────────────────────────────────────────────────────────────────────

  app.get('/vehicles', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    return { vehicles: await deps.directory.listVehicles(branchId) }
  })

  app.post('/vehicles', { config: { permission: 'fleet.manage', subject: targetBranch } }, async (req, reply) => {
    const body = createVehicleRequest.parse(req.body)
    const branchId = resolveBranch(req)
    const vehicle: VehicleRecord = { id: deps.ids.uuid(), branchId, ...body, state: 'ready', active: true }
    try {
      await deps.directory.createVehicle(vehicle)
    } catch (err) {
      if ((err as { code?: string }).code === 'DUPLICATE_CODE') {
        throw new ServiceError(409, 'duplicate_vehicle_code', { code: body.code })
      }
      throw err
    }
    await audit(deps, req, 'vehicles', vehicle.id, 'INSERT', null, vehicle)
    return reply.code(201).send(vehicle)
  })

  app.patch('/vehicles/:id', { config: { permission: 'fleet.manage', subject: vehicleSubject(deps) } }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = updateVehicleRequest.parse(req.body)
    const before = await deps.directory.vehicle(id)
    if (!before) throw new ServiceError(404, 'vehicle_not_found')

    if (body.state !== undefined && body.state !== before.state) {
      // The state machine lives in the domain; an illegal hop is a 422, not a silent write.
      if (!canTransitionVehicle(before.state, body.state)) {
        throw new ServiceError(422, 'illegal_vehicle_transition', { from: before.state, to: body.state })
      }
      // Taking a vehicle out of service mid-shift strands the shift riding on it.
      if (body.state !== 'ready') {
        const live = await deps.shifts.listLiveForVehicle(id)
        if (live.length > 0) throw new ServiceError(409, 'vehicle_has_live_shift', { shiftId: live[0]!.id })
      }
    }

    const after: VehicleRecord = {
      ...before,
      ...(body.state === undefined ? {} : { state: body.state }),
      ...(body.active === undefined ? {} : { active: body.active }),
    }
    await deps.directory.updateVehicle(after)
    await audit(deps, req, 'vehicles', id, 'UPDATE', before, after)
    return after
  })

  // ── Driver ↔ vehicle assignments (B-3 / س34) ────────────────────────────────────────────

  /**
   * The manager binds a bike to a driver ahead of the shift. Once bound, `createShift` refuses
   * any other bike for that driver — the driver app then shows him one vehicle instead of a menu.
   */
  app.post('/assignments', { config: { permission: 'fleet.manage', subject: targetBranch } }, async (req, reply) => {
    const body = createAssignmentRequest.parse(req.body)
    const branchId = resolveBranch(req)

    const [driver, vehicle] = await Promise.all([
      deps.directory.driver(body.driverId),
      deps.directory.vehicle(body.vehicleId),
    ])
    if (!driver || !vehicle) throw new ServiceError(404, 'driver_or_vehicle_not_found')
    // A cross-branch binding would produce a shift `createShift` itself refuses; catch it here,
    // where the manager can still see which of the two is in the wrong branch.
    if (driver.branchId !== branchId || vehicle.branchId !== branchId) {
      throw new ServiceError(422, 'cross_branch_assignment')
    }

    const assignment: AssignmentRecord = {
      id: deps.ids.uuid(),
      branchId,
      driverId: driver.id,
      vehicleId: vehicle.id,
      businessDate: body.businessDate ?? todayFor(deps),
      shiftNo: body.shiftNo,
      createdBy: req.actor?.userId ?? null,
    }

    try {
      await deps.assignments.create(assignment)
    } catch (err) {
      // Both adapters raise DUPLICATE_ASSIGNMENT; the table's two UNIQUE constraints are the real
      // guard, so a race between two managers still ends here rather than in a double booking.
      if ((err as { code?: string }).code === 'DUPLICATE_ASSIGNMENT') {
        throw new ServiceError(409, 'already_assigned')
      }
      throw err
    }
    await audit(deps, req, 'assignments', assignment.id, 'INSERT', null, assignment)
    return reply.code(201).send(assignment)
  })

  app.get('/assignments', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const { date } = z.object({ date: z.string().optional() }).parse(req.query)
    const businessDate = date ?? todayFor(deps)
    return { businessDate, assignments: await deps.assignments.listByDate(branchId, businessDate) }
  })

  app.delete('/assignments/:id', { config: { permission: 'fleet.manage', subject: ownBranch } }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    await deps.assignments.delete(id)
    await audit(deps, req, 'assignments', id, 'DELETE', { id }, null)
    return { ok: true }
  })

  // ── Documents with expiry (B-1 / س37) ───────────────────────────────────────────────────

  app.post('/documents', { config: { permission: 'fleet.manage', subject: targetBranch } }, async (req, reply) => {
    const body = createDocumentRequest.parse(req.body)
    const branchId = resolveBranch(req)

    // Exactly one owner, matching the CHECK constraint on the table.
    const ownerOk =
      (body.ownerKind === 'driver' && body.driverId !== null && body.vehicleId === null) ||
      (body.ownerKind === 'vehicle' && body.vehicleId !== null && body.driverId === null)
    if (!ownerOk) throw new ServiceError(422, 'document_owner_mismatch')

    const doc: DocumentRecord = { id: deps.ids.uuid(), branchId, ...body, supersededBy: null }
    await deps.directory.createDocument(doc)
    await audit(deps, req, 'documents', doc.id, 'INSERT', null, doc)
    return reply.code(201).send({ ...doc, status: documentStatusOn(doc.expiresOn, todayFor(deps)) })
  })

  /**
   * The expiry board (س37). Alerts fire at T-30/14/7/0 from the same domain rules; this is the
   * screen a manager opens to see what is coming.
   */
  app.get('/documents/expiring', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const { through } = z.object({ through: z.string().optional() }).parse(req.query)
    const today = todayFor(deps)
    const horizon = through ?? addDays(today, 30)

    const docs = await deps.directory.listExpiringDocuments(branchId, horizon)
    return {
      today,
      through: horizon,
      documents: docs.map((d) => ({
        id: d.id,
        kind: d.kind,
        driverId: d.driverId,
        vehicleId: d.vehicleId,
        expiresOn: d.expiresOn,
        status: documentStatusOn(d.expiresOn, today),
      })),
    }
  })
}

const driverSubject = (deps: Deps) => async (req: { params: unknown }) => {
  const { id } = z.object({ id: z.string() }).parse(req.params)
  const driver = await deps.directory.driver(id)
  return driver ? { branchId: driver.branchId } : {}
}

const vehicleSubject = (deps: Deps) => async (req: { params: unknown }) => {
  const { id } = z.object({ id: z.string() }).parse(req.params)
  const vehicle = await deps.directory.vehicle(id)
  return vehicle ? { branchId: vehicle.branchId } : {}
}

/** Every mutation is audited (A-5 / س79) — who, when, before and after. */
async function audit(
  deps: Deps,
  req: { actor?: { userId: string; branchId: string | null }; requestId: string },
  tableName: string,
  recordId: string,
  action: 'INSERT' | 'UPDATE' | 'DELETE',
  before: unknown,
  after: unknown,
): Promise<void> {
  await deps.audit.append({
    tableName,
    recordId,
    action,
    actorId: req.actor?.userId ?? null,
    actorKind: req.actor ? 'user' : 'system',
    branchId: req.actor?.branchId ?? null,
    requestId: req.requestId,
    before,
    after,
    occurredAtMs: deps.clock.nowMs(),
  })
}
