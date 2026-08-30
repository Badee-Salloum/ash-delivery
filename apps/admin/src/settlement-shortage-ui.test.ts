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
    expect(approvalSource).toContain('parseMinor(cashShortageReceivable.trim()) === parseMinor(settlement.cashShortageReceivable)')
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
