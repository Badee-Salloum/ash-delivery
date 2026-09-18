import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { CheckInRecord, CheckInWindowRecord, Deps } from '@ash/contracts'
import { createCheckInRequest, createCheckInWindowRequest, setBranchLocationRequest } from '@ash/contracts'
import { assessCheckIn, isWithinOperatingRegion, rollCall, swapWouldBeInRegion } from '@ash/domain'
import { ServiceError, todayFor } from './shifts.service.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'

/**
 * «التفقّد» — a branch manager proving he was at the branch when he is expected there.
 *
 * The owner's rule (2026-08-29): several rounds a day — say 01:00, 05:00 and 10:00 — each within a
 * tolerance and each from inside the branch's own patch of ground. DRIVERS ARE EXCLUDED by design:
 * they are out on the road all day and their whereabouts already ride on their shift's GPS pings.
 *
 * NOTHING HERE BLOCKS ANYONE. A manager whose phone refuses location, or who is genuinely away,
 * still gets a recorded row saying exactly that, with the distance and the minutes. The report is
 * for a human to read — the same stance the operation-window hint takes on the driver's screen.
 * A check-in that could stop a manager working would be a GPS outage away from stopping the branch.
 */

const serializeWindow = (w: CheckInWindowRecord) => ({
  id: w.id,
  userId: w.userId,
  atMinute: w.atMinute,
  toleranceMinutes: w.toleranceMinutes,
  label: w.label,
})

const serializeCheckIn = (c: CheckInRecord) => ({
  id: c.id,
  userId: c.userId,
  businessDate: c.businessDate,
  capturedAt: new Date(c.capturedAtMs).toISOString(),
  lat: c.lat,
  lng: c.lng,
  accuracyM: c.accuracyM,
  windowId: c.windowId,
  distanceM: c.distanceM,
  insideArea: c.insideArea,
  minutesFromTarget: c.minutesFromTarget,
  verdict: c.verdict,
  note: c.note,
})

