import type { CompanyHistoricalImportReceiptRecord, CompanyHistoricalSourceCorrection, CompanyHistoricalSourceValues } from '@ash/contracts'
import { serializeMoney } from '@ash/contracts'
import { minor, parseMinor } from '@ash/domain'

export function sourceValues(receipt: CompanyHistoricalImportReceiptRecord): CompanyHistoricalSourceValues {
  return { currency: receipt.currency, amount: receipt.amount === null ? null : serializeMoney(receipt.amount),
    occurredOn: receipt.occurredOn, description: receipt.description, excluded: false,
    sypMinorPerUsd: receipt.sypMinorPerUsd?.toString() ?? null, rateBasis: receipt.rateBasis }
}

/** One original source identity, one current administrative value; originals remain evidence. */
export function effectiveHistoricalSource(receipt: CompanyHistoricalImportReceiptRecord,
  revisions: readonly CompanyHistoricalSourceCorrection[]) {
  const history = revisions.filter(row=>row.sourceReference===receipt.sourceReference).sort((a,b)=>a.version-b.version)
  const latest = history.at(-1)
  const values = latest?.values ?? sourceValues(receipt)
  return { ...receipt, ...values, amount: values.amount === null ? null : minor(parseMinor(values.amount)),
    sypMinorPerUsd: values.sypMinorPerUsd === null ? null : BigInt(values.sypMinorPerUsd),
    version: latest?.version ?? 1, excluded: values.excluded, correctionIds: history.map(row=>row.id),
    originalValues: sourceValues(receipt) }
}

export function historicalSourceCapabilities(receipt: CompanyHistoricalImportReceiptRecord) {
  const unposted = receipt.journalEntryId===null && receipt.branchJournalEntryId===null
  return { editableFields: ['occurredOn','description', ...(unposted && receipt.currency!==null ?
    ['currency','amount','excluded','sypMinorPerUsd','rateBasis'] : [])],
    financialCorrectionSupported: unposted,
    blockingReason: unposted ? null : 'cash_backed_source_requires_dedicated_financial_correction' }
}
