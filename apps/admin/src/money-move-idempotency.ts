/**
 * One idempotency key per logical treasury money move — the `expense-idempotency.ts` pattern.
 *
 * صندوق الشركة deposits and withdrawals and branch-box owner funding are journal-only commands: a
 * second POST with a fresh key moves the money a second time. So the screen holds the key while a
 * submission is unresolved and sends the SAME key when the operator presses again after a lost
 * response; the server then returns the original entry instead of posting twice.
 *
 * The key belongs to the complete payload, including which command it is. Change any field — the
 * amount, the reason, the branch, deposit vs withdraw — and it is a different submission with a new
 * key, never a reuse the server would have to refuse as a conflict.
 */
export interface PendingMoneyMove {
  fingerprint: string
  idempotencyKey: string
}

export interface MoneyMovePayload {
  /** Which command: `company_deposit`, `company_withdraw`, `treasury_deposit:cash`, … */
  command: string
  branchId: string | null
  amount: string
  reason: string
}

/** Reuse one key only while the complete money-move payload remains unchanged. */
export const pendingMoneyMove = (
  current: PendingMoneyMove | null,
  payload: MoneyMovePayload,
  generateKey: () => string = () => crypto.randomUUID(),
): PendingMoneyMove => {
  const fingerprint = JSON.stringify([payload.command, payload.branchId, payload.amount, payload.reason])
  return current?.fingerprint === fingerprint
    ? current
    : { fingerprint, idempotencyKey: generateKey() }
}

/**
 * What to hold after an attempt: nothing once it succeeded (the next press is a new move), nothing
 * after `idempotency_key_conflict` (that key is spent on something else), and the same key after any
 * other failure — a lost response may have posted, and because the key is bound to this exact
 * payload, re-sending it can only ever return that entry or post it once.
 */
export const pendingAfterAttempt = (
  operation: PendingMoneyMove,
  outcome: { ok: true } | { ok: false; error: string | undefined },
): PendingMoneyMove | null =>
  outcome.ok || outcome.error === 'idempotency_key_conflict' ? null : operation
