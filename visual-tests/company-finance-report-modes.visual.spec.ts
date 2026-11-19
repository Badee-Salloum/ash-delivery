import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { expect, test, type Route } from '@playwright/test'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
const variants = [
  { project: 'admin-desktop', language: 'en' as const, appearance: 'light' as const, viewLabel: 'Report view', basisLabel: 'Filter dates by', exportLabel: 'Export displayed data', fromLabel: 'From date', ownerTitle: 'Owner-funded expenses and payments',
    currentText: 'Current snapshot, not a past-period trial balance. Each event appears once at its original posting date, or its current corrected occurrence date. No closed book period is rewritten.' },
  { project: 'admin-mobile', language: 'ar' as const, appearance: 'dark' as const, viewLabel: 'نسخة التقرير', basisLabel: 'تصفية التواريخ حسب', exportLabel: 'تصدير البيانات المعروضة', fromLabel: 'من تاريخ', ownerTitle: 'المصاريف والمدفوعات من جيب المالك',
    currentText: 'عرض حالي وليس ميزان فترة سابقة. تظهر كل عملية مرة واحدة حسب تاريخ ترحيلها الأصلي أو تاريخ حدوثها المصحح الحالي. لا تتغير دفاتر الفترات المغلقة.' },
]
const total = { debits: '0.00', credits: '0.00', cashNet: '0.00', income: '0.00', expense: '0.00', companyFundedExpense: '0.00', ownerOutsideExpense: '0.00', otherBookExpense: '0.00' }

function reportFor(url: URL) {
  const current = url.searchParams.get('view') === 'current_corrected'
  const amount = current ? '35.00' : '20.00'
  return { from: url.searchParams.get('from'), to: url.searchParams.get('to'), view: current ? 'current_corrected' : 'as_booked', dateBasis: url.searchParams.get('dateBasis'),
    generatedAtMs: Date.UTC(2026, 8, 20), periodSemantics: current ? 'current_snapshot_original_posting_anchor' : 'immutable_journals', historicalBookCostPolicy: 'not_reclassified',
    totals: { SYP_NEW: { ...total, debits: amount, credits: amount, cashNet: current ? '0.00' : '-20.00', expense: amount, companyFundedExpense: current ? '0.00' : '20.00', ownerOutsideExpense: current ? '35.00' : '0.00' }, USD: total },
    rows: [{ id: current ? 'command:original' : 'journal:17', nature: 'business_event', kind: 'expense', description: current ? 'Corrected current payment' : 'Original booked payment',
      occurredOn: current ? '2025-03-02' : '2025-02-10', occurredPrecision: 'day', occurredMonth: null, occurrenceSource: 'recorded', postingDate: '2026-07-21', latestPostingDate: current ? '2026-07-28' : '2026-07-21',
      canonicalCommandId: 'original', activeCommandId: current ? 'replacement' : 'original', originalEntryId: 17, activeEntryId: current ? 21 : 17, sourceEntryId: null,
      relatedEntryIds: current ? [17, 20, 21] : [17], correctionIds: current ? ['correction-1'] : [], version: current ? 2 : 1, reversed: false,
      currency: 'SYP_NEW', grossAmount: amount, netAmount: amount, fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null, source: current ? 'owner_outside' : 'pocket', branchId: null,
      externalReference: 'HQ-HIST-ORIGINAL', receiptReference: 'SOURCE-RECEIPT', sypMinorPerUsd: null, rateBasis: null,
      lines: [{ fundCode: 'company_expense:SYP_NEW:general', currency: 'SYP_NEW', side: 'D', role: 'expense_cost', grossAmount: amount, netAmount: amount },
        { fundCode: current ? 'company_equity:SYP_NEW:owner_funding' : 'company_cash:SYP_NEW', currency: 'SYP_NEW', side: 'C', role: 'expense_paid', grossAmount: amount, netAmount: amount }] }],
    occurrenceFallbackCount: 0, journalOnlyCount: 0, pendingRestorationCount: 1 }
}

