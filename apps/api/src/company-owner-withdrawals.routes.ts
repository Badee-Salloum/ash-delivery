import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { BranchRecord, Deps, FinancialTransactionDeps, JournalEntryRecord, OwnerWithdrawal, OwnerWithdrawalsView } from '@ash/contracts'
import { serializeMoney } from '@ash/contracts'
import { isCalendarDate, minor, parseMinor } from '@ash/domain'
import { ServiceError, todayFor } from './shifts.service.ts'

type ReadDeps = Pick<FinancialTransactionDeps, 'ledger' | 'companyLedger' | 'companyLedgerSource' | 'directory'>
const failure = () => new ServiceError(500, 'owner_withdrawal_integrity_error')
const moneyTotals = (rows: OwnerWithdrawal[]) => {
  const totals = { SYP_NEW: 0n, USD: 0n }
  for (const row of rows) totals[row.currency] += parseMinor(row.amount)
  return { SYP_NEW: serializeMoney(minor(totals.SYP_NEW)), USD: serializeMoney(minor(totals.USD)) }
}

/** Snapshot-bound, unpaginated HQ read plus complete cursor walks for operating branches. */
export async function readOwnerWithdrawals(tx: ReadDeps, company: BranchRecord, today: string): Promise<OwnerWithdrawal[]> {
  const branches = [company, ...(await tx.directory.listBranches()).filter(b => b.kind === 'branch')]
  const commands = await tx.companyLedger.listCommands(company.id)
  const byEntry = new Map(commands.map(c => [c.journalEntryId, c]))
  const rows: OwnerWithdrawal[] = []
  for (const branch of branches) {
    const entries = new Map<number, JournalEntryRecord>()
    const add = (entry: JournalEntryRecord) => {
      if (entry.branchId !== branch.id || entry.businessDate > today) return
      if (entries.has(entry.id)) {
        const prior = entries.get(entry.id)!
        if (JSON.stringify(prior, (_, v) => typeof v === 'bigint' ? String(v) : v) !==
          JSON.stringify(entry, (_, v) => typeof v === 'bigint' ? String(v) : v)) throw failure()
      }
      entries.set(entry.id, entry)
    }
    if (branch.kind === 'company') {
      for (const movement of await tx.companyLedgerSource.listMovements(company.id, { from: '2000-01-01', to: today })) add(movement.entry)
    } else for (const eventType of ['manual', 'correction'] as const) {
      let beforeId: number | undefined
      do {
        const page = await tx.ledger.listTreasuryMovements(branch.id, {
          from: '2000-01-01', to: today, eventType, limit: 500,
          ...(beforeId === undefined ? {} : { beforeId }),
        })
        for (const entry of page.entries) add(entry)
        if (page.nextBeforeId === null) break
        if (beforeId !== undefined && page.nextBeforeId >= beforeId) throw new ServiceError(500, 'owner_withdrawal_cursor_invalid')
        beforeId = page.nextBeforeId
      } while (true)
    }
    const direct = (entry: JournalEntryRecord) => {
      if (entry.shiftId !== null || entry.lines.length !== 2 ||
        entry.eventType !== (branch.kind === 'company' ? 'company_withdrawal' : 'manual')) return null
      const paid = entry.lines.find(l => l.side === 'C' && (branch.kind === 'company'
        ? l.fundCode === `company_cash:${l.currency}` : ['office_cash', 'office_wallet'].includes(l.fundCode)))
      const owner = entry.lines.find(l => l.side === 'D' && l.fundCode === (branch.kind === 'company'
        ? `company_equity:${l.currency}:owner_drawings` : 'cost_center:owner_drawings'))
      if (!paid || !owner || paid.amount <= 0n || paid.amount !== owner.amount || paid.currency !== owner.currency) return null
      const command = byEntry.get(entry.id)
      if (branch.kind === 'company' && command && (command.kind !== 'withdrawal' || command.equityAccount !== 'owner_drawings' ||
        command.currency !== paid.currency || command.amount !== paid.amount || command.branchId !== branch.id)) throw failure()
      return paid
    }
    const signature = (entry: JournalEntryRecord, invert: boolean) => entry.lines.map(l =>
      `${l.fundCode}|${invert ? l.side === 'D' ? 'C' : 'D' : l.side}|${l.currency}|${l.amount}|${l.role ?? ''}`,
    ).sort().join('\n')
    const roots = new Map<number, { originalId: number; sign: bigint } | null>()
    const resolve = (entry: JournalEntryRecord): { originalId: number; sign: bigint } | null => {
      if (roots.has(entry.id)) return roots.get(entry.id)!
      if (direct(entry)) {
        const root = { originalId: entry.id, sign: 1n }; roots.set(entry.id, root); return root
      }
      const command = branch.kind === 'company' ? byEntry.get(entry.id) : undefined
      const target = entry.eventType === 'company_correction' && command?.kind === 'reversal' ? command.targetEntryId
        : entry.eventType === 'correction' ? Number(/^reversal-of-(\d+)$/.exec(entry.occurrenceKey)?.[1] ?? 0) : 0
      const parent = entries.get(target)
      if (!parent || parent.id >= entry.id || entry.shiftId !== null || signature(entry, false) !== signature(parent, true)) {
        roots.set(entry.id, null); return null
      }
      const resolved = resolve(parent)
      const root = resolved ? { originalId: resolved.originalId, sign: -resolved.sign } : null
      roots.set(entry.id, root); return root
    }
    const net = new Map<number, { multiplier: bigint; ids: number[] }>()
    for (const entry of entries.values()) {
      const root = resolve(entry)
      if (!root) continue
      const held = net.get(root.originalId) ?? { multiplier: 0n, ids: [] }
      held.multiplier += root.sign; held.ids.push(entry.id); net.set(root.originalId, held)
    }
    for (const [id, held] of net) {
      if (held.multiplier === 0n) continue
      if (held.multiplier !== 1n) throw failure()
      const entry = entries.get(id)!, paid = direct(entry)!, command = branch.kind === 'company' ? byEntry.get(id) : undefined
      const occurredOn = command?.occurredOn ?? entry.businessDate
      if (occurredOn > today) continue
      const ids = held.ids.sort((a, b) => a - b)
      rows.push({
        id: `owner-withdrawal:${branch.id}:${id}`, journalEntryId: id, journalEntryIds: ids,
        branchId: branch.id, branchNameAr: branch.nameAr, branchNameEn: branch.nameEn,
        source: branch.kind === 'company' ? 'company' : paid.fundCode === 'office_cash' ? 'branch_cash' : 'branch_wallet',
        currency: paid.currency, amount: serializeMoney(paid.amount), originalAmount: serializeMoney(paid.amount),
        occurredOn, postingDate: entry.postingDate, recordedAt: new Date(entry.createdAtMs).toISOString(),
        occurrenceSource: command ? 'recorded' : 'business_date', description: entry.reason ?? '',
        reference: entry.externalReference ?? command?.id ?? null, sypMinorPerUsd: entry.sypMinorPerUsd?.toString() ?? null,
        status: ids.length > 1 ? 'corrected' : 'active',
        entries: ids.map(key => { const original = entries.get(key)!; return {
          id: key, eventType: original.eventType, businessDate: original.businessDate, postingDate: original.postingDate,
          reason: original.reason, lines: original.lines.map(l => ({ fundCode: l.fundCode, side: l.side, currency: l.currency, amount: serializeMoney(l.amount) })),
        } }),
      })
    }
  }
  return rows.sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.recordedAt.localeCompare(a.recordedAt) || b.journalEntryId - a.journalEntryId || a.id.localeCompare(b.id))
}

export function registerCompanyOwnerWithdrawalRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/company/owner-withdrawals', { config: { permission: 'company_fund.manage' } }, async req => {
    const q = z.object({ from: z.string().refine(isCalendarDate).optional(), to: z.string().refine(isCalendarDate).optional() }).parse(req.query)
    const today = todayFor(deps), from = q.from ?? '2000-01-01', to = q.to ?? today
    if (from < '2000-01-01' || from > to || to > today) throw new ServiceError(422, 'invalid_date_range')
    const company = await deps.directory.companyBranch()
    if (!company) throw new ServiceError(500, 'company_branch_missing')
    return deps.financialUnitOfWork.run({ mode: 'read_snapshot', lockKey: `receivables:${company.id}`, actorId: req.actor!.userId, requestId: req.requestId }, async tx => {
      const all = await readOwnerWithdrawals(tx, company, today)
      const withdrawals = all.filter(row => row.occurredOn >= from && row.occurredOn <= to)
      const response: OwnerWithdrawalsView = { from, to, asOf: today, basis: 'current_verified_original_withdrawals', totals: moneyTotals(all), periodTotals: moneyTotals(withdrawals), withdrawals }
      return response
    })
  })
}
