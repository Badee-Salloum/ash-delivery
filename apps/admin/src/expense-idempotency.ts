export interface PendingExpenseOperation {
  fingerprint: string
  idempotencyKey: string
}

export interface ExpenseOperationPayload {
  categoryId: string
  costCenterKind: 'vehicle' | 'branch' | 'general'
  vehicleId: string | null
  amount: string
  description: string
}

/** Reuse one key only while the complete immutable expense payload remains unchanged. */
export const pendingExpenseOperation = (
  current: PendingExpenseOperation | null,
  payload: ExpenseOperationPayload,
  generateKey: () => string = () => crypto.randomUUID(),
): PendingExpenseOperation => {
  const fingerprint = JSON.stringify(payload)
  return current?.fingerprint === fingerprint
    ? current
    : { fingerprint, idempotencyKey: generateKey() }
}
