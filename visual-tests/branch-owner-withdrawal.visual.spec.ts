import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'
import { branchWithdrawalPreview } from './branch-withdrawal-fixtures.ts'

const base = 'http://127.0.0.1:4173', out = resolve('outputs/owner-withdrawals-20261017/preview')
test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubCompanyFund(page)
  await page.route('**/api/**', async route => {
    const fixture = branchWithdrawalPreview(new URL(route.request().url()).pathname)
    if (fixture === undefined) return route.fallback()
    return route.fulfill({ json: fixture })
  })
})

test('branch cash and wallet select an explicit destination, confirm, and send only that recipe', async ({ page }, info) => {
  const payloads: Record<string, unknown>[] = []
  await page.route('**/api/treasury/withdraw', route => {
    payloads.push(route.request().postDataJSON())
    return route.fulfill({ status: 201, json: { balance: '50000.00', replayed: false, target: 'cash' } })
  })
  await page.goto(`${base}/#treasury`)
  const cash = page.locator('[data-branch-withdrawal="cash"]')
  await expect(cash.getByRole('combobox')).toHaveValue('')
  await cash.getByLabel('المبلغ', { exact: true }).fill('70000')
  await cash.getByLabel('الوصف', { exact: true }).fill('سحب شخصي تجريبي فقط')
  const save = cash.getByRole('button')
  await expect(save).toBeDisabled()
  await cash.getByRole('combobox').selectOption('owner_drawings')
  await expect(cash).toContainText('لا يزيد صندوق الشركة')
  await mkdir(out, { recursive: true })
  await cash.screenshot({ path: resolve(out, `06-branch-owner-${info.project.name}.png`) })
  await save.click()
  await expect(page.getByRole('dialog')).toContainText('سحب شخصي للمالك')
  await expect(page.getByRole('dialog')).toContainText('70,000')
  await page.keyboard.press('Escape')
  expect(payloads).toHaveLength(0)
  await save.click()
  await page.getByRole('dialog').getByRole('button', { name: 'تسجيل الحركة', exact: true }).click()
  await expect.poll(() => payloads.length).toBe(1)
  expect(payloads[0]).toMatchObject({ target: 'cash', to: 'owner_drawings', amount: '70000', reason: 'سحب شخصي تجريبي فقط' })
  await expect(cash.getByLabel('المبلغ', { exact: true })).toHaveValue('')
  const wallet = page.locator('[data-branch-withdrawal="wallet"]')
  await wallet.getByRole('combobox').selectOption('company_box')
  await wallet.getByLabel('المبلغ', { exact: true }).fill('1000')
  await wallet.getByLabel('الوصف', { exact: true }).fill('تحويل تجريبي للشركة')
  await expect(wallet).toContainText('وليس سحباً شخصياً')
  await wallet.getByRole('button').click()
  await page.getByRole('dialog').getByRole('button', { name: 'تسجيل الحركة', exact: true }).click()
  await expect.poll(() => payloads.length).toBe(2)
  expect(payloads[1]).toMatchObject({ target: 'wallet', to: 'company_box', amount: '1000' })
  expect(payloads[0]!.idempotencyKey).not.toBe(payloads[1]!.idempotencyKey)
  for (const [target, destination] of [['cash', 'company_box'], ['wallet', 'owner_drawings']] as const) {
    const panel = page.locator(`[data-branch-withdrawal="${target}"]`)
    await panel.getByRole('combobox').selectOption(destination)
    await panel.getByLabel('المبلغ', { exact: true }).fill('1000')
    await panel.getByLabel('الوصف', { exact: true }).fill('اختبار الوجهة الثانية')
    await panel.getByRole('button').click()
    await page.getByRole('dialog').getByRole('button', { name: 'تسجيل الحركة', exact: true }).click()
    await expect(panel.getByLabel('المبلغ', { exact: true })).toHaveValue('')
    expect(payloads.at(-1)).toMatchObject({ target, to: destination, amount: '1000' })
  }
  expect(payloads).toHaveLength(4)
  expect(new Set(payloads.map(payload => payload.idempotencyKey)).size).toBe(4)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
})

test('a lost response retries with the same key and owner destination', async ({ page }) => {
  const payloads: Record<string, unknown>[] = []
  await page.route('**/api/treasury/withdraw', route => {
    payloads.push(route.request().postDataJSON())
    return route.fulfill({ status: payloads.length === 1 ? 503 : 200, json: payloads.length === 1 ? { error: 'database_busy' } : { balance: '50000.00', replayed: true, target: 'cash' } })
  })
  await page.goto(`${base}/#treasury`)
  const panel = page.locator('[data-branch-withdrawal="cash"]')
  await panel.getByRole('combobox').selectOption('owner_drawings')
  await panel.getByLabel('المبلغ', { exact: true }).fill('70000')
  await panel.getByLabel('الوصف', { exact: true }).fill('اختبار إعادة المحاولة')
  for (let n = 0; n < 2; n++) {
    await panel.getByRole('button').click()
    await page.getByRole('dialog').getByRole('button', { name: 'تسجيل الحركة', exact: true }).click()
    await expect.poll(() => payloads.length).toBe(n + 1)
    if (n === 0) await expect(panel.getByRole('button')).toBeEnabled()
    else await expect(panel.getByLabel('المبلغ', { exact: true })).toHaveValue('')
  }
  expect(payloads[1]).toEqual(payloads[0])
})

test('branch manager sees owner drawings but not company transfer; company entry names the owner', async ({ page }) => {
  await page.route('**/api/me', route => route.fulfill({ json: { userId: 'test-manager', roleKey: 'branch_manager', branchId: 'visual-branch-1', driverId: null, businessDate: '2026-10-17' } }))
  await page.goto(`${base}/#treasury`)
  const cash = page.locator('[data-branch-withdrawal="cash"]')
  await expect(cash.locator('option[value="owner_drawings"]')).toHaveCount(1)
  await expect(cash.locator('option[value="company_box"]')).toHaveCount(0)
  await page.route('**/api/me', route => route.fulfill({ json: { userId: 'test-admin', roleKey: 'system_admin', branchId: null, driverId: null, businessDate: '2026-10-17' } }))
  await page.goto(`${base}/#companyFund`); await page.reload()
  await page.getByRole('button', { name: 'إضافة عملية', exact: true }).click()
  await page.getByRole('combobox', { name: 'النوع', exact: true }).selectOption('withdrawal')
  await expect(page.getByRole('note')).toContainText('هذا سحب شخصي للمالك من صندوق الشركة')
})
