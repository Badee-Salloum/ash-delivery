export type OperationWindowStatus =
  | 'in_window'
  | 'pre_open'
  | 'post_close'
  | 'open_minute_boundary'
  | 'close_minute_boundary'
  | 'unknown'

export interface WindowReviewRow {
  windowStatus?: OperationWindowStatus
  decisionReason?: string | null
}

/**
 * An unknown timestamp is a close-gate blocker until a manager records a decision. Older API
 * payloads have no `windowStatus`; treating absence as unknown would disable every legacy review,
 * so only the explicit server status is considered unresolved.
 */
export function isUnresolvedWindowRow(row: WindowReviewRow): boolean {
  return row.windowStatus === 'unknown' && !row.decisionReason?.trim()
}

export function countUnresolvedWindowRows(
  orders: readonly (WindowReviewRow & { kind?: string })[],
  cashDeductions: readonly WindowReviewRow[],
): number {
  return (
    orders.filter((row) => row.kind !== 'manual' && isUnresolvedWindowRow(row)).length +
    cashDeductions.filter(isUnresolvedWindowRow).length
  )
}

/** Read a newly-added money field without coupling the admin build to one API rollout instant. */
export function firstMoneyField(value: unknown, names: readonly string[]): string | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  for (const name of names) {
    if (typeof record[name] === 'string') return record[name]
  }
  return null
}