for (const variant of variants) test(`report basis switch never exports stale rows and retains canonical corrections — ${variant.project}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== variant.project)
  await preparePublicSurface(page, variant); await stubCompanyFund(page)
  const writes: string[] = [], reads: URL[] = [], held: Route[] = []
  let hold = false
  page.on('request', request => { const url = new URL(request.url()); if (request.method() === 'GET') reads.push(url); else if (url.pathname.startsWith('/api/')) writes.push(url.pathname) })
  await page.route('**/api/company/reports?**', async route => {
    if (hold) { held.push(route); return }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(reportFor(new URL(route.request().url()))) })
  })
  await page.goto(`${adminUrl}#companyFund?tab=reports`)
  const exporter = page.getByRole('button', { name: variant.exportLabel, exact: true })
  await expect(page.locator('[data-company-report-row]')).toContainText('Original booked payment')
  await expect(page.getByLabel(variant.viewLabel)).toHaveValue('as_booked')
  await expect(page.getByLabel(variant.basisLabel)).toHaveValue('posting')
  hold = true
  await page.getByLabel(variant.viewLabel).selectOption('current_corrected')
  await expect.poll(() => held.length).toBe(1)
  await expect(exporter).toBeDisabled()
  await expect(page.locator('[data-company-report-row]')).toHaveCount(0)
  hold = false
  for (const route of held.splice(0)) await route.fulfill({ contentType: 'application/json', body: JSON.stringify(reportFor(new URL(route.request().url()))) })
  await expect(page.locator('[data-company-report-row]')).toHaveCount(1)
  await expect(page.locator('[data-company-report-row]')).toContainText('Corrected current payment')
  await expect(page.getByText(variant.currentText, { exact: true })).toBeVisible()
  await page.getByLabel(variant.basisLabel).selectOption('occurrence')
  await expect.poll(() => reads.some(url => url.pathname === '/api/company/reports' && url.searchParams.get('view') === 'current_corrected' && url.searchParams.get('dateBasis') === 'occurrence')).toBe(true)
  await expect(exporter).toBeEnabled()
  await page.locator('[data-company-report-row] summary').click()
  await expect(page.locator('[data-company-report-row]')).toContainText('HQ-HIST-ORIGINAL')
  await expect(page.locator('[data-company-report-row]')).toContainText('correction-1')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  const screenshot = testInfo.outputPath('report-current-occurrence-with-audit-details.png')
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' }); await testInfo.attach('report-current-occurrence', { path: screenshot, contentType: 'image/png' })
  const permanentArtifacts = 'outputs/finance-report-qa-20261003'
  await mkdir(permanentArtifacts, { recursive: true })
  await copyFile(screenshot, `${permanentArtifacts}/current-occurrence-${variant.project}.png`)
  const [download] = await Promise.all([page.waitForEvent('download'), exporter.click()])
  expect(download.suggestedFilename()).toBe('company-finance-current_corrected-occurrence-2000-01-01-2026-09-20.csv')
  const csvPath = testInfo.outputPath('current-occurrence-audit.csv'); await download.saveAs(csvPath)
  await copyFile(csvPath, `${permanentArtifacts}/current-occurrence-${variant.project}.csv`)
  const csv = await readFile(csvPath, 'utf8')
  expect(csv).toContain('"report_view","date_basis","period_semantics"')
  expect(csv.match(/"HQ-HIST-ORIGINAL"/g)).toHaveLength(2)
  expect(csv.match(/"current_corrected","occurrence"/g)).toHaveLength(2)
  expect(csv).toContain('"17|20|21","correction-1","2"')
  await expect(page.getByRole('heading', { name: variant.ownerTitle, exact: true })).toBeVisible()
  await page.getByLabel(variant.fromLabel, { exact: true }).fill('2040-01-01')
  await expect(exporter).toBeDisabled()
  await expect(page.locator('[data-company-report-row]')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: variant.ownerTitle, exact: true })).toHaveCount(0)
  expect(writes).toEqual([])
})
