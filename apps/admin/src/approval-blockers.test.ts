import { describe, expect, it } from 'vitest'
import {
  type ApprovalBlockerInput,
  approvalBlockerCodes,
  closeWorkspaceApprovalReady,
} from './approval-workspace.ts'
import { deferralMatchesSettlement, isNonnegativeSettlementMoney } from './settlement-review.ts'
import type { ShiftSettlementView } from '@ash/client'

/**
 * The close button and its explanation must never disagree.
 *
 * Two gate terms used to disable the button while contributing nothing to the displayed list:
 * `deferralMatchesSettlement`, and the settlement-hash shape inside `settlementApprovalReady`. A
 * manager who meets a dead button with no stated reason concludes the console is broken and goes
 * looking for a way around the gate — which, on the screen that signs off real cash, is the worst
 * available outcome.
 */
const gate = (over: Partial<ApprovalBlockerInput> = {}): ApprovalBlockerInput => ({
  settlementReady: true,
  settlementLoaded: true,
  deferralMatches: true,
  confirmationsComplete: true,
  unresolvedOperationCount: 0,
  managerBatteryReadingCount: 0,
  pendingTimingDraftCount: 0,
  refreshing: false,
  forcePrepared: false,
  forceReason: '',
  ...over,
})

describe('the button and the reason are one statement', () => {
  it('is ready exactly when nothing blocks it — every combination, exhaustively', () => {
    /*
     * THE test. `closeWorkspaceApprovalReady` is *defined* as "this list is empty", so a future
     * gate term that forgets to explain itself cannot pass.
     *
     * Enumerated rather than sampled: the whole space is 2,048 states, so exhaustive is both
     * cheaper and stronger than random generation — and it needs no property-testing dependency
     * the admin package does not already carry.
     */
    const bools = [false, true]
    const counts = [0, 2]
    const reasons = ['', '   ', '‏', 'سبب حقيقي']
    let checked = 0
    for (const settlementReady of bools)
      for (const settlementLoaded of bools)
        for (const deferralMatches of bools)
          for (const confirmationsComplete of bools)
            for (const refreshing of bools)
              for (const forcePrepared of bools)
                for (const unresolvedOperationCount of counts)
                  for (const managerBatteryReadingCount of counts)
                    for (const pendingTimingDraftCount of counts)
                      for (const forceReason of reasons) {
                        const input: ApprovalBlockerInput = {
                          settlementReady,
                          settlementLoaded,
                          deferralMatches,
                          confirmationsComplete,
                          unresolvedOperationCount,
                          managerBatteryReadingCount,
                          pendingTimingDraftCount,
                          refreshing,
                          forcePrepared,
                          forceReason,
                        }
                        expect(
                          closeWorkspaceApprovalReady(input),
                          JSON.stringify(input),
                        ).toBe(approvalBlockerCodes(input).length === 0)
                        checked += 1
                      }
    expect(checked).toBe(2 ** 6 * 2 ** 3 * reasons.length)
  })

  it('says nothing when the shift is genuinely ready', () => {
    expect(approvalBlockerCodes(gate())).toEqual([])
    expect(closeWorkspaceApprovalReady(gate())).toBe(true)
  })

  it('names the two reasons that used to be silent', () => {
    // Mid-debounce: the typed amount does not yet match the priced statement.
    expect(approvalBlockerCodes(gate({ settlementReady: false, deferralMatches: false })))
      .toContain('settlement_amounts_pending')

    // A malformed settlement hash — neither half of "ready" explains it, and a manager cannot fix
    // it by typing, so it must still say something rather than leave a dead button.
    expect(approvalBlockerCodes(gate({ settlementReady: false })))
      .toContain('settlement_unavailable')
  })

  it('names every other reason too', () => {
    expect(approvalBlockerCodes(gate({ refreshing: true }))).toContain('recalculating')
    expect(approvalBlockerCodes(gate({ settlementLoaded: false }))).toContain('settlement_unavailable')
    expect(approvalBlockerCodes(gate({ settlementReady: false, confirmationsComplete: false })))
      .toContain('confirm_before_approval')
    expect(approvalBlockerCodes(gate({ unresolvedOperationCount: 2 }))).toContain('unresolved_operations')
    expect(approvalBlockerCodes(gate({ pendingTimingDraftCount: 1 }))).toContain('unsaved_timing_draft')
    expect(approvalBlockerCodes(gate({ managerBatteryReadingCount: 1 }))).toContain('manager_battery_required')
    expect(approvalBlockerCodes(gate({ forcePrepared: true }))).toContain('force_reason_required')
  })

  it('treats an invisible force reason as no reason', () => {
    // `'‏'.trim()` is truthy — an RTL mark that survives trimming used to pass as an audit trail.
    expect(approvalBlockerCodes(gate({ forcePrepared: true, forceReason: '‏' })))
      .toContain('force_reason_required')
    expect(approvalBlockerCodes(gate({ forcePrepared: true, forceReason: 'أُغلقت استثنائياً' })))
      .not.toContain('force_reason_required')
  })

  it('never says «recalculating» and «unavailable» in the same breath', () => {
    // While a refresh is in flight the settlement is legitimately null; saying both would tell the
    // manager something is broken when nothing is.
    const codes = approvalBlockerCodes(gate({ refreshing: true, settlementLoaded: false, settlementReady: false }))
    expect(codes).toContain('recalculating')
    expect(codes).not.toContain('settlement_unavailable')
  })
})

