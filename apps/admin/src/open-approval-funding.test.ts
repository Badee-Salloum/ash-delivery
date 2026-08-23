import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const approvalSource = readFileSync(new URL('./screens/Approval.tsx', import.meta.url), 'utf8')

describe('manager open-approval shift-funding contract', () => {
  it('shows both reviewed balances and posts the bound approval request', () => {
    expect(approvalSource).toContain('value={review.shiftFunding.cash}')
    expect(approvalSource).toContain('value={review.shiftFunding.wallet}')
    expect(approvalSource).toContain('openingApprovalRequest(floatText, topupText, review.shiftFunding)')
    expect(approvalSource).toContain("code === 'shift_funding_changed'")
  })
})
