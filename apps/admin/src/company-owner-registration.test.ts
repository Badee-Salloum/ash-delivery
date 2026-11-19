/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { motorRegistrationNextTab } from './screens/CompanyMotorRegistration.tsx'
import { ar, en } from '@ash/client/i18n'

const owner = readFileSync(new URL('./screens/CompanyFinanceReview.tsx', import.meta.url), 'utf8')
const overview = readFileSync(new URL('./screens/CompanyFinanceOverview.tsx', import.meta.url), 'utf8')
const registration = readFileSync(new URL('./screens/CompanyMotorRegistration.tsx', import.meta.url), 'utf8')
describe('complete owner totals and guided motor registration', () => {
  it('reads owner totals from all history and applies dates only to detail rows', () => {
    expect(owner).toContain("const requestedFrom = '2000-01-01', requestedTo = today")
    expect(owner).toContain('filterFinanceRows(index, filters, today)')
    expect(owner).toContain('matched.slice(0, 5)')
    expect(owner).not.toContain('all ? filters.from : from')
    expect(owner).toContain('data-owner-summary')
    expect(owner).toContain('data-owner-detail-filters')
    expect(overview).not.toContain('{valid ? <CompanyOwnerPanel')
    expect(overview).not.toContain('key={`${from}:${to}`} from={from}')
  })
  it('removes the overview review card, not the transfer evidence or correction workflow', () => {
    expect(overview).not.toContain('w.reviewAllTime')
    expect(overview).not.toContain('needsReview.map')
    expect(overview).toContain('data-transfer-row')
    expect(overview).toContain('group.variance')
    expect(overview).toContain('<RestorationReviewPanel')
  })
  it('opens scheduling for unpaid purchases and evidence for paid or partially paid purchases', () => {
    expect(motorRegistrationNextTab('unpaid')).toBe('schedule')
    for (const state of ['paid', 'partial', 'unknown'] as const) expect(motorRegistrationNextTab(state)).toBe('payments')
  })
  it('does not convert a paid checkbox into invented payment evidence or a cash write', () => {
    const payload = registration.slice(registration.indexOf('return { vehicleId:'), registration.indexOf('}} onSaved='))
    expect(payload).not.toContain('paymentState')
    expect(payload).not.toContain('paidNow')
    expect(payload).not.toContain('installmentAmount')
    expect(registration).toContain('initialAmount={saved.values.paymentState')
    expect(registration).toContain('p.confirmFullPaymentNext')
  })
  it('explains cumulative totals and separate payment/schedule confirmation in both languages', () => {
    for (const catalog of [ar, en]) {
      expect(catalog.financeReview.ownerAllHistoryHint.length).toBeGreaterThan(15)
      expect(catalog.financeReview.emptyOwnerPeriod.length).toBeGreaterThan(30)
      expect(catalog.motorPayments.confirmFullPaymentNext.length).toBeGreaterThan(50)
      expect(catalog.motorPayments.addAsExpense.length).toBeGreaterThan(10)
    }
  })
})
