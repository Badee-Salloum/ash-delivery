import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const base = 'http://127.0.0.1:4173', vehicle = '92000000-0000-4000-8000-000000000001'
const destination = resolve('outputs/finance-owner-assets-20261013/preview')
test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubCompanyFund(page)
})
async function shot(page: Page, name: string, project: string) {
  await mkdir(destination, { recursive: true })
  const original = page.viewportSize()!
  if (await page.getByRole('dialog').count()) {
    const height = await page.getByRole('dialog').evaluate(element => element.scrollHeight)
    await page.setViewportSize({ width: original.width, height: Math.max(original.height, height + 90) })
  }
  await page.screenshot({ path: resolve(destination, `${name}-${project}.png`), fullPage: true })
  await page.setViewportSize(original)
}
test('owner summary remains complete when detail period is empty, changed, or expanded', async ({ page }, info) => {
  test.setTimeout(60000)
  const reads: string[] = [], writes: string[] = []
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()) })
  await page.route('**/api/company/owner-payments?**', route => {
    const url = new URL(route.request().url()); reads.push(url.search)
    expect(url.searchParams.get('from')).toBe('2000-01-01')
    expect(url.searchParams.get('to')).toBe('2026-09-20')
    return route.fulfill({ json: {
      totals: { SYP_NEW: '72650.00', USD: '22620.00' }, expenseTotals: { SYP_NEW: '72650.00', USD: '10620.00' },
      capitalAndDebtTotals: { SYP_NEW: '0.00', USD: '12000.00' }, branchFundingTotals: { SYP_NEW: '116000.00', USD: '0.00' },
      payments: [{ id: 'old-owner', kind: 'asset_payment', currency: 'USD', amount: '12000.00', occurredOn: '2026-07-07', description: 'دفعة موتور تاريخية للاختبار' }],
      branchFundingPayments: [{ id: 'funding', branchNameAr: 'فرع الاختبار', channel: 'historical', currency: 'SYP_NEW', amount: '116000.00', occurredOn: '2026-07-09', description: 'تمويل فرع قديم للاختبار' }],
    } })
  })
  await page.goto(`${base}#companyFund`)
  const summary = page.locator('[data-owner-summary]')
  await expect(summary).toContainText('188,650.00', { timeout: 15000 }); await expect(summary).toContainText('22,620.00')
  await expect(page.getByText('لا توجد دفعات في الفترة المختارة. الدفعات السابقة محفوظة ومحصلتها ظاهرة أعلى القسم.', { exact: true })).toBeVisible()
  const filters = page.locator('[data-owner-detail-filters]')
  await expect(filters).toBeVisible()
  await shot(page, '01-owner-cumulative-empty-period', info.project.name)
  await filters.getByLabel('من تاريخ', { exact: true }).fill('2026-07-01')
  await filters.getByLabel('إلى تاريخ', { exact: true }).fill('2026-07-31')
  await expect(page.getByText('دفعة موتور تاريخية للاختبار', { exact: true }).first()).toBeVisible()
  await expect(summary).toContainText('188,650.00')
  await page.getByRole('button', { name: 'عرض جميع الدفعات', exact: true }).click()
  await expect(summary).toContainText('22,620.00')
  // Changing transfer dates must neither reset owner details nor remove the cumulative card.
  await page.getByRole('main').getByLabel('من تاريخ', { exact: true }).first().fill('2026-09-21')
  await expect(summary).toContainText('188,650.00')
  await expect(page.getByText('دفعة موتور تاريخية للاختبار', { exact: true }).first()).toBeVisible()
  expect(new Set(reads).size).toBe(1); expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
})

