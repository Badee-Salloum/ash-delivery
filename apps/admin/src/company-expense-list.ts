/** Ordinary lists hide deleted expenses and their technical reversal, not the audit history. */
export function visibleCompanyMovement(row: { reversed?: boolean; command: null | { kind: string; targetKind?: string } }): boolean {
  return !row.reversed && row.command?.kind !== 'reversal'
}

/** Sort a copy before filtering/pagination/export; never change evidence running balances. */
export function newestFinancialRows<T>(rows: readonly T[], date: (row: T) => string, sequence: (row: T) => number,
  recordedAt?: (row: T) => number | undefined): T[] {
  return [...rows].sort((a, b) => date(b).localeCompare(date(a)) ||
    (recordedAt?.(b) ?? 0) - (recordedAt?.(a) ?? 0) || sequence(b) - sequence(a))
}

export type ExpenseDeleteTarget =
  | { kind: 'command'; id: string; description: string }
  | { kind: 'source'; reference: string; description: string }

export function expenseDeleteRequest(target: ExpenseDeleteTarget, idempotencyKey: string, expectedVersion?: number) {
  // No reason input or accounting vocabulary in the UI. Record the operator's confirmation internally.
  const reason = 'Expense deleted after explicit user confirmation'
  if (target.kind === 'command') return { path: '/company/reversals', body: { idempotencyKey, targetId: target.id, reason } }
  if (!expectedVersion || expectedVersion < 1) throw new Error('Missing historical expense version')
  return { path: '/company/historical-source-corrections', body: { idempotencyKey,
    sourceReference: target.reference, expectedVersion, reason, values: { excluded: true }, acknowledgeCashEffect: true } }
}
