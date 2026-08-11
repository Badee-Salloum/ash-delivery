import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps } from '@ash/contracts'
import {
  addOrderRequest,
  addTrancheRequest,
  gpsPingRequest,
  approveCloseRequest,
  forceCloseRequest,
  approveOpenRequest,
  closeWeekRequest,
  createShiftRequest,
  endPackageRequest,
  loginRequest,
  uploadEvidenceParams,
  serializeMoney,
  setFxRequest,
  updateSettingsRequest,
  startPackageRequest,
  putBatteryReadingsRequest,
  batterySwapRequest,
  closeFiguresRequest,
  operationsRequest,
  reviseOperationsRequest,
} from '@ash/contracts'
import { addDays, checkWeekClose, dayOfWeek, minor, resolveFxDay, sum, weekClosedOn, weekStartFor } from '@ash/domain'
import {
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  beginEnrollment,
  confirmEnrollment,
  login,
  logout,
  mfaEnrollmentRequired,
  resolveSession,
  verifySecondFactor,
} from './auth.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'
import { assertEveryRouteDeclaresPermission, collectRoutes, makeAuthorize, resetRouteRegistry } from './rbac.ts'
import { registerExpenseRoutes } from './expenses.routes.ts'
import { registerFleetRoutes } from './fleet.routes.ts'
import { registerUserRoutes } from './users.routes.ts'
import { registerDashboardRoutes } from './dashboard.routes.ts'
import { registerNotificationRoutes } from './notification.routes.ts'
import { registerTierRoutes } from './tier.routes.ts'
import { registerTreasuryRoutes } from './treasury.routes.ts'
import { MAX_UPLOAD_BYTES, readEvidence, uploadEvidence } from './media.service.ts'
import {
  ServiceError,
  addOrder,
  addManualOrder,
  addTranche,
  approveClose,
  approveOpen,
  cancelShift,
  createShift,
  ensureFxDay,
  evaluateShift,
  rejectClose,
  reviseCloseFigures,
  reviseOperations,
  submitOperations,
  rejectOpen,
  reportIncident,
  requestRephoto,
  resumeShift,
  submitEndPackage,
  suspendShift,
  swapBattery,
  voidShift,
  forceClose,
  submitStartPackage,
  includedOrders,
  todayFor,
} from './shifts.service.ts'

export interface AppOptions {
  deps: Deps
  logger?: boolean
  splitGate?: 'advisory' | 'strict'
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { deps } = opts
  const app = Fastify({ logger: opts.logger ?? false, genReqId: () => deps.ids.uuid() })

  resetRouteRegistry()
  collectRoutes(app)
  await app.register(cookie)