for (const state of ['unpaid', 'paid', 'partial'] as const) test(`motor registration ${state} keeps card save separate from real money`, async ({ page }, info) => {
  test.setTimeout(60000)
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  page.on('request', request => { if (request.method() === 'POST') writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }) })
  let paid = 0, scheduled = false
  await page.route('**/api/expense-categories*', route => route.fulfill({ json: { categories: [{ id: '93000000-0000-4000-8000-000000000001', nameAr: 'دفعات موتور', nameEn: 'Motor payments', active: true }] } }))
  await page.route('**/api/company/existing-assets/*/payments', route => route.fulfill({ json: {
    version: paid ? 1 : 0, totalPaid: paid.toFixed(2), remaining: (1200 - paid).toFixed(2), status: paid ? 'documented' : 'not_documented',
    plan: scheduled ? { data: { supplier: 'مورد اختبار' } } : null, installments: [], history: [], payments: [],
    sources: [{ key: 'historical:test', hash: 'a'.repeat(64), available: '1200.00', amount: '1200.00', currency: 'USD', occurredOn: '2026-07-01', paidFrom: 'owner_outside', description: 'دفعة شراء مسجلة سابقاً للاختبار' }],
  } }))
  await page.route('**/api/company/existing-assets/*/payments/schedule', route => {
    scheduled = true
    expect(route.request().postDataJSON()).toMatchObject({ supplier: 'مورد اختبار', installmentAmount: '150.00', firstDueOn: '2026-10-15', reminderDays: 3 })
    return route.fulfill({ status: 201, json: { administrativeOnly: true, cashEffect: 'none' } })
  })
  await page.route('**/api/company/expenses', route => {
    const body = route.request().postDataJSON()
    expect(body).toMatchObject({ amount: '1200.00', currency: 'USD', paidFrom: 'owner_outside', existingAssetPayment: { acknowledgedNewExpense: true } })
    paid = 1200
    return route.fulfill({ status: 201, json: { replayed: false } })
  })
  await page.goto(`${base}#companyFund?tab=assets`)
  await page.getByRole('button', { name: 'إضافة بطاقة موتور', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('آلية', { exact: true }).selectOption(vehicle)
  await dialog.getByLabel('السعر الكامل للموتور', { exact: true }).fill('1200.00')
  await dialog.getByLabel('بدء الاستخدام', { exact: true }).fill('2026-07-01')
  await dialog.getByLabel('هل دُفع ثمن الموتور؟', { exact: true }).selectOption(state)
  if (state === 'unpaid') {
    await dialog.getByLabel('البائع / الجهة المستحقة', { exact: true }).fill('مورد اختبار')
    await dialog.getByLabel('قيمة الدفعة', { exact: true }).fill('150.00')
    await dialog.getByLabel('موعد أول دفعة', { exact: true }).fill('2026-10-15')
  } else {
    await expect(dialog.getByLabel('قيمة الدفعة', { exact: true })).toHaveCount(0)
    if (state === 'paid') {
      const mode = dialog.getByLabel('كيف تريد تسجيل الدفعة؟', { exact: true })
      await expect(mode).toContainText('إضافتها كصرفية جديدة'); await mode.selectOption('new')
    }
  }
  await shot(page, `02-card-price-${state}`, info.project.name)
  await dialog.getByRole('button', { name: 'معاينة واعتماد', exact: true }).click()
  await dialog.getByRole('button', { name: 'حفظ البطاقة ومتابعة الدفع أو الجدولة', exact: true }).click()
  await expect(page.locator('[data-motor-registration-followup]')).toBeVisible()
  expect(writes).toHaveLength(1)
  expect(writes[0]!.path).toBe('/api/company/existing-assets')
  expect(writes[0]!.body).not.toHaveProperty('paymentState')
  expect(writes[0]!.body).not.toHaveProperty('paidNow')
  dialog = page.getByRole('dialog')
  if (state === 'unpaid') {
    await expect(dialog.getByLabel('قيمة الدفعة', { exact: true })).toHaveValue('150.00')
    await expect(dialog.getByLabel('موعد أول دفعة', { exact: true })).toHaveValue('2026-10-15')
    await dialog.getByLabel('السبب', { exact: true }).fill('جدول دون دفع')
    await dialog.getByRole('button', { name: 'معاينة واعتماد', exact: true }).click()
    await dialog.getByRole('button', { name: 'حفظ جدول الدفعات والتذكير', exact: true }).click()
    await expect(dialog.getByLabel('البائع / الجهة المستحقة', { exact: true })).toHaveValue('مورد اختبار')
    expect(writes).toHaveLength(2); expect(writes[1]!.path).toMatch(/\/payments\/schedule$/)
  } else if (state === 'paid') {
    await expect(dialog.getByLabel('المبلغ', { exact: true })).toHaveValue('1200.00')
    await dialog.getByLabel('مصدر التمويل', { exact: true }).selectOption('owner_outside')
    await dialog.getByLabel('الفئة', { exact: true }).selectOption('93000000-0000-4000-8000-000000000001')
    await dialog.getByLabel('سعر الصرف التاريخي', { exact: true }).fill('130.00')
    await dialog.getByLabel('الوصف', { exact: true }).fill('دفعة فعلية جديدة للاختبار')
    await dialog.getByRole('button', { name: 'معاينة واعتماد', exact: true }).click()
    await dialog.getByRole('button', { name: 'تأكيد الصرفية الجديدة وربطها', exact: true }).click()
    await expect(dialog).toContainText('1,200.00')
    expect(writes).toHaveLength(2); expect(writes[1]!.path).toBe('/api/company/expenses')
  } else {
    await expect(dialog.getByText('وثّق المبلغ المدفوع أولاً بربط الدفعة أو تسجيل صرفية جديدة، ثم جدْول المتبقي الفعلي من «جدولة الدفعات».', { exact: true })).toBeVisible()
    expect(writes).toHaveLength(1)
  }
  await shot(page, `03-card-payment-${state}`, info.project.name)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
})
