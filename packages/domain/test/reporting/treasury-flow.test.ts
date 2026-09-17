import { describe, expect, it } from 'vitest'
import {
  type TreasuryFlowEntry,
  isTreasuryFlowCandidate,
  reversalTargetId,
  treasuryFlowAmount,
  treasuryRoleOf,
} from '../../src/reporting/treasury-flow.ts'
import {
  compareLedgerRangeLines,
  isDriverBlockLine,
  isLegacyDriverShareLine,
  isRangeReportLine,
} from '../../src/reporting/ledger-range.ts'

const box = (side: 'D' | 'C', role?: string) => ({ fundCode: 'company_box', side, ...(role ? { role } : {}) })
const cash = (side: 'D' | 'C') => ({ fundCode: 'office_cash', side })

const entries: TreasuryFlowEntry[] = [
  { id: 1, eventType: 'restoration', occurrenceKey: '2026-07-21#1:office_cash', lines: [box('D'), cash('C')] },
  { id: 2, eventType: 'restoration', occurrenceKey: '2026-07-21#1:office_wallet', lines: [cash('D'), box('C')] },
  // A legacy correction with no role: resolved through its key.
  { id: 3, eventType: 'correction', occurrenceKey: 'reversal-of-1', lines: [cash('D'), box('C')] },
  // A reversal of that reversal: back in the ORIGINAL's column.
  { id: 4, eventType: 'correction', occurrenceKey: 'reversal-of-3', lines: [box('D'), cash('C')] },
  // A modern hand «كييش» carries its role.
  { id: 5, eventType: 'manual', occurrenceKey: 'client:abc', lines: [box('D', 'kaish'), cash('C')] },
  // A correction of an unrelated manual company-box entry is not a flow.
  { id: 6, eventType: 'manual', occurrenceKey: 'owner-in', lines: [box('D'), { fundCode: 'cost_center:owner_funding', side: 'C' }] },
  { id: 7, eventType: 'correction', occurrenceKey: 'reversal-of-6', lines: [box('C'), { fundCode: 'cost_center:owner_funding', side: 'D' }] },
  // A self-referencing correction must terminate.
  { id: 8, eventType: 'correction', occurrenceKey: 'reversal-of-8', lines: [box('C')] },
  // A correction whose original is missing (another branch, or never existed).
  { id: 9, eventType: 'correction', occurrenceKey: 'reversal-of-999', lines: [box('C')] },
  // A modern correction carries the original's role on its own line.
  { id: 10, eventType: 'correction', occurrenceKey: 'reversal-of-2', lines: [cash('C'), box('D', 'shahn')] },
]
const byId = new Map(entries.map((e) => [e.id, e]))
const lookup = (id: number) => byId.get(id)
const roleOf = (id: number) => {
  const entry = byId.get(id)!
  const line = entry.lines.find((l) => l.fundCode === 'company_box')!
  return treasuryRoleOf(entry, line, lookup)
}

describe('treasuryRoleOf', () => {
  it('reads a restoration by side, and a role wherever one is written', () => {
    expect(roleOf(1)).toBe('kaish')
    expect(roleOf(2)).toBe('shahn')
    expect(roleOf(5)).toBe('kaish')
    expect(roleOf(10)).toBe('shahn')
  })

  it('follows reversal links back to the original column, however deep', () => {
    expect(roleOf(3)).toBe('kaish')
    expect(roleOf(4)).toBe('kaish')
  })

  it('refuses to guess: unrelated, cyclic and dangling corrections are not flows', () => {
    expect(roleOf(6)).toBeNull()
    expect(roleOf(7)).toBeNull()
    expect(roleOf(8)).toBeNull()
    expect(roleOf(9)).toBeNull()
  })

  it('keeps a correction in its original column with the opposite sign', () => {
    // #1 is +500 كييش; #3 reverses it (a CREDIT of company_box) → −500 in the same column.
    expect(treasuryFlowAmount('kaish', 'D', 500n)).toBe(500n)
    expect(treasuryFlowAmount('kaish', 'C', 500n)).toBe(-500n)
    expect(treasuryFlowAmount('shahn', 'C', 500n)).toBe(500n)
    expect(treasuryFlowAmount('shahn', 'D', 500n)).toBe(-500n)
  })

  it('parses only well-formed reversal keys', () => {
    expect(reversalTargetId('reversal-of-42')).toBe(42)
    expect(reversalTargetId('reversal-of-0')).toBeNull()
    expect(reversalTargetId('reversal-of-')).toBeNull()
    expect(reversalTargetId('x-reversal-of-42')).toBeNull()
    expect(reversalTargetId('reversal-of-99999999999999999999')).toBeNull()
  })

  it('pre-filters candidates the way both adapters do', () => {
    expect(isTreasuryFlowCandidate('manual', box('D', 'kaish'))).toBe(true)
    expect(isTreasuryFlowCandidate('restoration', box('D'))).toBe(true)
    expect(isTreasuryFlowCandidate('correction', box('C'))).toBe(true)
    expect(isTreasuryFlowCandidate('manual', box('D'))).toBe(false)
    expect(isTreasuryFlowCandidate('restoration', cash('D'))).toBe(false)
  })
})

describe('range read model line rules', () => {
  it('keeps exactly the lines the dashboard reads', () => {
    expect(isRangeReportLine('company_revenue', null)).toBe(true)
    expect(isRangeReportLine('other_income', null)).toBe(true)
    expect(isRangeReportLine('yalago_income', null)).toBe(true)
    expect(isRangeReportLine('company_box', 'kaish')).toBe(true)
    expect(isRangeReportLine('cost_center:owner_funding', null)).toBe(true)
    expect(isRangeReportLine('driver_share_payable:d', 'driver_share')).toBe(true)
    expect(isRangeReportLine('driver_share_payable:d', 'cash_deduction_share')).toBe(true)
    expect(isRangeReportLine('driver_receivable_cash:d', 'cash_deduction_overflow')).toBe(true)
    expect(isRangeReportLine('driver_share_payable:d', 'driver_payout')).toBe(false)
    expect(isRangeReportLine('driver_receivable_cash:d', null)).toBe(false)
    expect(isRangeReportLine('office_cash', null)).toBe(false)
    expect(isRangeReportLine('fee_earned', null)).toBe(false)
  })

  it('separates the gross block share from the net legacy share', () => {
    expect(isDriverBlockLine('driver_share_payable:d', 'driver_share')).toBe(true)
    expect(isDriverBlockLine('driver_share_payable:d', 'cash_deduction_share')).toBe(false)
    expect(isLegacyDriverShareLine('driver_share_payable:d', 'cash_deduction_share')).toBe(true)
  })

  it('orders rows by code unit, roles without a value first', () => {
    const row = (fundCode: string, role: string | null, side: 'D' | 'C' = 'C') => ({
      businessDate: '2026-07-21',
      eventType: 'share_split',
      fundCode,
      role,
      side,
      currency: 'SYP_NEW',
    })
    const rows = [
      row('driver_share_payable:x', 'driver_share'),
      row('company_revenue', null, 'D'),
      row('Company_revenue', null),
      row('company_revenue', null),
      row('driver_share_payable:x', null),
    ]
    expect([...rows].sort(compareLedgerRangeLines).map((r) => `${r.fundCode}|${r.role}|${r.side}`)).toEqual([
      'Company_revenue|null|C',
      'company_revenue|null|C',
      'company_revenue|null|D',
      'driver_share_payable:x|null|C',
      'driver_share_payable:x|driver_share|C',
    ])
  })
})
