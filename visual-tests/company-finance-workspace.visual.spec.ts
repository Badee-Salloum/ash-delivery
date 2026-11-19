import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { formatMinor, minor, parseMinor } from '../packages/domain/src/index.ts'
import type { CompanyReportRow } from '../apps/admin/src/company-report.ts'
import { companyReportTotals } from '../apps/admin/src/company-report.ts'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
const branch = 'visual-branch-1'
const movement = (id: number, amount: string, side: 'D' | 'C' = 'D', extra: Partial<CompanyReportRow> = {}): CompanyReportRow => ({
  id: `journal:${id}`, nature: 'business_event', kind: 'branch_receipt', occurredOn: '2026-09-12', occurredPrecision: 'day', occurredMonth: null,
  occurrenceSource: 'recorded', postingDate: '2026-09-12', latestPostingDate: '2026-09-12', canonicalCommandId: null, activeCommandId: null,
  originalEntryId: id, activeEntryId: id, sourceEntryId: null, relatedEntryIds: [id], correctionIds: [], version: 1, reversed: false,
  currency: 'SYP_NEW', grossAmount: amount, netAmount: amount, fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null,
  source: side === 'D' ? 'to_company' : 'from_company', branchId: branch, description: `Synthetic transfer ${id}`, externalReference: `SOURCE-${id}`, receiptReference: null,
  sypMinorPerUsd: null, rateBasis: null, lines: [{ fundCode: 'company_cash:SYP_NEW', currency: 'SYP_NEW', side, grossAmount: amount, netAmount: amount, role: null },
    { fundCode: `branch_clearing:${branch}`, currency: 'SYP_NEW', side: side === 'D' ? 'C' : 'D', grossAmount: amount, netAmount: amount, role: null }], ...extra,
})

async function setup(page: Page) {
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubCompanyFund(page, { existingAsset: true, ownerBranchFunding: true, secondBranch: true })
  await page.route('**/api/company/owner-payments?**', route => {
    const q = new URL(route.request().url()).searchParams, from = q.get('from')!, to = q.get('to')!
    const payments = [
      { id: 'owner-direct', kind: 'expense', currency: 'SYP_NEW', amount: '51000.00', description: 'Synthetic owner expense', occurredOn: '2026-09-18' },
      { id: 'owner-asset', kind: 'asset_payment', currency: 'USD', amount: '1200.00', description: 'Synthetic older motor payment', occurredOn: '2026-07-10' },
    ].filter(row => row.occurredOn >= from && row.occurredOn <= to)
    const branchFundingPayments = [{ id: 'owner-branch', branchNameAr: 'فرع الاختبار', channel: 'cash', currency: 'SYP_NEW', amount: '200000.00', description: 'Synthetic owner branch funding', occurredOn: '2026-09-19' }].filter(row => row.occurredOn >= from && row.occurredOn <= to)
    const total = (items: typeof payments) => Object.fromEntries(['SYP_NEW', 'USD'].map(currency => [currency, formatMinor(minor(items.filter(row => row.currency === currency).reduce((sum, row) => sum + parseMinor(row.amount), 0n)))]))
    return route.fulfill({ json: { from, to, payments, totals: total(payments), expenseTotals: total(payments.filter(row => row.kind === 'expense')),
      capitalAndDebtTotals: total(payments.filter(row => row.kind !== 'expense')), branchFundingPayments,
      branchFundingTotals: total(branchFundingPayments.map(row => ({ ...row, kind: 'branch_funding' }))) } })
  })
  const rows = [movement(11, '5250.00'), movement(12, '100.00', 'D', { occurredOn: '2026-09-13' }), movement(13, '200.00', 'C'),
    movement(99, '5350.00', 'D', { kind: 'company_historical_restoration_reclass', lines: [{ fundCode: `branch_clearing:${branch}`, currency: 'SYP_NEW', side: 'C', grossAmount: '5350.00', netAmount: '5350.00', role: null }] }),
    ...Array.from({ length: 21 }, (_, index) => movement(200 + index, '1.00', 'D', { branchId: 'visual-branch-2', occurredOn: '2026-09-15' }))]
  await page.route('**/api/company/reports?**', route => {
    const q = new URL(route.request().url()).searchParams, from = q.get('all') ? '2026-09-01' : q.get('from')!, to = q.get('to') ?? '2026-09-20'
    const selected = rows.filter(row => row.occurredOn >= from && row.occurredOn <= to)
    return route.fulfill({ json: { from, to, availableFrom: '2026-09-01', generatedAtMs: 0, view: q.get('view'), dateBasis: q.get('dateBasis'),
      periodSemantics: 'current_snapshot_original_posting_anchor', historicalBookCostPolicy: 'not_reclassified', rows: selected, totals: companyReportTotals(selected),
      occurrenceFallbackCount: 0, journalOnlyCount: 1, pendingRestorationCount: 1,
      cashBalances: { SYP_NEW: { opening: '0.00', closing: '5171.00' }, USD: { opening: '0.00', closing: '0.00' } } } })
  })
  await page.route('**/api/company/restoration-reviews', route => route.fulfill({ json: {
    enabled: true, branches: [{ branchId: branch, reviewEnabled: true }],
    proposals: [{ id: 'pending-proposal', branchId: branch, businessDate: '2026-09-18', status: 'pending_review', version: 1, reviewEnabled: true,
      legs: [{ sourceEntryId: 1, amount: '5000.00', direction: 'to_company', fundCode: 'office_cash' }, { sourceEntryId: 2, amount: '5000.00', direction: 'from_company', fundCode: 'office_wallet' }] }],
    linkedHistorical: [{ restorationId: 4, branchId: branch, journalEntryId: 11, occurredOn: '2026-09-12', amount: '5250.00', currency: 'SYP_NEW' },
      { restorationId: 4, branchId: branch, journalEntryId: 12, occurredOn: '2026-09-13', amount: '100.00', currency: 'SYP_NEW' }],
    historicalGroups: [{ restorationId: 4, branchId: branch, businessDate: '2026-09-11', variance: '-38.00', branchSourceEntries: [
      { sourceEntryId: 5, direction: 'to_company', amount: '6000.00' }, { sourceEntryId: 6, direction: 'from_company', amount: '688.00' }] }],
    unlinkedHistorical: [], legacy: [],
  } }))
}

