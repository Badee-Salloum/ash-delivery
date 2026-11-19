import type { LedgerRepo } from '@ash/contracts'
import { minor, type CalendarDate, type Currency, type Minor } from '@ash/domain'

/** A schedule or reserve transfer is not posted depreciation. Only the asset's GL balance counts. */
export async function assetLedgerBookValue(ledger: LedgerRepo, branchId: string, assetId: string,
  currency: Currency, asOf: CalendarDate, today: CalendarDate): Promise<Minor> {
  const code=`fixed_asset:${currency}:${assetId}`
  if(asOf===today) return ledger.fundBalance(branchId,code)
  const entries=await ledger.listByRange(branchId,'2000-01-01',asOf)
  return minor(entries.reduce((sum,entry)=>sum+entry.lines.filter(line=>line.fundCode===code)
    .reduce((value,line)=>value+(line.side==='D'?line.amount:-line.amount),0n),0n))
}