export function registerCheckInRoutes(app: FastifyInstance, deps: Deps): void {
  const ownBranch = branchSubject
  const targetBranch = branchSubject

  /**
   * Where the branch is. `settings.write` — the same gate as the rest of the system's shape.
   *
   * Clearing it (null coordinates) is a legitimate act, not an error: it switches «التفقّد» back
   * off for this branch rather than leaving a fence nobody can satisfy.
   */
  app.put('/branch-location', { config: { permission: 'settings.write', subject: targetBranch } }, async (req) => {
    const body = setBranchLocationRequest.parse(req.body)
    const branchId = resolveBranchId(req)
    const before = await deps.directory.branch(branchId)
    if (!before) throw new ServiceError(404, 'branch_not_found')

    /*
     * The one error a range check cannot see: latitude and longitude entered the wrong way round.
     *
     * `lat` is bounded by ±90 and `lng` by ±180, and at nearly every inhabited place both numbers
     * are legal in both fields. Damascus is the worst case — 33.5 and 36.3 are each valid as either
     * — so a swap passes every schema, stores cleanly, and moves the fence several hundred
     * kilometres. It did, in production, on the day this branch was first placed: the point landed
     * in southern Turkey and every round would have read «خارج الفرع» with nothing to say why.
     *
     * Refuse once and hand back the swap when reversing the pair would land inside, which turns the
     * refusal into a correction the operator can accept with one press.
     */
    if (body.lat !== null && body.lng !== null && !body.confirmOutsideRegion) {
      const point = { lat: body.lat, lng: body.lng }
      if (!isWithinOperatingRegion(point)) {
        throw new ServiceError(422, 'location_outside_operating_region', {
          lat: body.lat,
          lng: body.lng,
          swapSuggested: swapWouldBeInRegion(point),
          suggestedLat: body.lng,
          suggestedLng: body.lat,
        })
      }
    }

    const updated = await deps.directory.setBranchLocation(branchId, {
      lat: body.lat,
      lng: body.lng,
      checkinRadiusM: body.checkinRadiusM,
    })
    if (!updated) throw new ServiceError(404, 'branch_not_found')

    const shape = (b: { lat: number | null; lng: number | null; checkinRadiusM: number }) => ({
      lat: b.lat, lng: b.lng, checkinRadiusM: b.checkinRadiusM,
    })
    await deps.audit.append({
      tableName: 'branches',
      recordId: branchId,
      action: 'UPDATE',
      actorId: req.actor!.userId,
      actorKind: 'user',
      branchId,
      requestId: req.requestId,
      before: shape(before),
      after: shape(updated),
      occurredAtMs: deps.clock.nowMs(),
    })
    return { id: branchId, ...shape(updated) }
  })

  /**
   * The rota: which rounds this branch expects, and from whom.
   *
   * A caller whose grant is scoped to his branch sees ONLY HIS OWN rounds — he is the subject of
   * the check, not its auditor, and the owner's rule is that he gets «زر التفقد و مواعيد تفقده»
   * and nothing further. Narrowing by the SCOPE the authorisation granted, rather than by a role
   * name, keeps this true if the matrix is ever edited: whoever is given branch-wide sight becomes
   * an auditor by the same act.
   */
  app.get('/checkin-windows', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranchId(req)
    const asked = z.object({ userId: z.string().optional() }).parse(req.query).userId
    const userId = req.grantedScope === 'all' ? asked : req.actor!.userId
    const windows = await deps.checkIns.listWindows(branchId, userId)
    return { windows: windows.map(serializeWindow) }
  })

  app.post('/checkin-windows', { config: { permission: 'settings.write', subject: targetBranch } }, async (req, reply) => {
    const body = createCheckInWindowRequest.parse(req.body)
    const branchId = resolveBranchId(req)

    // Per USER, not per role. The owner asked for this on the branch-manager account, and naming
    // the account keeps a second manager — or a stand-in during leave — from silently inheriting
    // a rota nobody agreed he was on.
    const user = await deps.users.findById(body.userId)
    if (!user) throw new ServiceError(404, 'user_not_found')
    if (user.branchId !== branchId) throw new ServiceError(422, 'user_in_another_branch')
    if (user.roleKey === 'driver') {
      // Drivers are excluded by design, not by omission: they are out on the road all day, and a
      // rota of office rounds for them would be a queue of guaranteed misses.
      throw new ServiceError(422, 'checkin_not_for_drivers', { userId: body.userId })
    }

    const window: CheckInWindowRecord = {
      id: deps.ids.uuid(),
      branchId,
      userId: body.userId,
      atMinute: body.atMinute,
      toleranceMinutes: body.toleranceMinutes,
      active: true,
      label: body.label,
      createdBy: req.actor!.userId,
    }
    try {
      const created = await deps.checkIns.createWindow(window)
      await deps.audit.append({
        tableName: 'checkin_windows',
        recordId: created.id,
        action: 'INSERT',
        actorId: req.actor!.userId,
        actorKind: 'user',
        branchId,
        requestId: req.requestId,
        before: null,
        after: serializeWindow(created),
        occurredAtMs: deps.clock.nowMs(),
      })
      return reply.code(201).send(serializeWindow(created))
    } catch (err) {
      if ((err as { code?: string }).code === 'DUPLICATE_WINDOW') {
        throw new ServiceError(409, 'checkin_window_exists', { atMinute: body.atMinute })
      }
      throw err
    }
  })

  app.delete('/checkin-windows/:id', { config: { permission: 'settings.write', subject: targetBranch } }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    // Retiring keeps the history: `active` moves, the row stays, and yesterday's roll-call still
    // explains itself.
    const removed = await deps.checkIns.deactivateWindow(id)
    if (!removed) throw new ServiceError(404, 'checkin_window_not_found')
    await deps.audit.append({
      tableName: 'checkin_windows',
      recordId: id,
      action: 'UPDATE',
      actorId: req.actor!.userId,
      actorKind: 'user',
      branchId: resolveBranchId(req),
      requestId: req.requestId,
      before: { active: true },
      after: { active: false },
      occurredAtMs: deps.clock.nowMs(),
    })
    return { id, active: false }
  })

  /**
   * «تفقّد» — the manager presses the button and his browser supplies the fix.
   *
   * A deliberate act rather than a silent read on login: a browser only surrenders location on an
   * explicit interaction anyway, and a manager who stays signed in all day would otherwise miss
   * every round while sitting at his desk.
   */
  app.post('/checkins', { config: { permission: 'branch_data.view', subject: targetBranch } }, async (req, reply) => {
    const body = createCheckInRequest.parse(req.body)
    const branchId = resolveBranchId(req)
    const userId = req.actor!.userId

    const branch = await deps.directory.branch(branchId)
    if (!branch) throw new ServiceError(404, 'branch_not_found')
    if (branch.lat === null || branch.lng === null) {
      // Refusing here rather than measuring against (0,0) — a default point in the Gulf of Guinea
      // would fail every round with a distance of several thousand kilometres and no explanation.
      throw new ServiceError(422, 'branch_location_not_set', { branchId })
    }

    const windows = await deps.checkIns.listWindows(branchId, userId)
    const capturedAtMs = deps.clock.nowMs()
    const assessment = assessCheckIn({
      at: { lat: body.lat, lng: body.lng },
      fence: { lat: branch.lat, lng: branch.lng, radiusMetres: branch.checkinRadiusM },
      epochMs: capturedAtMs,
      offsetMinutes: deps.clock.offsetMinutes(),
      windows: windows.map((w) => ({
        windowRef: w.id,
        atMinute: w.atMinute,
        toleranceMinutes: w.toleranceMinutes,
      })),
    })

    const record: CheckInRecord = {
      id: deps.ids.uuid(),
      branchId,
      userId,
      businessDate: todayFor(deps),
      capturedAtMs,
      lat: body.lat,
      lng: body.lng,
      accuracyM: body.accuracyM,
      windowId: assessment.windowRef,
      distanceM: assessment.distanceMetres,
      insideArea: assessment.insideArea,
      minutesFromTarget: assessment.minutesFromTarget,
      verdict: assessment.verdict,
      note: body.note,
    }
    const saved = await deps.checkIns.record(record)
    return reply.code(201).send(serializeCheckIn(saved))
  })

  /**
   * The day's roll-call: every expected round, answered or not.
   *
   * Built from the WINDOWS rather than from the check-ins, because the interesting row is the one
   * with no check-in against it — and a report driven by what happened can never show what didn't.
   */
  app.get('/checkins', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranchId(req)
    const { date, userId } = z.object({ date: z.string().optional(), userId: z.string().optional() }).parse(req.query)
    const businessDate = date ?? todayFor(deps)

    // Branch-wide sight makes an auditor; anything narrower makes a subject, who sees himself only.
    // Enforced HERE and not in the screen: hiding another manager's rounds in the client would
    // leave them one request away, and UI hiding is not security.
    const auditor = req.grantedScope === 'all'
    const only = auditor ? null : req.actor!.userId

    const [allCheckIns, users] = await Promise.all([
      deps.checkIns.listByBranchAndDate(branchId, businessDate),
      deps.users.list(branchId),
    ])
    const checkIns = only === null ? allCheckIns : allCheckIns.filter((c) => c.userId === only)
    const named = new Map(users.map((u) => [u.id, u.fullNameAr]))

    // One roll-call per person who has a rota, so the report reads as "who was where" rather than
    // as a flat list of pings.
    const subjects =
      only !== null
        ? [only]
        : userId
          ? [userId]
          : [...new Set((await deps.checkIns.listWindows(branchId)).map((w) => w.userId))]
    const people = await Promise.all(
      subjects.map(async (subject) => {
        const windows = await deps.checkIns.listWindows(branchId, subject)
        const mine = checkIns.filter((c) => c.userId === subject)
        return {
          userId: subject,
          name: named.get(subject) ?? subject.slice(0, 8),
          rounds: rollCall(
            windows.map((w) => ({ windowRef: w.id, atMinute: w.atMinute, toleranceMinutes: w.toleranceMinutes })),
            mine.map((c) => ({
              windowRef: c.windowId,
              insideArea: c.insideArea,
              distanceMetres: c.distanceM,
              minutesFromTarget: c.minutesFromTarget,
            })),
          ),
        }
      }),
    )

    return {
      businessDate,
      // The screen decides what to render from what the server says the caller may see, rather
      // than re-deriving the rule from the session and risking a second, divergent answer.
      scope: auditor ? ('all' as const) : ('own' as const),
      radiusM: (await deps.directory.branch(branchId))?.checkinRadiusM ?? null,
      people,
      checkIns: checkIns.map(serializeCheckIn),
    }
  })
}
