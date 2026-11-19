import { describe, expect, it } from 'vitest'
import type { OwnerWithdrawal } from '@ash/client'
import { filterOwnerWithdrawals, validWithdrawalFilters, withdrawalSourceKey } from './owner-withdrawals.ts'
const base = { from: '2000-01-01', to: '2026-10-17', source: 'all', currency: 'all' as const }
const row = (id: number, source: OwnerWithdrawal['source'], currency: OwnerWithdrawal['currency'], date: string): OwnerWithdrawal => ({
  id: `row-${id}`, journalEntryId: id, journalEntryIds: [id], branchId: source === 'company' ? 'hq' : 'damascus',
  branchNameAr: 'دمشق', branchNameEn: 'Damascus', source, currency, amount: '960.00', originalAmount: '960.00',
  occurredOn: date, postingDate: date, recordedAt: `${date}T10:00:00Z`, occurrenceSource: 'recorded', description: '',
  reference: null, sypMinorPerUsd: null, status: 'active', entries: [],
})
describe('owner withdrawal detail filters', () => {
  const rows = [row(1, 'company', 'USD', '2026-10-15'), row(2, 'branch_cash', 'SYP_NEW', '2026-10-17'), row(3, 'branch_wallet', 'SYP_NEW', '2026-10-17')]
  it('sorts deterministically newest first without mutating the source', () => {
    expect(filterOwnerWithdrawals(rows, base, base.to).map(x => x.id)).toEqual(['row-3', 'row-2', 'row-1'])
    expect(rows[0]!.id).toBe('row-1')
  })
  it('filters by date, original currency and the actual source', () => {
    expect(filterOwnerWithdrawals(rows, { ...base, currency: 'USD' }, base.to).map(x => x.id)).toEqual(['row-1'])
    expect(filterOwnerWithdrawals(rows, { ...base, source: withdrawalSourceKey(rows[1]!) }, base.to).map(x => x.id)).toEqual(['row-2'])
    expect(filterOwnerWithdrawals(rows, { ...base, to: '2026-10-14' }, base.to)).toEqual([])
  })
  it('rejects invalid, incomplete, reversed and future date ranges', () => {
    for (const patch of [{ from: '' }, { from: '2026-02-30' }, { from: '2026-10-18' }, { to: '2026-10-18' }]) {
      expect(validWithdrawalFilters({ ...base, ...patch }, base.to)).toBe(false)
      expect(filterOwnerWithdrawals(rows, { ...base, ...patch }, base.to)).toEqual([])
    }
  })
})
