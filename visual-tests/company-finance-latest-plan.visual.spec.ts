import { expect, test } from '@playwright/test'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'

for (const width of [360, 390, 768, 1440]) {
  for (const appearance of ['light', 'dark'] as const) {
    test(`latest finance plan Arabic ${width}px ${appearance}`, async ({ page }, info) => {
      test.skip(info.project.name !== 'admin-desktop')
      await page.setViewportSize({ width, height: 900 })
      await preparePublicSurface(page, { language: 'ar', appearance })
      await stubCompanyFund(page, { expenseForCorrection: true, ownerBranchFunding: true })
      const writes: string[] = []
      page.on('request', request => { if (['POST', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()) })
      await page.goto(`${adminUrl}#companyFund?tab=historical`)
      await expect(page.getByRole('button', { name: 'إدخال حركة مالية سابقة', exact: true })).toHaveCount(0)
      await expect(page.getByRole('tab', { name: 'العمليات', exact: true })).toHaveAttribute('aria-selected', 'true')
      await page.getByRole('button', { name: 'تعديل', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'تعديل العملية', exact: true })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('القيمة المقترحة', { exact: true })).toBeVisible()
      await expect(dialog.getByLabel('سعر الصرف التاريخي', { exact: true })).toHaveCount(0)
      await dialog.getByLabel('العملة', { exact: true }).selectOption('USD')
      await expect(dialog.getByLabel('سعر الصرف التاريخي', { exact: true })).toBeVisible()
      const bounds = await dialog.boundingBox()
      expect(bounds?.y).toBeGreaterThanOrEqual(0)
      expect(bounds?.x).toBeGreaterThanOrEqual(0)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'تعديل', exact: true })).toBeFocused()
      await page.getByRole('tab', { name: 'نظرة عامة', exact: true }).click()
      const pocketTile = page.getByText('جيب الليرة السورية', { exact: true }).locator('..')
      const tileBounds = await pocketTile.boundingBox(), moneyBounds = await pocketTile.locator('span[dir="ltr"]').first().boundingBox()
      expect(tileBounds).not.toBeNull(); expect(moneyBounds).not.toBeNull()
      expect(moneyBounds!.x).toBeGreaterThanOrEqual(tileBounds!.x)
      expect(moneyBounds!.x + moneyBounds!.width).toBeLessThanOrEqual(tileBounds!.x + tileBounds!.width)
      await expect(page.getByText('إجمالي المدفوعات المباشرة وتمويل الفرع', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'عرض جميع الدفعات', exact: true }).click()
      await expect(page.getByText('عدد النتائج:').first()).toBeVisible()
      expect(writes).toHaveLength(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      const path = info.outputPath(`finance-${width}-${appearance}.png`)
      await page.screenshot({ path, fullPage: true, animations: 'disabled' })
      await info.attach('finance overview', { path, contentType: 'image/png' })
    })
  }
}

