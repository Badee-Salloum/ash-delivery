import { formatMinor, minor, parseMinor, type Currency } from '@ash/domain'
import type { CompanyReportRow } from './company-report.ts'

export type TransferLeg = { id: string; date: string; direction: 'to_company' | 'from_company'; currency: Currency; amount: string; description: string }
export type RestorationFeed = {
  proposals: Array<{ id: string; branchId: string; businessDate: string; status: string; version: number;
    legs: Array<{ sourceEntryId: number; amount: string; direction: string; sourceBusinessDate?: string }>; revisions?: Array<{ kind: string }> }>
  unlinkedHistorical?: Array<{ restorationId: number; branchId: string; businessDate: string; netToCompany: string }>
  linkedHistorical?: Array<{ restorationId: number; branchId: string; journalEntryId: number; occurredOn: string; amount: string | null; currency: Currency }>
  historicalGroups?: Array<{ restorationId: number; branchId: string; businessDate: string; variance: string;
    branchSourceEntries: Array<{ sourceEntryId: number; direction: 'to_company' | 'from_company'; amount: string }> }>
  legacy?: Array<{ restorationId: number; branchId: string; sourceEntryId: number; journalEntryId: number; direction: 'to_company' | 'from_company'; amount: string }>
}
export type TransferGroup = { id: string; branchId: string; branchDate: string | null; proposalId?: string;
  confirmedOn?: string | undefined;
  status: 'pending' | 'deferred' | 'unlinked' | 'confirmed' | 'matched' | 'variance' | 'corrected';
  company: TransferLeg[]; branch: TransferLeg[] | null; variance: string | null }

export function reportCashLegs(row: CompanyReportRow): TransferLeg[] {
  return row.lines.filter(line => line.fundCode === `company_cash:${line.currency}` && parseMinor(line.netAmount) !== 0n)
    .map((line, index) => ({ id: `${row.id}:${index}`, date: row.occurredOn,
      direction: line.side === 'D' ? 'to_company' : 'from_company', currency: line.currency,
      amount: line.netAmount, description: row.description }))
}
export function signedTransfer(legs: TransferLeg[], currency: Currency): string {
  return formatMinor(minor(legs.filter(leg => leg.currency === currency).reduce((sum, leg) =>
    sum + parseMinor(leg.amount) * (leg.direction === 'to_company' ? 1n : -1n), 0n)))
}

/** Only persisted links group events. Non-cash reclassifications and owner funding never enter this register. */
export function companyTransferRegister(rows: CompanyReportRow[], feed: RestorationFeed): TransferGroup[] {
  const candidates = rows.filter(row => row.branchId && row.source !== 'owner_outside' &&
    (reportCashLegs(row).length || row.kind === 'company_restoration_mirror' && row.netAmount === '0.00'))
  const consumed = new Set<string>(), groups: TransferGroup[] = []
  const take = (matching: CompanyReportRow[]) => {
    for (const row of matching) consumed.add(row.id)
    return matching.flatMap(reportCashLegs)
  }
  for (const proposal of feed.proposals) {
    const matching = candidates.filter(row => row.canonicalCommandId === proposal.id && row.kind === 'company_restoration_mirror')
    const company = take(matching), branch: TransferLeg[] = proposal.legs.map(leg => ({ id: String(leg.sourceEntryId),
      date: leg.sourceBusinessDate ?? proposal.businessDate, direction: leg.direction === 'to_company' ? 'to_company' : 'from_company',
      currency: 'SYP_NEW', amount: leg.amount, description: '' }))
    const confirmed = proposal.status === 'confirmed'
    const variance = confirmed ? formatMinor(minor(parseMinor(signedTransfer(branch, 'SYP_NEW')) - parseMinor(signedTransfer(company, 'SYP_NEW')))) : null
    groups.push({ id: `proposal:${proposal.id}`, branchId: proposal.branchId, branchDate: proposal.businessDate, proposalId: proposal.id,
      confirmedOn: confirmed ? matching[0]?.occurredOn : undefined,
      status: !confirmed ? proposal.status === 'deferred' ? 'deferred' : 'pending' : parseMinor(variance!) !== 0n ? 'variance' :
        proposal.revisions?.some(revision => revision.kind === 'correct') ? 'corrected' : 'matched', company, branch, variance })
  }
  const historical = new Map<string, NonNullable<RestorationFeed['linkedHistorical']>>()
  for (const link of feed.linkedHistorical ?? []) {
    const key = `${link.branchId}:${link.restorationId}`
    historical.set(key, [...historical.get(key) ?? [], link])
  }
  for (const [key, links] of historical) {
    const first = links[0]!, evidence = feed.historicalGroups?.find(group => `${group.branchId}:${group.restorationId}` === key)
    const entryIds = new Set(links.map(link => link.journalEntryId))
    const company = take(candidates.filter(row => row.activeEntryId !== null && entryIds.has(row.activeEntryId) && !consumed.has(row.id)))
    const branch: TransferLeg[] | null = evidence ? evidence.branchSourceEntries.map(leg => ({ id: String(leg.sourceEntryId),
      date: evidence.businessDate, currency: 'SYP_NEW', direction: leg.direction, amount: leg.amount, description: '' })) : null
    groups.push({ id: `historical:${key}`, branchId: first.branchId, branchDate: evidence?.businessDate ?? null,
      status: evidence ? parseMinor(evidence.variance) === 0n ? 'matched' : 'variance' : 'confirmed',
      company, branch, variance: evidence?.variance ?? null })
  }
  for (const row of candidates.filter(row => !consumed.has(row.id))) {
    const mirror = feed.legacy?.find(item => item.journalEntryId === row.activeEntryId)
    const key = mirror ? `legacy:${mirror.branchId}:${mirror.restorationId}` : row.id
    const existing = groups.find(group => group.id === key), company = reportCashLegs(row)
    if (existing) existing.company.push(...company)
    else groups.push({ id: key, branchId: row.branchId!, branchDate: mirror ? row.occurredOn : null,
      status: row.version > 1 ? 'corrected' : 'confirmed', company, branch: null, variance: null })
  }
  for (const run of feed.unlinkedHistorical ?? []) groups.push({ id: `unlinked:${run.branchId}:${run.restorationId}`,
    branchId: run.branchId, branchDate: run.businessDate, status: 'unlinked', company: [], variance: null,
    // Net-only evidence must not pretend to describe the run's gross cash/wallet legs.
    branch: null })
  return groups.sort((a, b) => (b.company.at(-1)?.date ?? b.branchDate ?? '').localeCompare(a.company.at(-1)?.date ?? a.branchDate ?? ''))
}

export function transferPeriodTotals(groups: TransferGroup[], from: string, to: string, branchId = '') {
  const values = { SYP_NEW: { receipts: 0n, payments: 0n }, USD: { receipts: 0n, payments: 0n } }
  for (const group of groups) if ((!branchId || group.branchId === branchId) && !['pending', 'deferred', 'unlinked'].includes(group.status)) {
    for (const leg of group.company) if (leg.date >= from && leg.date <= to) values[leg.currency][leg.direction === 'to_company' ? 'receipts' : 'payments'] += parseMinor(leg.amount)
  }
  return Object.fromEntries((['SYP_NEW', 'USD'] as const).map(currency => [currency, {
    receipts: formatMinor(minor(values[currency].receipts)), payments: formatMinor(minor(values[currency].payments)),
    net: formatMinor(minor(values[currency].receipts - values[currency].payments)),
  }])) as Record<Currency, { receipts: string; payments: string; net: string }>
}
