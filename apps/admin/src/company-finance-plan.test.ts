/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { ownerCombinedTotals } from './screens/CompanyFinanceReview.tsx'

const screen = readFileSync(new URL('./screens/CompanyFund.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./screens/CompanyFinanceReview.tsx', import.meta.url), 'utf8')

describe('finance plan safety and presentation', () => {
  it('combines complete owner and branch totals exactly, never adding currencies', () => {
    expect(ownerCombinedTotals({ SYP_NEW: '72650.00', USD: '22620.00' }, { SYP_NEW: '116000.00', USD: '0.00' })).toEqual({ SYP_NEW: '188650.00', USD: '22620.00' })
    expect(ownerCombinedTotals({ SYP_NEW: '90071992547409.91', USD: '0.01' }, { SYP_NEW: '0.01', USD: '0.02' })).toEqual({ SYP_NEW: '90071992547409.92', USD: '0.03' })
    expect(ownerCombinedTotals({ SYP_NEW: '0.00', USD: '0.00' }, undefined)).toBeNull()
  })
  it('removes the historical creation route, but preserves the imported register', () => {
    const mounted = screen.slice(screen.indexOf('export function CompanyFund'), screen.indexOf('export type MutationOutcome'))
    expect(mounted).not.toContain('<HistoricalMovementsTab')
    expect(mounted).not.toContain('setOperationMode(\'historical\')')
    expect(mounted).toContain('<CompanyHistoricalImportRegister')
    expect(mounted).toContain('<SavedHistoricalDrafts')
    expect(mounted).toContain('<FinanceDialog')
    expect(mounted).not.toContain('historicalLoad')
    expect(mounted).not.toContain("'/company/historical-movements/preflight'")
  })
  it('does not equate zero signed variance with no pending operations', () => {
    expect(screen).toContain('pending === 0 && variance === 0')
    expect(screen).toContain('r.unavailable')
    expect(screen).toContain('branch.unexplainedDifference')
    expect(screen).toContain('r.companyInBranch')
    expect(screen).toContain('r.branchNotLinked')
  })
  it('defaults reports to corrected occurrence and totals the exact filtered money lines', () => {
    const report = screen.slice(screen.indexOf('function CompanyReportsTab'), screen.indexOf('function CompanyEntryTab'))
    expect(report).toContain("useState<CompanyReportView>(initial.view ?? 'current_corrected')")
    expect(report).toContain("useState<CompanyReportDateBasis>(initial.dateBasis ?? 'occurrence')")
    expect(report).toContain("'all=true'")
    expect(report).toContain("companyReportTotals(rows, category === 'custody' ? 'company_custody' : 'company_cash')")
    expect(report).toContain("category === 'custody' ? w.custodyNet : r.reportCashNet")
    expect(report).toContain('companyReportRows(reportRows,')
    expect(report).toContain("row.kind === 'expense' && row.reversed")
    expect(report).toContain('rows.slice(page * 20')
    expect(report).toContain('companyReportCsv({ ...report, rows, detailCategory: category, filters:')
  })
  it('keeps FX fields conditional, technical receipts optional, and request races guarded', () => {
    expect(review).toContain("visibleWhen: { key: 'currency', value: 'USD' }")
    expect(review).toContain('advanced: true, optional: true')
    expect(review).toContain('current === request.current')
    expect(review).toContain('result?.key === key')
    expect(review).toContain('filterFinanceRows(index, filters, today)')
    expect(review).toContain('today={today} kinds=')
    expect(review).toContain('review.reviewEnabled ?? branchReviewEnabled(review.branchId)')
    expect(screen).toContain("current.period === 'custom'")
    expect(screen).toContain('reportDay.current !== today')
  })
  it('uses matching terminology and neutral-card explanation in both catalogues', () => {
    expect(ar.companyFinance.branches).not.toContain('مقاصة')
    for (const catalog of [ar, en]) {
      expect(catalog.financeReview.ownerCombined).toBeTruthy()
      expect(catalog.financeReview.cashNetHint.length).toBeGreaterThan(30)
      expect(catalog.existingAssetReview.previousPayer).toBeTruthy()
    }
  })
})
