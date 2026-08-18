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
  moneySchema,
  nonnegativeMoneySchema,
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
  patchCloseDraftRequest,
  linkedCloseDraftReadRequest,
  restoreCloseDraftAttachmentRequest,
} from '@ash/contracts'
import { addDays, bmsSlot, checkWeekClose, dayOfWeek, minor, resolveFxDay, sum, weekClosedOn, weekStartFor } from '@ash/domain'
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
import {
  MAX_UPLOAD_BYTES,
  acknowledgeStaleEvidence,
  deleteEvidence,
  readEvidence,
  restoreEvidence,
  uploadEvidence,
} from './media.service.ts'
import { OCR_FIELDS_TUPLE, readScreen } from './ocr.service.ts'
import { rereadManagerOrderEvidence } from './manager-order-reread.service.ts'
import {
  getCloseDraft,
  patchCloseDraft,
  readCloseDraftAttachment,
  syncCloseDraftEvidence,
} from './close-draft.service.ts'
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
  settlementFor,
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
  prepareShiftReview,
  todayFor,
} from './shifts.service.ts'

export interface AppOptions {
  deps: Deps
  logger?: boolean
  splitGate?: 'advisory' | 'strict'
  /** Runaway guard on paid cloud OCR. Defaults here so a test never has to think about spend. */
  maxOcrReadsPerShift?: number
}

/**
 * SQLSTATE 25006 is broader than the ledger's sealed-week guard.
 *
 * PostgreSQL also uses it for this schema's write-once shift approval fields and append-only media
 * history. Match only the messages emitted by the week guards in migrations 0006, 0018 and 0029;
 * calling every such refusal `week_locked` sends a manager to the wrong remedy.
 */
