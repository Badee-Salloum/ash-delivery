import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps, DocumentRecord, DriverRecord } from '@ash/contracts'
import {
  createAssignmentRequest,
  createBatteryRequest,
  createBranchRequest,
  createDocumentRequest,
  createDriverRequest,
  createGovernorateRequest,
  createVehicleRequest,
  createVehicleTypeRequest,
  updateBatteryRequest,
  updateBranchRequest,
  updateDriverRequest,
  updateGovernorateRequest,
  updateVehicleRequest,
  updateVehicleTypeRequest,
} from '@ash/contracts'
import type {
  AssignmentRecord,
  BatteryRecord,
  BranchRecord,
  GovernorateRecord,
  VehicleRecord,
  VehicleTypeRecord,
} from '@ash/contracts'
import {
  addDays,
  canTransitionVehicle,
  documentStatusOn,
  formatVehicleNumber,
  nextMachineNo,
} from '@ash/domain'
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

  /**
   * Add a bike.
   *
   * The caller no longer supplies a code. «رقم الآلية» is
   * `<governorate>-<branch>-<type>-<machine>`, assembled here from where the bike actually sits,
   * so a vehicle whose printed number disagrees with its branch is unrepresentable.
   *
   * This route used to 500 in production and report success: the console sent the literal string
   * `'e_motorbike'` for a `uuid` foreign key, the insert failed with 22P02, and the UI swallowed
   * it. An unknown type is now a 404 that names the problem.
   */
  app.post('/vehicles', { config: { permission: 'fleet.manage', subject: targetBranch } }, async (req, reply) => {
    const body = createVehicleRequest.parse(req.body)
    const branchId = resolveBranch(req)
    const { code, machineNo } = await composeVehicleNumber(deps, branchId, body.vehicleTypeId, body.machineNo)

    const vehicle: VehicleRecord = {
      id: deps.ids.uuid(),
      branchId,
      vehicleTypeId: body.vehicleTypeId,
      code,
      machineNo,
      plateNo: body.plateNo,
      state: 'ready',
      active: true,
    }
    try {
      await deps.directory.createVehicle(vehicle)
    } catch (err) {
      if ((err as { code?: string }).code === 'DUPLICATE_CODE') {
        throw new ServiceError(409, 'duplicate_vehicle_code', { code })
      }
      throw err
    }
    await audit(deps, req, 'vehicles', vehicle.id, 'INSERT', null, vehicle)
    return reply.code(201).send(vehicle)
  })

  /**
   * Work out a bike's number from where it sits.
   *
   * Exported through the closure rather than inlined because the admin console previews the
   * number before the bike exists, and a preview that computes it differently from the write
   * would be worse than no preview at all.
   */
  async function composeVehicleNumber(
    d: Deps,
    branchId: string,
    vehicleTypeId: string,
    requested: number | undefined,
  ): Promise<{ code: string; machineNo: number }> {
    const [branch, types, siblings] = await Promise.all([
      d.directory.branch(branchId),
      d.directory.listVehicleTypes(),
      d.directory.listVehicles(branchId),
    ])
    if (!branch) throw new ServiceError(404, 'branch_not_found')

    const type = types.find((t) => t.id === vehicleTypeId)
    if (!type) throw new ServiceError(404, 'vehicle_type_not_found', { vehicleTypeId })

    const governorate = (await d.directory.listGovernorates()).find((g) => g.id === branch.governorateId)
    if (!governorate) throw new ServiceError(422, 'branch_has_no_governorate', { branchId })

    const taken = siblings.filter((v) => v.vehicleTypeId === vehicleTypeId).map((v) => v.machineNo)
    // An explicit number is honoured; the UNIQUE constraint is what actually refuses a clash, so
    // this is a courtesy, not the guard.
    const machineNo = requested ?? nextMachineNo(taken)

    return {
      code: formatVehicleNumber({
        governorateNo: governorate.no,
        branchNo: branch.branchNo,
        typeNo: type.typeNo,
        machineNo,
      }),
      machineNo,
    }
  }

  /** What the next bike of this type would be called, for the console's live preview. */
  app.get('/vehicles/next-number', { config: { permission: 'fleet.manage', subject: ownBranch } }, async (req) => {
    const { vehicleTypeId } = z.object({ vehicleTypeId: z.string().min(1) }).parse(req.query)
    return composeVehicleNumber(deps, resolveBranch(req), vehicleTypeId, undefined)
  })

  // ── Geography and the numbering scheme ──────────────────────────────────────────────────
  // `settings.write` (sysadmin only): renumbering restates printed vehicle codes, which is a
  // configuration act, not fleet operations.

  app.get('/governorates', { config: { permission: 'branch_data.view', subject: ownBranch } }, async () => ({
    governorates: await deps.directory.listGovernorates(),
  }))

  app.post('/governorates', { config: { permission: 'settings.write' } }, async (req, reply) => {
    const body = createGovernorateRequest.parse(req.body)
    const governorate: GovernorateRecord = { id: deps.ids.uuid(), ...body, active: true }
    await createOrConflict(() => deps.directory.createGovernorate(governorate), 'duplicate_governorate_no')
    await audit(deps, req, 'governorates', governorate.id, 'INSERT', null, governorate)
    return reply.code(201).send(governorate)
  })

  app.patch('/governorates/:id', { config: { permission: 'settings.write' } }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = updateGovernorateRequest.parse(req.body)
    const before = (await deps.directory.listGovernorates()).find((g) => g.id === id)
    if (!before) throw new ServiceError(404, 'governorate_not_found')

    const after: GovernorateRecord = {
      ...before,
      ...(body.no === undefined ? {} : { no: body.no }),
      ...(body.nameAr === undefined ? {} : { nameAr: body.nameAr }),
      ...(body.nameEn === undefined ? {} : { nameEn: body.nameEn }),
      ...(body.active === undefined ? {} : { active: body.active }),
    }
    await createOrConflict(() => deps.directory.updateGovernorate(after), 'duplicate_governorate_no')
    await audit(deps, req, 'governorates', id, 'UPDATE', before, after)
    return after
  })

  app.post('/branches', { config: { permission: 'settings.write' } }, async (req, reply) => {
    const body = createBranchRequest.parse(req.body)
    const branch: BranchRecord = { id: deps.ids.uuid(), ...body }
    await createOrConflict(() => deps.directory.createBranch(branch), 'duplicate_branch')
    await audit(deps, req, 'branches', branch.id, 'INSERT', null, branch)
    return reply.code(201).send(branch)
  })

  app.patch('/branches/:id', { config: { permission: 'settings.write' } }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = updateBranchRequest.parse(req.body)
    const before = await deps.directory.branch(id)
    if (!before) throw new ServiceError(404, 'branch_not_found')

    const after: BranchRecord = {
      ...before,
      ...(body.nameAr === undefined ? {} : { nameAr: body.nameAr }),
      ...(body.nameEn === undefined ? {} : { nameEn: body.nameEn }),
      ...(body.governorateId === undefined ? {} : { governorateId: body.governorateId }),
      ...(body.branchNo === undefined ? {} : { branchNo: body.branchNo }),
    }
    await createOrConflict(() => deps.directory.updateBranch(after), 'duplicate_branch')
    await audit(deps, req, 'branches', id, 'UPDATE', before, after)
    // Moving a branch or renumbering it changes the first two segments of every one of its
    // vehicles' numbers. Restate them here for the same reason updateVehicleType does.
    if (before.governorateId !== after.governorateId || before.branchNo !== after.branchNo) {
      await restateBranchVehicleCodes(after)
    }
    return after
  })

  async function restateBranchVehicleCodes(branch: BranchRecord): Promise<void> {
    const [governorates, types, vehicles] = await Promise.all([
      deps.directory.listGovernorates(),
      deps.directory.listVehicleTypes(),
      deps.directory.listVehicles(branch.id),
    ])
    const governorate = governorates.find((g) => g.id === branch.governorateId)
    if (!governorate) return
    for (const vehicle of vehicles) {
      const type = types.find((t) => t.id === vehicle.vehicleTypeId)
      if (!type) continue
      await deps.directory.updateVehicle({
        ...vehicle,
        code: formatVehicleNumber({
          governorateNo: governorate.no,
          branchNo: branch.branchNo,
          typeNo: type.typeNo,
          machineNo: vehicle.machineNo,
        }),
      })
    }
  }

  app.get('/vehicle-types', { config: { permission: 'branch_data.view', subject: ownBranch } }, async () => ({
    vehicleTypes: await deps.directory.listVehicleTypes(),
  }))

  app.post('/vehicle-types', { config: { permission: 'settings.write' } }, async (req, reply) => {
    const body = createVehicleTypeRequest.parse(req.body)
    const type: VehicleTypeRecord = { id: deps.ids.uuid(), ...body, active: true }
    await createOrConflict(() => deps.directory.createVehicleType(type), 'duplicate_vehicle_type')
    await audit(deps, req, 'vehicle_types', type.id, 'INSERT', null, type)
    return reply.code(201).send(type)
  })

  /** Renumbering restates the printed code of every vehicle of this type, in one transaction. */
  app.patch('/vehicle-types/:id', { config: { permission: 'settings.write' } }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = updateVehicleTypeRequest.parse(req.body)
    const before = (await deps.directory.listVehicleTypes()).find((t) => t.id === id)
    if (!before) throw new ServiceError(404, 'vehicle_type_not_found')

    const after: VehicleTypeRecord = {
      ...before,
      ...(body.nameAr === undefined ? {} : { nameAr: body.nameAr }),
      ...(body.nameEn === undefined ? {} : { nameEn: body.nameEn }),
      ...(body.typeNo === undefined ? {} : { typeNo: body.typeNo }),
      ...(body.active === undefined ? {} : { active: body.active }),
    }
    await createOrConflict(
      () => deps.directory.updateVehicleType(after, formatVehicleNumber),
      'duplicate_vehicle_type',
    )
    await audit(deps, req, 'vehicle_types', id, 'UPDATE', before, after)
    return after
  })

  // ── Batteries (SRS section L seam) ──────────────────────────────────────────────────────

  app.get('/batteries', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => ({
    batteries: await deps.directory.listBatteries(resolveBranch(req)),
  }))

  app.post('/batteries', { config: { permission: 'fleet.manage', subject: targetBranch } }, async (req, reply) => {
    const body = createBatteryRequest.parse(req.body)
    const branchId = resolveBranch(req)
    assertPlacement(body.vehicleId, body.slotNo)

    const battery: BatteryRecord = {
      id: deps.ids.uuid(),
      branchId,
      serialNo: body.serialNo,
      bmsMac: body.bmsMac,
      capacityAh: body.capacityAh,
      vehicleId: body.vehicleId,
      slotNo: body.slotNo,
      state: 'ready',
      active: true,
    }
    await createOrConflict(() => deps.directory.createBattery(battery), 'duplicate_battery')
    await audit(deps, req, 'batteries', battery.id, 'INSERT', null, battery)
    return reply.code(201).send(battery)
  })

  app.patch('/batteries/:id', { config: { permission: 'fleet.manage', subject: batterySubject(deps) } }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = updateBatteryRequest.parse(req.body)
    const before = await deps.directory.battery(id)
    if (!before) throw new ServiceError(404, 'battery_not_found')

    const after: BatteryRecord = {
      ...before,
      ...(body.serialNo === undefined ? {} : { serialNo: body.serialNo }),
      ...(body.bmsMac === undefined ? {} : { bmsMac: body.bmsMac }),
      ...(body.capacityAh === undefined ? {} : { capacityAh: body.capacityAh }),
      ...(body.vehicleId === undefined ? {} : { vehicleId: body.vehicleId }),
      ...(body.slotNo === undefined ? {} : { slotNo: body.slotNo }),
      ...(body.state === undefined ? {} : { state: body.state }),
      ...(body.active === undefined ? {} : { active: body.active }),
    }
    assertPlacement(after.vehicleId, after.slotNo)

    // Pulling a pack off a bike mid-shift would leave the close gate demanding a screenshot for
    // a pack that is no longer there — and the shift could never be submitted.
    if (before.vehicleId !== null && after.vehicleId !== before.vehicleId) {
      const live = await deps.shifts.listLiveForVehicle(before.vehicleId)
      if (live.length > 0) throw new ServiceError(409, 'vehicle_has_live_shift', { shiftId: live[0]!.id })
    }

    await createOrConflict(() => deps.directory.updateBattery(after), 'duplicate_battery')
    await audit(deps, req, 'batteries', id, 'UPDATE', before, after)
    return after
  })

  /** Mirrors the schema CHECK: fitted means BOTH a bike and a slot, or neither. */
  function assertPlacement(vehicleId: string | null, slotNo: number | null): void {
    if ((vehicleId === null) !== (slotNo === null)) {
      throw new ServiceError(422, 'battery_half_fitted', {
        hint: 'send both vehicleId and slotNo to fit a pack, or neither to leave it a spare',
      })
    }
  }

  /** Both adapters raise DUPLICATE_CODE, so the route handles one case rather than two. */
  async function createOrConflict(run: () => Promise<void>, code: string): Promise<void> {
    try {
      await run()
    } catch (err) {
      const raised = (err as { code?: string }).code
      if (raised === 'DUPLICATE_CODE') throw new ServiceError(409, code)
      if (raised === 'BATTERY_SLOT_TAKEN') throw new ServiceError(409, 'battery_slot_taken')
      if (raised === 'BATTERY_HALF_FITTED') throw new ServiceError(422, 'battery_half_fitted')
      throw err
    }
  }

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

const batterySubject = (deps: Deps) => async (req: { params: unknown }) => {
  const { id } = z.object({ id: z.string() }).parse(req.params)
  const battery = await deps.directory.battery(id)
  return battery ? { branchId: battery.branchId } : {}
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
