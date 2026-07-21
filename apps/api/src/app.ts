import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps } from '@ash/contracts'
import {
  addOrderRequest,
  approveCloseRequest,
  closeWeekRequest,
  createShiftRequest,
  endPackageRequest,
  loginRequest,
  serializeMoney,
  setFxRequest,
  startPackageRequest,
} from '@ash/contracts'
import { checkWeekClose, minor, sum, weekClosedOn, weekStartFor } from '@ash/domain'
import { SESSION_COOKIE, SESSION_IDLE_MS, login, logout, resolveSession } from './auth.ts'
import { assertEveryRouteDeclaresPermission, collectRoutes, makeAuthorize, resetRouteRegistry } from './rbac.ts'
import {
  ServiceError,
  addOrder,
  approveClose,
  approveOpen,
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
      })
  })

  app.post('/auth/logout', { config: { permission: null } }, async (req, reply) => {
    await logout(deps, req.cookies[SESSION_COOKIE])
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true })
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

  // ── Shifts ──────────────────────────────────────────────────────────────────────────────
  const shiftSubject = async (req: { params: unknown }) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const shift = await deps.shifts.findById(id)
    return shift ? { driverId: shift.driverId, branchId: shift.branchId } : {}
  }

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
      const shift = await approveOpen(deps, req.actor!, id)
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
  app.post('/weeks/close', { config: { permission: 'week.close' } }, async (req, reply) => {
    const body = closeWeekRequest.parse(req.body)
    const branchId = req.actor!.branchId
    if (!branchId) {
      // The org-wide close fans out to one lock per branch; single-branch today, so require one.
      return reply.code(422).send({ error: 'branch_required_for_close' })
    }

    const { start, end } = weekClosedOn(body.closeDate)
    const shifts = await deps.shifts.listByBranchAndDate(branchId, start)
    const closedStarts = await deps.weekLocks.listClosedStarts(branchId)
    const existing = await deps.weekLocks.find(branchId, start)

    const entries = await deps.ledger.listByWeek(branchId, start)
    let diff = 0n
    for (const e of entries) for (const l of e.lines) diff += l.side === 'D' ? l.amount : -l.amount

    const check = checkWeekClose({
      closeDate: body.closeDate,
      unapprovedShiftCount: shifts.filter((s) => s.state !== 'approved' && s.state !== 'week_locked').length,
      daysMissingCashCount: [],
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
