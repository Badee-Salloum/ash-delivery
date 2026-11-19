import type { FastifyInstance } from 'fastify'
import { assertCustodyChronology } from './company-custody-balance.service.ts'
import { z } from 'zod'
import type { Deps, JournalEntryRecord } from '@ash/contracts'
import { moneySchema, serializeMoney } from '@ash/contracts'
import { fundCode, hasVisibleText, isCalendarDate, resolveFxDay, weekStartFor, type Posting } from '@ash/domain'
import { ServiceError, assertWeekOpen, ensureFxDay, todayFor } from './shifts.service.ts'

const permission = { config: { permission: 'company_fund.manage' as const } }
export function registerCompanyCustodyRoutes(app: FastifyInstance, deps: Deps): void {
  const company = async () => {
    const row = await deps.directory.companyBranch()
    if (!row) throw new ServiceError(500, 'company_branch_missing')
    return row
  }
  const balances = async (ledger: Deps['ledger'], branchId: string) => Object.fromEntries(await Promise.all(
    (['SYP_NEW', 'USD'] as const).map(async currency => [currency, serializeMoney(await ledger.fundBalance(branchId, `company_custody:${currency}`))])))
  const wire = (entry: JournalEntryRecord) => {
    const line = entry.lines.find(l => l.fundCode.startsWith('company_custody:'))!
    return { id: entry.occurrenceKey.slice(8), journalEntryId: entry.id, occurredOn: entry.businessDate,
      direction: line.side === 'D' ? 'to_custody' : 'to_company', currency: line.currency,
      amount: serializeMoney(line.amount), reason: entry.reason, createdBy: entry.createdBy,
      createdAtMs: entry.createdAtMs, sypMinorPerUsd: entry.sypMinorPerUsd?.toString() ?? null }
  }
  app.get('/company/custody', permission, async req => {
    const hq = await company()
    return deps.financialUnitOfWork.run({ mode: 'read_snapshot', lockKey: `receivables:${hq.id}`, actorId: req.actor!.userId, requestId: req.requestId }, async tx => ({
      balances: await balances(tx.ledger, hq.id),
      transfers: (await tx.ledger.listByRange(hq.id, '2000-01-01', todayFor(deps)))
        .filter(e => e.eventType === 'company_custody_transfer').map(wire).sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.journalEntryId - a.journalEntryId),
    }))
  })
  app.post('/company/custody/transfers', permission, async (req, reply) => {
    const body = z.object({ idempotencyKey: z.string().uuid().transform(s => s.toLowerCase()),
      direction: z.enum(['to_custody', 'to_company']), currency: z.enum(['SYP_NEW', 'USD']),
      amount: moneySchema.refine(n => n > 0n), occurredOn: z.string().refine(isCalendarDate),
      historicalRate: moneySchema.refine(n => n > 0n).optional(),
      reason: z.string().trim().min(1).max(500).refine(hasVisibleText) }).strict().parse(req.body)
    const hq = await company(), today = todayFor(deps), actor = req.actor!.userId
    if (body.occurredOn < '2000-01-01' || body.occurredOn > today) throw new ServiceError(422, 'invalid_occurrence_date')
    const posting: Posting = { eventType: 'company_custody_transfer', occurrenceKey: `custody:${body.idempotencyKey}`, lines: [
      { fund: { kind: 'company_custody', currency: body.currency }, side: body.direction === 'to_custody' ? 'D' : 'C', amount: body.amount, role: 'custody_transfer' },
      { fund: { kind: 'company_cash', currency: body.currency }, side: body.direction === 'to_custody' ? 'C' : 'D', amount: body.amount, role: 'custody_transfer' },
    ] }
    const result = await deps.financialUnitOfWork.run({ lockKey: `receivables:${hq.id}`, actorId: actor, requestId: req.requestId }, async tx => {
      if (await tx.companyLedger.findCommand(body.idempotencyKey)) throw new ServiceError(409, 'idempotency_key_conflict')
      const prior = await tx.ledger.findStandaloneEntry(hq.id, posting.eventType, posting.occurrenceKey)
      if (prior) {
        if (prior.createdBy !== actor || prior.reason !== body.reason || prior.businessDate !== body.occurredOn ||
          (body.historicalRate !== undefined && prior.sypMinorPerUsd !== body.historicalRate) ||
          prior.lines.length !== posting.lines.length || !posting.lines.every(l => prior.lines.some(p =>
            p.fundCode === fundCode(l.fund) && p.side === l.side && p.amount === l.amount && p.role === l.role))) {
          throw new ServiceError(409, 'idempotency_key_conflict')
        }
        return { transfer: wire(prior), balances: await balances(tx.ledger, hq.id), replayed: true }
      }
      if (body.occurredOn === today) await assertWeekOpen(deps, hq.id, today)
      if (body.currency === 'USD' && body.occurredOn < today && !body.historicalRate) throw new ServiceError(422, 'historical_rate_required')
      await assertCustodyChronology(tx.ledger, hq.id, posting, body.occurredOn, today)
      if (body.direction === 'to_company' && await tx.ledger.fundBalance(hq.id, `company_custody:${body.currency}`) < body.amount) {
        throw new ServiceError(422, 'company_custody_insufficient')
      }
      const fxDayId = await ensureFxDay(deps, today)
      const rate = body.currency === 'USD' ? body.historicalRate ?? resolveFxDay(await deps.fx.list(), today).sypMinorPerUsd : null
      const [entry] = await tx.ledger.post(hq.id, [posting], { shiftId: null,
        businessDate: body.occurredOn, postingDate: body.occurredOn, weekStartDate: weekStartFor(body.occurredOn),
        fxDayId, sypMinorPerUsd: rate, createdBy: actor, reason: body.reason,
        ...(body.occurredOn < today ? { priorPeriodReason: body.reason } : {}),
      })
      if (!entry) throw new ServiceError(409, 'idempotency_key_conflict')
      return { transfer: wire(entry), balances: await balances(tx.ledger, hq.id), replayed: false }
    })
    return reply.code(result.replayed ? 200 : 201).send(result)
  })
}
