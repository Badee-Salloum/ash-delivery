import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'

const approval = readFileSync(new URL('./screens/Approval.tsx', import.meta.url), 'utf8')

describe('optional settlement variance reason UI', () => {
  it('labels the surplus/shortage note as optional in both languages', () => {
    expect(ar.settlement.varianceReason).toContain('اختياري')
    expect(ar.settlement.varianceReasonPlaceholder).toContain('اختياري')
    expect(en.settlement.varianceReason.toLowerCase()).toContain('optional')
    expect(en.settlement.varianceReasonPlaceholder.toLowerCase()).toContain('optional')
  })

  it('does not add an empty variance note to either approval blocker list', () => {
    expect(approval).not.toContain(
      "settlement && settlementHasVariance(settlement) && varianceReason.trim() === ''",
    )
    expect(approval).not.toContain(
      "settlementHasVariance(settlement) && settlementDraft.varianceReason.trim() === ''",
    )
    expect(approval).not.toContain(
      '<p className="mt-1 text-xs font-medium text-red-700">{t.settlement.varianceReasonRequired}</p>',
    )
  })

  it('keeps the separate exceptional-close override reason mandatory', () => {
    expect(approval).toContain("!closeSettlementReady || notes.trim() === ''")
    expect(approval).toContain("disabled={busy || !approvalReady || notes.trim() === ''}")
    expect(approval).toContain('t.approval.forceReasonRequired')
  })
})
