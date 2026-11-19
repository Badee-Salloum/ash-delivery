import type { OwnerWithdrawal, OwnerWithdrawalsView } from '../packages/contracts/src/owner-withdrawals.ts'

/** Synthetic read-only examples. The branch 70000 is illustrative, NOT a posted user operation. */
export function ownerWithdrawalFixture(): OwnerWithdrawalsView {
  const row = (journalEntryId: number, source: OwnerWithdrawal['source'], amount: string, currency: OwnerWithdrawal['currency'], occurredOn: string): OwnerWithdrawal => ({
    id: `preview-withdrawal-${journalEntryId}`, journalEntryId, journalEntryIds: [journalEntryId],
    branchId: source === 'company' ? 'preview-hq' : 'visual-branch-1', branchNameAr: source === 'company' ? 'الشركة' : 'فرع تجريبي', branchNameEn: source === 'company' ? 'Company' : 'Demo branch',
    source, currency, amount, originalAmount: amount, occurredOn, postingDate: occurredOn, recordedAt: `${occurredOn}T10:00:00.000Z`, occurrenceSource: 'recorded',
    description: source === 'company' ? 'مثال توضيحي لسحب شخصي من الشركة بالدولار' : 'مثال توضيحي فقط — سحب 70,000 من الفرع لم يُسجّل في الإنتاج',
    reference: `PREVIEW-ONLY-${journalEntryId}`, sypMinorPerUsd: currency === 'USD' ? '13900' : null, status: 'active',
    entries: [{ id: journalEntryId, eventType: source === 'company' ? 'company_withdrawal' : 'manual', businessDate: occurredOn, postingDate: occurredOn,
      reason: 'بيانات معاينة غير فعلية', lines: [
        { fundCode: source === 'company' ? `company_equity:${currency}:owner_drawings` : 'cost_center:owner_drawings', side: 'D', currency, amount },
        { fundCode: source === 'company' ? `company_cash:${currency}` : 'office_cash', side: 'C', currency, amount },
      ] }],
  })
  return { from: '2000-01-01', to: '2026-10-17', asOf: '2026-10-17', basis: 'current_verified_original_withdrawals',
    totals: { SYP_NEW: '70000.00', USD: '960.00' }, periodTotals: { SYP_NEW: '70000.00', USD: '960.00' },
    withdrawals: [row(51, 'company', '960.00', 'USD', '2026-10-15'), row(52, 'branch_cash', '70000.00', 'SYP_NEW', '2026-10-17')],
  }
}

export function companyExpensePreview() {
  const row = (id: number, occurredOn: string, createdAtMs: number, description: string) => ({
    entry: { id, businessDate: occurredOn, createdAtMs, eventType: 'company_expense', reason: description, sypMinorPerUsd: null, lines: [] },
    command: { id: `preview-expense-${id}`, kind: 'expense', occurredOn, createdAtMs, currency: 'SYP_NEW', amount: '10.00', description, paidFrom: 'pocket', categoryId: 'preview-category' }, reversed: false,
  })
  return [row(900, '2026-10-16', 9000, 'مثال صرفية أقدم تاريخاً'), row(99, '2026-10-17', 1000, 'مثال صرفية سابقة في اليوم نفسه'), row(1, '2026-10-17', 5000, 'مثال أحدث صرفية مسجلة')]
}
