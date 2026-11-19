import { expect, test } from '@playwright/test'
import { preparePublicSurface } from './fixtures.ts'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'

const url = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' }); await stubCompanyFund(page)
})

test('edit and delete direct operations refresh the ledger; cancel never sends a write', async ({ page }, info) => {
  let edited = false, deleted = false
  const writes: Record<string, unknown>[] = []
  await page.route('**/api/company/movements?**', route => route.fulfill({ json: { movements: [], effectiveMovements: deleted ? [] : [{
    entry: { id: edited ? 402 : 400, businessDate: '2026-09-20', eventType: 'company_withdrawal', reason: 'Synthetic drawing', sypMinorPerUsd: null },
    command: { id: edited ? '40000000-0000-4000-8000-000000000002' : '40000000-0000-4000-8000-000000000001', kind: 'withdrawal',
      occurredOn: '2026-09-20', currency: 'SYP_NEW', amount: edited ? '25.00' : '10.00', reason: edited ? 'Updated synthetic drawing' : 'Synthetic drawing' },
  }] } }))
  await page.route('**/api/company/operations/*/actions', route => {
    const body = route.request().postDataJSON(); writes.push(body)
    if (body.action === 'delete') deleted = true
    else edited = true
    return route.fulfill({ status: 201, json: { replayed: false } })
  })
  await page.goto(`${url}#companyFund?tab=movements`)
  const row = page.locator('[data-company-movement]')
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: 'تعديل', exact: true }).click()
  const editor = page.getByRole('dialog')
  await expect(editor).toContainText('يبقى الأصل في سجل التدقيق')
  await editor.getByLabel('المبلغ', { exact: true }).fill('25.00')
  await editor.getByLabel('الوصف', { exact: true }).fill('Updated synthetic drawing')
  await editor.getByLabel('السبب', { exact: true }).fill('Corrected source receipt')
  await editor.getByRole('button', { name: 'معاينة واعتماد', exact: true }).click()
  expect(writes).toHaveLength(0)
  await expect(editor.getByRole('status')).toContainText('25.00')
  await page.screenshot({ path: info.outputPath('operation-edit-preview.png'), fullPage: true })
  await editor.getByRole('button', { name: 'تأكيد التعديل', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(row).toContainText('25.00')
  expect(writes[0]).toMatchObject({ action: 'edit', expectedEntryId: 400, values: { amount: '25.00', currency: 'SYP_NEW' } })
  await row.getByRole('button', { name: 'حذف العملية', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await confirmation.getByRole('button', { name: 'إلغاء', exact: true }).click()
  expect(writes).toHaveLength(1)
  await row.getByRole('button', { name: 'حذف العملية', exact: true }).click()
  await confirmation.getByRole('button', { name: 'حذف العملية', exact: true }).click()
  await expect(row).toHaveCount(0)
  expect(writes[1]).toMatchObject({ action: 'delete', expectedEntryId: 402 })
  await expect(page.getByRole('status')).toContainText('تم حذف العملية')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
})

test('failed deletion is retryable with identical key and never leaves a busy screen', async ({ page }) => {
  const writes: Record<string, unknown>[] = []
  await page.route('**/api/company/movements?**', route => route.fulfill({ json: { movements: [], effectiveMovements: [{
    entry: { id: 400, businessDate: '2026-09-20', eventType: 'company_deposit', reason: 'Synthetic deposit', sypMinorPerUsd: null },
    command: { id: '40000000-0000-4000-8000-000000000001', kind: 'deposit', occurredOn: '2026-09-20', currency: 'SYP_NEW', amount: '10.00', reason: 'Synthetic deposit' },
  }] } }))
  await page.route('**/api/company/operations/*/actions', route => {
    writes.push(route.request().postDataJSON())
    return route.fulfill({ status: 503, json: { error: 'database_busy' } })
  })
  await page.goto(`${url}#companyFund?tab=movements`)
  const button = page.locator('[data-company-movement]').getByRole('button', { name: 'حذف العملية', exact: true })
  for (let i = 0; i < 2; i++) {
    await button.click(); await page.getByRole('alertdialog').getByRole('button', { name: 'حذف العملية', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible(); await expect(button).toBeEnabled()
  }
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0])
})