test('reports require applying changed period and never export stale data', async ({ page }, info) => {
  test.skip(info.project.name !== 'admin-desktop')
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubCompanyFund(page, { reportingBreakdown: true })
  const reads: URL[] = []
  page.on('request', request => { if (request.method() === 'GET') reads.push(new URL(request.url())) })
  await page.goto(`${adminUrl}#companyFund?tab=reports`)
  await expect.poll(() => reads.some(url => url.pathname === '/api/company/reports' && url.searchParams.get('from') === '2026-09-01' && url.searchParams.get('view') === 'current_corrected' && url.searchParams.get('dateBasis') === 'occurrence')).toBe(true)
  await expect(page.getByText('حركة صندوق الشركة', { exact: true }).first()).toBeVisible()
  await page.getByLabel('الفترة', { exact: true }).selectOption('custom')
  await page.getByLabel('من تاريخ', { exact: true }).fill('2026-09-10')
  await page.getByLabel('إلى تاريخ', { exact: true }).fill('2026-09-19')
  await expect(page.getByText('تغيرت الخيارات؛ اضغط «عرض التقرير» لتحميل النتائج المطابقة.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'تصدير البيانات المعروضة', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'عرض التقرير', exact: true }).click()
  await expect.poll(() => reads.some(url => url.pathname === '/api/company/reports' && url.searchParams.get('from') === '2026-09-10' && url.searchParams.get('to') === '2026-09-19')).toBe(true)
  await expect(page.getByRole('button', { name: 'تصدير البيانات المعروضة', exact: true })).toBeEnabled()
})

test('an imported owner payment previews a currency correction without cash mutation', async ({ page }, info) => {
  test.skip(info.project.name !== 'admin-desktop')
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubCompanyFund(page)
  const before = { currency: 'SYP_NEW', amount: '51500.00', occurredOn: '2026-07-08', description: 'حقائب عدد 10', excluded: false, sypMinorPerUsd: null, rateBasis: null }
  const after = { ...before, currency: 'USD', amount: '390.00' }
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  await page.route('**/api/company/movements?**', route => route.fulfill({ json: { movements: [{ entry: { id: 710, businessDate: '2026-07-08', eventType: 'company_historical_transfer', reason: before.description, externalReference: 'HQ-SRC-10', sypMinorPerUsd: null }, command: null }] } }))
  await page.route('**/api/company/historical-imports/HQ-SRC-10/review', route => route.fulfill({ json: { original: before, effective: before, version: 0, capabilities: { editableFields: ['amount', 'currency', 'occurredOn', 'description', 'excluded', 'sypMinorPerUsd', 'rateBasis'], financialCorrectionSupported: true, blockingReason: null }, history: [] } }))
  await page.route('**/api/company/historical-source-corrections**', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON() as Record<string, unknown>
    writes.push({ path, body })
    if (path.endsWith('/preview')) return route.fulfill({ json: { before, after, impact: { companyCash: { SYP_NEW: '0.00', USD: '0.00' }, ownerPayments: { SYP_NEW: '-51500.00', USD: '390.00' }, branchCash: '0.00', administrativeOnly: true } } })
    return route.fulfill({ status: 201, json: { effective: after } })
  })
  await page.goto(`${adminUrl}#companyFund?tab=movements`)
  await page.getByRole('button', { name: 'تعديل', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'تعديل العملية', exact: true })
  await dialog.getByLabel('العملة', { exact: true }).selectOption('USD')
  await dialog.getByLabel('القيمة المقترحة', { exact: true }).fill('390')
  await dialog.getByLabel('السبب', { exact: true }).fill('تصحيح الحقائب حسب اعتماد المالك')
  await dialog.getByRole('button', { name: 'معاينة واعتماد', exact: true }).click()
  await expect(dialog.getByText('صندوق الفرع لا يتغير؛ الأصل وروابطه محفوظة.', { exact: true })).toBeVisible()
  expect(writes).toHaveLength(1)
  expect(writes[0]!.body).not.toHaveProperty('idempotencyKey')
  expect(writes[0]!.body.values).toMatchObject({ amount: '390.00', currency: 'USD', sypMinorPerUsd: null, rateBasis: null })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'معاينة واعتماد', exact: true }).click()
  await dialog.getByRole('button', { name: 'اعتماد التصحيح', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(writes).toHaveLength(2)
  expect(writes[1]!.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  expect(writes[1]!.body.acknowledgeCashEffect).toBe(true)
})

test('existing motor sale links a receipt and performs no duplicate financial write', async ({ page }, info) => {
  test.skip(info.project.name !== 'admin-desktop')
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubCompanyFund(page, { existingAsset: true })
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname) })
  await page.route('**/api/company/existing-assets/95000000-0000-4000-8000-000000000001', route => route.fulfill({ json: { evidence: [], events: [] } }))
  await page.route('**/api/company/existing-assets/sale-receipts?**', route => route.fulfill({ json: { receipts: [{ id: 911, occurredOn: '2026-09-20', amount: '850.00', currency: 'USD', description: 'قبض بيع موتور موثق' }] } }))
  let body: Record<string, unknown> | null = null
  await page.route('**/api/company/existing-assets/*/documentary-sale', async route => { body = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ status: 201, json: { administrativeOnly: true, cashEffect: 'none', bookGain: null } }) })
  await page.goto(`${adminUrl}#companyFund?tab=assets`)
  await page.getByRole('button', { name: 'الإجراء', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Visual motorcycle', exact: true })
  await dialog.getByRole('button', { name: 'بيع الأصل', exact: true }).click()
  await dialog.getByLabel('المشتري', { exact: true }).fill('مشتري الاختبار')
  await dialog.getByLabel('سعر البيع', { exact: true }).fill('850')
  await dialog.getByLabel('قبض الثمن المسجل سابقاً', { exact: true }).selectOption('911')
  await dialog.getByLabel('السبب', { exact: true }).fill('ربط بطاقة الموتور بالقبض المسجل دون تكرار')
  await dialog.getByRole('button', { name: 'معاينة واعتماد', exact: true }).click()
  expect(writes).toHaveLength(0)
  await dialog.getByRole('button', { name: 'اعتماد بيع البطاقة وربط القبض', exact: true }).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toContain('/documentary-sale')
  expect(body).toMatchObject({ price: '850', currency: 'USD', receiptEntryId: 911, expectedVersion: 1 })
  expect(body).not.toHaveProperty('disposalEntryId')
  const path = info.outputPath('documentary-sale.png')
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
  await info.attach('neutral documentary sale', { path, contentType: 'image/png' })
})