export function isSealedWeekPgError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const candidate = err as { code?: unknown; message?: unknown }
  if (candidate.code !== '25006' || typeof candidate.message !== 'string') return false
  return (
    /^week lock .* is (?:already )?closed\b/.test(candidate.message) ||
    /^week \d{4}-\d{2}-\d{2} is closed\b/.test(candidate.message) ||
    /^business date \d{4}-\d{2}-\d{2} falls inside sealed week\b/.test(candidate.message)
  )
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
    // The week-lock guards (migrations 0006, 0018 and 0029) raise 25006. Migration 0006's own comment has
    // always said «the application maps it to a 409» — it did not, so a week-lock refusal surfaced
    // as «خطأ داخلي» and looked like a bug in the system rather than the rule doing its job. The
    // application checks these cases itself and answers 409 first; this is the backstop for any
    // write path that forgets to. Other 25006 invariants must not be mislabeled as a sealed week.
    if (isSealedWeekPgError(err)) {
      req.log.warn({ err }, 'refused: sealed week')
      return reply.code(409).send({ error: 'week_locked', detail: null })
    }
    /*
     * A framework refusal already carries its own status, and flattening it to 500 destroys the
     * only signal the caller could act on.
     *
     * Fastify raises `FST_ERR_CTP_BODY_TOO_LARGE` (413) and `FST_ERR_CTP_INVALID_MEDIA_TYPE` (415)
     * from the content-type parser, BEFORE any handler runs — which is also why `media.service`'s
     * own `upload_too_large` and `not_an_image` are unreachable over HTTP. Those two were the whole
     * signal for "your photo is too big" and "that is not an image", and both arrived as an
     * anonymous «خطأ داخلي».
     */
    const framework = err as { statusCode?: unknown; code?: unknown }
    if (typeof framework.statusCode === 'number' && framework.statusCode >= 400 && framework.statusCode < 500) {
      const code =
        framework.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
          ? 'upload_too_large'
          : framework.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
            ? 'not_an_image'
            : 'invalid_request'
      req.log.warn({ err }, 'refused before the handler')
      return reply.code(framework.statusCode).send({ error: code, detail: null })
    }
    /*
     * A privilege refusal is OUR bug, never the caller's, so it stays a 500 — but it is NAMED.
     *
     * An anonymous 42501 took every evidence upload in the fleet down for three days: `0028` makes
     * `shift_media_attachment_history` append-only by REVOKEing UPDATE from `app_user`, and a
     * `SELECT ... FOR UPDATE` against it asked for a lock the runtime role cannot hold. The only
     * thing anyone could see was «فشل الرفع». Give the next one a name in the response and a
     * dedicated log line, so it is one grep away instead of three days away.
     */
    if (typeof framework.code === 'string' && framework.code === '42501') {
      req.log.error({ err }, 'insufficient database privilege — a statement asked for a grant the runtime role lacks')
      return reply.code(500).send({ error: 'insufficient_privilege', detail: null })
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
            // The number ON THE MACHINE. `code` says where the bike sits in the fleet — it is not
            // painted anywhere, so a driver sent to take «رقم ٤» had to hold the mapping in his
            // head. Getting that wrong means the odometer, the battery and the entire start package
            // belong to a bike nobody rode.
            groundNo: v.groundNo,
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
              // The marking on the pack. A slot number says which socket, not which battery.
              groundNo: b.groundNo,
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
        // `groundNo` matters MOST here: choosing a spare off the shelf is the moment a man is
        // holding two packs that look identical.
        .map((b) => ({
          id: b.id,
          slotNo: b.slotNo,
          capacityAh: b.capacityAh,
          groundNo: b.groundNo,
          serialNo: b.serialNo,
          bmsProfile: b.bmsProfile,
        })),
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
      const { date, live, pending } = z
        .object({ date: z.string().optional(), live: z.string().optional(), pending: z.string().optional() })
        .parse(req.query)
      const target = resolveBranchId(req)
      const businessDate = date ?? todayFor(deps)
      // `?live=1` asks "who is out RIGHT NOW", which is NOT a question about today's date: a shift
      // that opened before midnight and is still running belongs to yesterday's business date, and
      // the date-filtered list dropped it — the bike looked free and the shift unreachable from the
      // live screen. `listLiveForBranch` is the same date-independent read the GPS map uses.
      // `?pending=1` asks "what is waiting for me to decide", which — like `?live=1` above — is NOT
      // a question about today's date. The approval queue asked the date-filtered list and dropped
      // everything the manager did not get to before midnight: the shift stayed `pending_review`
      // with its money unposted, and the one screen whose job is to surface it stopped showing it.
      const shifts =
        pending === '1'
          ? await deps.shifts.listAwaitingDecisionForBranch(target)
          : live === '1'
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
    const shift = await cancelShift(deps, id, req.actor?.userId ?? null)
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
      const packageEditable =
        body.package === 'start'
          ? shift.state === 'draft'
          : shift.state === 'open' || shift.state === 'suspended'
      if (!packageEditable) {
        throw new ServiceError(409, 'battery_reading_package_not_editable', {
          package: body.package,
          state: shift.state,
        })
      }

      // Only packs actually fitted to THIS bike. Without this a driver could attach a reading
      // from a healthy pack on another machine and satisfy his own bike's gate with it.
      const fitted = await deps.directory.listBatteriesForVehicle(shift.vehicleId)
      // The screenshot each reading came from. `media_id` has been on this table since 0007 and was
      // written NULL every time, so no manager could ever see WHICH picture produced «39%» and the
      // training pair had no pixels behind it. The slot name is the link: pack n's evidence is
      // `bms_n` in the same package.
      const attached = await deps.media.listSlots(shift.id)
      const existingReadings = await deps.batteryReadings.listByShift(shift.id)
      const prepared = body.readings.map((reading) => {
        const battery = fitted.find((b) => b.id === reading.batteryId)
        if (!battery) {
          throw new ServiceError(422, 'battery_not_on_this_vehicle', { batteryId: reading.batteryId })
        }
        const currentMediaId =
          attached.find((a) => a.package === body.package && a.slot === bmsSlot(battery.slotNo ?? 1))?.mediaId ?? null
        // A current PWA names the attachment returned by its own upload. Refuse rather than bind a
        // late OCR/manual write to whichever file another tab (or a later retake) put in the slot.
        // Cached PWAs omit the lock: before the FIRST upload they still stage a NULL-media row,
        // which uploadEvidence binds for backwards compatibility.
        if (reading.expectedMediaId !== undefined && reading.expectedMediaId !== currentMediaId) {
          throw new ServiceError(409, 'battery_evidence_changed', {
            batteryId: battery.id,
            expectedMediaId: reading.expectedMediaId,
            currentMediaId,
          })
        }
        const prior = existingReadings.find(
          (candidate) => candidate.batteryId === battery.id && candidate.package === body.package,
        )
        /*
         * A cached PWA cannot name an evidence generation. Its RETAKE sequence is reading first,
         * upload second: when its prior row still matches the current attachment, NULL stages the
         * new value safely and the following bms_N upload binds it. If replacement already landed,
         * prior/current differ and the read binds current. A first-ever upload-first read has no
         * prior row and likewise binds current. Current PWAs always take the explicit branch above.
         */
        const mediaId =
          reading.expectedMediaId !== undefined
            ? currentMediaId
            : prior !== undefined && prior.mediaId === currentMediaId
              ? null
              : currentMediaId
        return {
          reading,
          battery,
          mediaId,
          // Once the driver transfers this pack to the manager, only the manager route may fill it.
          // A cloud/upload request already in flight on the phone must not race the declaration and
          // silently turn it back into an ordinary driver reading.
          lockedUnavailable: prior?.unavailable === true && reading.unavailable !== true,
        }
      })
      // Validate the full page before the first write. A cached PWA may reach this route just
      // before its BMS image upload; that row is staged with mediaId NULL and remains unusable by
      // the gate until uploadEvidence binds the exact bms_N attachment.
      for (const { reading, battery, mediaId, lockedUnavailable } of prepared) {
        if (lockedUnavailable) continue
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
          mediaId,
          source: reading.source,
          // «تطبيق البطارية لا يعمل على جهازي». Unblocks the driver, and blocks the manager until he
          // has read the pack himself — see `awaiting_manager_reading` in the domain.
          unavailable: reading.unavailable,
          ocrRaw: reading.ocrRaw ?? null,
          batterySwapId: null,
        })
      }
      return { readings: await deps.batteryReadings.listByShift(shift.id) }
    },
  )

  /**
   * The branch manager reading a pack the driver's phone could not.
   *
   * Its own route because it is its own permission. `shift.operate` is scoped `own` to the driver,
   * so the manager cannot post to that one at all — and he must be able to, precisely in the case
   * where the driver has declared «تطبيق البطارية لا يعمل على جهازي». Same shape as
   * `close-figures`: the manager correcting what the driver could not supply, under `shift.approve`.
   *
   * `source` is forced to `manager` here rather than trusted from the body: a figure taken by the
   * manager on his own device is a different fact from one the driver typed, and the route that only
   * he can call is the honest place to stamp that.
   */
  app.put(
    '/shifts/:id/battery-readings/manager',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = putBatteryReadingsRequest.parse(req.body)
      const shift = await deps.shifts.findById(id)
      if (!shift) throw new ServiceError(404, 'shift_not_found')
      const managerPackageEditable =
        body.package === 'start' ? shift.state === 'awaiting_open_approval' : shift.state === 'pending_review'
      if (!managerPackageEditable) {
        throw new ServiceError(409, 'battery_reading_not_under_review', {
          package: body.package,
          state: shift.state,
        })
      }

      const fitted = await deps.directory.listBatteriesForVehicle(shift.vehicleId)
      const attached = await deps.media.listSlots(shift.id)
      for (const reading of body.readings) {
        const battery = fitted.find((b) => b.id === reading.batteryId)
        if (!battery) throw new ServiceError(422, 'battery_not_on_this_vehicle', { batteryId: reading.batteryId })
        const before = (await deps.batteryReadings.listByShift(shift.id)).find(
          (r) => r.batteryId === battery.id && r.package === body.package,
        )
        if (before?.unavailable !== true) {
          throw new ServiceError(409, 'battery_reading_not_awaiting_manager', { batteryId: battery.id })
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
          mediaId:
            attached.find((a) => a.package === body.package && a.slot === bmsSlot(battery.slotNo ?? 1))?.mediaId ?? null,
          source: 'manager',
          // The declaration STAYS on the row after he fills it. It is the record of why a manager's
          // figure is here at all, and erasing it would hide that the driver could not read it.
          unavailable: before?.unavailable ?? reading.unavailable,
          ocrRaw: before?.ocrRaw ?? null,
          batterySwapId: null,
        })
        await deps.audit.append({
          tableName: 'shift_battery_readings',
          recordId: `${shift.id}:${battery.id}:${body.package}`,
          action: 'UPDATE',
          actorId: req.actor!.userId,
          actorKind: 'user',
          branchId: shift.branchId,
          requestId: req.requestId,
          before: before ? { percent: before.percent, source: before.source } : null,
          after: { percent: reading.percent, source: 'manager' },
          occurredAtMs: deps.clock.nowMs(),
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

  app.get(
    '/shifts/:id/close-draft',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      return getCloseDraft(deps, req.actor!, id)
    },
  )

  app.patch(
    '/shifts/:id/close-draft',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      return patchCloseDraft(deps, req.actor!, id, patchCloseDraftRequest.parse(req.body))
    },
  )

  app.post(
    '/shifts/:id/close-draft/media/:slot/read',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req, reply) => {
      const { id, slot } = z.object({ id: z.string(), slot: z.string().min(1).max(32) }).parse(req.params)
      const body = linkedCloseDraftReadRequest.parse(req.body)
      if (body.field === 'orders' && req.headers['x-ash-orders-time-consensus'] !== 'close-draft-v1') {
        return reply.code(428).send({ error: 'driver_update_required' })
      }
      return readCloseDraftAttachment(
        deps,
        req.actor!,
        id,
        slot,
        body,
        opts.maxOcrReadsPerShift ?? 15,
      )
    },
  )

  app.get(
    '/shifts/:id/close-draft/attachments',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const current = await getCloseDraft(deps, req.actor!, id)
      const tokens = new Set(current.attachments.map((attachment) => attachment.attachmentToken))
      const history = (await deps.media.listAttachmentHistory(id)).map((row) => ({
        historyId: row.id,
        package: row.package,
        slot: row.slot,
        mediaId: row.mediaId,
        attachmentToken: row.attachmentToken,
        attachedAt: new Date(row.attachedAtMs).toISOString(),
        attachedAtMs: row.attachedAtMs,
        reusedFromShiftId: row.reusedFromShiftId,
        isCurrent: tokens.has(row.attachmentToken),
      }))
      return { current: current.attachments, history }
    },
  )

  app.post(
    '/shifts/:id/close-draft/attachments/:historyId/restore',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req) => {
      const { id, historyId } = z.object({ id: z.string(), historyId: z.string().min(1) }).parse(req.params)
      const body = restoreCloseDraftAttachmentRequest.parse(req.body)
      const preliminary = await getCloseDraft(deps, req.actor!, id)
      if (preliminary.revision !== body.expectedRevision) {
        throw new ServiceError(409, 'close_draft_revision_conflict', { current: preliminary })
      }
      const historical = (await deps.media.listAttachmentHistory(id)).find((row) => row.id === historyId)
      if (!historical) throw new ServiceError(404, 'evidence_history_not_found')
      const expectedField = historical.package === 'end'
        ? /^dashboard(?:_[2-9]|_[1-9]\d+)?$/.test(historical.slot)
          ? 'orders' as const
          : /^payments_log(?:_[2-9]|_[1-9]\d+)?$/.test(historical.slot)
            ? 'payments_log' as const
            : null
        : null
      if (expectedField !== null) {
        const { bytes } = await readEvidence(deps, historical.mediaId)
        const classified = await readScreen(deps, {
          shiftId: id,
          field: expectedField,
          bytes,
          requestedBy: req.actor!.userId,
          maxReadsPerShift: opts.maxOcrReadsPerShift ?? 15,
          retryFailed: false,
        })
        if (!classified.result.ok && classified.result.reason === 'wrong_screen') {
          throw new ServiceError(422, 'wrong_screen', {
            slot: historical.slot,
            expectedField,
            historyId,
          })
        }
      }
      const committed = await deps.closeUnitOfWork.run(
        { shiftId: id, actorId: req.actor!.userId, requestId: req.requestId },
        async (transaction) => {
          const transactionDeps: Deps = { ...deps, ...transaction }
          const current = await getCloseDraft(transactionDeps, req.actor!, id)
          if (current.revision !== body.expectedRevision) {
            throw new ServiceError(409, 'close_draft_revision_conflict', { current })
          }
          const before = current.attachments.find(
            (attachment) => attachment.attachmentToken === body.expectedAttachmentToken,
          ) ?? null
          const restored = await restoreEvidence(transactionDeps, {
            shiftId: id,
            historyId,
            expectedCurrentAttachmentToken: body.expectedAttachmentToken,
            actorId: req.actor!.userId,
            reason: body.reason,
          })
          const draft = await syncCloseDraftEvidence(transactionDeps, req.actor!, id, current.revision)
          return { before, restored, draft }
        },
      )
      return { attachment: committed.restored, draft: committed.draft }
    },
  )

  app.get(
    '/shifts/:id/close-draft/media/:mediaId/thumbnail',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req, reply) => {
      const { id, mediaId } = z.object({ id: z.string(), mediaId: z.string() }).parse(req.params)
      const allowed = (await deps.media.listAttachmentHistory(id)).some((row) => row.mediaId === mediaId)
      if (!allowed) throw new ServiceError(404, 'evidence_not_found')
      const { media, bytes } = await readEvidence(deps, mediaId)
      return reply
        .header('content-type', media.mimeType)
        .header('cache-control', 'private, no-store')
        .header('pragma', 'no-cache')
        .header('expires', '0')
        .send(Buffer.from(bytes))
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
      const bytes = new Uint8Array(req.body as Buffer)
      const takenHeader = req.headers['x-client-taken-at']
      const clientTakenAtMs = typeof takenHeader === 'string' && /^\d+$/.test(takenHeader) ? Number(takenHeader) : null
      const acknowledgedHeader = req.headers['x-stale-evidence-acknowledged']
      const revisionHeader = req.headers['x-close-draft-revision']
      const expectedTokenHeader = req.headers['x-expected-attachment-token']
      let expectedAttachmentToken = typeof expectedTokenHeader === 'string' && expectedTokenHeader !== ''
        ? expectedTokenHeader
        : null
      if (params.package === 'start' && expectedAttachmentToken === null) {
        expectedAttachmentToken = (await deps.media.listSlots(params.id)).find(
          (slot) => slot.package === 'start' && slot.slot === params.slot,
        )?.attachmentToken ?? null
      }
      let expectedRevision: number | null = null
      let draftBefore: Awaited<ReturnType<typeof getCloseDraft>> | null = null
      if (params.package === 'end') {
        if (typeof revisionHeader !== 'string' || !/^\d+$/.test(revisionHeader)) {
          return reply.code(428).send({ error: 'driver_update_required' })
        }
        expectedRevision = Number(revisionHeader)
        draftBefore = await getCloseDraft(deps, req.actor!, params.id)
        if (draftBefore.revision !== expectedRevision) {
          throw new ServiceError(409, 'close_draft_revision_conflict', { current: draftBefore })
        }
      }

      const preflightField = params.package === 'end'
        ? /^dashboard(?:_[2-9]|_[1-9]\d+)?$/.test(params.slot)
          ? 'orders' as const
          : /^payments_log(?:_[2-9]|_[1-9]\d+)?$/.test(params.slot)
            ? 'payments_log' as const
            : params.slot === 'wallet'
              ? 'wallet' as const
              : params.slot === 'odometer'
                ? 'odometer' as const
                : /^bms(?:_[1-9]\d*)?$/.test(params.slot)
                  ? 'bms' as const
                  : null
        : null

      let result
      try {
        result = await uploadEvidence(deps, {
          shiftId: params.id,
          package: params.package,
          slot: params.slot,
          bytes,
          clientTakenAtMs,
          uploadedBy: req.actor!.userId,
          staleAcknowledged: acknowledgedHeader === 'true',
          replaceConfirmed: req.headers['x-replace-confirmed'] === 'true',
          expectedAttachmentToken,
          ...(expectedRevision === null ? {} : {
            runCommit: <T>(work: (transactionDeps: Deps) => Promise<T>): Promise<T> =>
              deps.closeUnitOfWork.run(
                { shiftId: params.id, actorId: req.actor!.userId, requestId: req.requestId },
                (transaction) => work({ ...deps, ...transaction }),
              ),
            beforeCommit: async (transactionDeps: Deps) => {
              const current = await transactionDeps.closeDrafts.findByShift(params.id)
              if (!current || current.revision !== expectedRevision) {
                throw new ServiceError(409, 'close_draft_revision_conflict', {
                  current: current ? await getCloseDraft(transactionDeps, req.actor!, params.id) : null,
                })
              }
            },
            afterAttach: (transactionDeps: Deps) =>
              syncCloseDraftEvidence(transactionDeps, req.actor!, params.id, expectedRevision),
          }),
          ...(preflightField === null ? {} : {
            beforeAttach: async () => {
              const screen = await readScreen(deps, {
                shiftId: params.id,
                field: preflightField,
                bytes,
                requestedBy: req.actor!.userId,
                maxReadsPerShift: opts.maxOcrReadsPerShift ?? 15,
                retryFailed: false,
              })
              if (!screen.result.ok && screen.result.reason === 'wrong_screen') {
                throw new ServiceError(422, 'wrong_screen', { slot: params.slot, expectedField: preflightField })
              }
            },
          }),
        })
      } catch (error) {
        if (
          error instanceof ServiceError &&
          draftBefore !== null &&
          [
            'stale_evidence_confirmation_required',
            'evidence_replacement_confirmation_required',
            'evidence_already_attached',
            'evidence_attachment_changed',
          ].includes(error.code)
        ) {
          throw new ServiceError(error.status, error.code, {
            ...(typeof error.detail === 'object' && error.detail !== null ? error.detail : {}),
            current: draftBefore,
          })
        }
        throw error
      }
      return reply.code(201).send({
        mediaId: result.media.id,
        sha256: result.media.sha256,
        byteSize: result.media.byteSize,
        deduped: result.deduped,
        clockSkewMs: result.clockSkewMs,
        reusedFromShiftId: result.reusedFromShiftId,
        attachmentToken: result.attachmentToken,
        staleAcknowledged: result.staleAcknowledged,
        slots: result.slotsNow,
        ...(result.draft === undefined ? {} : { draft: result.draft }),
      })
    },
  )

  app.post(
    '/shifts/:id/media/:package/:slot/acknowledge-stale',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req) => {
      const params = uploadEvidenceParams.parse(req.params)
      const { mediaId, attachmentToken } = z
        .object({ mediaId: z.string().min(1), attachmentToken: z.string().min(1) })
        .parse(req.body)
      await acknowledgeStaleEvidence(deps, {
        shiftId: params.id,
        package: params.package,
        slot: params.slot,
        mediaId,
        attachmentToken,
        acknowledgedBy: req.actor!.userId,
      })
      return { ok: true }
    },
  )

  /**
   * Read a screen with the cloud model (SRS D, un-deferred).
   *
   * Raw bytes, like the upload beside it — but these are the ORIGINAL pixels, not the compressed
   * evidence copy, because the compression that makes evidence cheap to store also makes it
   * unreadable. Two uploads of one photograph, deliberately.
   *
   * `shift.operate` + `shiftSubject` is the same pair the upload route uses: only a driver on his
   * OWN shift, plus the system admin. No new permission key, so no `DEFAULT_GRANTS` edit and no
   * RBAC migration.
   *
   * Always 200. A read that failed says so in the body — see the header of `ocr.service.ts` for
   * why an OCR limb must never be able to fail a money limb.
   */
  app.post(
    '/shifts/:id/ocr/:field',
    {
      config: { permission: 'shift.operate', subject: shiftSubject },
      bodyLimit: MAX_UPLOAD_BYTES,
    },
    async (req, reply) => {
      const params = z.object({ id: z.string(), field: z.enum(OCR_FIELDS_TUPLE) }).parse(req.params)
      // The consensus reader can deliberately return a monetary row whose unverified clock is
      // null. Driver bundles before this release discarded such rows. Refuse those stale callers
      // before spending an OCR attempt so a cached PWA can never turn uncertainty into missing
      // money. The current same-origin client always sends this capability header for orders.
      if (
        params.field === 'orders' &&
        req.headers['x-ash-orders-time-consensus'] !== 'close-draft-v1'
      ) {
        return reply.code(428).send({
          error: 'driver_update_required',
          message: 'Refresh the driver application before reading Recent Orders.',
        })
      }
      const out = await readScreen(deps, {
        shiftId: params.id,
        field: params.field,
        bytes: new Uint8Array(req.body as Buffer),
        requestedBy: req.actor!.userId,
        maxReadsPerShift: opts.maxOcrReadsPerShift ?? 15,
        retryFailed: req.headers['x-ocr-retry'] === 'true',
      })
      return reply.send({
        ok: out.result.ok,
        cached: out.cached,
        retryable: out.retryable,
        reads: out.reads,
        ...(out.result.ok
          ? { rows: out.result.rows, fields: out.result.fields }
          : { reason: out.result.reason, rows: [], fields: {} }),
      })
    },
  )

  /**
   * «حذف الصورة» — take a photo back out of a slot.
   *
   * Same grant as the upload it undoes. The BR5 gates read the slot links, so a driver who deletes
   * a photo he still owes fails his own gate immediately and cannot submit — he cannot delete his
   * way past a requirement, only correct a mistake or drop a surplus page.
   */
  app.delete(
    '/shifts/:id/media/:package/:slot',
    { config: { permission: 'shift.operate', subject: shiftSubject } },
    async (req, reply) => {
      const params = uploadEvidenceParams.parse(req.params)
      if (params.package === 'end') {
        const revisionHeader = req.headers['x-close-draft-revision']
        const tokenHeader = req.headers['x-expected-attachment-token']
        if (
          typeof revisionHeader !== 'string' || !/^\d+$/.test(revisionHeader) ||
          typeof tokenHeader !== 'string' || tokenHeader === ''
        ) {
          return reply.code(428).send({ error: 'driver_update_required' })
        }
        const expectedRevision = Number(revisionHeader)
        const committed = await deps.closeUnitOfWork.run(
          { shiftId: params.id, actorId: req.actor!.userId, requestId: req.requestId },
          async (transaction) => {
            const transactionDeps: Deps = { ...deps, ...transaction }
            const current = await getCloseDraft(transactionDeps, req.actor!, params.id)
            if (current.revision !== expectedRevision) {
              throw new ServiceError(409, 'close_draft_revision_conflict', { current })
            }
            const result = await deleteEvidence(transactionDeps, {
              shiftId: params.id,
              package: 'end',
              slot: params.slot,
              deletedBy: req.actor!.userId,
              expectedAttachmentToken: tokenHeader,
            })
            const draft = await syncCloseDraftEvidence(transactionDeps, req.actor!, params.id, current.revision)
            return { result, draft }
          },
        )
        return reply.send({ slots: committed.result.slotsNow, draft: committed.draft })
      }
      const result = await deleteEvidence(deps, {
        shiftId: params.id,
        package: 'start',
        slot: params.slot,
        deletedBy: req.actor?.userId ?? null,
      })
      return reply.send({ slots: result.slotsNow })
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
  const shiftSnapshot = async (shiftId: string, sourceDeps: Deps = deps) => {
    const shift = await sourceDeps.shifts.findById(shiftId)
    if (!shift) return null
    // Per-pack readings, joined to the packs so a slot and a capacity are shown rather than a
    // uuid. A two-pack bike hands back two of these at each end of the shift.
    const [orders, movements, cashDeductions, readings, fitted, slots, swaps, allBatteries, driver, vehicle] = await Promise.all([
      sourceDeps.orders.listByShift(shiftId),
      // Every movement, checked and unchecked — the owner's rule is that whoever closes the shift
      // sees ALL of them. Fetched HERE so the driver's view and the manager's cannot disagree.
      sourceDeps.movements.listByShift(shiftId),
      sourceDeps.cashDeductions.listByShift(shiftId),
      sourceDeps.batteryReadings.listByShift(shiftId),
      sourceDeps.directory.listBatteriesForVehicle(shift.vehicleId),
      // C-7: the review must SHOW the photos, not just their slot names. Each attached slot carries
      // the media id the RBAC-checked GET /media/:id serves.
      sourceDeps.media.listSlots(shiftId),
      sourceDeps.batterySwaps.listByShift(shiftId),
      // Serials for BOTH packs of every swap — the outgoing one is no longer fitted, so it is not in
      // `fitted`; it has to be resolved off the branch's full battery list.
      sourceDeps.directory.listBatteries(shift.branchId),
      // The review header used to make two extra HTTP round-trips through the fleet endpoints just
      // to turn ids already present on the shift into the name/code a manager can recognise. Keep
      // the identity beside the snapshot so deep links and a freshly opened review render it on the
      // first response. These are additive fields; older clients continue to use the ids.
      sourceDeps.directory.driver(shift.driverId),
      sourceDeps.directory.vehicle(shift.vehicleId),
    ])
    const withPack = (pkg: 'start' | 'end') =>
      readings
        .filter((r) => r.package === pkg)
        .map((r) => {
          const battery = fitted.find((b) => b.id === r.batteryId)
          return {
            ...r,
            // Required by the driver after a remount: an ordinary edit must lock to the evidence
            // already reviewed instead of looking like an old-PWA read-before-retake write.
            mediaId: r.mediaId,
            capacityAh: battery?.capacityAh ?? null,
            serialNo: battery?.serialNo ?? null,
          }
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
        driverNameAr: driver?.fullNameAr ?? null,
        driverNameEn: driver?.fullNameEn ?? null,
        vehicleCode: vehicle?.code ?? null,
        shiftNo: shift.shiftNo,
        businessDate: shift.businessDate,
        openApprovedAt: shift.openApprovedAt,
        submittedAt: shift.submittedAt,
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
          odometerKmOcr: shift.odoEndOcr,
          odometerAnomalyConfirmedAt: shift.odoEndAnomalyConfirmedAt,
          odometerAnomalyConfirmedBy: shift.odoEndAnomalyConfirmedBy,
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
          windowStatus: o.windowStatus,
          decisionReason: o.decisionReason,
          decidedBy: o.decidedBy,
          decidedAt: o.decidedAt,
          windowBasis: o.windowBasis ?? null,
          positionEvidence: o.positionEvidence ?? null,
          observationId: o.observationId ?? null,
          closeDraftReviewReasons: o.closeDraftReviewReasons ?? [],
        })),
        cashDeductions: cashDeductions.map((d) => ({
          id: d.id,
          operationKey: d.operationKey,
          amount: serializeMoney(d.amount),
          occurredDate: d.occurredDate,
          occurredMinute: d.occurredMinute,
          source: d.source,
          amountOcr: d.amountOcr === null ? null : serializeMoney(d.amountOcr),
          pointA: d.pointA,
          pointB: d.pointB,
          included: d.included,
          windowStatus: d.windowStatus,
          decisionReason: d.decisionReason,
          decidedBy: d.decidedBy,
          decidedAt: d.decidedAt,
          windowBasis: d.windowBasis ?? null,
          positionEvidence: d.positionEvidence ?? null,
          observationId: d.observationId ?? null,
          closeDraftReviewReasons: d.closeDraftReviewReasons ?? [],
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
        /**
         * Each photo with WHEN IT WAS TAKEN, not just when it arrived.
         *
         * `MediaRecord` has carried both timestamps from the start, and its own comment says the gap
         * "is surfaced to the branch manager — that difference is what makes a photo evidence rather
         * than just a picture". It never was: the review sent only the id. That mattered less while
         * `capture="environment"` forced a live shot; now that every slot can be filled from the
         * gallery, the age of the image IS the control that replaced it.
         */
        media: await Promise.all(
          slots.map(async (s) => {
            const record = await sourceDeps.media.findById(s.mediaId)
            return {
              package: s.package,
              slot: s.slot,
              mediaId: s.mediaId,
              // The phone's clock is a CLAIM; `receivedAt` is authoritative. Both cross, and the
              // screen shows the difference rather than picking a winner.
              clientTakenAt: record?.clientTakenAtMs == null ? null : new Date(record.clientTakenAtMs).toISOString(),
              receivedAt: record ? new Date(record.receivedAtMs).toISOString() : null,
              attachedAt: new Date(s.attachedAtMs).toISOString(),
              reusedFromShiftId: s.reusedFromShiftId,
              staleAcknowledgedAt:
                s.staleAcknowledgedAtMs === null ? null : new Date(s.staleAcknowledgedAtMs).toISOString(),
              staleAcknowledgedBy: s.staleAcknowledgedBy,
            }
          }),
        ),
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
      const shift = await cancelShift(deps, id, req.actor?.userId ?? null)
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

  /** Immutable fixed-policy preview. Optional actuals let force-close preview the same calculation. */
  app.get(
    '/shifts/:id/settlement',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const query = z.object({ actualCash: nonnegativeMoneySchema.optional(), actualWallet: moneySchema.optional() }).parse(req.query)
      const plan = await deps.closeUnitOfWork.run(
        { shiftId: id, actorId: req.actor!.userId },
        async (transaction) => {
          const transactionDeps: Deps = { ...deps, ...transaction }
          const shift = await transaction.shifts.findById(id)
          if (!shift) throw new ServiceError(404, 'shift_not_found')
          const stored = await transaction.settlements.findByShift(id)
          if (stored) {
            return {
              ...stored,
              wallet: { action: stored.walletAction, amount: stored.walletAmount },
              cash: { action: stored.cashAction, amount: stored.cashAmount },
            }
          }
          // Pre-policy approvals stay historically intact; never present a freshly recomputed 40%
          // receipt for a journal that was actually posted under a former tier rule.
          if (shift.state === 'approved' || shift.state === 'week_locked') {
            throw new ServiceError(409, 'legacy_settlement_read_only')
          }
          return settlementFor(transactionDeps, {
            ...shift,
            ...(query.actualCash === undefined ? {} : { endCashDeclared: query.actualCash }),
            ...(query.actualWallet === undefined ? {} : { endWalletDeclared: query.actualWallet }),
          })
        },
      )
      return {
        policyCode: plan.policyCode,
        driverRateBps: plan.driverRateBps,
        deliveryFeeTotal: serializeMoney(plan.deliveryFeeTotal),
        fixedDriverShare: serializeMoney(plan.fixedDriverShare),
        manualDriverShare: serializeMoney(plan.manualDriverShare),
        grossDriverShare: serializeMoney(plan.grossDriverShare),
        cashDeductionTotal: serializeMoney(plan.cashDeductionTotal),
        baseDriverShare: serializeMoney(plan.baseDriverShare),
        expectedTotal: serializeMoney(plan.expectedTotal),
        actualCash: serializeMoney(plan.actualCash),
        actualWallet: serializeMoney(plan.actualWallet),
        actualTotal: serializeMoney(plan.actualTotal),
        variance: serializeMoney(plan.variance),
        varianceDirection: plan.varianceDirection,
        finalEmployeeCash: serializeMoney(plan.finalEmployeeCash),
        walletToOffice: serializeMoney(plan.walletToOffice),
        cashToOffice: serializeMoney(plan.cashToOffice),
        walletAction: plan.wallet.action,
        walletAmount: serializeMoney(plan.wallet.amount),
        cashAction: plan.cash.action,
        cashAmount: serializeMoney(plan.cash.amount),
        settlementHash: plan.settlementHash,
      }
    },
  )

  /** The branch manager's review screen (C-7): the numbers, the difference, and why. */
  app.get(
    '/shifts/:id/review',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const review = await deps.closeUnitOfWork.run(
        { shiftId: id, actorId: req.actor!.userId },
        async (transaction) => {
          const transactionDeps: Deps = { ...deps, ...transaction }
          const shift = await transaction.shifts.findById(id)
          if (!shift) return null
          await prepareShiftReview(transactionDeps, shift, req.actor!.userId)
          const snapshot = await shiftSnapshot(id, transactionDeps)
          if (!snapshot) return null
          const br1 = await evaluateShift(transactionDeps, snapshot.shift)
          const decisions = await transaction.decisions.listByShift(id)
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
      if (!review) return reply.code(404).send({ error: 'shift_not_found' })
      return review
    },
  )

  app.post(
    '/shifts/:id/approve-close',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = approveCloseRequest.parse(req.body)
      const result = await approveClose(deps, req.actor!, id, body.reviewedOrdersHash, opts.splitGate ?? 'advisory', {
        ...(body.keepAsReceivable === undefined ? {} : { keepAsReceivable: body.keepAsReceivable }),
        ...(body.payShareNow === undefined ? {} : { payShareNow: body.payShareNow }),
        ...(body.reviewedSettlementHash === undefined ? {} : { reviewedSettlementHash: body.reviewedSettlementHash }),
        walletTransferConfirmed: body.walletTransferConfirmed,
        cashSettlementConfirmed: body.cashSettlementConfirmed,
        varianceReason: body.varianceReason,
      })
      return { id: result.shift.id, state: result.shift.state, postings: result.postings }
    },
  )

  /**
   * Re-read one explicitly selected stored Recent Orders page during close review.
   *
   * Persisted operations do not know which screenshot row created them. Consequently this route
   * returns the COMPLETE page as suggestions and never changes a fee, time or inclusion itself;
   * applying one suggestion remains an explicit, reasoned `/operations/revise` action.
   */
  app.post(
    '/shifts/:id/ocr/orders/evidence-reread',
    { config: { permission: 'shift.approve', subject: shiftSubject } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      if (req.headers['x-ash-orders-time-consensus'] !== 'close-draft-v1') {
        return reply.code(428).send({
          error: 'manager_update_required',
          message: 'Refresh the manager application before re-reading stored Recent Orders evidence.',
        })
      }
      const body = z
        .object({
          package: z.literal('end').default('end'),
          slot: z.string().min(1).max(80),
          target: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('order'), providerOrderNo: z.string().min(1).max(64) }),
            z.object({
              kind: z.literal('cash_deduction'),
              id: z.string().min(1).optional(),
              operationKey: z.string().min(1).max(160).optional(),
            }),
          ]),
          reason: z.string().trim().min(1).max(500),
        })
        .superRefine((value, context) => {
          if (
            value.target.kind === 'cash_deduction' &&
            value.target.id === undefined &&
            value.target.operationKey === undefined
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['target'],
              message: 'cash deduction id or operationKey is required',
            })
          }
        })
        .parse(req.body)
      const out = await rereadManagerOrderEvidence(deps, req.actor!, {
        shiftId: id,
        package: body.package,
        slot: body.slot,
        target: body.target,
        reason: body.reason,
        requestId: req.requestId,
        maxReadsPerShift: opts.maxOcrReadsPerShift ?? 15,
      })
      return reply.send({
        ok: out.result.ok,
        cached: out.cached,
        retryable: out.retryable,
        reads: out.reads,
        evidence: out.evidence,
        target: out.target,
        reviewedOrdersHash: out.reviewedOrdersHash,
        settlementHash: out.settlementHash,
        ...(out.result.ok
          ? { rows: out.result.rows }
          : { reason: out.result.reason, rows: [] }),
      })
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
      const { br1, cashDeductions } = await submitOperations(deps, req.actor!, id, body)
      return {
        id,
        br1: serializeBr1(br1),
        cashDeductions: cashDeductions.map((deduction) => ({
          id: deduction.id,
          operationKey: deduction.operationKey,
          amount: serializeMoney(deduction.amount),
          amountOcr: deduction.amountOcr === null ? null : serializeMoney(deduction.amountOcr),
          occurredMinute: deduction.occurredMinute,
          occurredDate: deduction.occurredDate,
          source: deduction.source,
          pointA: deduction.pointA,
          pointB: deduction.pointB,
          included: deduction.included,
          windowStatus: deduction.windowStatus,
          decisionReason: deduction.decisionReason,
          decidedBy: deduction.decidedBy,
          decidedAt: deduction.decidedAt,
          windowBasis: deduction.windowBasis ?? null,
          positionEvidence: deduction.positionEvidence ?? null,
          observationId: deduction.observationId ?? null,
          closeDraftReviewReasons: deduction.closeDraftReviewReasons ?? [],
        })),
      }
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
      const auditedBody = {
        ...body,
        orders: body.orders.map((order) => ({
          ...order,
          ...(order.fee === undefined ? {} : { fee: serializeMoney(order.fee) }),
          ...(order.walletAmount === undefined
            ? {}
            : { walletAmount: order.walletAmount === null ? null : serializeMoney(order.walletAmount) }),
        })),
      }
      await deps.audit.append({
        tableName: 'shifts',
        recordId: shift.id,
        action: 'UPDATE',
        actorId: req.actor!.userId,
        actorKind: 'user',
        branchId: shift.branchId,
        requestId: req.requestId,
        before: { ordersHash: before.ordersHash },
        after: { ordersHash: shift.ordersHash, revisedByManager: true, ...auditedBody },
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
  // discards the orders → cancelled. FORCE-CLOSE first freezes the boundary/actuals, then uses the
  // same full-wallet and signed-cash settlement as normal approval; variance belongs to the employee
  // and never goes to a branch variance account. Both paths are audited with a mandatory reason.
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
      if (result.prepared) {
        return { id: result.shift.id, state: result.shift.state, postings: 0, prepared: true }
      }
      if (!result.replayed) {
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
      }
      return { id: result.shift.id, state: result.shift.state, postings: result.postings, prepared: false }
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
    cashDeductionTotal: serializeMoney(view.cashDeductionTotal),
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
