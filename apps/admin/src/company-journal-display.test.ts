import { describe, expect, it } from 'vitest'
import { companyCsvCell, companyJournalBranch, companyJournalCash } from './company-journal-display.ts'

describe('raw company journal display', () => {
  it('shows a branch receipt even when there is no company command', () => {
    const lines = [{ fundCode: 'company_cash:SYP_NEW', side: 'D' as const, amount: '8420.00' }, { fundCode: 'branch_clearing:branch-1', side: 'C' as const, amount: '8420.00' }]
    expect(companyJournalCash(lines)).toEqual([{ currency: 'SYP_NEW', amount: '8420.00' }])
    expect(companyJournalBranch(lines)).toBe('branch-1')
    expect(companyJournalBranch([{ fundCode: 'company_cash:SYP_NEW', side: 'D', amount: '7080.00' },
      { fundCode: 'historical_branch_transit:branch-1', side: 'C', amount: '7080.00' }])).toBe('branch-1')
  })
  it('keeps an outgoing cash impact negative and a reversal positive', () => {
    const outgoing = [{ fundCode: 'company_cash:SYP_NEW', side: 'C' as const, amount: '8000.00' }]
    expect(companyJournalCash(outgoing)[0]?.amount).toBe('-8000.00')
    expect(companyJournalCash(outgoing.map(line => ({ ...line, side: 'D' as const })))[0]?.amount).toBe('8000.00')
  })
  it('never sums different currencies or loses large minor-unit precision', () => {
    expect(companyJournalCash([{ fundCode: 'company_cash:USD', side: 'D', amount: '2.35' }, { fundCode: 'company_cash:SYP_NEW', side: 'D', amount: '90071992547409.93' }])).toEqual([{ currency: 'SYP_NEW', amount: '90071992547409.93' }, { currency: 'USD', amount: '2.35' }])
  })
  it('does not turn a non-cash clearing entry into a cash movement', () => {
    expect(companyJournalCash([{ fundCode: 'branch_clearing:branch-1', side: 'D', amount: '4.00' }])).toEqual([])
    expect(companyJournalBranch([{ fundCode: 'branch_clearing:a', side: 'D', amount: '1.00' }, { fundCode: 'branch_clearing:b', side: 'C', amount: '1.00' }])).toBeNull()
  })
  it('exports negative money as signed decimals, but protects free-text formula cells', () => {
    expect(companyCsvCell('-2750.50')).toBe('"-2750.50"')
    expect(companyCsvCell('=1+2')).toBe('"\'=1+2"')
    expect(companyCsvCell('  =1+2')).toBe('"\'  =1+2"')
    expect(companyCsvCell('أجرة "المكتب"')).toBe('"أجرة ""المكتب"""')
  })
})
