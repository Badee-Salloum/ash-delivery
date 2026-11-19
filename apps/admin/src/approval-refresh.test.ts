import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { missingClosingFigures, operationReviewResolved, summarizeOrders } from './approval-workspace.ts'
import { operationDecisionPreview } from './operation-decision.ts'
import { countUnresolvedWindowRows } from './operation-window.ts'

describe('review completion', () => {
  it('moves an exceptional inclusion to the included bucket without inventing a clock', () => {
    const row = { fee: '280.00', included: true, windowStatus: 'unknown' as const, windowBasis: 'manager' as const, decisionReason: 'Verified against evidence', closeDraftReviewReasons: [] }
    expect(operationReviewResolved(row)).toBe(true)
    expect(countUnresolvedWindowRows([row], [])).toBe(0)
    expect(summarizeOrders([row])).toEqual({ included: { count: 1, total: '280.00' }, excluded: { count: 0, total: '0.00' }, unresolved: { count: 0, total: '0.00' } })
  })
  it('does not hide unresolved reasons behind an old decision', () => {
    expect(operationReviewResolved({ windowBasis: 'manager', decisionReason: 'Old decision', closeDraftReviewReasons: ['reader_conflict'] })).toBe(false)
  })
  it('requires review for an unconfirmed unknown clock or invisible reason', () => {
    expect(operationReviewResolved({ windowStatus: 'unknown', windowBasis: 'manager', decisionReason: '\u200f' })).toBe(false)
  })
  it('previews the effective financial inclusion when the raw included flag was already true', () => {
    expect(operationDecisionPreview([{ key: 'A', kind: 'order', amount: '330.00', included: true, proposedIncluded: true, requiresReview: true, date: '2026-10-12', minute: '14:33' }])).toMatchObject({ changed: true, orderDelta: '330.00' })
  })
  it('distinguishes missing closing figures from a verified zero', () => {
    expect(missingClosingFigures({ cashDeclared: '0.00', walletDeclared: null })).toEqual(['wallet'])
    expect(missingClosingFigures({ cashDeclared: null, walletDeclared: null })).toEqual(['cash', 'wallet'])
    expect(missingClosingFigures({ cashDeclared: '0.00', walletDeclared: '0.00' })).toEqual([])
  })
})

describe('refresh safety wiring', () => {
  const source = readFileSync(new URL('./screens/Approval.tsx', import.meta.url), 'utf8')
  it('bounds review and settlement reads and aborts outdated settlement requests', () => {
    expect(source).toContain("cache: 'no-store', signal: request.signal, timeoutMs: 20_000")
    expect(source).toContain("cache: 'no-store', signal: controller.signal, timeoutMs: 20_000")
    expect(source).toContain('controller.abort()')
    expect(source).toContain("review.state !== 'pending_review' || refreshing || loadError")
  })
  it('waits for the accepted review snapshot before releasing the operation save', () => {
    const revise = source.slice(source.indexOf('async function reviseOps('), source.indexOf('async function rereadOrderEvidence('))
    expect(revise).toContain('await refreshVisible()')
    expect(source).toContain('const editsDisabled = busy || refreshing || snapshotUnavailable')
    expect(source).toContain('reviewLoadError={loadError}')
  })
})
