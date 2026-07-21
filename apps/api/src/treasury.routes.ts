import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { CashCountLine, CashCountRecord, Deps } from '@ash/contracts'
import { createCashCountRequest, manualEntryRequest, serializeMoney } from '@ash/contracts'
import { type Posting, assertBalanced, fundRefFromCode, minor, reverse, weekStartFor } from '@ash/domain'
import { ServiceError, ensureFxDay, todayFor } from './shifts.service.ts'

/**
 * Treasury: the daily cash count (E-5 / س51) and disciplined manual entries (E-3 / س50).
 *
 * Both are branch manager + GM per the §3 matrix and decision D-5 — explicitly NOT the system
 * admin, who owns rules and periods rather than money.
 */
export function registerTreasuryRoutes(app: FastifyInstance, deps: Deps): void {
  const targetBranch = (req: { actor?: { branchId: string | null }; body?: unknown }) => {
    const parsed = z.object({ branchId: z.string().optional() }).safeParse(req.body ?? {})
    const fromBody = parsed.success ? parsed.data.branchId : undefined
    return { branchId: fromBody ?? req.actor?.branchId ?? null }
  }
  const ownBranch = (req: { actor?: { branchId: string | null } }) => ({ branchId: req.actor?.branchId ?? null })
  const resolveBranch = (req: { actor?: { branchId: string | null }; body?: unknown }): string => {
    const branchId = targetBranch(req).branchId
    if (!branchId) throw new ServiceError(422, 'branch_required')
    return branchId
  }

  /** The funds a physical count covers. Driver funds are counted through the shift close. */
  const COUNTABLE_FUNDS = ['office_cash', 'office_wallet'] as const

  // ── The daily count (E-5) ───────────────────────────────────────────────────────────────

  /** What the system believes each fund holds right now — the sheet a manager counts against. */
  app.get('/cash-counts/sheet', { config: { permission: 'cash_count.perform', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const businessDate = todayFor(deps)
    const existing = await deps.cashCounts.find(branchId, businessDate)

    const funds = await Promise.all(
      COUNTABLE_FUNDS.map(async (fundCode) => ({
        fundCode,
        computed: serializeMoney(await deps.ledger.fundBalance(branchId, fundCode)),
      })),
    )
    return { businessDate, alreadyCounted: existing !== null, funds }
  })

  app.post('/cash-counts', { config: { permission: 'cash_count.perform', subject: targetBranch } }, async (req, reply) => {
    const body = createCashCountRequest.parse(req.body)
    const branchId = resolveBranch(req)
    const businessDate = body.businessDate ?? todayFor(deps)

    const lines: CashCountLine[] = []
    for (const line of body.lines) {
      if (!(COUNTABLE_FUNDS as readonly string[]).includes(line.fundCode)) {
        throw new ServiceError(422, 'fund_not_countable', { fundCode: line.fundCode })
      }
      // The computed side is FROZEN here, not recomputed at read time. Otherwise a later
      // posting silently rewrites history and the variance the manager signed off disappears.
      const computed = await deps.ledger.fundBalance(branchId, line.fundCode)
      lines.push({
        fundCode: line.fundCode,
        counted: line.counted,
        computed,
        variance: minor(line.counted - computed),
        resolution: line.resolution,
      })
    }

    const record: CashCountRecord = {
      id: deps.ids.uuid(),
      branchId,
      businessDate,
      countedBy: req.actor!.userId,
      countedAtMs: deps.clock.nowMs(),
      lines,
      proofSha256: null,
      sealedAtMs: null,
      notes: body.notes,
    }
    // «إثبات الجرد» — a sha256 over the frozen lines, so the count cannot be quietly restated.
    record.proofSha256 = sealProof(record)
    record.sealedAtMs = record.countedAtMs

    try {
      await deps.cashCounts.create(record)
    } catch (err) {
      if ((err as { code?: string }).code === 'DUPLICATE_COUNT') {
        throw new ServiceError(409, 'already_counted_today', { businessDate })
      }
      throw err
    }

    await deps.audit.append({
      tableName: 'cash_counts',
      recordId: record.id,
      action: 'INSERT',
      actorId: req.actor!.userId,
      actorKind: 'user',
      branchId,
      requestId: req.requestId,
      before: null,
      after: serializeCount(record),
      occurredAtMs: deps.clock.nowMs(),
    })

    return reply.code(201).send(serializeCount(record))
  })

  app.get('/cash-counts/:date', { config: { permission: 'cash_count.perform', subject: ownBranch } }, async (req) => {
    const { date } = z.object({ date: z.string() }).parse(req.params)
    const branchId = resolveBranch(req)
    const found = await deps.cashCounts.find(branchId, date)
    if (!found) throw new ServiceError(404, 'cash_count_not_found')
    return serializeCount(found)
  })

  // ── Manual entries and corrections (E-3 / س50) ──────────────────────────────────────────

  app.post('/journal/manual', { config: { permission: 'journal.manual.write', subject: targetBranch } }, async (req, reply) => {
    const body = manualEntryRequest.parse(req.body)
    const branchId = resolveBranch(req)

    // A manual entry without a stated reason is not auditable. The schema requires it and the
    // database CHECK requires it too — this is the third layer, and the one with a clear error.
    if (body.reason.trim().length === 0) throw new ServiceError(422, 'reason_required')

    const ceiling = await deps.settings.receiptRequiredAbove(branchId)
    const total = body.lines
      .filter((l) => l.side === 'D')
      .reduce((acc, l) => acc + l.amount, 0n)
    if (ceiling !== null && total > ceiling && body.evidenceMediaId === null) {
      throw new ServiceError(422, 'evidence_required', {
        amount: serializeMoney(minor(total)),
        ceiling: serializeMoney(ceiling),
      })
    }

    const posting: Posting = assertBalanced({
      eventType: 'manual',
      occurrenceKey: deps.ids.uuid(),
      // fundRefFromCode, NOT a blanket cost-centre wrap: naming `office_cash` must move the
      // office cash fund, not a look-alike called `cost_center:office_cash`.
      lines: body.lines.map((l) => ({
        fund: fundRefFromCode(l.fundCode),
        side: l.side,
        amount: l.amount,
      })),
    })

    const businessDate = body.businessDate ?? todayFor(deps)
    const fxDayId = await ensureFxDay(deps, businessDate)
    const [entry] = await deps.ledger.post(branchId, [posting], {
      shiftId: null,
      businessDate,
      postingDate: todayFor(deps),
      weekStartDate: weekStartFor(businessDate),
      fxDayId,
      createdBy: req.actor!.userId,
      reason: body.reason,
    })

    return reply.code(201).send({ entryId: entry?.id ?? null, businessDate, reason: body.reason })
  })

  /**
   * Correct a posted entry (BR7).
   *
   * A locked week is NEVER edited — the database refuses it twice over. A correction is a
   * visible, dated reversal plus whatever replaces it, which is exactly what SRS E-6 means by
   * «أي تصحيح لاحق بقيد ظاهر مؤرَّخ».
   */
  app.post(
    '/journal/:entryId/reverse',
    { config: { permission: 'journal.manual.write', subject: ownBranch } },
    async (req, reply) => {
      const { entryId } = z.object({ entryId: z.coerce.number().int() }).parse(req.params)
      const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body)
      const branchId = resolveBranch(req)

      const original = await findEntry(deps, branchId, entryId)
      if (!original) throw new ServiceError(404, 'entry_not_found')

      const posting = reverse(
        {
          eventType: original.eventType,
          occurrenceKey: original.occurrenceKey,
          lines: original.lines.map((l) => ({
            fund: fundRefFromCode(l.fundCode),
            side: l.side,
            amount: l.amount,
          })),
        },
        `reversal-of-${entryId}`,
      )

      // The correction posts on TODAY's date while keeping the original business date, so the
      // day it belongs to and the day it was fixed are both visible.
      const postingDate = todayFor(deps)
      const fxDayId = await ensureFxDay(deps, original.businessDate)
      const [entry] = await deps.ledger.post(branchId, [posting], {
        shiftId: null,
        businessDate: original.businessDate,
        postingDate,
        weekStartDate: original.weekStartDate,
        fxDayId,
        createdBy: req.actor!.userId,
        reason,
      })

      return reply.code(201).send({ reversalEntryId: entry?.id ?? null, reversalOf: entryId, postingDate })
    },
  )
}

