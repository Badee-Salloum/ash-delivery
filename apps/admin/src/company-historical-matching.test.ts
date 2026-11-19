/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { historicalMatchingHasMultipleLinks, historicalMatchingIsNeutral, historicalMatchingLinkLabelKey, type HistoricalMatchingGroup, type HistoricalMatchingPreview } from './screens/CompanyHistoricalRestorationMatching.tsx'

const source = readFileSync(new URL('./screens/CompanyHistoricalRestorationMatching.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./screens/CompanyFinanceReview.tsx', import.meta.url), 'utf8')
const finance = readFileSync(new URL('./screens/CompanyFund.tsx', import.meta.url), 'utf8')
const zero = { SYP_NEW: '0.00', USD: '0.00' }
const group: HistoricalMatchingGroup = { restorationId: 7, businessDate: '2026-09-11', branchEntryIds: [8], hqEntryIds: [9], sourceReferences: ['HQ-SRC-1'], branchNet: '10.00', companyNet: '10.00', variance: '0.00', sources: [] }

describe('protected historical counterpart review UI', () => {
  it('requires complete, exact zero effects in both currencies and all three ledgers', () => {
    expect(historicalMatchingIsNeutral({ impacts: { companyCash: zero, branchCash: zero, pnl: zero } })).toBe(true)
    for (const effect of ['companyCash', 'branchCash', 'pnl'] as const) {
      expect(historicalMatchingIsNeutral({ impacts: { companyCash: zero, branchCash: zero, pnl: zero, [effect]: { SYP_NEW: '0.01', USD: '0.00' } } })).toBe(false)
    }
    expect(historicalMatchingIsNeutral({ impacts: { companyCash: zero, branchCash: zero, pnl: { SYP_NEW: '0.00' } } } as unknown as HistoricalMatchingPreview)).toBe(false)
    expect(historicalMatchingIsNeutral({ impacts: { companyCash: zero, branchCash: zero, pnl: { SYP_NEW: 'invalid', USD: '0.00' } } })).toBe(false)
  })
  it('distinguishes multiple mappings without treating duplicate IDs as extra sources', () => {
    expect(historicalMatchingHasMultipleLinks(group)).toBe(false)
    expect(historicalMatchingHasMultipleLinks({ ...group, hqEntryIds: [9, 9], sourceReferences: ['HQ-SRC-1', 'HQ-SRC-1'] })).toBe(false)
    expect(historicalMatchingHasMultipleLinks({ ...group, hqEntryIds: [9, 10] })).toBe(true)
    expect(historicalMatchingHasMultipleLinks({ ...group, branchEntryIds: [8, 11] })).toBe(true)
    expect(historicalMatchingHasMultipleLinks({ ...group, sourceReferences: ['HQ-SRC-1', 'HQ-SRC-2'] })).toBe(true)
  })
  it('explains known link evidence and never presents an unknown status as confirmation', () => {
    expect(historicalMatchingLinkLabelKey('probable_amount_date')).toBe('historicalLinkProbable')
    expect(historicalMatchingLinkLabelKey('confirmed_by_user')).toBe('historicalLinkConfirmed')
    expect(historicalMatchingLinkLabelKey('confirmed_by_user_branch_payment')).toBe('historicalLinkConfirmedBranchPayment')
    expect(historicalMatchingLinkLabelKey('confirmed_by_user_posted_later')).toBe('historicalLinkConfirmedPostedLater')
    expect(historicalMatchingLinkLabelKey('exact_amount_date')).toBe('historicalLinkExact')
    expect(historicalMatchingLinkLabelKey('exact_amount_near_date')).toBe('historicalLinkNearDate')
    for (const unknown of ['unknown', 'future_link_code', 'toString', '__proto__']) expect(historicalMatchingLinkLabelKey(unknown)).toBe('historicalLinkUnknown')
    expect(source).toContain('<ImpactMoney value={shown.impacts?.[effect]?.USD}')
  })
  it('uses runtime totals and counts inside the existing review screen, not a new tab', () => {
    expect(review).toContain('<CompanyHistoricalRestorationMatching')
    expect(source).toContain('data.counts.sourceCount')
    expect(source).toContain('data.counts.hqJournalCount')
    expect(source).toContain('data.totals.amountDifference')
    expect(source).toContain('data.unlinkedHistoricalCount')
    expect(source).not.toContain('api.post(\'/company/historical-movements')
    expect(source).not.toContain('api.post(\'/company/deposits')
  })
  it('labels the correction as a non-cash event before the generic branch-payment labels', () => {
    expect(finance).toContain("const kindLabel = row.kind === 'company_historical_restoration_reclass' ? t.companyFinance.historicalKinds.historicalRestorationReclass : row.branchId ?")
    expect(finance).toContain("movement.entry.eventType === 'company_historical_restoration_reclass' ? movement.entry.eventType : branch ? 'branch_transfer'")
    expect(finance).toContain("row.entry.eventType !== 'company_historical_restoration_reclass' ? <p")
    expect(finance).toContain("case 'company_historical_restoration_reclass': return labels.historicalRestorationReclass")
  })
  it('binds acknowledgment to evidence and retains the exact request after uncertain attempts', () => {
    expect(source).toContain('draft.acknowledgedHash === data.evidenceHash')
    expect(source).toContain('uncertain ? draft.attempt!.payload')
    expect(source).toContain('draft.attempt?.request ?? null')
    expect(source).toContain('expectedVersion: data.version')
    expect(source).toContain('idempotencyKey: request.idempotencyKey')
    expect(source).toContain('uncertainMoneyMoveOutcome(outcome)')
    expect(source).toContain('storeDraft(key, next)')
  })
})
