/**
 * Aggregate state for a paged, cloud-authoritative OCR screen.
 *
 * Several gallery pages can be selected before the first AI request settles. A single boolean
 * cannot represent that: the first completion would clear it and allow the shift to close while
 * another page was still being read. This state machine counts every in-flight page and retains
 * the aggregate outcome for the status line.
 */
interface PageReadTotals {
  rows: number
  refused: number
  cutOff: number
  succeeded: number
  failures: number
}

export type AiPageReadState =
  | { kind: 'idle' }
  | ({ kind: 'reading'; pending: number } & PageReadTotals)
  | ({ kind: 'read' } & PageReadTotals)
  | ({ kind: 'failed' } & PageReadTotals)

export type AiPageReadOutcome =
  | { kind: 'read'; rows: number; refused?: number; cutOff?: number }
  | { kind: 'failed' }

const EMPTY_TOTALS: PageReadTotals = {
  rows: 0,
  refused: 0,
  cutOff: 0,
  succeeded: 0,
  failures: 0,
}

function totalsOf(state: AiPageReadState): PageReadTotals {
  return state.kind === 'idle'
    ? EMPTY_TOTALS
    : {
        rows: state.rows,
        refused: state.refused,
        cutOff: state.cutOff,
        succeeded: state.succeeded,
        failures: state.failures,
      }
}

/** Register one AI request without losing results already accumulated from sibling pages. */
export function beginAiPageRead(state: AiPageReadState): AiPageReadState {
  // Preserve the other pages' outcomes across sequential picks. A caller retrying/replacing one
  // failed slot first removes that slot's old failure with `discardAiPageFailure`.
  const totals = totalsOf(state)
  return {
    kind: 'reading',
    pending: state.kind === 'reading' ? state.pending + 1 : 1,
    ...totals,
  }
}

/**
 * Settle exactly one request. The screen remains `reading` until the final concurrent request
 * settles; a failed page never erases successful pages or their row count.
 */
export function finishAiPageRead(
  state: AiPageReadState,
  outcome: AiPageReadOutcome,
): AiPageReadState {
  // A terminal event without a matching start is stale. Ignoring it is safer than manufacturing a
  // completed request and, importantly, cannot make a current request look finished.
  if (state.kind !== 'reading' || state.pending < 1) return state

  const next: PageReadTotals = {
    rows: state.rows + (outcome.kind === 'read' ? Math.max(0, outcome.rows) : 0),
    refused: state.refused + (outcome.kind === 'read' ? Math.max(0, outcome.refused ?? 0) : 0),
    cutOff: state.cutOff + (outcome.kind === 'read' ? Math.max(0, outcome.cutOff ?? 0) : 0),
    succeeded: state.succeeded + (outcome.kind === 'read' ? 1 : 0),
    failures: state.failures + (outcome.kind === 'failed' ? 1 : 0),
  }
  const pending = state.pending - 1

  if (pending > 0) return { kind: 'reading', pending, ...next }
  return next.succeeded > 0 ? { kind: 'read', ...next } : { kind: 'failed', ...next }
}

/** Settle a superseded/deleted generation without presenting it as an AI answer. */
export function cancelAiPageRead(state: AiPageReadState): AiPageReadState {
  if (state.kind !== 'reading' || state.pending < 1) return state
  const pending = state.pending - 1
  const totals = totalsOf(state)
  if (pending > 0) return { kind: 'reading', pending, ...totals }
  if (totals.succeeded > 0) return { kind: 'read', ...totals }
  if (totals.failures > 0) return { kind: 'failed', ...totals }
  return { kind: 'idle' }
}

/** Remove the visible failure belonging to a page the driver explicitly deleted. */
export function discardAiPageFailure(state: AiPageReadState): AiPageReadState {
  if (state.kind === 'idle' || state.failures < 1) return state
  const totals = { ...totalsOf(state), failures: state.failures - 1 }
  if (state.kind === 'reading') return { kind: 'reading', pending: state.pending, ...totals }
  if (totals.succeeded > 0) return { kind: 'read', ...totals }
  if (totals.failures > 0) return { kind: 'failed', ...totals }
  return { kind: 'idle' }
}