  // Evidence photos arrive as RAW BYTES. Fastify has no parser for image/* by default, and we
  // deliberately do not want multipart or base64: a driver on office Wi-Fi should pay for the
  // 300 KB the photo actually weighs, not 400 KB of base64.
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream']) {
    app.addContentTypeParser(mime, { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body)
    })
  }

  const authorize = makeAuthorize(deps)

  // Resolve the session before authorization, on every request.
  app.addHook('onRequest', async (req) => {
    req.requestId = String(req.id)
    const token = req.cookies[SESSION_COOKIE]
    if (!token) return
    const check = await resolveSession(deps, token)
    if (check.ok) {
      req.actor = check.actor
      req.sessionToken = token
      req.mfaSatisfied = check.session.mfaSatisfied

      // B-4 (س41): «نفس تسجيل الدخول اليومي» — an admin staffer's daily login IS their attendance.
      // Drivers are tracked by their shifts, and org-wide roles have no branch to stamp, so only a
      // branch-scoped non-driver is recorded. Once-a-day upsert; fire-and-forget so it never adds
      // latency to, or fails, the request it rides on — the next request re-stamps regardless.
      const actor = check.actor
      if (actor.branchId && actor.roleKey !== 'driver') {
        void deps.attendance.touch(actor.userId, actor.branchId, todayFor(deps), deps.clock.nowMs()).catch(() => undefined)
      }
    }
  })
  app.addHook('preHandler', authorize)

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof ServiceError) {
      return reply.code(err.status).send({ error: err.code, detail: err.detail ?? null })
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_request', detail: err.issues })
    }
    // The week-lock guards (migrations 0006 and 0018) raise 25006. Migration 0006's own comment has
    // always said «the application maps it to a 409» — it did not, so a week-lock refusal surfaced
    // as «خطأ داخلي» and looked like a bug in the system rather than the rule doing its job. The
    // application checks these cases itself and answers 409 first; this is the backstop for any
    // write path that forgets to, and it must not be a 500 when it fires.
    if (typeof (err as { code?: string }).code === 'string' && (err as { code: string }).code === '25006') {
      req.log.warn({ err }, 'refused: sealed week')
      return reply.code(409).send({ error: 'week_locked', detail: null })
    }
    req.log.error({ err }, 'unhandled error')
    return reply.code(500).send({ error: 'internal_error' })
  })

  // ── Health (public on purpose) ──────────────────────────────────────────────────────────
  app.get('/health', { config: { permission: null } }, async () => ({ ok: true }))

  // ── Auth ────────────────────────────────────────────────────────────────────────────────
  app.post('/auth/login', { config: { permission: null } }, async (req, reply) => {
    const body = loginRequest.parse(req.body)
    const result = await login(deps, body.username, body.password)

    if (!result.ok) {
      await deps.audit.append({
        tableName: 'users',
        recordId: body.username,
        action: 'UPDATE',
        actorId: null,
        actorKind: 'anonymous', // the unauthenticated path has no actor, by definition
        branchId: null,
        requestId: req.requestId,
        before: null,
        after: { loginFailure: result.failure.kind },
        occurredAtMs: deps.clock.nowMs(),
      })
      const status = result.failure.kind === 'locked' ? 423 : 401
      return reply.code(status).send({ error: result.failure.kind })
    }

    await deps.audit.append({
      tableName: 'sessions',
      recordId: result.session.id,
      action: 'INSERT',
      actorId: result.user.id,
      actorKind: 'user',
      branchId: result.user.branchId,
      requestId: req.requestId,
      before: null,
      after: { login: 'success' },
      occurredAtMs: deps.clock.nowMs(),
    })

    return reply
      .setCookie(SESSION_COOKIE, result.token, {
        httpOnly: true,
        sameSite: 'lax', // the SPA is same-origin behind Caddy, so lax is enough and safer
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: SESSION_IDLE_MS / 1000,
      })
      .send({
        userId: result.user.id,
        roleKey: result.user.roleKey,
        branchId: result.user.branchId,
        fullNameAr: result.user.fullNameAr,
        expiresAt: result.session.expiresAtMs,
        // The client uses these to decide whether to show the 2FA code step or an enrol prompt.
        secondFactorRequired: !result.session.mfaSatisfied,
        enrollmentRequired: mfaEnrollmentRequired(result.user),
      })
  })

  // ── Second factor (SRS §7, A-1) ──────────────────────────────────────────────────────────

  /** Present the TOTP code after a password login, flipping the session to fully authenticated. */
  app.post('/auth/2fa/verify', { config: { permission: null } }, async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.body)
    const result = await verifySecondFactor(deps, req.cookies[SESSION_COOKIE], code)
    if (!result.ok) {
      const status = result.reason === 'bad_code' ? 401 : 400
      return reply.code(status).send({ error: result.reason })
    }
    return reply.send({ ok: true })
  })

  /** Begin enrolment: returns a secret + otpauth URI for the authenticator app to scan. */
  app.post('/auth/2fa/enroll', { config: { permission: null } }, async (req, reply) => {
    if (!req.actor) return reply.code(401).send({ error: 'unauthenticated' })
    const user = await deps.users.findById(req.actor.userId)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const challenge = beginEnrollment(deps, user)
    // The secret is echoed once so the client can render a manual-entry fallback; it is not
    // stored until confirmEnrollment proves a code from it.
    return reply.send(challenge)
  })

  /** Confirm enrolment with a code, which proves the phone and server agree before persisting. */
  app.post('/auth/2fa/confirm', { config: { permission: null } }, async (req, reply) => {
    if (!req.actor) return reply.code(401).send({ error: 'unauthenticated' })
    const { secret, code } = z.object({ secret: z.string().min(8), code: z.string() }).parse(req.body)
    const user = await deps.users.findById(req.actor.userId)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })

    const confirmed = await confirmEnrollment(deps, user, secret, code)
    if (!confirmed) return reply.code(401).send({ error: 'bad_code' })

    await deps.audit.append({
      tableName: 'users',
      recordId: user.id,
      action: 'UPDATE',
      actorId: user.id,
      actorKind: 'user',
      branchId: user.branchId,
      requestId: req.requestId,
      before: { mfaEnrolled: false },
      after: { mfaEnrolled: true },
      occurredAtMs: deps.clock.nowMs(),
    })
    return reply.send({ ok: true, enrolled: true })
  })

  app.post('/auth/logout', { config: { permission: null } }, async (req, reply) => {
    await logout(deps, req.cookies[SESSION_COOKIE])
    // Clearing a cookie only works if the attributes match the ones it was set with — the set
    // cookie is Secure + SameSite=Lax in production, so the clear must be too, or the browser
    // keeps the session cookie and the user is silently logged back in on the next request.
    return reply
      .clearCookie(SESSION_COOKIE, { path: '/', secure: process.env.NODE_ENV === 'production', sameSite: 'lax' })
      .send({ ok: true })
  })

  app.get('/me', { config: { permission: null } }, async (req, reply) => {
    if (!req.actor) return reply.code(401).send({ error: 'unauthenticated' })
    return {
      userId: req.actor.userId,
      roleKey: req.actor.roleKey,
      branchId: req.actor.branchId,
      driverId: req.actor.driverId ?? null,
      businessDate: todayFor(deps),
    }
  })

  // ── The driver's own assignment (SRS B-3) ───────────────────────────────────────────────
  // A driver picks the bike he is actually on today; the server still enforces the binding and
  // one-live-shift rules on POST /shifts, so the phone can never create an unbacked shift.
  app.get('/me/assignment', { config: { permission: 'shift.operate', subject: (req) => ({ driverId: req.actor?.driverId ?? null }) } }, async (req, reply) => {
    if (!req.actor?.driverId) return reply.code(422).send({ error: 'not_a_driver' })
    const driver = await deps.directory.driver(req.actor.driverId)
    if (!driver) return reply.code(404).send({ error: 'driver_not_found' })
    const today = todayFor(deps)
    const [allVehicles, live, assignments] = await Promise.all([
      deps.directory.listVehicles(driver.branchId),
      deps.shifts.listLiveForDriver(driver.id),
      deps.assignments.findForDriver(driver.id, today),
    ])

    // SRS B-3: once the manager has bound a bike to this driver for today, the app shows that bike
    // and nothing else — the driver confirms, he does not choose. With no assignment on file the
    // full ready list is returned, so a branch that has not started assigning still works.
    const assignedIds = new Set(assignments.map((a) => a.vehicleId))
    const vehicles = assignedIds.size > 0 ? allVehicles.filter((v) => assignedIds.has(v.id)) : allVehicles
    return {
      driverId: driver.id,
      branchId: driver.branchId,
      businessDate: today,
      assigned: assignedIds.size > 0,
      liveShiftId: live[0]?.id ?? null,
      liveShiftState: live[0]?.state ?? null,
      // A bike already bound to a live shift is NOT pickable: POST /shifts refuses it with
      // `vehicle_already_on_shift`. Reporting it here is what stops a driver choosing a dead end
      // and staring at a screen that never advances.
      vehicles: await Promise.all(
        vehicles
          .filter((v) => v.active && v.state === 'ready')
          .map(async (v) => ({
            id: v.id,
            code: v.code,
            state: v.state,
            busy: (await deps.shifts.listLiveForVehicle(v.id)).length > 0,
            // Whose shift it is matters: a driver told his own bike is «على نوبة الآن» has no way
            // to tell that the shift blocking him is the one he is supposed to be finishing.
            busyByMe: (await deps.shifts.listLiveForVehicle(v.id)).some((s) => s.driverId === driver.id),
            // The packs fitted to this bike. The driver has no `branch_data.view`, so this is the
            // only way his app can know how many BMS screenshots the gate will ask him for — and
            // it is the SAME list the gate counts, so the checklist cannot disagree with the gate.
            batteries: (await deps.directory.listBatteriesForVehicle(v.id)).map((b) => ({
              id: b.id,
              slotNo: b.slotNo,
              capacityAh: b.capacityAh,
              serialNo: b.serialNo,
              // Which BMS app this pack ships with, so the driver's reader uses the right label
              // spellings and layout rule instead of trying every profile it knows.
              bmsProfile: b.bmsProfile,
            })),
          })),
      ),
      // Ready spares on the branch shelf (not fitted to any bike), so the driver can pick one when
      // he swaps a depleted pack mid-shift (SRS §L seam). Same fields as the fitted packs above.
      spareBatteries: (await deps.directory.listBatteries(driver.branchId))
        .filter((b) => b.vehicleId === null && b.state === 'ready' && b.active)
        .map((b) => ({ id: b.id, slotNo: b.slotNo, capacityAh: b.capacityAh, serialNo: b.serialNo, bmsProfile: b.bmsProfile })),
    }
  })

  // ── Shifts ──────────────────────────────────────────────────────────────────────────────
  const mediaSubject = async (req: { params: unknown }) => {
    const { mediaId } = z.object({ mediaId: z.string() }).parse(req.params)
    const media = await deps.media.findById(mediaId)
    return media ? { branchId: media.branchId } : {}
  }

  const shiftSubject = async (req: { params: unknown }) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const shift = await deps.shifts.findById(id)
    return shift ? { driverId: shift.driverId, branchId: shift.branchId } : {}
  }

  /**
   * A day's shifts for the branch — the manager's view of who is out and on what.
   *
   * It is also how a stranded bike is found: a shift left in `draft` never reaches the approval
   * queue (nothing notified), yet it still holds its vehicle. Listing every state is what makes
   * that visible, and `DELETE /shifts/:id` is what clears it.
   */
  app.get(
    '/shifts',
    { config: { permission: 'branch_data.view', subject: branchSubject } },
    async (req) => {
      const { date, live } = z.object({ date: z.string().optional(), live: z.string().optional() }).parse(req.query)
      const target = resolveBranchId(req)
      const businessDate = date ?? todayFor(deps)
      // `?live=1` asks "who is out RIGHT NOW", which is NOT a question about today's date: a shift
      // that opened before midnight and is still running belongs to yesterday's business date, and
      // the date-filtered list dropped it — the bike looked free and the shift unreachable from the
      // live screen. `listLiveForBranch` is the same date-independent read the GPS map uses.
      const shifts = live === '1'
        ? await deps.shifts.listLiveForBranch(target)
        : await deps.shifts.listByBranchAndDate(target, businessDate)
      return {
        businessDate,
        shifts: await Promise.all(
          shifts.map(async (s) => ({
            id: s.id,
            driverId: s.driverId,
            vehicleId: s.vehicleId,
            shiftNo: s.shiftNo,
            state: s.state,
            // Enough for a manager to judge a running shift at a glance without opening it: the
            // odometer he started on, the branch money he is carrying, and how much work is on the
            // shift so far. Money crosses as decimal strings, never JSON numbers.
            businessDate: s.businessDate,
            odometerStart: s.odoStart,
            floatTotal: serializeMoney(sum(s.floatTranches)),
            topupTotal: serializeMoney(sum(s.topupTranches)),
            // How much work COUNTS on the shift. An unchecked operation is stored and visible but
            // is out of the money, so counting it here would tell the manager a shift is worth
            // more than the approval will post.
            orderCount: includedOrders(await deps.orders.listByShift(s.id)).length,
            // WHICH SHIFT TO OPEN FIRST. The queue showed a driver, a vehicle and a count, so a
            // manager could not tell a clean shift from a broken one without opening every single
            // one — and approving from the list is deliberately not offered. The difference is
            // already stored on the row by `evaluateShift`; serving it costs nothing.
            equationDiff: s.equationDiff === null ? null : serializeMoney(s.equationDiff),
          })),
        ),
      }
    },
  )

  app.post(
    '/shifts',
    {
      config: {
        permission: 'shift.operate',
        subject: async (req) => {
          const body = createShiftRequest.parse(req.body)
          const driver = await deps.directory.driver(body.driverId)
          return { driverId: body.driverId, branchId: driver?.branchId ?? null }
        },
      },
    },
    async (req, reply) => {
      const body = createShiftRequest.parse(req.body)
      const shift = await createShift(deps, req.actor!, body)
      return reply.code(201).send({ id: shift.id, state: shift.state, businessDate: shift.businessDate })
    },
  )

  /**
   * Discard a shift that never opened.
   *
   * A driver who backs out of the start screen leaves the shift in `draft`/`awaiting_open_approval`
   * — and that shift still holds the bike, so nobody can start it again for the rest of the day.
   * The manager needs a way out that does not involve the database. Nothing has posted yet at
   * these two states, so there is no ledger entry to reverse; the service refuses anything later.
   */
  app.delete('/shifts/:id', { config: { permission: 'shift.approve', subject: shiftSubject } }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const shift = await cancelShift(deps, id)
    await deps.audit.append({
      tableName: 'shifts',
      recordId: shift.id,
      action: 'DELETE',
      actorId: req.actor?.userId ?? null,
      actorKind: req.actor ? 'user' : 'system',
      branchId: shift.branchId,
      requestId: req.requestId,
      before: { state: shift.state, driverId: shift.driverId, vehicleId: shift.vehicleId },
      after: null,
      occurredAtMs: deps.clock.nowMs(),
    })
    return { ok: true, id: shift.id }
  })

  /**
   * Record what the driver read off each battery pack's BMS app.
   *
   * Separate from the start/end package because the packs are separate assets: one screenshot per
   * pack, corrected independently, and a retake replaces that pack's reading rather than adding a
   * second one. `ocrRaw` carries what the OCR produced before the driver touched anything, which
   * is what makes SRS D-3's "the manual edit AND its difference from the OCR reading" recoverable
   * later rather than only at the moment of typing.
   */
  app.put(
    '/shifts/:id/battery-readings',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = putBatteryReadingsRequest.parse(req.body)
      const shift = await deps.shifts.findById(id)
      if (!shift) throw new ServiceError(404, 'shift_not_found')

      // Only packs actually fitted to THIS bike. Without this a driver could attach a reading
      // from a healthy pack on another machine and satisfy his own bike's gate with it.
      const fitted = await deps.directory.listBatteriesForVehicle(shift.vehicleId)
      for (const reading of body.readings) {
        const battery = fitted.find((b) => b.id === reading.batteryId)
        if (!battery) {
          throw new ServiceError(422, 'battery_not_on_this_vehicle', { batteryId: reading.batteryId })
        }
        await deps.batteryReadings.upsert({
          shiftId: shift.id,
          batteryId: battery.id,
          package: body.package,
          slotNo: battery.slotNo ?? 1,
          percent: reading.percent,
          packMillivolts: reading.packMillivolts,
          cycleCount: reading.cycleCount,
          remainCapacityDah: reading.remainCapacityDah,
          fullCapacityDah: reading.fullCapacityDah,
          mosTempDc: reading.mosTempDc,
          t1Dc: reading.t1Dc,
          t2Dc: reading.t2Dc,
          mediaId: null,
          source: reading.source,
          ocrRaw: reading.ocrRaw ?? null,
          batterySwapId: null,
        })
      }
      return { readings: await deps.batteryReadings.listByShift(shift.id) }
    },
  )

  /**
   * A mid-shift battery swap (SRS §L seam). The driver traded a depleted pack for a charged spare;
   * both readings are captured and the bike re-fitted. `shift.operate` (his own live shift). Audited
   * — it moves an asset between the bike and the shelf.
   */
  app.post(
    '/shifts/:id/battery-swap',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = batterySwapRequest.parse(req.body)
      const result = await swapBattery(deps, req.actor!, id, body)
      await deps.audit.append({
        tableName: 'battery_swaps',
        recordId: result.swap.id,
        action: 'INSERT',
        actorId: req.actor!.userId,
        actorKind: 'user',
        branchId: req.actor!.branchId,
        requestId: req.requestId,
        before: null,
        after: {
          slotNo: result.swap.slotNo,
          outBatteryId: result.swap.outBatteryId,
          inBatteryId: result.swap.inBatteryId,
        },
        occurredAtMs: deps.clock.nowMs(),
      })
      return reply.code(201).send({
        swap: { id: result.swap.id, seqNo: result.swap.seqNo, slotNo: result.swap.slotNo },
        readings: result.readings,
        // The refreshed fitted set, in the driver-app FittedBattery shape, so the close screen asks
        // for the pack now on the bike, not the one that just came off.
        batteries: result.fitted.map((b) => ({
          id: b.id,
          slotNo: b.slotNo,
          capacityAh: b.capacityAh,
          serialNo: b.serialNo,
          bmsProfile: b.bmsProfile,
        })),
      })
    },
  )

  app.put(
    '/shifts/:id/start-package',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = startPackageRequest.parse(req.body)
      const shift = await submitStartPackage(deps, req.actor!, id, body)
      return { id: shift.id, state: shift.state }
    },
  )

  app.post(
    '/shifts/:id/approve-open',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = approveOpenRequest.parse(req.body)
      const shift = await approveOpen(deps, req.actor!, id, body)
      return { id: shift.id, state: shift.state }
    },
  )

  /**
   * The driver records his own YALLAGO deliveries, off the «Recent orders» list he scans at the end
   * of his shift. A MANUAL job — the branch's own work, priced by hand — is a manager's to enter
   * (`/orders/manual`): letting it in here would let a driver write his own share.
   */
  app.post(
    '/shifts/:id/orders',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = addOrderRequest.parse(req.body)
      if (body.kind === 'manual') throw new ServiceError(403, 'manual_order_is_manager_only')
      const order = await addOrder(deps, req.actor!, id, body)
      return reply.code(201).send({ id: order.id, providerOrderNo: order.providerOrderNo })
    },
  )

  // A higher-level manager adds a manual order to reconcile a shift (C-7 «missing order»). Audited,
  // since it moves money into BR1; permitted through pending_review, forcing a re-review after.
  app.post(
    '/shifts/:id/orders/manual',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = addOrderRequest.parse(req.body)
      const order = await addManualOrder(deps, req.actor!, id, body)
      const shift = await deps.shifts.findById(id)
      await deps.audit.append({
        tableName: 'shift_orders',
        recordId: order.id,
        action: 'INSERT',
        actorId: req.actor!.userId,
        actorKind: 'user',
        // The SHIFT's branch, not the actor's: a GM/sysadmin has none, and an audit row filed
        // against `null` is invisible to every branch-scoped read of the log.
        branchId: shift?.branchId ?? req.actor!.branchId,
        requestId: req.requestId,
        before: null,
        after: {
          ...order,
          fee: serializeMoney(order.fee),
          driverShare: order.driverShare === null ? null : serializeMoney(order.driverShare),
          companyShare: order.companyShare === null ? null : serializeMoney(order.companyShare),
          manual: true,
        },
        occurredAtMs: deps.clock.nowMs(),
      })
      return reply.code(201).send({ id: order.id, providerOrderNo: order.providerOrderNo })
    },
  )

  app.put(
    '/shifts/:id/end-package',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = endPackageRequest.parse(req.body)
      const { shift, br1 } = await submitEndPackage(deps, req.actor!, id, body)
      return { id: shift.id, state: shift.state, br1: serializeBr1(br1) }
    },
  )

  /**
   * Evidence upload (SRS C-6). Raw image bytes as the body — not multipart, not base64 — so a
   * ~300 KB photo costs 300 KB on a phone connection rather than 400.
   */
  app.put(
    '/shifts/:id/media/:package/:slot',
    {
      config: { permission: 'shift.operate', subject: shiftSubject },
      bodyLimit: MAX_UPLOAD_BYTES,
    },
    async (req, reply) => {
      const params = uploadEvidenceParams.parse(req.params)
      const takenHeader = req.headers['x-client-taken-at']
      const clientTakenAtMs = typeof takenHeader === 'string' && /^\d+$/.test(takenHeader) ? Number(takenHeader) : null

      const result = await uploadEvidence(deps, {
        shiftId: params.id,
        package: params.package,
        slot: params.slot,
        bytes: new Uint8Array(req.body as Buffer),
        clientTakenAtMs,
        uploadedBy: req.actor!.userId,
      })
      return reply.code(201).send({
        mediaId: result.media.id,
        sha256: result.media.sha256,
        byteSize: result.media.byteSize,
        deduped: result.deduped,
        clockSkewMs: result.clockSkewMs,
        slots: result.slotsNow,
      })
    },
  )

  /** Every read is RBAC-checked; evidence is never served from a public path. */
  app.get(
    '/media/:mediaId',
    { config: { permission: 'branch_data.view', subject: mediaSubject } },
    async (req, reply) => {
      const { mediaId } = z.object({ mediaId: z.string() }).parse(req.params)
      const { media, bytes } = await readEvidence(deps, mediaId)
      return reply
        .header('content-type', media.mimeType)
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(Buffer.from(bytes))
    },
  )

  /**
   * Everything both shift screens are built from: the packages, the evidence that arrived, and
   * the orders. Shared so the driver's view and the manager's view can never drift apart about
   * what a shift actually contains — they differ only in what is ADDED on top (the manager gets
   * BR1 and its causes; the driver does not, per BR8).
   */
  const shiftSnapshot = async (shiftId: string) => {
    const shift = await deps.shifts.findById(shiftId)
    if (!shift) return null
    // Per-pack readings, joined to the packs so a slot and a capacity are shown rather than a
    // uuid. A two-pack bike hands back two of these at each end of the shift.
    const [orders, movements, readings, fitted, slots, swaps, allBatteries] = await Promise.all([
      deps.orders.listByShift(shiftId),
      // Every movement, checked and unchecked — the owner's rule is that whoever closes the shift
      // sees ALL of them. Fetched HERE so the driver's view and the manager's cannot disagree.
      deps.movements.listByShift(shiftId),
      deps.batteryReadings.listByShift(shiftId),
      deps.directory.listBatteriesForVehicle(shift.vehicleId),
      // C-7: the review must SHOW the photos, not just their slot names. Each attached slot carries
      // the media id the RBAC-checked GET /media/:id serves.
      deps.media.listSlots(shiftId),
      deps.batterySwaps.listByShift(shiftId),
      // Serials for BOTH packs of every swap — the outgoing one is no longer fitted, so it is not in
      // `fitted`; it has to be resolved off the branch's full battery list.
      deps.directory.listBatteries(shift.branchId),
    ])
    const withPack = (pkg: 'start' | 'end') =>
      readings
        .filter((r) => r.package === pkg)
        .map((r) => {
          const battery = fitted.find((b) => b.id === r.batteryId)
          return { ...r, capacityAh: battery?.capacityAh ?? null, serialNo: battery?.serialNo ?? null }
        })
        .sort((a, b) => a.slotNo - b.slotNo)

    // Mid-shift swaps (SRS §L seam), resolved to serials + each pack's captured percent.
    const serialById = new Map(allBatteries.map((b) => [b.id, b.serialNo]))
    const swapPercent = (pkg: 'swap_out' | 'swap_in', batteryId: string): number | null =>
      readings.find((r) => r.package === pkg && r.batteryId === batteryId)?.percent ?? null
    const batterySwaps = swaps.map((s) => ({
      seqNo: s.seqNo,
      slotNo: s.slotNo,
      occurredAt: new Date(s.occurredAtMs).toISOString(),
      outSerial: serialById.get(s.outBatteryId) ?? null,
      inSerial: serialById.get(s.inBatteryId) ?? null,
      outPercent: swapPercent('swap_out', s.outBatteryId),
      inPercent: swapPercent('swap_in', s.inBatteryId),
    }))

    return {
      shift,
      body: {
        id: shift.id,
        state: shift.state,
        driverId: shift.driverId,
        vehicleId: shift.vehicleId,
        shiftNo: shift.shiftNo,
        businessDate: shift.businessDate,
        startPackage: {
          odometerKm: shift.odoStart,
          batteryPercent: shift.batteryStart,
          // SRS D-3 baselines (readDashboard) — null unless OCR ran and the driver kept/changed it.
          odometerKmOcr: shift.odoStartOcr,
          batteryPercentOcr: shift.batteryStartOcr,
          floatTotal: serializeMoney(sum(shift.floatTranches)),
          topupTotal: serializeMoney(sum(shift.topupTranches)),
          mediaSlots: shift.mediaSlotsStart,
          batteries: withPack('start'),
        },
        endPackage: {
          odometerKm: shift.odoEnd,
          batteryPercent: shift.batteryEnd,
          cashDeclared: shift.endCashDeclared === null ? null : serializeMoney(shift.endCashDeclared),
          walletDeclared: shift.endWalletDeclared === null ? null : serializeMoney(shift.endWalletDeclared),
          // SRS D-3 baseline (readWallet), money as a decimal string.
          walletDeclaredOcr: shift.endWalletDeclaredOcr === null ? null : serializeMoney(shift.endWalletDeclaredOcr),
          mediaSlots: shift.mediaSlotsEnd,
          batteries: withPack('end'),
        },
        orders: orders.map((o) => ({
          providerOrderNo: o.providerOrderNo,
          payMode: o.payMode,
          fee: serializeMoney(o.fee),
          zone: o.zone,
          // SRS D-1/D-3: whether the fee came from OCR, and what OCR read (for the manager's delta).
          source: o.source,
          feeOcr: o.feeOcr === null ? null : serializeMoney(o.feeOcr),
          // A manual job's agreed split, route and note — the numbers the manager signs for.
          kind: o.kind,
          driverShare: o.driverShare === null ? null : serializeMoney(o.driverShare),
          companyShare: o.companyShare === null ? null : serializeMoney(o.companyShare),
          notes: o.notes,
          points: o.points,
          // The checkbox, what the log measured, and the minute it is paired on. `included` goes to
          // BOTH views deliberately: whoever closes the shift must see every operation, checked or
          // not — an excluded row hidden from one of the two screens is a row nobody can put back.
          included: o.included,
          walletAmount: o.walletAmount === null ? null : serializeMoney(o.walletAmount),
          occurredMinute: o.occurredMinute,
          // The DAY the screen said, which is not always the shift's day — the list scrolls back.
          occurredDate: o.occurredDate,
        })),
        // «سجل المدفوعات» as read: what the wallet actually did, beside what the orders imply.
        movements: movements.map((m) => ({
          id: m.id,
          amount: serializeMoney(m.amount),
          occurredMinute: m.occurredMinute,
          seq: m.seq,
          orderId: m.orderId,
          role: m.role,
          ambiguous: m.ambiguous,
          included: m.included,
          source: m.source,
          notes: m.notes,
        })),
        media: slots.map((s) => ({ package: s.package, slot: s.slot, mediaId: s.mediaId })),
        batterySwaps,
      },
    }
  }

  /**
   * The DRIVER's read of his own shift.
   *
   * Until this existed there was no endpoint at all by which a driver could learn the state of
   * his own shift: every read was `branch_data.view` or `shift.approve`, neither of which he has.
   * His app polled the manager's `/review` waiting to be let out of "awaiting approval", got 403
   * on every poll, swallowed it, and sat there forever — the manager approved, the shift really
   * opened, and the phone never found out. He could never record an order or close the shift.
   *
   * `shift.operate` is granted to the driver at scope `own`, and `shiftSubject` supplies the
   * shift's own driverId, so this is his shift and nobody else's with no new RBAC concept.
   */
  app.get(
    '/shifts/:id/state',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const snapshot = await shiftSnapshot(id)
      if (!snapshot) return reply.code(404).send({ error: 'shift_not_found' })
      // Deliberately no BR1 causes: that ranked diagnosis is the manager's approval tool (BR8).
      // The driver already gets the difference back from his own end-package submit. But he DOES
      // get the manager's latest decision, so a bounced shift shows him why (C-7 re-shoot/reject).
      const [latest] = await deps.decisions.listByShift(id)
      return {
        ...snapshot.body,
        lastDecision: latest ? { decision: latest.decision, notes: latest.notes } : null,
      }
    },
  )

  /**
   * Discard a shift that never opened — by the driver whose shift it is.
   *
   * Same rule and same service as the manager's DELETE: legal only in `draft` and
   * `awaiting_open_approval`, where nothing has posted to the ledger. A separate route because a
   * route declares one permission, and widening the manager's would hand every driver the power
   * to discard anybody's. Without this, a driver who abandons a start screen must wait for
   * someone at the office before he can work at all.
   */
  app.delete(
    '/shifts/:id/mine',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const shift = await cancelShift(deps, id)
      await deps.audit.append({
        tableName: 'shifts',
        recordId: shift.id,
        action: 'DELETE',
        actorId: req.actor?.userId ?? null,
        actorKind: req.actor ? 'user' : 'system',
        branchId: shift.branchId,
        requestId: req.requestId,
        before: { state: shift.state, driverId: shift.driverId, vehicleId: shift.vehicleId },
        after: null,
        occurredAtMs: deps.clock.nowMs(),
      })
      return { ok: true, id: shift.id }
    },
  )

  /** The branch manager's review screen (C-7): the numbers, the difference, and why. */
  app.get(
    '/shifts/:id/review',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const snapshot = await shiftSnapshot(id)
      if (!snapshot) return reply.code(404).send({ error: 'shift_not_found' })
      const br1 = await evaluateShift(deps, snapshot.shift)
      const decisions = await deps.decisions.listByShift(id)
      return {
        ...snapshot.body,
        br1: serializeBr1(br1),
        decisions: decisions.map((d) => ({
          gate: d.gate,
          decision: d.decision,
          notes: d.notes,
          decidedAt: new Date(d.decidedAtMs).toISOString(),
        })),
      }
    },
  )

  app.post(
    '/shifts/:id/approve-close',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = approveCloseRequest.parse(req.body)
      const result = await approveClose(deps, req.actor!, id, body.reviewedOrdersHash, opts.splitGate ?? 'advisory')
      return { id: result.shift.id, state: result.shift.state, postings: result.postings }
    },
  )

  // C-7: the manager sends the package back for a re-shoot, or rejects a close. Both return the
  // shift to the driver with a logged reason.
  const decisionBody = z.object({ notes: z.string().max(2000).nullable().default(null) })
  app.post(
    '/shifts/:id/request-rephoto',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const { notes } = decisionBody.parse(req.body ?? {})
      const shift = await requestRephoto(deps, req.actor!, id, notes)
      return { id: shift.id, state: shift.state }
    },
  )
  app.post(
    '/shifts/:id/reject-close',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const { notes } = decisionBody.parse(req.body ?? {})
      const shift = await rejectClose(deps, req.actor!, id, notes)
      return { id: shift.id, state: shift.state }
    },
  )
  /**
   * Correct a closing figure during the review, without approving and without bouncing the shift
   * back to the driver. The close gate still has to pass afterwards, so this gives BR1 the right
   * numbers — it is not a way around it. Audited: it moves the equation.
   */
  app.post(
    '/shifts/:id/close-figures',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = closeFiguresRequest.parse(req.body)
      const { shift, br1, before } = await reviseCloseFigures(deps, req.actor!, id, body)
      await deps.audit.append({
        tableName: 'shifts',
        recordId: shift.id,
        action: 'UPDATE',
        actorId: req.actor!.userId,
        actorKind: 'user',
        branchId: shift.branchId,
        requestId: req.requestId,
        before: {
          odometerKm: before.odoEnd,
          cashDeclared: before.endCashDeclared === null ? null : serializeMoney(before.endCashDeclared),
          walletDeclared: before.endWalletDeclared === null ? null : serializeMoney(before.endWalletDeclared),
        },
        after: {
          odometerKm: shift.odoEnd,
          cashDeclared: shift.endCashDeclared === null ? null : serializeMoney(shift.endCashDeclared),
          walletDeclared: shift.endWalletDeclared === null ? null : serializeMoney(shift.endWalletDeclared),
          revisedByManager: true,
        },
        occurredAtMs: deps.clock.nowMs(),
      })
      return { id: shift.id, state: shift.state, br1: serializeBr1(br1) }
    },
  )

  /**
   * The driver submits his whole operations list, read off his screenshots.
   *
   * Idempotent by construction: the orders upsert on `(shift, provider_order_no)` and the movements
   * merge as a multiset, so re-reading an overlapping page adds nothing and stepping back into the
   * close to add one delivery sends the whole list again safely.
   */
  app.put(
    '/shifts/:id/operations',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = operationsRequest.parse(req.body)
      const { br1 } = await submitOperations(deps, req.actor!, id, body)
      return { id, br1: serializeBr1(br1) }
    },
  )

  /**
   * The manager changes what counts, during the review, without approving.
   *
   * The driver curates the list at close — but he is reading a screenshot at the end of a long day,
   * so the manager must be able to put a row back, take one out, or say whether a credit belongs to
   * its order. The shift stays `pending_review` and the close gate still has to pass afterwards.
   * Audited: every one of these moves BR1.
   */
  app.post(
    '/shifts/:id/operations/revise',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = reviseOperationsRequest.parse(req.body)
      const { shift, br1, before } = await reviseOperations(deps, req.actor!, id, body)
      await deps.audit.append({
        tableName: 'shifts',
        recordId: shift.id,
        action: 'UPDATE',
        actorId: req.actor!.userId,
        actorKind: 'user',
        branchId: shift.branchId,
        requestId: req.requestId,
        before: { ordersHash: before.ordersHash },
        after: { ordersHash: shift.ordersHash, revisedByManager: true, ...body },
        occurredAtMs: deps.clock.nowMs(),
      })
      return { id: shift.id, state: shift.state, br1: serializeBr1(br1) }
    },
  )

  /** Refuse a shift at the OPEN gate, sending it back to the driver with a recorded reason. To
   *  refuse it outright instead, `POST /shifts/:id/void` now reaches this state too. */
  app.post(
    '/shifts/:id/reject-open',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const { notes } = decisionBody.parse(req.body ?? {})
      const shift = await rejectOpen(deps, req.actor!, id, notes)
      return { id: shift.id, state: shift.state }
    },
  )

  // C-1 «معلقة»: a manager suspends a live shift for a mid-shift incident; the driver resumes it
  // when the incident clears. A suspended shift still closes under the same BR1.
  app.post(
    '/shifts/:id/suspend',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const { notes } = decisionBody.parse(req.body ?? {})
      const shift = await suspendShift(deps, req.actor!, id, notes)
      return { id: shift.id, state: shift.state }
    },
  )
  app.post(
    '/shifts/:id/resume',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const shift = await resumeShift(deps, req.actor!, id)
      return { id: shift.id, state: shift.state }
    },
  )
  // The driver can't suspend himself — he reports the incident to the branch, which rings the bell.
  app.post(
    '/shifts/:id/report-incident',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const { notes } = decisionBody.parse(req.body ?? {})
      await reportIncident(deps, req.actor!, id, notes)
      return reply.code(202).send({ ok: true })
    },
  )

  // Upper-level override for a stuck shift (shift.approve). VOID reverses the float/top-up and
  // discards the orders → cancelled; FORCE-CLOSE settles it (order splits + a shift_variance for any
  // declared-vs-expected gap) → approved. Both audited with a mandatory reason.
  app.post(
    '/shifts/:id/void',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body)
      const shift = await voidShift(deps, req.actor!, id, reason)
      await deps.audit.append({
        tableName: 'shifts',
        recordId: shift.id,
        action: 'UPDATE',
        actorId: req.actor!.userId,
        actorKind: 'user',
        branchId: shift.branchId,
        requestId: req.requestId,
        before: null,
        after: { state: shift.state, reason, voided: true },
        occurredAtMs: deps.clock.nowMs(),
      })
      return { id: shift.id, state: shift.state }
    },
  )
  app.post(
    '/shifts/:id/force-close',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = forceCloseRequest.parse(req.body)
      const result = await forceClose(deps, req.actor!, id, body)
      await deps.audit.append({
        tableName: 'shifts',
        recordId: result.shift.id,
        action: 'UPDATE',
        actorId: req.actor!.userId,
        actorKind: 'user',
        branchId: result.shift.branchId,
        requestId: req.requestId,
        before: null,
        after: { state: result.shift.state, reason: body.reason, forced: true },
        occurredAtMs: deps.clock.nowMs(),
      })
      return { id: result.shift.id, state: result.shift.state, postings: result.postings }
    },
  )

  // ── Live GPS (SRS K) — the driver's phone streams its location while the shift is open ────────
  // Ingest: the driver's own shift (shift.operate). The server stamps received_at, so a skewed
  // phone clock can't rewrite when the office actually saw him.
  app.post(
    '/shifts/:id/gps',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = gpsPingRequest.parse(req.body)
      const shift = await deps.shifts.findById(id)
      if (!shift) return reply.code(404).send({ error: 'shift_not_found' })
      await deps.gps.append({
        shiftId: shift.id,
        driverId: shift.driverId,
        branchId: shift.branchId,
        lat: body.lat,
        lng: body.lng,
        accuracyM: body.accuracyM,
        capturedAtMs: body.capturedAtMs,
        receivedAtMs: deps.clock.nowMs(),
      })
      return reply.code(202).send({ ok: true })
    },
  )
  // The manager's live map: the latest fix per driver in the branch (gps.view — BM/GM/sysadmin).
  app.get('/gps/live', { config: { permission: 'gps.view', subject: branchSubject } }, async (req) => {
    const branchId = resolveBranchId(req)
    // The live map is "who is out RIGHT NOW", so a ping only counts while its shift is live. Without
    // this a driver whose shift closed — or was force-closed / voided as a stuck shift — would linger
    // on the map at his last-known spot forever (gps_pings is append-only). Keyed on the shift id, not
    // just the driver, so a stale ping from an already-ended shift is dropped even when the driver has
    // since opened a fresh one that has not pinged yet.
    const [pings, liveShifts] = await Promise.all([
      deps.gps.latestPerDriverForBranch(branchId),
      deps.shifts.listLiveForBranch(branchId),
    ])
    const liveShiftByDriver = new Map(liveShifts.map((s) => [s.driverId, s.id]))
    return {
      drivers: pings
        .filter((p) => liveShiftByDriver.get(p.driverId) === p.shiftId)
        .map((p) => ({
          driverId: p.driverId,
          lat: p.lat,
          lng: p.lng,
          accuracyM: p.accuracyM,
          capturedAt: new Date(p.capturedAtMs).toISOString(),
          receivedAt: new Date(p.receivedAtMs).toISOString(),
        })),
    }
  })

  // C-5: a second (or later) cash-float / wallet top-up disbursed mid-day. Branch money the manager
  // hands the driver, so `shift.approve`. Audited — it moves cash out of the office.
  app.post(
    '/shifts/:id/tranche',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = addTrancheRequest.parse(req.body)
      const shift = await addTranche(deps, req.actor!, id, body)
      await deps.audit.append({
        tableName: 'shifts',
        recordId: shift.id,
        action: 'UPDATE',
        actorId: req.actor!.userId,
        actorKind: 'user',
        branchId: shift.branchId,
        requestId: req.requestId,
        before: null,
        after: { tranche: body.kind, amount: serializeMoney(body.amount) },
        occurredAtMs: deps.clock.nowMs(),
      })
      return reply.code(201).send({ id: shift.id, kind: body.kind })
    },
  )

  // ── Fleet: drivers, vehicles, documents (SRS B) ─────────────────────────────────
  registerFleetRoutes(app, deps)

  // ── Accounts (SRS A-2) ──────────────────────────────────────────────────────────
  registerUserRoutes(app, deps)

  // ── Expenses (SRS G) ────────────────────────────────────────────────────────────
  registerExpenseRoutes(app, deps)

  // ── Treasury: daily cash count + manual entries (SRS E-3, E-5) ──────────────────
  registerTreasuryRoutes(app, deps)

  // ── Tier admin (SRS F-3…F-6) ────────────────────────────────────────────────────
  registerTierRoutes(app, deps)

  // ── Notifications bell (SRS A-6) ────────────────────────────────────────────────
  registerNotificationRoutes(app, deps)

  // ── Minimal ops dashboard (SRS I-1) ─────────────────────────────────────────────
  registerDashboardRoutes(app, deps)

  // ── Daily FX (BR6) — system admin only ──────────────────────────────────────────────────

  /** Today's rate, for the settings screen — resolved (a carried-forward rate reads provisional). */
  app.get('/fx', { config: { permission: 'fx_rate.write' } }, async () => {
    const today = todayFor(deps)
    const days = await deps.fx.list()
    // resolveFxDay throws only when NO rate has ever been entered; the app seeds a provisional
    // one at boot, so in practice this always resolves.
    try {
      const rate = resolveFxDay(days, today)
      // The FX rate is a bounded integer the wire carries as a number by design (setFxRequest),
      // NOT a cash-minor amount — so a plain integer here is correct, not a precision hazard.
      const perUsd = rate.sypMinorPerUsd
      return { businessDate: today, sypMinorPerUsd: Number(perUsd), provisional: rate.provisional }
    } catch {
      return { businessDate: today, sypMinorPerUsd: null, provisional: true }
    }
  })

  app.put('/fx', { config: { permission: 'fx_rate.write' } }, async (req) => {
    const body = setFxRequest.parse(req.body)
    const before = (await deps.fx.list()).find((d) => d.businessDate === body.businessDate) ?? null
    const id = await deps.fx.upsert({
      businessDate: body.businessDate,
      sypMinorPerUsd: BigInt(body.sypMinorPerUsd),
      provisional: false,
    })
    // The rate gates every day's USD figures and the Sunday close, so it is audited like any other
    // money-adjacent setting — the existing route wrote it without a trail.
    await deps.audit.append({
      tableName: 'fx_days',
      recordId: String(id),
      action: before ? 'UPDATE' : 'INSERT',
      actorId: req.actor?.userId ?? null,
      actorKind: req.actor ? 'user' : 'system',
      branchId: null,
      requestId: req.requestId,
      before: before ? { sypMinorPerUsd: before.sypMinorPerUsd.toString(), provisional: before.provisional } : null,
      after: { sypMinorPerUsd: body.sypMinorPerUsd, provisional: false },
      occurredAtMs: deps.clock.nowMs(),
    })
    return { id, businessDate: body.businessDate }
  })

  // ── General settings (SRS A-4) — system admin only ──────────────────────────────────────

  /** The receipt ceiling and the kWh price, as decimal strings for the settings screen. */
  app.get('/settings', { config: { permission: 'settings.write' } }, async () => {
    const [ceiling, kwh] = await Promise.all([deps.settings.receiptRequiredAbove(''), deps.settings.kwhPriceMinor()])
    return {
      receiptCeilingMinor: ceiling === null ? null : serializeMoney(ceiling),
      kwhPriceMinor: kwh === null ? null : serializeMoney(kwh),
    }
  })

  app.put('/settings', { config: { permission: 'settings.write' } }, async (req) => {
    const body = updateSettingsRequest.parse(req.body)
    const actorId = req.actor!.userId
    const written: Record<string, string> = {}

    // A fixed key map — never write an arbitrary key. Money is stored as a STRING of minor units,
    // matching how PgSettingsRepo.money() reads it back, so a large ceiling keeps its precision.
    const fields: Array<[keyof typeof body, string]> = [
      ['receiptCeilingMinor', 'expense.receipt_required_above_minor'],
      ['kwhPriceMinor', 'vehicle.kwh_price_minor'],
    ]
    for (const [field, key] of fields) {
      const value = body[field]
      if (value === undefined) continue
      await deps.settings.set(key, value.toString(), actorId)
      written[key] = serializeMoney(value)
    }
    if (Object.keys(written).length > 0) {
      await deps.audit.append({
        tableName: 'settings',
        recordId: Object.keys(written).join(','),
        action: 'UPDATE',
        actorId,
        actorKind: 'user',
        branchId: null,
        requestId: req.requestId,
        before: null,
        after: written,
        occurredAtMs: deps.clock.nowMs(),
      })
    }
    return { updated: Object.keys(written) }
  })

  // ── The Sunday close (BR7) — system admin only ──────────────────────────────────────────
  app.post('/weeks/close', { config: { permission: 'week.close', subject: branchSubject } }, async (req, reply) => {
    const body = closeWeekRequest.parse(req.body)
    // The org-wide close fans out to one lock per branch; single-branch today, so the sysadmin
    // names the one he is sealing. Reading `req.actor.branchId` alone made BR7 unperformable:
    // `week.close` is system-admin-only and a system admin never has a branch.
    const branchId = resolveBranchId(req)

    // `weekClosedOn` throws on a non-Sunday, and an operator typing the wrong date deserves a
    // clear 422 naming the problem rather than a 500. checkWeekClose reports it as a blocker,
    // so ask it first — it returns early for exactly this case.
    if (dayOfWeek(body.closeDate) !== 0) {
      const check = checkWeekClose({
        closeDate: body.closeDate,
        unapprovedShiftCount: 0,
        daysMissingCashCount: [],
        provisionalFxDays: [],
        priorWeekClosed: true,
        trialBalanceDiff: minor(0n),
        alreadyClosed: false,
      })
      return reply.code(422).send({ error: 'week_not_closable', blockers: check.blockers })
    }

    const { start, end } = weekClosedOn(body.closeDate)
    // The WHOLE week, not the Sunday. A single-day query left Monday-to-Saturday invisible, so a
    // week could seal with a shift still in review — and approving it afterwards posted entries
    // into the sealed week with week_lock_id = NULL, which nothing can ever lock.
    const shifts = await deps.shifts.listByBranchAndDateRange(branchId, start, end)
    const closedStarts = await deps.weekLocks.listClosedStarts(branchId)
    const existing = await deps.weekLocks.find(branchId, start)

    const entries = await deps.ledger.listByWeek(branchId, start)
    let diff = 0n
    for (const e of entries) for (const l of e.lines) diff += l.side === 'D' ? l.amount : -l.amount

    // Every day of the week must have been physically counted (E-5) before it can be sealed.
    // This was a placeholder until cash counts existed; leaving it empty would have let a week
    // close with drawers nobody ever opened.
    const counted = new Set(await deps.cashCounts.listDatesInRange(branchId, start, end))
    const daysMissingCashCount: string[] = []
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (!counted.has(d)) daysMissingCashCount.push(d)
    }

    const check = checkWeekClose({
      closeDate: body.closeDate,
      unapprovedShiftCount: shifts.filter((s) => s.state !== 'approved' && s.state !== 'week_locked').length,
      daysMissingCashCount,
      provisionalFxDays: (await deps.fx.list())
        .filter((d) => d.provisional && d.businessDate >= start && d.businessDate <= end)
        .map((d) => d.businessDate),
      priorWeekClosed: closedStarts.length === 0 || closedStarts.some((s) => s < start),
      trialBalanceDiff: minor(diff),
      alreadyClosed: existing?.closedAtMs !== null && existing !== null,
    })

    if (!check.canClose) return reply.code(422).send({ error: 'week_not_closable', blockers: check.blockers })

    const lock = existing ?? (await deps.weekLocks.create({
      branchId,
      weekStartDate: check.weekStart,
      weekEndDate: check.weekEnd,
      closedAtMs: null,
      closedBy: null,
    }))
    const sealed = await deps.weekLocks.seal(lock.id, req.actor!.userId, deps.clock.nowMs())
    return { weekStart: check.weekStart, weekEnd: check.weekEnd, entriesSealed: sealed }
  })

  // ── Audit viewer (A-5) ──────────────────────────────────────────────────────────────────
  app.get('/audit', { config: { permission: 'audit.view' } }, async (req) => {
    const q = z
      .object({ tableName: z.string().optional(), recordId: z.string().optional(), actorId: z.string().optional() })
      .parse(req.query)
    const rows = await deps.audit.list(q)
    return { rows: rows.map((r) => ({ ...r, occurredAt: new Date(r.occurredAtMs).toISOString() })) }
  })

  // Refuses to boot if any route forgot to declare its permission.
  await app.ready()
  assertEveryRouteDeclaresPermission(app)
  await ensureSeedFx(deps)
  return app
}

