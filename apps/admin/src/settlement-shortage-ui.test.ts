/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'

const approvalSource = readFileSync(new URL('./screens/Approval.tsx', import.meta.url), 'utf8')

describe('close-time ordinary shortage receivable UI', () => {
  it('recalculates, confirms, and posts the exact reviewed shortage amount', () => {
    expect(approvalSource).toContain("const [cashShortageReceivable, setCashShortageReceivable] = useState('0')")
    expect(approvalSource).toContain('cashShortageReceivable: cashShortageReceivable.trim()')
    expect(approvalSource).toContain('cashShortageReceivable: settlement.cashShortageReceivable')
    /*
     * The invariant this line used to assert — that the typed amount must equal the priced one —
     * now lives in `deferralMatchesSettlement`, where `approval-blockers.test.ts` exercises it
     * against trailing zeros, whitespace, negatives and a missing statement. What is left to check
     * here is only that the screen still ASKS.
     */
    expect(approvalSource).toContain('deferralMatchesSettlementInputs(')
    expect(approvalSource).toContain('cashShortageReceivable,')
    expect(approvalSource).toContain('settlement.maximumCashShortageReceivable')
    expect(approvalSource).toContain('onCashShortageReceivable(event.target.value)')
  })

  it('uses explicit debt language and promises no second office deduction in both languages', () => {
    expect(ar.settlement.shortageReceivableTitle).toContain('ذمة عادية')
    expect(ar.settlement.shortageReceivableOfficeUnchanged).toContain('لا يخصم صندوق المكتب مرة ثانية')
    expect(en.settlement.shortageReceivableTitle).toContain('ordinary receivable')
    expect(en.settlement.shortageReceivableOfficeUnchanged).toContain('does not reduce the office box a second time')
  })
})

describe('«الحسم» — the charge, and the place it is actually rendered', () => {
  /*
   * ITS PREDECESSOR HAD NO USER INTERFACE AT ALL.
   *
   * The withdrawn version put its form in the ordinary review JSX, which is only reached AFTER
   * `if (isClose) return <CloseApprovalWorkspace/>` has already returned for `pending_review` —
   * the exact state the form required. Unreachable dead code, and nobody noticed, because the
   * money it moved was zero either way.
   *
   * So the assertion is about POSITION, not existence: the form must sit inside the workspace that
   * renders for a shift under review, beside the settlement it changes.
   */
  it('renders inside the close workspace, not in the unreachable review branch', () => {
    const workspaceStart = approvalSource.indexOf('function CloseApprovalWorkspace(')
    expect(workspaceStart).toBeGreaterThan(-1)
    const used = approvalSource.indexOf('<ManagerChargeBox')
    expect(used).toBeGreaterThan(workspaceStart)
    // …and it is wired to the workspace's own props rather than reaching for an outer closure.
    expect(approvalSource).toContain('onSetManagerCharge={setCharge}')
    expect(approvalSource).toContain('onSave={onSetManagerCharge}')
  })

  it('refuses to charge without a stated reason, in the browser as well as the server', () => {
    // A deduction from someone's pay with no reason is the one thing this instrument must not do.
    expect(approvalSource).toContain('disabled={disabled || !amountReady || !reasonReady}')
    expect(approvalSource).toContain('copy.chargeReasonRequired')
    expect(ar.settlement.chargeReasonRequired).toContain('سبب')
  })

  it('says the charge is income, not a fuller cash box', () => {
    // The sentence a manager reads is the one the ledger actually posts.
    expect(ar.settlement.chargeHint).toContain('دخلاً')
    expect(en.settlement.chargeHint).toContain('income')
  })
})
