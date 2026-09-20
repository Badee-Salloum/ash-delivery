/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { installmentPlanPayload, newInstallmentPlanDraft } from './screens/AssetInstallments.tsx'

const companyFund = readFileSync(new URL('./screens/CompanyFund.tsx', import.meta.url), 'utf8')
const installments = readFileSync(new URL('./screens/AssetInstallments.tsx', import.meta.url), 'utf8')

describe('asset installment plans', () => {
  it('creates exact recurrence payloads without a client-side money conversion', () => {
    const monthly = installmentPlanPayload({ ...newInstallmentPlanDraft('2026-09-01'), amount: '100.00' })
    expect(monthly).toMatchObject({
      amount: '100.00', paidFrom: 'pocket', scheduleKind: 'monthly_first',
      weekday: null, intervalDays: null, startsOn: '2026-09-01',
    })
    const weekly = installmentPlanPayload({
      ...newInstallmentPlanDraft('2026-09-02'), amount: '20.50', scheduleKind: 'weekly', weekday: 3,
    })
    expect(weekly).toMatchObject({ scheduleKind: 'weekly', weekday: 3, intervalDays: null })
    const interval = installmentPlanPayload({
      ...newInstallmentPlanDraft('2026-09-02'), amount: '20.50', scheduleKind: 'every_n_days', intervalDays: '17',
    })
    expect(interval).toMatchObject({ scheduleKind: 'every_n_days', weekday: null, intervalDays: 17 })
  })

  it('supports an atomic plan on a new financed asset and adjusts its default start with the purchase date', () => {
    expect(companyFund).toContain('scheduleNewAsset')
    expect(companyFund).toContain('installmentPlan: installmentPlanPayload(newPlan)')
    expect(companyFund).toContain('required={scheduleNewAsset}')
    expect(companyFund).toContain("if (newPlan.startsOn === purchasedOn)")
  })

  it('has a manual due workflow with an editable source, confirmation, and documented skip', () => {
    expect(installments).toContain("api.post(`/company/assets/${row.assetId}/installment-plans/${row.id}/occurrences/${row.dueDate}/pay`")
    expect(installments).toContain("api.post(`/company/assets/${row.assetId}/installment-plans/${row.id}/occurrences/${row.dueDate}/skip`")
    expect(installments).toContain('const confirm = useConfirm()')
    expect(installments).toContain('const requestText = useTextPrompt()')
    expect(installments).toContain('source,')
    expect(installments).toContain('idempotencyKey: crypto.randomUUID(), reason')
    expect(installments).toContain('formatBusinessDate(row.dueDate, lang)')
    expect(companyFund).toContain('today={due.today || today}')
  })

  it('allows an existing unpaid financed asset to gain a plan and deactivates it with a reason', () => {
    expect(installments).toContain('createInstallmentPlan')
    expect(installments).toContain('/installment-plans`, installmentPlanPayload(draft)')
    expect(installments).toContain('/deactivate`, { reason }')
    expect(installments).toContain('positiveMoney(row.outstanding)')
  })

  it('ships Arabic and English manager-facing labels', () => {
    for (const catalog of [ar, en]) {
      for (const key of [
        'installmentPlan', 'scheduleInstallments', 'installmentsDue', 'noInstallmentsDue',
        'payInstallment', 'skipInstallment', 'installmentPayConfirmTitle', 'deactivateInstallmentPlan',
      ] as const) {
        expect(catalog.companyFinance[key].length, key).toBeGreaterThan(3)
      }
    }
  })
})