async function findEntry(deps: Deps, branchId: string, entryId: number) {
  // Entries are addressed by week; scanning the shift index would miss standalone entries.
  const starts = await deps.weekLocks.listClosedStarts(branchId)
  const candidates = new Set<string>([...starts, weekStartFor(todayFor(deps))])
  for (const start of candidates) {
    const entries = await deps.ledger.listByWeek(branchId, start)
    const found = entries.find((e) => e.id === entryId)
    if (found) return found
  }
  return null
}

function sealProof(record: CashCountRecord): string {
  const canonical = record.lines
    .map((l) => `${l.fundCode}|${l.counted}|${l.computed}|${l.variance}`)
    .sort()
    .join(';')
  return createHash('sha256')
    .update(`${record.branchId}|${record.businessDate}|${record.countedBy}|${canonical}`)
    .digest('hex')
}

function serializeCount(record: CashCountRecord) {
  return {
    id: record.id,
    businessDate: record.businessDate,
    countedBy: record.countedBy,
    countedAt: new Date(record.countedAtMs).toISOString(),
    proofSha256: record.proofSha256,
    notes: record.notes,
    lines: record.lines.map((l) => ({
      fundCode: l.fundCode,
      counted: serializeMoney(l.counted),
      computed: serializeMoney(l.computed),
      variance: serializeMoney(l.variance),
      resolution: l.resolution,
    })),
    /** Any non-zero variance is what the manager must explain before the Sunday close. */
    balanced: record.lines.every((l) => l.variance === 0n),
  }
}