/**
 * The comparison that decides whether the typed amounts describe the statement the server priced.
 * `closeApprovalRequest` posts the values from `settlement`, never from the boxes — so the boxes
 * only have to AGREE, and agreement is a question about money, not about text.
 */
describe('do the typed receivables match the priced statement', () => {
  const settlement = (over: Partial<ShiftSettlementView> = {}): ShiftSettlementView =>
    ({
      cashReceivableDeferred: '0.00',
      walletReceivableDeferred: '0.00',
      cashShortageReceivable: '0.00',
      ...over,
    }) as ShiftSettlementView

  const inputs = (over: Partial<Record<string, string>> = {}) => ({
    cashReceivableDeferred: '0',
    walletReceivableDeferred: '0',
    cashShortageReceivable: '0',
    ...over,
  })

  it.each([
    ['0', '0.00'],
    ['0.00', '0.00'],
    [' 0.00 ', '0.00'],
    ['1500', '1500.00'],
    ['1500.00', '1500.00'],
  ])('reads «%s» and «%s» as the same amount', (typed, priced) => {
    // Compared in minor units, not as text: a screen that refused «0» against «0.00» would be
    // refusing for a reason no manager could see.
    expect(deferralMatchesSettlement(inputs({ cashReceivableDeferred: typed }), settlement({ cashReceivableDeferred: priced }))).toBe(true)
  })

  it('refuses a real disagreement on any of the three', () => {
    expect(deferralMatchesSettlement(inputs({ cashReceivableDeferred: '1' }), settlement())).toBe(false)
    expect(deferralMatchesSettlement(inputs({ walletReceivableDeferred: '1' }), settlement())).toBe(false)
    expect(deferralMatchesSettlement(inputs({ cashShortageReceivable: '1' }), settlement())).toBe(false)
  })

  it('refuses a half-typed, negative or empty amount', () => {
    for (const bad of ['', '   ', '-1', '1.', 'abc', '١٢٣']) {
      expect(deferralMatchesSettlement(inputs({ cashShortageReceivable: bad }), settlement())).toBe(false)
      expect(isNonnegativeSettlementMoney(bad)).toBe(false)
    }
  })

  it('refuses when there is no statement to compare against', () => {
    expect(deferralMatchesSettlement(inputs(), null)).toBe(false)
  })
})
