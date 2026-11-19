import { expect, test } from '@playwright/test'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'

test('general manager records income and advances for the selected branch on desktop and phone', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubCompanyFund(page, { secondBranch: true })
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // Every API request is intercepted locally. Unhandled routes stay sealed by stubCompanyFund.
  await page.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/api/me') return fulfill({ userId: 'local-general-manager', roleKey: 'general_manager', branchId: null, driverId: null, businessDate: '2026-11-19' })
    if (path === '/api/dashboard/meta') return fulfill({ today: '2026-11-19', goLiveBusinessDate: '2026-08-30', firstActivityDate: '2026-08-30', epoch: '2026-08-30', weekStart: '2026-11-15', monthStart: '2026-11-01', dayStartMinutes: 240 })
    if (path === '/api/income-categories') return fulfill({ categories: [{ id: 'other-income', code: 'OTHER', nameAr: 'دخل آخر', active: true }] })
    if (path === '/api/expense-categories') return fulfill({ categories: [{ id: 'fuel', code: 'FUEL', nameAr: 'بنزين', active: true }] })
    if (request.method() === 'POST') {
      const body = request.postDataJSON()
      writes.push({ path, body })
      if (!body.branchId) return fulfill({ error: 'branch_required' }, 422)
      return fulfill({ ...body, id: body.idempotencyKey, journalEntryId: 1 }, 201)
    }
    if (path === '/api/incomes') return fulfill({ incomes: [], total: '0.00' })
    if (path === '/api/advances') return fulfill({ advances: [], parties: [], total: '0.00', outstanding: [] })
    if (path === '/api/expenses') return fulfill({ branchId: url.searchParams.get('branchId'), from: '2026-11-19', to: '2026-11-19', earliestBusinessDate: '2026-08-30', currency: 'SYP_NEW', totalBasis: 'recorded_expense_rows', expenses: [], total: '0.00', count: 0, offset: 0, limit: 50, generatedAt: '2026-11-19T10:00:00Z' })
    return route.fallback()
  })
  await page.goto(`${adminUrl}/#expenses`)
  const form = page.locator('section').filter({ has: page.getByRole('heading', { name: 'تسجيل حركة مالية', exact: true }) })
  await form.getByRole('button', { name: 'الإيرادات', exact: true }).click()
  await form.getByLabel('الفئة', { exact: true }).selectOption('other-income')
  await form.getByLabel('المبلغ', { exact: true }).fill('4500')
  await form.getByLabel('الوصف', { exact: true }).fill('اختبار محلي فقط')
  await form.getByRole('button', { name: 'تسجيل مدخول', exact: true }).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({ path: '/api/incomes', body: { branchId: 'visual-branch-1', amount: '4500', channel: 'office_cash' } })
  await expect(form.getByLabel('المبلغ', { exact: true })).toHaveValue('')
  await expect(form.getByRole('alert')).toHaveCount(0)

  if (testInfo.project.name === 'admin-mobile') await page.getByRole('button', { name: 'القائمة', exact: true }).click()
  await page.getByLabel('الفرع', { exact: true }).selectOption('visual-branch-2')
  if (testInfo.project.name === 'admin-mobile') await page.keyboard.press('Escape')
  await form.getByRole('button', { name: 'السلف', exact: true }).click()
  await form.locator('input[list="advance-parties"]').fill('اختبار محلي')
  await form.getByLabel('الفئة', { exact: true }).selectOption('fuel')
  await form.getByLabel('المبلغ', { exact: true }).fill('20')
  await form.getByLabel('الوصف', { exact: true }).fill('سلفة محلية فقط')
  await form.getByRole('button', { name: 'تسجيل سلفة', exact: true }).click()
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toMatchObject({ path: '/api/advances', body: { branchId: 'visual-branch-2', amount: '20' } })
  await expect(form.getByLabel('المبلغ', { exact: true })).toHaveValue('')
  await expect(form.getByRole('alert')).toHaveCount(0)
  expect(errors).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('branch-registration-fixed.png'), fullPage: true })
})