function serializeBr1(view: Awaited<ReturnType<typeof evaluateShift>>) {
  return {
    expectedCash: serializeMoney(view.result.expectedCash),
    expectedWallet: serializeMoney(view.result.expectedWallet),
    expectedTotal: serializeMoney(view.result.expectedTotal),
    actualTotal: serializeMoney(view.result.actualTotal),
    difference: serializeMoney(view.result.scalarDiff),
    cashDifference: serializeMoney(view.result.cashDiff),
    walletDifference: serializeMoney(view.result.walletDiff),
    balanced: view.result.balanced,
    splitBalanced: view.result.splitBalanced,
    minWalletBalance: serializeMoney(view.minWallet),
    // Machine-readable codes; the UI resolves `br1.cause.<code>` to Arabic.
    causes: view.causes.map((c) => ({
      code: c.code,
      confidence: c.confidence,
      amount: serializeMoney(c.amount),
      candidateOrderNos: c.candidateOrderNos,
      detail: c.detail,
    })),
    ordersHash: view.ordersHash,
  }
}

/** The very first rate has to come from somewhere, or nothing can post. */
async function ensureSeedFx(deps: Deps): Promise<void> {
  const existing = await deps.fx.list()
  if (existing.length > 0) return
  await deps.fx.upsert({
    businessDate: todayFor(deps),
    sypMinorPerUsd: 13_000n, // ~130 new SYP/USD, July 2026. A seed, never a rule.
    provisional: true,
  })
}

export { weekStartFor, ensureFxDay }
