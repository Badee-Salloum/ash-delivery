import { expect, test, type Page } from '@playwright/test'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'

async function stubExpenses(page: Page, options: { delayed?: boolean; fail?: boolean; delayedExport?: boolean } = {}) {
  await stubCompanyFund(page, { secondBranch: true })
  const reads: URL[] = []
  const writes: string[] = []
  page.on('request', (request) => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url()) })
  const records = Array.from({ length: 52 }, (_, index) => ({
    id: `expense-${String(index).padStart(3, '0')}`, branchId: 'visual-branch-1', categoryId: index === 0 ? 'inactive' : 'fuel',
    categoryNameAr: index === 0 ? 'فئة تاريخية' : 'بنزين', costCenterKind: index === 1 ? 'vehicle' : 'general',
    vehicleId: index === 1 ? 'vehicle-1' : null, vehicleCode: index === 1 ? 'D12' : null,
    channel: index === 1 ? 'office_wallet' : 'office_cash', receiptMediaId: index === 1 ? 'receipt-1' : null,
    amount: '1.01', businessDate: '2026-09-20', description: index === 1 ? 'صيانة خاصة للموتور' : `صرفية اختبار ${index}`,
    journalEntryId: index + 1, createdBy: 'visual-user', advanceId: null,
  }))
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()), path = url.pathname
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/api/dashboard/meta') return fulfill({ today: '2026-10-04', goLiveBusinessDate: '2026-08-30', firstActivityDate: '2026-08-30', epoch: '2026-08-30', weekStart: '2026-10-04', monthStart: '2026-10-01', dayStartMinutes: 240 })
    if (path === '/api/expense-categories') return fulfill({ categories: [
      { id: 'fuel', code: 'fuel', nameAr: 'بنزين', active: true }, { id: 'inactive', code: 'old', nameAr: 'فئة تاريخية', active: false },
    ] })
    if (path === '/api/vehicles') return fulfill({ vehicles: [{ id: 'vehicle-1', code: 'D12' }] })
    if (path === '/api/income-categories') return fulfill({ categories: [] })
    if (path === '/api/advances') return fulfill({ parties: [], advances: [], total: '0.00' })
    if (path === '/api/incomes') return fulfill({ incomes: [], total: '0.00' })
    if (path === '/api/expenses' || path === '/api/expenses/export') {
      reads.push(url)
      if (options.fail) return fulfill({ error: 'invalid_request' }, 400)
      if (options.delayedExport && path.endsWith('/export')) await new Promise((resolve) => setTimeout(resolve, 300))
      if (options.delayed && url.searchParams.get('q') === 'قديم') await new Promise((resolve) => setTimeout(resolve, 300))
      let filtered = records.filter((row) => {
        const q = url.searchParams.get('q')
        const category = url.searchParams.get('categoryId'), centre = url.searchParams.get('costCenterKind'), channel = url.searchParams.get('channel'), vehicle = url.searchParams.get('vehicleId'), receipt = url.searchParams.get('receipt')
        return (!q || row.description.includes(q)) && (!category || row.categoryId === category) && (!centre || (centre === 'operating' ? row.costCenterKind !== 'vehicle' : row.costCenterKind === centre)) && (!channel || row.channel === channel) && (!vehicle || row.vehicleId === vehicle) && (!receipt || (receipt === 'with') === Boolean(row.receiptMediaId))
      })
      if (url.searchParams.get('branchId') === 'visual-branch-2') filtered = []
      const count = filtered.length, offset = path.endsWith('/export') ? 0 : Number(url.searchParams.get('offset') ?? '0'), limit = path.endsWith('/export') ? null : Number(url.searchParams.get('limit') ?? '50')
      return fulfill({ branchId: url.searchParams.get('branchId'), from: url.searchParams.get('all') ? '2026-07-08' : url.searchParams.get('from'), to: url.searchParams.get('to'), earliestBusinessDate: '2026-07-08', currency: 'SYP_NEW', totalBasis: 'recorded_expense_rows', expenses: limit === null ? filtered : filtered.slice(offset, offset + limit), total: (count * 1.01).toFixed(2), count, offset, limit, generatedAt: '2026-10-04T12:00:00.000Z' })
    }
    return route.fallback()
  })
  return { reads, writes }
}