test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('admin-'))
  await setup(page)
})

test('overview keeps review in transfer details, separates balances and owner payments, and loads sections lazily', async ({ page }, info) => {
  const reads: string[] = [], writes: string[] = []
  page.on('request', request => { if (request.method() === 'GET') reads.push(new URL(request.url()).pathname); else writes.push(request.url()) })
  await page.goto(`${adminUrl}#companyFund`)
  const summary = page.locator('[data-transfer-summary="SYP_NEW"]')
  await expect(summary).toContainText('5,371.00'); await expect(summary).toContainText('200.00'); await expect(summary).toContainText('5,171.00')
  expect(reads.some(path => ['/api/company/assets', '/api/company/depreciation', '/api/company/recurring-expenses'].includes(path))).toBe(false)
  await expect(page.getByRole('heading', { name: 'يحتاج مراجعة — جميع الفترات', exact: true })).toHaveCount(0)
  await expect(page.getByText('آخر دفعات المالك في الفترة', { exact: true })).toBeVisible()
  await expect(page.getByText('Synthetic older motor payment', { exact: true })).toHaveCount(0)
  await page.getByRole('main').getByLabel('الفرع', { exact: true }).selectOption(branch)
  await expect(summary).toContainText('5,350.00'); await expect(summary).not.toContainText('5,371.00')
  // One known approved variance is not falsely queued as an unapproved transaction.
  await expect(page.locator('[data-transfer-row]')).toHaveCount(3)
  const pendingRow = page.locator('tr').filter({ hasText: '2026-09-18' }).filter({ has: page.getByRole('button', { name: 'مراجعة العملية', exact: true }) }).first()
  await pendingRow.getByRole('button', { name: 'مراجعة العملية', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText('5,000.00')
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
  await expect(pendingRow.getByRole('button', { name: 'مراجعة العملية', exact: true })).toBeFocused()
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  const path = info.outputPath('finance-overview.png'); await page.screenshot({ path, fullPage: true }); await info.attach('overview', { path, contentType: 'image/png' })
})

test('reports show filtered totals, matching table and full-result readable and audit exports', async ({ page }, info) => {
  await page.goto(`${adminUrl}#companyFund?tab=reports`)
  await page.getByLabel('ماذا تريد أن تعرف؟', { exact: true }).selectOption('branch')
  await expect(page.locator('[data-report-summary="SYP_NEW"]')).toContainText('5,371.00')
  await expect(page.locator('[data-company-report-row]')).toHaveCount(20)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'تصدير البيانات المعروضة', exact: true }).click()
  const exported = await download, csv = await readFile((await exported.path())!, 'utf8')
  expect(csv).toContain('SOURCE-220'); expect(csv).not.toContain('SOURCE-99'); expect(csv).toContain('المقبوض'); expect(csv).toContain('2026-09-01')
  await page.getByRole('main').getByLabel('الفرع', { exact: true }).selectOption(branch)
  await expect(page.locator('[data-report-summary="SYP_NEW"]')).toContainText('5,350.00')
  await expect(page.locator('[data-company-report-row]')).toHaveCount(3)
  await page.locator('[data-report-summary="SYP_NEW"]').getByRole('button', { name: 'عرض عمليات الدفع', exact: true }).click()
  await expect(page.locator('[data-company-report-row]')).toHaveCount(1)
  await expect(page.locator('[data-report-summary="SYP_NEW"]')).toContainText('200.00')
  await expect(page.locator('[data-report-summary="SYP_NEW"]')).not.toContainText('5,350.00')
  await page.getByRole('button', { name: 'عرض كل العمليات', exact: true }).click()
  await page.getByText('خيارات التدقيق المتقدمة', { exact: true }).last().click()
  const auditDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'تنزيل ملف التدقيق التفصيلي', exact: true }).click()
  const audit = await auditDownload, auditCsv = await readFile((await audit.path())!, 'utf8')
  expect(auditCsv).toContain('branch_filter'); expect(auditCsv).toContain(branch)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  const path = info.outputPath('finance-reports.png'); await page.screenshot({ path, fullPage: true }); await info.attach('reports', { path, contentType: 'image/png' })
})

test('asset registration stays behind a short dialog and a failing asset read cannot block reports', async ({ page }) => {
  await page.goto(`${adminUrl}#companyFund?tab=assets`)
  await expect(page.getByRole('row').filter({ hasText: 'Visual motorcycle' })).toBeVisible()
  await expect(page.getByLabel('سعر الشراء', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'إضافة بطاقة موتور', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.route('**/api/company/assets', route => route.fulfill({ status: 503, json: { error: 'database_unavailable' } }))
  await page.getByRole('button', { name: 'شراء جديد وأقساط قائمة', exact: true }).click()
  await page.getByRole('tab', { name: 'التقارير', exact: true }).click()
  await expect(page.locator('[data-report-summary="SYP_NEW"]')).toContainText('5,371.00')
})
