import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps } from '@ash/contracts'
import { publishTierRequest, serializeMoney, simulateTierRequest } from '@ash/contracts'
import {
  type ShiftOrder,
  type TierRule,
  DEFAULT_BANDS,
  addDays,
  minor,
  splitDay,
  validateBands,
  TierRuleError,
} from '@ash/domain'
import { ServiceError, todayFor } from './shifts.service.ts'
import { type StoredRule, asDomainRule, ruleInForceOn } from './tier-rule.ts'

/**
 * The tier engine's admin surface (SRS F-3…F-6).
 *
 * Editing is **system admin only** — not even the General Manager (س46, BR8, open point م-5).
 * The engine itself lives in the domain and is already used at approval time; this is the
 * screen that changes it, and the simulation that must be run before anyone does.
 */
export function registerTierRoutes(app: FastifyInstance, deps: Deps): void {
  /** Everyone who can see branch data can READ the table — a driver's share depends on it. */
  app.get('/tier-rules', { config: { permission: 'branch_data.view', subject: () => ({}) } }, async () => {
    const rows = await deps.tiers.list()
    return {
      rules: rows.map((r) => ({ ...r, isDefault: false })),
      /** Shown when nothing is published yet: the client's F-1 table is the seeded fallback. */
      fallback: { bands: DEFAULT_BANDS, basis: 'orders', mode: 'whole' },
    }
  })

  /**
   * Publish a new version (F-3).
   *
   * Dated, never destructive: the incumbent becomes `superseded` so every past day still
   * resolves to the rate that actually applied to it. Deleting it would silently restate
   * history the first time anyone edited the table.
   */
  app.post('/tier-rules', { config: { permission: 'tier_rule.write' } }, async (req, reply) => {
    const body = publishTierRequest.parse(req.body)

    try {
      validateBands(body.bands)
    } catch (err) {
      // Caught at publish time, never at 23:00 on a Saturday when a shift will not close.
      if (err instanceof TierRuleError) throw new ServiceError(422, 'invalid_band_table', { message: err.message })
      throw err
    }

    // Effective dates are forward-only. Back-dating would restate days that are already posted
    // and possibly already inside a sealed week.
    const today = todayFor(deps)
    if (body.effectiveFrom <= today) {
      throw new ServiceError(422, 'effective_from_must_be_future', {
        effectiveFrom: body.effectiveFrom,
        earliest: addDays(today, 1),
      })
    }

    const published = await deps.tiers.publish({
      basis: body.basis,
      mode: body.mode,
      vehicleTypeId: body.vehicleTypeId,
      bands: body.bands,
      effectiveFrom: body.effectiveFrom,
      createdBy: req.actor!.userId,
    })

    await deps.audit.append({
      tableName: 'tier_rules',
      recordId: String(published.id),
      action: 'INSERT',
      actorId: req.actor!.userId,
      actorKind: 'user',
      branchId: null,
      requestId: req.requestId,
      before: null,
      after: published,
      occurredAtMs: deps.clock.nowMs(),
    })

    return reply.code(201).send(published)
  })

  app.post('/tier-rules/:id/withdraw', { config: { permission: 'tier_rule.write' } }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params)
    await deps.tiers.withdraw(id, req.actor!.userId)
    return { id, status: 'withdrawn' }
  })

  /**
   * «ماذا لو» — replay a candidate table over past approved shifts (F-5).
   *
   * Reads only. Nothing is written to the ledger, which is the entire point: the sysadmin must
   * be able to see what a change would cost before it costs it.
   */
  app.post('/tier-rules/simulate', { config: { permission: 'tier_rule.write' } }, async (req) => {
    const body = simulateTierRequest.parse(req.body)
    validateBands(body.bands)

    const branchId = body.branchId ?? req.actor!.branchId
    if (!branchId) throw new ServiceError(422, 'branch_required')

    const stored: StoredRule[] = (await deps.tiers.list()).map(asDomainRule)
    const candidate: TierRule = {
      basis: body.basis,
      mode: body.mode,
      vehicleTypeId: null,
      bands: body.bands,
      effectiveFrom: body.from,
    }

    const perDriver = new Map<string, { current: bigint; candidate: bigint; orders: number }>()

    for (let date = body.from; date <= body.to; date = addDays(date, 1)) {
      const shifts = await deps.shifts.listByBranchAndDate(branchId, date)
      const approved = shifts.filter((s) => s.state === 'approved' || s.state === 'week_locked')

      // The tier basis is the DAY, so orders are gathered per driver across all his shifts.
      const byDriver = new Map<string, ShiftOrder[]>()
      for (const shift of approved) {
        const orders = await deps.orders.listByShift(shift.id)
        const list = byDriver.get(shift.driverId) ?? []
        list.push(...orders.map((o) => ({ orderNo: o.providerOrderNo, payMode: o.payMode, fee: o.fee })))
        byDriver.set(shift.driverId, list)
      }

      // The rule that ACTUALLY applied on that day. `resolveRule` filters on
      // status IN ('active','superseded'), so a rule since replaced still governs its own past.
      const ruleForDate = ruleInForceOn(stored, date)

      for (const [driverId, orders] of byDriver) {
        if (orders.length === 0) continue
        const fees = orders.map((o) => o.fee)

        const now = splitDay(fees, ruleForDate)
        const then = splitDay(fees, candidate)

        const acc = perDriver.get(driverId) ?? { current: 0n, candidate: 0n, orders: 0 }
        acc.current += now.driverShare
        acc.candidate += then.driverShare
        acc.orders += orders.length
        perDriver.set(driverId, acc)
      }
    }

    const drivers = [...perDriver.entries()].map(([driverId, v]) => ({
      driverId,
      orders: v.orders,
      currentDriverShare: serializeMoney(minor(v.current)),
      candidateDriverShare: serializeMoney(minor(v.candidate)),
      /** Positive means the driver earns more; the company absorbs it (BR4). */
      driverDelta: serializeMoney(minor(v.candidate - v.current)),
    }))

    const totalDelta = [...perDriver.values()].reduce((acc, v) => acc + (v.candidate - v.current), 0n)

    return {
      from: body.from,
      to: body.to,
      drivers,
      /** The company's side moves by exactly the opposite amount — Yallago's 20% never moves. */
      driverTotalDelta: serializeMoney(minor(totalDelta)),
      companyTotalDelta: serializeMoney(minor(-totalDelta)),
    }
  })
}
