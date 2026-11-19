import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { preparePublicSurface } from './fixtures.ts'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import type { CompanyReportRow } from '../apps/admin/src/company-report.ts'
import { companyReportTotals } from '../apps/admin/src/company-report.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
function expense(id: number, description: string, amount: string, extra: Partial<CompanyReportRow> = {}): CompanyReportRow {
  return { id: `journal:${id}`, nature: 'business_event', kind: 'expense', description,
    occurredOn: '2026-09-13', occurredPrecision: 'day', occurredMonth: null, occurrenceSource: 'recorded',
    postingDate: '2026-09-13', latestPostingDate: '2026-09-13', canonicalCommandId: `expense-${id}`, activeCommandId: `expense-${id}`,
    originalEntryId: id, activeEntryId: id, sourceEntryId: null, relatedEntryIds: [id], correctionIds: [], version: 1, reversed: false,
    currency: 'SYP_NEW', grossAmount: amount, netAmount: amount, fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null,
    source: 'pocket', branchId: null, externalReference: `HQ-${id}`, receiptReference: null, sypMinorPerUsd: null, rateBasis: null,
    lines: [{ fundCode: 'company_expense:SYP_NEW:general', currency: 'SYP_NEW', side: 'D', role: null, grossAmount: amount, netAmount: amount },
      { fundCode: 'company_cash:SYP_NEW', currency: 'SYP_NEW', side: 'C', role: null, grossAmount: amount, netAmount: amount }], ...extra }
}

test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: info.project.name === 'admin-mobile' ? 'dark' : 'light' })
  await stubCompanyFund(page)
})

test('current expense detail and CSV omit deletion; audit requires explicit choice and clearly labels retained evidence', async ({ page }, info) => {
  const writes: string[] = []
  page.on('request', req => { if (req.url().includes('/api/') && req.method() !== 'GET') writes.push(req.url()) })
  const active = expense(11, 'صرفية باقية للاختبار', '9.50')
  const deleted = expense(10, 'صرفية محذوفة للاختبار', '10000.00', { auditState: 'deleted_expense', relatedEntryIds: [10, 12] })
  const cancellation = expense(12, 'إلغاء صرفية للاختبار', '10000.00', { kind: 'reversal', auditState: 'expense_deletion',
    occurredOn: '2026-09-14', postingDate: '2026-09-14', latestPostingDate: '2026-09-14',
    lines: deleted.lines.map(line => ({ ...line, side: line.side === 'D' ? 'C' : 'D' })) })
  await page.route('**/api/company/reports?**', route => {
    const q = new URL(route.request().url()).searchParams, current = q.get('view') === 'current_corrected'
    // Include a zeroed legacy response as well: the client must safely handle an older API.
    const legacy = { ...deleted, reversed: true, netAmount: '0.00', lines: deleted.lines.map(line => ({ ...line, netAmount: '0.00' })) }
    const rows = current ? [active, legacy] : [deleted, active, cancellation]
    return route.fulfill({ json: { from: q.get('from'), to: q.get('to'), view: q.get('view'), dateBasis: q.get('dateBasis'),
      generatedAtMs: Date.UTC(2026, 8, 20), periodSemantics: current ? 'current_snapshot_original_posting_anchor' : 'immutable_journals',
      historicalBookCostPolicy: 'not_reclassified', rows, totals: companyReportTotals(rows), occurrenceFallbackCount: 0, journalOnlyCount: 0, pendingRestorationCount: 0 } })
  })
  await page.goto(`${adminUrl}#companyFund?tab=reports&range=custom&from=2026-09-01&to=2026-09-20&report=cost_income`)
  await expect(page.getByLabel('ماذا تريد أن تعرف؟')).toHaveValue('cost_income')
  await expect(page.locator('[data-company-report-row]')).toHaveCount(1)
  await expect(page.locator('[data-company-report-row]')).toContainText('صرفية باقية للاختبار')
  await expect(page.getByText('صرفية محذوفة للاختبار', { exact: true })).toHaveCount(0)
  const exportButton = page.getByRole('button', { name: 'تصدير البيانات المعروضة', exact: true })
  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()])
  const csvPath = info.outputPath('current-expenses.csv'); await download.saveAs(csvPath)
  const csv = await readFile(csvPath, 'utf8')
  expect(csv).toContain('صرفية باقية للاختبار'); expect(csv).not.toContain('صرفية محذوفة للاختبار'); expect(csv).not.toContain('10000.00')
  await page.screenshot({ path: info.outputPath('current-expenses.png'), fullPage: true })
  await page.getByText('خيارات التدقيق المتقدمة', { exact: true }).first().click()
  await page.getByLabel('نسخة التقرير').selectOption('as_booked')
  await expect(page.locator('[data-company-report-row]')).toHaveCount(0)
  await page.getByRole('button', { name: 'عرض التقرير', exact: true }).click()
  await expect(page.locator('[data-company-report-row]')).toHaveCount(3)
  await expect(page.getByText('صرفية محذوفة — للتدقيق فقط', { exact: true })).toBeVisible()
  await expect(page.getByText('قيد إلغاء الصرفية', { exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'هذا سجل التدقيق الأصلي' })).toBeVisible()
  await page.screenshot({ path: info.outputPath('expense-audit.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  expect(writes).toEqual([])
})

test('busy database is a temporary read failure, never an apparent empty balance, and retry recovers locally', async ({ page }, info) => {
  let attempts = 0, recovered = false
  await page.route('**/api/company/custody', route => {
    attempts++
    return route.fulfill(!recovered ? { status: 503, json: { error: 'database_busy' } } : {
      json: { balances: { SYP_NEW: '123.00', USD: '45.00' }, transfers: [] },
    })
  })
  await page.goto(`${adminUrl}#companyFund`)
  const alert = page.getByRole('alert').filter({ hasText: 'تعذّر تحميل البيانات مؤقتاً' })
  await expect(alert).toBeVisible(); await expect(alert).not.toContainText('database_busy')
  await page.screenshot({ path: info.outputPath('temporary-read-failure.png'), fullPage: true })
  recovered = true
  await alert.getByRole('button', { name: 'إعادة المحاولة', exact: true }).click()
  await expect(alert).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'احتياطي الشركة بعهدة المالك', exact: true })).toContainText('123.00')
  expect(attempts).toBeGreaterThanOrEqual(2)
})

test('a retired historical-entry read cannot block the current expense ledger', async ({ page }) => {
  const legacyReads: string[] = []
  await page.route('**/api/company/historical-movements**', route => {
    legacyReads.push(route.request().url())
    return route.fulfill({ status: 503, json: { error: 'database_busy' } })
  })
  await page.route('**/api/company/movements?**', route => route.fulfill({ json: { movements: [], effectiveMovements: [] } }))
  await page.goto(`${adminUrl}#companyFund?tab=movements`)
  await expect(page.getByRole('button', { name: 'السجل الموحد', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(legacyReads).toEqual([])
})
