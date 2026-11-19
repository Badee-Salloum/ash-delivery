import type { LedgerRepo } from '@ash/contracts'
import { fundCode, type CalendarDate, type Posting } from '@ash/domain'
import { ServiceError } from './shifts.service.ts'

/** Old spending cannot borrow from a custody handover that happened later. */
export async function assertCustodyChronology(ledger: LedgerRepo, branchId: string, posting: Posting,
  financialDate: CalendarDate, today: CalendarDate): Promise<void> {
  const deltas = new Map<string, bigint>()
  for (const line of posting.lines) if (line.fund.kind === 'company_custody') {
    const code = fundCode(line.fund)
    deltas.set(code, (deltas.get(code) ?? 0n) + (line.side === 'D' ? line.amount : -line.amount))
  }
  for (const [code, delta] of deltas) {
    if (delta >= 0n) continue
    if (financialDate === today) {
      if (await ledger.fundBalance(branchId, code) + delta < 0n) throw new ServiceError(422, 'company_custody_insufficient')
      continue
    }
    const entries = (await ledger.listByRange(branchId, '2000-01-01', today))
      .sort((a,b) => a.businessDate.localeCompare(b.businessDate) || a.id-b.id)
    let balance = 0n, applied = false
    for (const entry of entries) {
      // New entry is after the existing entries on its day, before entries of a later day.
      if (!applied && entry.businessDate > financialDate) {
        balance += delta; applied = true
        if (balance < 0n) throw new ServiceError(422, 'company_custody_historical_insufficient', { financialDate })
      }
      for (const line of entry.lines) if (line.fundCode === code) balance += line.side === 'D' ? line.amount : -line.amount
      if (applied && balance < 0n) throw new ServiceError(422, 'company_custody_historical_insufficient', { financialDate: entry.businessDate })
    }
    if (!applied && balance+delta < 0n) throw new ServiceError(422, 'company_custody_historical_insufficient', { financialDate })
  }
}
