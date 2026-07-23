import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps } from '@ash/contracts'
import {
  addOrderRequest,
  approveCloseRequest,
  approveOpenRequest,
  closeWeekRequest,
  createShiftRequest,
  endPackageRequest,
  loginRequest,
  uploadEvidenceParams,
  serializeMoney,
  setFxRequest,
  startPackageRequest,
  putBatteryReadingsRequest,
} from '@ash/contracts'
import { addDays, checkWeekClose, dayOfWeek, minor, sum, weekClosedOn, weekStartFor } from '@ash/domain'
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
  approveClose,
  approveOpen,
  cancelShift,
  createShift,
  ensureFxDay,
  evaluateShift,
  submitEndPackage,
  submitStartPackage,
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
            // The packs fitted to this bike. The driver has no `branch_data.view`, so this is the
            // only way his app can know how many BMS screenshots the gate will ask him for — and
            // it is the SAME list the gate counts, so the checklist cannot disagree with the gate.
            batteries: (await deps.directory.listBatteriesForVehicle(v.id)).map((b) => ({
              id: b.id,
              slotNo: b.slotNo,
              capacityAh: b.capacityAh,
              serialNo: b.serialNo,
            })),
          })),
      ),
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
      const { date } = z.object({ date: z.string().optional() }).parse(req.query)
      const target = resolveBranchId(req)
      const businessDate = date ?? todayFor(deps)
      const shifts = await deps.shifts.listByBranchAndDate(target, businessDate)
      return {
        businessDate,
        shifts: shifts.map((s) => ({
          id: s.id,
          driverId: s.driverId,
          vehicleId: s.vehicleId,
          shiftNo: s.shiftNo,
          state: s.state,
        })),
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
        })
      }
      return { readings: await deps.batteryReadings.listByShift(shift.id) }
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

  app.post(
    '/shifts/:id/orders',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = addOrderRequest.parse(req.body)
      const order = await addOrder(deps, req.actor!, id, body)
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

  /** The branch manager's review screen (C-7): the numbers, the difference, and why. */
  app.get(
    '/shifts/:id/review',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const shift = await deps.shifts.findById(id)
      if (!shift) return reply.code(404).send({ error: 'shift_not_found' })
      const orders = await deps.orders.listByShift(id)
      const br1 = await evaluateShift(deps, shift)
      return {
        id: shift.id,
        state: shift.state,
        driverId: shift.driverId,
        vehicleId: shift.vehicleId,
        businessDate: shift.businessDate,
        startPackage: {
          odometerKm: shift.odoStart,
          batteryPercent: shift.batteryStart,
          floatTotal: serializeMoney(sum(shift.floatTranches)),
          topupTotal: serializeMoney(sum(shift.topupTranches)),
          mediaSlots: shift.mediaSlotsStart,
        },
        endPackage: {
          odometerKm: shift.odoEnd,
          batteryPercent: shift.batteryEnd,
          cashDeclared: shift.endCashDeclared === null ? null : serializeMoney(shift.endCashDeclared),
          walletDeclared: shift.endWalletDeclared === null ? null : serializeMoney(shift.endWalletDeclared),
          mediaSlots: shift.mediaSlotsEnd,
        },
        orders: orders.map((o) => ({
          providerOrderNo: o.providerOrderNo,
          payMode: o.payMode,
          fee: serializeMoney(o.fee),
          zone: o.zone,
        })),
        br1: serializeBr1(br1),
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
  app.put('/fx', { config: { permission: 'fx_rate.write' } }, async (req) => {
    const body = setFxRequest.parse(req.body)
    const id = await deps.fx.upsert({
      businessDate: body.businessDate,
      sypMinorPerUsd: BigInt(body.sypMinorPerUsd),
      provisional: false,
    })
    return { id, businessDate: body.businessDate }
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
    const shifts = await deps.shifts.listByBranchAndDate(branchId, start)
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
