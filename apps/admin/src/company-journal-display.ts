import { formatMinor, minor, parseMinor, type Currency } from '@ash/domain'

export interface CompanyJournalDisplayLine {
  fundCode: string
  side: 'D' | 'C'
  amount: string
}

/** Cash impact of a raw HQ journal, not an invented company command or expense. */
export function companyJournalCash(lines: readonly CompanyJournalDisplayLine[] = []): Array<{ currency: Currency; amount: string }> {
  const totals = new Map<Currency, bigint>()
  for (const line of lines) {
    const currency = line.fundCode === 'company_cash:SYP_NEW' ? 'SYP_NEW' : line.fundCode === 'company_cash:USD' ? 'USD' : null
    if (!currency) continue
    const value = parseMinor(line.amount)
    totals.set(currency, (totals.get(currency) ?? 0n) + (line.side === 'D' ? value : -value))
  }
  return (['SYP_NEW', 'USD'] as const).flatMap(currency => {
    const value = totals.get(currency)
    return value === undefined ? [] : [{ currency, amount: formatMinor(minor(value)) }]
  })
}

/** A live clearing or pre-platform transit link identifies the branch without changing its cash. */
export function companyJournalBranch(lines: readonly CompanyJournalDisplayLine[] = []): string | null {
  const branches = new Set(lines.flatMap(line => line.fundCode.startsWith('branch_clearing:') ||
    line.fundCode.startsWith('historical_branch_transit:') ? [line.fundCode.split(':')[1] ?? ''] : []))
  return branches.size === 1 ? branches.values().next().value ?? null : null
}

/** Preserve signed decimal money as numbers, while neutralizing formula-like user text. */
export function companyCsvCell(value: string): string {
  const money = /^-?\d+\.\d{2}$/.test(value)
  const safe = !money && (/^\s*[=+\-@]/.test(value) || /^[\t\r]/.test(value)) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}
