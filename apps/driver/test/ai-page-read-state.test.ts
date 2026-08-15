import { describe, expect, it } from 'vitest'
import {
  beginAiPageRead,
  cancelAiPageRead,
  discardAiPageFailure,
  discardAiPageRefusals,
  finishAiPageRead,
  type AiPageReadState,
  visibleAiPageReadOutcome,
} from '../src/ai-page-read-state.ts'

describe('cloud-authoritative paged OCR state', () => {
  it('stays busy until every concurrent page has settled', () => {
    let state: AiPageReadState = { kind: 'idle' }
    state = beginAiPageRead(state)
    state = beginAiPageRead(state)
    state = finishAiPageRead(state, { kind: 'read', rows: 4 })

    expect(state).toMatchObject({ kind: 'reading', pending: 1, rows: 4 })

    state = finishAiPageRead(state, { kind: 'read', rows: 2 })
    expect(state).toMatchObject({ kind: 'read', rows: 6, succeeded: 2, failures: 0 })
  })

  it('retains successful pages while making a sibling failure visible', () => {
    let state: AiPageReadState = beginAiPageRead({ kind: 'idle' })
    state = beginAiPageRead(state)
    state = finishAiPageRead(state, { kind: 'failed' })
    state = finishAiPageRead(state, { kind: 'read', rows: 3, refused: 1 })

    expect(state).toEqual({
      kind: 'read',
      rows: 3,
      refused: 1,
      cutOff: 0,
      succeeded: 1,
      failures: 1,
    })
  })

  it('reports a failure when AI answered no page successfully', () => {
    const state = finishAiPageRead(beginAiPageRead({ kind: 'idle' }), { kind: 'failed' })
    expect(state).toMatchObject({ kind: 'failed', rows: 0, succeeded: 0, failures: 1 })
  })

  it('starts a clean batch when a failed page is retried', () => {
    const failed = finishAiPageRead(beginAiPageRead({ kind: 'idle' }), { kind: 'failed' })
    const retried = finishAiPageRead(
      beginAiPageRead(discardAiPageFailure(failed)),
      { kind: 'read', rows: 2 },
    )
    expect(retried).toMatchObject({ kind: 'read', rows: 2, succeeded: 1, failures: 0 })
  })

  it('keeps successful siblings while one failed page is retried as a single replacement attempt', () => {
    let state: AiPageReadState = beginAiPageRead({ kind: 'idle' })
    state = beginAiPageRead(state)
    state = finishAiPageRead(state, { kind: 'read', rows: 3 })
    state = finishAiPageRead(state, { kind: 'failed' })

    state = beginAiPageRead(discardAiPageFailure(state))
    expect(state).toMatchObject({ kind: 'reading', pending: 1, rows: 3, succeeded: 1, failures: 0 })

    state = finishAiPageRead(state, { kind: 'read', rows: 2 })
    expect(state).toMatchObject({ kind: 'read', rows: 5, succeeded: 2, failures: 0 })
  })

  it('removes a partial page refusal before its successful retry without losing accepted rows', () => {
    let state = finishAiPageRead(beginAiPageRead({ kind: 'idle' }), {
      kind: 'read',
      rows: 5,
      refused: 2,
    })
    state = beginAiPageRead(discardAiPageRefusals(state, 2))
    state = finishAiPageRead(state, { kind: 'read', rows: 0, refused: 0 })

    expect(state).toMatchObject({ kind: 'read', rows: 5, refused: 0, failures: 0 })
  })

  it('keeps an earlier failed page visible when a different page is selected later', () => {
    const failed = finishAiPageRead(beginAiPageRead({ kind: 'idle' }), { kind: 'failed' })
    const withSibling = finishAiPageRead(beginAiPageRead(failed), { kind: 'read', rows: 2 })
    expect(withSibling).toMatchObject({ kind: 'read', rows: 2, succeeded: 1, failures: 1 })
  })

  it('ignores a stale completion that has no matching in-flight request', () => {
    const state: AiPageReadState = {
      kind: 'read',
      rows: 5,
      refused: 0,
      cutOff: 0,
      succeeded: 1,
      failures: 0,
    }
    expect(finishAiPageRead(state, { kind: 'failed' })).toBe(state)
  })

  it('cancels a replaced generation without ending a newer sibling read', () => {
    let state: AiPageReadState = beginAiPageRead({ kind: 'idle' })
    state = beginAiPageRead(state)
    state = cancelAiPageRead(state)
    expect(state).toMatchObject({ kind: 'reading', pending: 1, succeeded: 0, failures: 0 })

    state = finishAiPageRead(state, { kind: 'read', rows: 1 })
    expect(state).toMatchObject({ kind: 'read', rows: 1, failures: 0 })
  })

  it('returns to idle when the only in-flight generation is deleted', () => {
    expect(cancelAiPageRead(beginAiPageRead({ kind: 'idle' }))).toEqual({ kind: 'idle' })
  })

  it('clears a terminal failure when that page is deleted', () => {
    const failed = finishAiPageRead(beginAiPageRead({ kind: 'idle' }), { kind: 'failed' })
    expect(discardAiPageFailure(failed)).toEqual({ kind: 'idle' })
  })

  it('counts only surviving overlap deductions and actionable refused rows', () => {
    const orders = Array.from({ length: 6 }, () => ({ feeRefused: false }))
    const duplicateSightings = [{ localId: 'minus-50' }, { localId: 'minus-50-overlap' }]
    const reconciled = [{ localId: 'minus-50' }]

    expect(visibleAiPageReadOutcome(orders, duplicateSightings, reconciled)).toEqual({
      kind: 'read',
      rows: 7,
      refused: 0,
    })

    expect(visibleAiPageReadOutcome([{ feeRefused: true }], [], [])).toEqual({
      kind: 'read',
      rows: 1,
      refused: 1,
    })

    expect(visibleAiPageReadOutcome([{ feeRefused: false, timeText: '' }], [], [])).toEqual({
      kind: 'read',
      rows: 1,
      refused: 1,
    })

    expect(visibleAiPageReadOutcome([{ feeRefused: false, timeText: '', cancelled: true }], [], [])).toEqual({
      kind: 'read',
      rows: 1,
      refused: 0,
    })

    expect(visibleAiPageReadOutcome(
      [{ feeRefused: false, timeText: '20:09' }],
      // A retry that verified only the minute is still actionable: without its date the server
      // cannot place the deduction in the shift window.
      [{ localId: 'unknown-minus-50', timeText: '22:36', timeReviewRequired: true }],
      [{ localId: 'unknown-minus-50' }],
    )).toEqual({
      kind: 'read',
      rows: 2,
      refused: 1,
    })
  })
})
