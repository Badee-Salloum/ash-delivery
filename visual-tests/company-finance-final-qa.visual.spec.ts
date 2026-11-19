import { readFile } from 'node:fs/promises'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
const variants = [
  {
    project: 'admin-desktop', language: 'en' as const, appearance: 'light' as const,
    labels: {
      historical: 'Record a historical movement', occurredOn: 'Occurred on', postedOn: 'Posted on',
      amount: 'Amount', description: 'Description', submitHistorical: 'Record historical movement',
      retryTitle: 'Not saved; the fields and retry key are retained.', retry: 'Try again',
      uncertain: 'The previous attempt has an uncertain outcome. Retry the same request before changing it.',
      expired: 'Your session ended — please sign in again',
      reports: 'Reports', from: 'From date', to: 'To date', export: 'Export displayed data',
      postingBasis: 'Book figures use posting dates; today’s correction never rewrites a closed past period.',
      ownerBasis: 'Owner payments below use actual occurrence dates and may differ from the posting period above.',
      bookExpense: 'Total book expense', companyExpense: 'Expense funded by company cash or reserve', ownerExpense: 'Owner-funded expenses',
      toCompany: 'Branch to company', fromCompany: 'Company to branch', cashImpact: 'Company cash impact',
      rawCash: 'Cash impact from the posted journal', amountBasis: 'Amount basis', currency: 'SYP',
      journalOnly: 'Journal-only fact', reportDetails: 'Report rows and audit details',
    },
  },
  {
    project: 'admin-mobile', language: 'ar' as const, appearance: 'dark' as const,
    labels: {
      historical: 'إدخال حركة مالية سابقة', occurredOn: 'تاريخ حدوث العملية', postedOn: 'تاريخ الترحيل',
      amount: 'المبلغ', description: 'الوصف', submitHistorical: 'تسجيل الحركة السابقة',
      retryTitle: 'لم يتم الحفظ؛ البيانات ومفتاح إعادة المحاولة محفوظان.', retry: 'إعادة المحاولة',
      uncertain: 'نتيجة المحاولة السابقة غير مؤكدة. أعد الطلب نفسه قبل تغيير بياناته.',
      expired: 'انتهت الجلسة — سجّل الدخول من جديد',
      reports: 'التقارير', from: 'من تاريخ', to: 'إلى تاريخ', export: 'تصدير البيانات المعروضة',
      postingBasis: 'أرقام الدفاتر حسب تاريخ الترحيل؛ تصحيح اليوم لا يعيد كتابة فترة قديمة مغلقة.',
      ownerBasis: 'مدفوعات المالك أدناه حسب تاريخ حدوث الدفع؛ قد تختلف عن فترة الترحيل أعلاه.',
      bookExpense: 'إجمالي المصروف الدفتري', companyExpense: 'مصروف ممول من صندوق الشركة أو الاحتياطي', ownerExpense: 'صرفيات مدفوعة من المالك',
      toCompany: 'من الفرع إلى الشركة', fromCompany: 'من الشركة إلى الفرع', cashImpact: 'أثر صندوق الشركة',
      rawCash: 'أثر نقدي من القيد المسجل', amountBasis: 'طبيعة القيمة', currency: 'ل.س',
      journalOnly: 'واقعة من القيد فقط', reportDetails: 'صفوف التقرير وتفاصيل التدقيق',
    },
  },
]

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
}

function quotedCsvCells(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1]!.replaceAll('""', '"'))
}

