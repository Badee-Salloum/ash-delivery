import { describe, expect, it } from 'vitest'
import { decisionReasonReady, operationDecisionPreview, type OperationDecisionRow } from './operation-decision.ts'

const row = (over: Partial<OperationDecisionRow> = {}): OperationDecisionRow => ({
  key: 'A', kind: 'order', amount: '280.00', included: false, proposedIncluded: true,
  date: null, minute: null, ...over,
})
describe('audited operation decision preview', () => {
  it('shows exceptional inclusion without inventing a timestamp', () => {
    const rows = [row()]
    expect(operationDecisionPreview(rows)).toEqual({ orderDelta: '280.00', deductionDelta: '0.00', unknownIncluded: true, changed: true })
    expect(rows[0]?.date).toBeNull()
    expect(rows[0]?.minute).toBeNull()
  })
  it('shows both outcomes when changing which duplicate is counted', () => {
    expect(operationDecisionPreview([
      row({ amount: '330.00', included: true, proposedIncluded: false }),
      row({ key: 'B', amount: '230.00', date: '2026-10-12', minute: '15:10' }),
    ])).toMatchObject({ orderDelta: '-100.00', unknownIncluded: false })
  })
  it('does not treat a cash deduction as positive delivery earnings', () => {
    expect(operationDecisionPreview([
      row({ kind: 'cash_deduction', amount: '260.15' }),
      row({ key: 'B', amount: '330.12', included: true, proposedIncluded: false }),
    ])).toMatchObject({ orderDelta: '-330.12', deductionDelta: '260.15' })
  })
  it('does not warn about the missing time of an excluded duplicate', () => {
    expect(operationDecisionPreview([row({ included: true, proposedIncluded: false })])).toMatchObject({ unknownIncluded: false })
  })
  it('marks no-op decisions and refuses negative magnitudes', () => {
    expect(operationDecisionPreview([row({ included: true })]).changed).toBe(false)
    expect(() => operationDecisionPreview([row({ amount: '-1.00' })])).toThrow()
  })
  it('requires visible reason text, not spaces or invisible direction marks', () => {
    expect(decisionReasonReady(' \u200f\u200b\u2066 ')).toBe(false)
    expect(decisionReasonReady(' راجعت الصورة ')).toBe(true)
  })
})
