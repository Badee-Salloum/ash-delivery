import { expect, test, type Page } from '@playwright/test'
import { preparePublicSurface } from './fixtures.ts'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
const command = (id: number, occurredOn: string, amount: string, description: string, extra = {}) => ({
  entry: { id, businessDate: occurredOn, eventType: 'company_expense', reason: description, sypMinorPerUsd: null },
  command: { id: `expense-${id}`, kind: 'expense', currency: 'SYP_NEW', amount, paidFrom: 'pocket', occurredOn, description }, ...extra,
})

async function setup(page: Page) {
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubCompanyFund(page)
}

test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('admin-'))
  await setup(page)
})

test('newest-first concise ledger: cancel does nothing, one confirmation deletes and hides both technical rows', async ({ page }, info) => {
  let deleted = false
  const writes: Record<string, unknown>[] = []
  const rows = [command(2, '2026-09-01', '10.00', 'Older expense'),
    command(4, '2026-09-20', '30.00', 'Newest expense', { originalCommand: { id: 'original-before-correction' }, corrected: true }),
    command(3, '2026-09-20', '20.00', 'Same-day earlier expense'),
    command(5, '2026-09-18', '999.00', 'Previously deleted expense', { reversed: true })]
  await page.route('**/api/company/movements?**', route => route.fulfill({ json: { effectiveMovements: rows.map(row => row.entry.id === 4 ? { ...row, reversed: deleted } : row), movements: [] } }))
  await page.route('**/api/company/reversals', route => {
    writes.push(route.request().postDataJSON()); deleted = true
    return route.fulfill({ status: 201, json: { replayed: false } })
  })
  await page.goto(`${adminUrl}#companyFund?tab=movements`)
  const cards = page.locator('[data-company-movement]')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0)).toContainText('Newest expense')
  await expect(cards.nth(1)).toContainText('Same-day earlier expense')
  await expect(cards.nth(2)).toContainText('Older expense')
  await expect(page.getByText('Previously deleted expense', { exact: true })).toHaveCount(0)
  if (info.project.name === 'admin-desktop') await expect(page.getByRole('columnheader')).toHaveCount(5)
  await cards.first().getByRole('button', { name: 'حذف', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Newest expense')
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'إلغاء', exact: true }).click()
  expect(writes).toHaveLength(0)
  await cards.first().getByRole('button', { name: 'حذف', exact: true }).click()
  await dialog.getByRole('button', { name: 'حذف', exact: true }).click()
  await expect(cards).toHaveCount(2)
  await expect(page.getByText('Newest expense', { exact: true })).toHaveCount(0)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ targetId: 'expense-4', reason: 'Expense deleted after explicit user confirmation' })
  await expect(page.getByRole('status')).toContainText('تم حذف الصرفية.')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  const path = info.outputPath('expense-ledger.png')
  await page.screenshot({ path, fullPage: true }); await info.attach('ledger', { path, contentType: 'image/png' })
})

test('retry after a lost financial response uses the exact same deletion request', async ({ page }) => {
  let deleted = false
  const writes: Record<string, unknown>[] = []
  await page.route('**/api/company/movements?**', route => route.fulfill({ json: {
    movements: [], effectiveMovements: [command(4, '2026-09-20', '30.00', 'Retry expense', { reversed: deleted })],
  } }))
  await page.route('**/api/company/reversals', route => {
    writes.push(route.request().postDataJSON()); deleted = true
    return route.fulfill(writes.length === 1 ? { status: 503, json: { error: 'database_busy' } } : { json: { replayed: true } })
  })
  await page.goto(`${adminUrl}#companyFund?tab=movements`)
  const remove = page.locator('[data-company-movement]').getByRole('button', { name: 'حذف', exact: true })
  await remove.click(); await page.getByRole('alertdialog').getByRole('button', { name: 'حذف', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await remove.click(); await page.getByRole('alertdialog').getByRole('button', { name: 'حذف', exact: true }).click()
  await expect(page.locator('[data-company-movement]')).toHaveCount(0)
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0])
})

test('owner historical deletion has one confirmation, stable retry/version, no journal write, and no excluded-row toggle', async ({ page }) => {
  let excluded = false, reviews = 0
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  await page.route('**/api/company/historical-imports', route => route.fulfill({ json: { sourceClosing: { SYP_NEW: '100.00', USD: '0.00' },
    rows: [{ sourceReference: 'HQ-SRC-10', sourcePosition: 10, occurredOn: '2026-07-08', movementType: 'expense',
      paidFrom: 'owner_outside', description: 'Owner old bags', originalAmount: '390$', currency: 'USD', amount: '390.00',
      fromCurrency: null, toCurrency: null, restorationId: null, branchJournalEntryId: null, version: excluded ? 3 : 2, excluded,
      balanceAfter: { SYP_NEW: '100.00', USD: '0.00' }, financialStatus: 'owner_direct_outside_company_books', deleteCommandId: null }] } }))
  await page.route('**/api/company/historical-imports/HQ-SRC-10/review', route => {
    reviews++
    return route.fulfill({ json: { effective: { movementType: 'expense', excluded }, version: 2, capabilities: { financialCorrectionSupported: true } } })
  })
  await page.route('**/api/company/historical-source-corrections', route => {
    writes.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() }); excluded = true
    return route.fulfill(writes.length === 1 ? { status: 503, json: { error: 'database_busy' } } : { json: { replayed: true } })
  })
  await page.goto(`${adminUrl}#companyFund?tab=movements`)
  await page.locator('summary').filter({ hasText: 'سجل العمليات القديمة المعتمد' }).click()
  const register = page.locator('section').filter({ has: page.getByRole('heading', { name: 'سجل العمليات القديمة المعتمد', exact: true }) })
  const remove = register.getByRole('button', { name: 'حذف', exact: true })
  await expect(remove).toBeVisible()
  await expect(register.getByRole('checkbox')).toHaveCount(0)
  for (let attempt = 0; attempt < 2; attempt++) {
    await remove.click(); await page.getByRole('alertdialog').getByRole('button', { name: 'حذف', exact: true }).click()
    if (attempt === 0) await expect(page.getByRole('alert')).toBeVisible()
  }
  await expect(register.getByText('Owner old bags', { exact: true })).toHaveCount(0)
  expect(reviews).toBe(1); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0])
  expect(writes[0]!.body).toMatchObject({ sourceReference: 'HQ-SRC-10', expectedVersion: 2, values: { excluded: true }, acknowledgeCashEffect: true })
})
