import { expect, test } from '@playwright/test'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'

const variants = [
  {
    name: 'english-light-desktop', project: 'admin-desktop', language: 'en' as const, appearance: 'light' as const,
    labels: { exchange: 'Currency exchange', sold: 'Amount sold', received: 'Amount received', rate: 'Exchange rate', reason: 'Reason', submit: 'Record exchange' },
  },
  {
    name: 'arabic-dark-mobile', project: 'admin-mobile', language: 'ar' as const, appearance: 'dark' as const,
    labels: { exchange: 'تحويل عملة', sold: 'المبلغ المباع', received: 'المبلغ المستلم', rate: 'سعر الصرف', reason: 'السبب', submit: 'تسجيل التحويل' },
  },
]

for (const variant of variants) {
  test(`company-fund live exchange — ${variant.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== variant.project, `Only the ${variant.project} baseline owns this presentation.`)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page)

    await page.goto(`${adminUrl}#companyFund?tab=overview`)
    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.exchange, exact: true }) })
    await expect(card).toBeVisible()

    // The target amount appears while the manager is still typing; submission is separately held
    // behind the app's confirmation dialog.
    await card.getByLabel(variant.labels.sold, { exact: true }).fill('100')
    await card.getByLabel(variant.labels.rate, { exact: true }).fill('150')
    await expect(card.getByLabel(variant.labels.received, { exact: true })).toHaveValue('15000.00')
    await card.getByLabel(variant.labels.reason, { exact: true }).fill('Visual fixture exchange')
    await expect(card).toHaveScreenshot(`admin-company-fund-exchange-${variant.name}.png`)

    await card.getByRole('button', { name: variant.labels.submit, exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveScreenshot(`admin-company-fund-exchange-confirm-${variant.name}.png`)
  })
}
