/**
 * Arbitration for a field whose machine value must come from cloud AI.
 *
 * The phone reader may still run so its crop can be retained for training, but a local observation
 * is deliberately a no-op here: it can never become either the visible value or the OCR baseline.
 * That keeps a fast local guess from masquerading as human input while the slower AI request is in
 * flight. Explicit human input remains authoritative over every machine event.
 */
export interface AiOcrAuthorityState<Value, Generation> {
  generation: Generation | null
  phase: 'idle' | 'reading' | 'read' | 'failed'
  value: Value | null
  aiValue: Value | null
  humanEdited: boolean
}

export type AiOcrAuthorityEvent<Value, Generation> =
  | { type: 'started'; generation: Generation }
  | { type: 'local_observed'; generation: Generation; value: Value }
  | { type: 'ai_read'; generation: Generation; value: Value }
  | { type: 'ai_failed'; generation: Generation }
  | { type: 'human_edited'; value: Value | null }

export function reduceAiOcrAuthority<Value, Generation>(
  state: AiOcrAuthorityState<Value, Generation>,
  event: AiOcrAuthorityEvent<Value, Generation>,
): AiOcrAuthorityState<Value, Generation> {
  if (event.type === 'human_edited') {
    return { ...state, value: event.value, humanEdited: true }
  }

  if (event.type === 'started') {
    return {
      generation: event.generation,
      phase: 'reading',
      value: state.humanEdited ? state.value : null,
      aiValue: null,
      humanEdited: state.humanEdited,
    }
  }

  // A late answer from a replaced photograph owns nothing on the current screen.
  if (state.generation !== event.generation) return state

  // Intentionally record no monetary state. The crop/sample is retained outside this policy seam.
  if (event.type === 'local_observed') return state

  if (event.type === 'ai_read') {
    return {
      ...state,
      phase: 'read',
      value: state.humanEdited ? state.value : event.value,
      aiValue: event.value,
    }
  }

  return {
    ...state,
    phase: 'failed',
    value: state.humanEdited ? state.value : null,
    aiValue: null,
  }
}