for (const variant of variants) {
  test(`historical review precedes POST and exact pending request survives reload — ${variant.project}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000)
    test.skip(testInfo.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page)
    let aborted = false
    await page.route('**/api/company/historical-movements', async route => {
      if (route.request().method() === 'POST' && !aborted) {
        aborted = true
        await route.abort('connectionreset')
        return
      }
      await route.fallback()
    })
    const posts: Array<Record<string, unknown>> = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/company/historical-movements') posts.push(request.postDataJSON() as Record<string, unknown>)
    })
    await page.goto(`${adminUrl}#companyFund?tab=historical`)
    const entry = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.historical, exact: true }) })
    await entry.getByLabel(variant.labels.occurredOn, { exact: true }).fill('2026-07-28')
    await entry.getByLabel(variant.labels.amount, { exact: true }).fill('708000')
    await entry.getByLabel(variant.labels.description, { exact: true }).fill('Visual historical kaish')
    await entry.getByRole('button', { name: variant.labels.submitHistorical, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: variant.labels.historical, exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(variant.labels.occurredOn)
    await expect(dialog).toContainText(variant.labels.postedOn)
    await expect(dialog).toContainText('2026-07-28')
    await expect(dialog).toContainText('2026-09-20')
    expect(posts).toHaveLength(0)
    await capture(page, testInfo, 'historical-confirmation-before-post')
    await dialog.getByRole('button', { name: variant.labels.submitHistorical, exact: true }).click()
    const retry = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.retryTitle, exact: true }) })
    await expect(retry.getByText(variant.labels.uncertain, { exact: true })).toBeVisible()
    await expect(entry.getByLabel(variant.labels.amount, { exact: true })).toBeDisabled()
    expect(posts).toHaveLength(1)
    const original = posts[0]!
    expect(original).toMatchObject({ type: 'deposit', occurredOn: '2026-07-28', occurredPrecision: 'day',
      amount: '708000.00', currency: 'SYP_NEW', description: 'Visual historical kaish' })
    expect(original.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(original).not.toHaveProperty('externalReference')
    expect(original).not.toHaveProperty('receiptReference')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(retry.getByText('Visual historical kaish', { exact: true })).toBeVisible()
    await expect(retry).toContainText('2026-07-28')
    await expect(retry).toContainText('708000.00')
    // Reloaded controls have their default date/empty amount; retry must use the persisted body,
    // never reconstruct a different fact from these disabled controls.
    await expect(entry.getByLabel(variant.labels.amount, { exact: true })).toHaveValue('')
    await expect(entry.getByLabel(variant.labels.occurredOn, { exact: true })).toHaveValue('2026-09-20')
    await expect(entry.getByLabel(variant.labels.amount, { exact: true })).toBeDisabled()
    await capture(page, testInfo, 'historical-persisted-retry-after-reload')
    await retry.getByRole('button', { name: variant.labels.retry, exact: true }).click()
    await expect.poll(() => posts.length).toBe(2)
    expect(posts[1]).toEqual(original)
    await expect(retry).toHaveCount(0)
    await expect(entry.getByLabel(variant.labels.amount, { exact: true })).toBeEnabled()
    expect(await page.evaluate(() => sessionStorage.getItem('ash.historical-request:visual-system-admin:HQ'))).toBeNull()
  })

  test(`expired session preserves historical request for exact retry after session restoration — ${variant.project}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000)
    test.skip(testInfo.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page)
    let expired = false
    await page.route('**/api/company/historical-movements', async route => {
      if (route.request().method() === 'POST' && !expired) {
        expired = true
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) })
        return
      }
      await route.fallback()
    })
    const posts: Array<Record<string, unknown>> = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/company/historical-movements') posts.push(request.postDataJSON() as Record<string, unknown>)
    })
    await page.goto(`${adminUrl}#companyFund?tab=historical`)
    const entry = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.historical, exact: true }) })
    await entry.getByLabel(variant.labels.occurredOn, { exact: true }).fill('2026-07-28')
    await entry.getByLabel(variant.labels.amount, { exact: true }).fill('708000')
    await entry.getByLabel(variant.labels.description, { exact: true }).fill('Visual session-expiry historical request')
    await entry.getByRole('button', { name: variant.labels.submitHistorical, exact: true }).click()
    await page.getByRole('dialog', { name: variant.labels.historical, exact: true }).getByRole('button', { name: variant.labels.submitHistorical, exact: true }).click()
    await expect(page.getByText(variant.labels.expired, { exact: true })).toBeVisible()
    expect(posts).toHaveLength(1)
    const original = posts[0]!
    const stored = await page.evaluate(() => sessionStorage.getItem('ash.historical-request:visual-system-admin:HQ'))
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored!)).toEqual(original)
    // The sealed /me fixture models a renewed session on reload; no real sign-in is performed.
    await page.reload({ waitUntil: 'domcontentloaded' })
    const retry = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.retryTitle, exact: true }) })
    await expect(retry.getByText('Visual session-expiry historical request', { exact: true })).toBeVisible()
    await capture(page, testInfo, 'historical-session-expiry-preserved-retry')
    await retry.getByRole('button', { name: variant.labels.retry, exact: true }).click()
    await expect.poll(() => posts.length).toBe(2)
    expect(posts[1]).toEqual(original)
    await expect(retry).toHaveCount(0)
    expect(await page.evaluate(() => sessionStorage.getItem('ash.historical-request:visual-system-admin:HQ'))).toBeNull()
  })

  test(`report period, raw HQ cash transfers and both exchange sides in CSV — ${variant.project}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page, { reportingBreakdown: true, rawHeadquartersTransfers: true })
    const reads: URL[] = []
    page.on('request', request => { if (request.method() === 'GET') reads.push(new URL(request.url())) })
    await page.goto(`${adminUrl}#companyFund?tab=reports`)
    const report = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.reports, exact: true }) })
    await expect(report.getByText(variant.labels.postingBasis, { exact: true })).toBeVisible()
    await expect(page.getByText(variant.labels.ownerBasis, { exact: true })).toBeVisible()
    await expect(report.getByText(variant.labels.bookExpense, { exact: true })).toHaveCount(2)
    await expect(report.getByText(variant.labels.companyExpense, { exact: true })).toHaveCount(2)
    await expect(report.getByText(variant.labels.ownerExpense, { exact: true })).toHaveCount(2)
    await report.getByLabel(variant.labels.from, { exact: true }).fill('2026-09-10')
    await report.getByLabel(variant.labels.to, { exact: true }).fill('2026-09-19')
    for (const path of ['/api/company/reports', '/api/company/owner-payments']) {
      await expect.poll(() => reads.some(url => url.pathname === path && url.searchParams.get('from') === '2026-09-10' && url.searchParams.get('to') === '2026-09-19')).toBe(true)
    }
    await expect.poll(() => reads.some(url => url.pathname === '/api/company/reports' && url.searchParams.get('view') === 'as_booked' && url.searchParams.get('dateBasis') === 'posting' && url.searchParams.get('from') === '2026-09-10')).toBe(true)
    await expect(report.getByRole('button', { name: variant.labels.export, exact: true })).toBeEnabled()
    for (const [description, amount, direction] of [
      ['Visual branch receipt', '8,420.00', variant.labels.toCompany],
      ['Visual outgoing branch transfer', '-2,750.50', variant.labels.fromCompany],
    ]) {
      const row = page.locator('article[data-company-report-row]').filter({ hasText: description })
      await expect(row).toHaveCount(1)
      await row.locator('summary').click()
      await expect(row).toContainText(direction!)
      await expect(row).toContainText(variant.labels.journalOnly)
      await expect(row).toContainText(amount!)
      await expect(row).toContainText(variant.labels.currency)
      await expect(row).toContainText('visual-branch-1')
    }
    await capture(page, testInfo, 'finance-report-period-and-funding-sources')
    const [download] = await Promise.all([
      page.waitForEvent('download'), report.getByRole('button', { name: variant.labels.export, exact: true }).click(),
    ])
    expect(download.suggestedFilename()).toBe('company-finance-as_booked-posting-2026-09-10-2026-09-19.csv')
    const path = testInfo.outputPath('company-finance-report.csv')
    await download.saveAs(path)
    const csv = await readFile(path, 'utf8')
    await testInfo.attach('company-finance-report', { path, contentType: 'text/csv' })
    const lines = csv.split(/\r?\n/)
    const header = quotedCsvCells(lines[0]!.replace(/^\ufeff/, ''))
    expect(header).toHaveLength(48)
    const cells = lines.slice(1).map(quotedCsvCells)
    const column = (name: string): number => header.indexOf(name)
    for (const name of ['occurred_on', 'original_posting_date', 'latest_posting_date', 'line_side', 'line_signed_net_amount', 'canonical_audit_reference', 'correction_ids']) expect(column(name)).toBeGreaterThanOrEqual(0)
    const exchanges = cells.filter(line => line[column('description')] === 'Visual fixture exchange')
    expect(exchanges).toHaveLength(4)
    for (const exchange of exchanges) {
      expect(exchange[column('report_view')]).toBe('as_booked')
      expect(exchange[column('date_basis')]).toBe('posting')
      expect(exchange[column('period_semantics')]).toBe('immutable_journals')
      expect(exchange[column('period_from')]).toBe('2026-09-10')
      expect(exchange[column('period_to')]).toBe('2026-09-19')
      expect(exchange[column('from_currency')]).toBe('USD')
      expect(exchange[column('from_gross_amount')]).toBe('100.00')
      expect(exchange[column('to_currency')]).toBe('SYP_NEW')
      expect(exchange[column('to_gross_amount')]).toBe('15000.00')
      expect(exchange[column('frozen_syp_minor_per_usd')]).toBe('15000')
      expect(exchange[column('canonical_audit_reference')]).toBe('VISUAL-REPORT-EXCHANGE')
    }
    expect(exchanges.filter(line => line[column('fund_code')] === 'company_cash:USD')[0]![column('line_signed_net_amount')]).toBe('-100.00')
    expect(exchanges.filter(line => line[column('fund_code')] === 'company_cash:SYP_NEW')[0]![column('line_signed_net_amount')]).toBe('15000.00')
    for (const [description, amount] of [
      ['Visual branch receipt', '8420.00'], ['Visual outgoing branch transfer', '-2750.50'],
    ]) {
      const rows = cells.filter(line => line[column('description')] === description)
      expect(rows).toHaveLength(2)
      const cash = rows.find(line => line[column('fund_code')] === 'company_cash:SYP_NEW')!
      expect(cash[column('row_nature')]).toBe('journal_only')
      expect(cash[column('line_currency')]).toBe('SYP_NEW')
      expect(cash[column('line_signed_net_amount')]).toBe(amount)
      expect(cash[column('branch_id')]).toBe('visual-branch-1')
    }
  })
}
