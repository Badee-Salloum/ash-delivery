import { expect, test } from '@playwright/test'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'

const variants = [
  {
    project: 'admin-desktop', language: 'en' as const, appearance: 'light' as const,
    labels: {
      entry: 'Record a historical movement', occurredOn: 'Occurred on', reference: 'Unique audit reference',
      description: 'Description', kind: 'Kind', fromCurrency: 'Currency sold', toCurrency: 'Currency received',
      fromAmount: 'Amount sold', toAmount: 'Amount received',
    },
  },
  {
    project: 'admin-mobile', language: 'ar' as const, appearance: 'dark' as const,
    labels: {
      entry: 'إدخال حركة مالية سابقة', occurredOn: 'تاريخ حدوث العملية', reference: 'المرجع التدقيقي الفريد',
      description: 'الوصف', kind: 'النوع', fromCurrency: 'العملة المباعة', toCurrency: 'العملة المستلمة',
      fromAmount: 'المبلغ المباع', toAmount: 'المبلغ المستلم',
    },
  },
]

for (const variant of variants) {
  test(`company-fund historical entry controls — ${variant.project}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== variant.project, 'This variant owns one responsive historical-entry check.')
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page)

    await page.goto(`${adminUrl}#companyFund?tab=historical`)
    const entry = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.entry, exact: true }) })
    await expect(entry).toBeVisible()
    await expect(entry.getByLabel(variant.labels.occurredOn, { exact: true })).toHaveAttribute('min', '2000-01-01')
    await expect(entry.getByLabel(variant.labels.reference, { exact: true })).toBeVisible()
    await expect(entry.getByLabel(variant.labels.description, { exact: true })).toBeVisible()

    await entry.getByLabel(variant.labels.kind, { exact: true }).selectOption('exchange')
    await expect(entry.getByLabel(variant.labels.fromCurrency, { exact: true })).toBeVisible()
    await expect(entry.getByLabel(variant.labels.toCurrency, { exact: true })).toBeVisible()
    await expect(entry.getByLabel(variant.labels.fromAmount, { exact: true })).toBeVisible()
    await expect(entry.getByLabel(variant.labels.toAmount, { exact: true })).toBeVisible()
  })
}