test('branch filters preserve dashboard period, page totals, inactive categories and a complete export', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: testInfo.project.name === 'admin-mobile' ? 'dark' : 'light' })
  const { reads, writes } = await stubExpenses(page)
  await page.goto(`${adminUrl}#expenses?range=custom&from=2026-08-30&to=2026-10-03`)
  const card = page.locator('section').filter({ has: page.getByLabel('تصفية حسب الفئة') })
  await expect(card.locator('tbody tr')).toHaveCount(50)
  expect(reads.at(-1)?.searchParams.get('from')).toBe('2026-08-30')
  expect(reads.at(-1)?.searchParams.get('to')).toBe('2026-10-03')
  await expect(card).toContainText('52.52')
  await card.getByRole('button', { name: 'التالي', exact: true }).click()
  await expect(card.locator('tbody tr')).toHaveCount(2)
  await expect(card).toContainText('52.52')
  await expect(page).toHaveURL(/page=2/)
  const downloadPromise = page.waitForEvent('download')
  await card.getByRole('button', { name: 'تصدير كل النتائج CSV' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('branch-expenses-2026-08-30-2026-10-03.csv')
  expect(reads.at(-1)?.pathname).toBe('/api/expenses/export')
  expect(reads.at(-1)?.searchParams.has('offset')).toBe(false)
  await page.getByLabel('تصفية حسب الفئة').selectOption('inactive')
  await expect(card.locator('tbody tr')).toHaveCount(1)
  await expect(card).toContainText('فئة تاريخية')
  expect(reads.at(-1)?.searchParams.get('categoryId')).toBe('inactive')
  const recording = page.locator('section').filter({ has: page.getByRole('heading', { name: 'تسجيل حركة مالية', exact: true }) })
  if (await recording.count()) await expect(recording.locator('option[value="inactive"]')).toHaveCount(0)
  await card.getByRole('button', { name: 'فلاتر إضافية' }).click()
  await expect(page.getByLabel('أقل مبلغ — ليرة جديدة')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('branch-expense-filters.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(writes).toHaveLength(0)
})

test('combined expense filters are sent to the API and slow old results cannot replace the latest search', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const { reads, writes } = await stubExpenses(page, { delayed: true })
  await page.goto(`${adminUrl}#expenses?range=custom&from=2026-08-30&to=2026-10-03&costCenterKind=vehicle&vehicle=vehicle-1&expenseChannel=office_wallet&receipt=with`)
  const card = page.locator('section').filter({ has: page.getByLabel('تصفية حسب الفئة') })
  await expect(card.locator('tbody tr')).toHaveCount(1)
  expect(reads.at(-1)?.searchParams.get('vehicleId')).toBe('vehicle-1')
  expect(reads.at(-1)?.searchParams.get('channel')).toBe('office_wallet')
  const search = page.getByLabel('بحث في الوصف أو مرجع الصرفية')
  await search.fill('قديم')
  await expect.poll(() => reads.some((url) => url.searchParams.get('q') === 'قديم')).toBe(true)
  await search.fill('صيانة')
  await expect(card.locator('tbody tr')).toHaveCount(1)
  await expect(card).toContainText('صيانة خاصة للموتور')
  await page.waitForTimeout(400)
  await expect(card.locator('tbody tr')).toHaveCount(1)
  await page.getByLabel('أقل مبلغ — ليرة جديدة').fill('20')
  await page.getByLabel('أكبر مبلغ — ليرة جديدة').fill('10')
  await expect(card.getByRole('alert')).toContainText('أقل مبلغ يجب ألا يتجاوز أكبر مبلغ')
  await expect(card.getByRole('button', { name: 'تصدير كل النتائج CSV' })).toBeDisabled()
  expect(writes).toHaveLength(0)
})

test('read errors are not empty expense records or stale totals', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubExpenses(page, { fail: true })
  await page.goto(`${adminUrl}#expenses?range=custom&from=2026-08-30&to=2026-10-03`)
  const card = page.locator('section').filter({ has: page.getByLabel('تصفية حسب الفئة') })
  await expect(card.getByRole('alert')).toBeVisible()
  await expect(card.locator('table')).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'تصدير كل النتائج CSV' })).toBeDisabled()
  await expect(card).not.toContainText('52.52')
})

test('changing branch clears the old branch result and changing export scope cancels a stale download', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'admin-desktop')
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const { reads, writes } = await stubExpenses(page, { delayedExport: true })
  const downloads: string[] = []
  page.on('download', (download) => downloads.push(download.suggestedFilename()))
  await page.goto(`${adminUrl}#expenses?range=custom&from=2026-08-30&to=2026-10-03`)
  const card = page.locator('section').filter({ has: page.getByLabel('تصفية حسب الفئة') })
  await expect(card.locator('tbody tr')).toHaveCount(50)
  await card.getByRole('button', { name: 'تصدير كل النتائج CSV' }).click()
  await expect.poll(() => reads.some((url) => url.pathname.endsWith('/export'))).toBe(true)
  await page.getByLabel('تصفية حسب الفئة').selectOption('inactive')
  await expect(card.locator('tbody tr')).toHaveCount(1)
  await page.waitForTimeout(400)
  expect(downloads).toHaveLength(0)
  await page.getByLabel('الفرع', { exact: true }).selectOption('visual-branch-2')
  await expect(card).toContainText('0.00')
  await expect(card.locator('tbody tr')).toHaveCount(1) // the single empty-state row, not a financial record
  await expect(card.locator('tbody')).not.toContainText('صرفية اختبار')
  expect(reads.at(-1)?.searchParams.get('branchId')).toBe('visual-branch-2')
  expect(writes).toHaveLength(0)
})