test('review deep link exposes original unlinked restorations without replaying branch cash', async ({ page }, info) => {
  test.skip(info.project.name !== 'admin-desktop')
  await preparePublicSurface(page, { language: 'ar', appearance: 'dark' })
  await stubCompanyFund(page, { restorationReviewEnabled: false })
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()) })
  await page.route('**/api/company/restoration-reviews', route => route.fulfill({ json: { enabled: false, proposals: [], legacy: [], linkedHistorical: [{ restorationId: 99, branchId: 'visual-branch-1', branchNameAr: 'فرع الاختبار', journalEntryId: 301, sourceReference: 'HQ-SRC-84', amount: '6870.00', currency: 'SYP_NEW', occurredOn: '2026-09-18', description: 'تحويل مرتبط بالسجل', status: 'linked_historical' }], unlinkedHistorical: [{ restorationId: 44, branchId: 'visual-branch-1', branchNameAr: 'فرع الاختبار', businessDate: '2026-09-17', netToCompany: '0.00', activationRequired: false, reason: 'ترميم قديم ذو طرفين متساويين', status: 'unlinked_legacy' }] } }))
  await page.goto(`${adminUrl}#companyFund?tab=review`)
  await expect(page.getByRole('tab', { name: 'العمليات', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: 'ترميمات قديمة تحتاج ربطاً ومراجعة: 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'إعداد اقتراح للمراجعة', exact: true })).toBeDisabled()
  await page.getByText('ترميمات مرتبطة بالسجل التاريخي:', { exact: false }).click()
  await expect(page.getByText('HQ-SRC-84', { exact: true })).toHaveCount(1)
  expect(writes).toHaveLength(0)
})

test('one activated branch does not unlock another branch review', async ({ page }, info) => {
  test.skip(info.project.name !== 'admin-desktop')
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubCompanyFund(page)
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()) })
  await page.route('**/api/company/restoration-reviews', route => route.fulfill({ json: { enabled: true, branches: [{ branchId: 'active', reviewEnabled: true }, { branchId: 'inactive', reviewEnabled: false }], proposals: [{ id: 'pending-review', branchId: 'inactive', branchNameAr: 'فرع غير مفعل', reviewEnabled: false, businessDate: '2026-09-17', status: 'pending', version: 0, legs: [{ sourceEntryId: 600, amount: '10.00', direction: 'to_company', fundCode: 'office_cash' }] }], unlinkedHistorical: [{ restorationId: 44, branchId: 'inactive', branchNameAr: 'فرع غير مفعل', businessDate: '2026-09-17', netToCompany: '0.00', activationRequired: false, reason: 'قديم', status: 'unlinked_legacy' }] } }))
  await page.goto(`${adminUrl}#companyFund?tab=review`)
  await expect(page.getByRole('button', { name: 'إعداد اقتراح للمراجعة', exact: true })).toBeDisabled()
  await page.getByLabel('ترميمات منفذة بانتظار اعتماد الشركة', { exact: true }).getByRole('button', { name: 'مراجعة', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('مراجعة الترميم غير مفعلة في إعدادات هذه النسخة.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'اعتماد المبلغ', exact: true })).toHaveCount(0)
  expect(writes).toHaveLength(0)
})
