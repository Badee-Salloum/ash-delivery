import { expect, test } from '@playwright/test'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'

const variants = [
  {
    name: 'arabic-light-desktop', project: 'admin-desktop', language: 'ar' as const, appearance: 'light' as const,
    labels: {
      due: 'الأقساط المستحقة', plan: 'خطة الأقساط', pay: 'دفع القسط', confirmPay: 'تأكيد دفع القسط',
      create: 'إنشاء خطة أقساط', amount: 'قيمة القسط', recurrence: 'التكرار', weekday: 'يوم الأسبوع',
    },
  },
  {
    name: 'english-dark-mobile', project: 'admin-mobile', language: 'en' as const, appearance: 'dark' as const,
    labels: {
      due: 'Installments due', plan: 'Installment plan', pay: 'Pay installment', confirmPay: 'Confirm installment payment',
      create: 'Create installment plan', amount: 'Installment amount', recurrence: 'Recurrence', weekday: 'Weekday',
    },
  },
]

for (const variant of variants) {
  test(`company-fund installment reminders and schedule — ${variant.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== variant.project, `Only the ${variant.project} baseline owns this presentation.`)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page)

    await page.goto(`${adminUrl}#companyFund?tab=assets`)
    const dueCard = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.due, exact: true }) })
    await expect(dueCard).toBeVisible()
    await expect(dueCard.getByRole('button', { name: variant.labels.pay, exact: true })).toBeVisible()

    if (variant.project === 'admin-desktop') {
      await expect(dueCard).toHaveScreenshot(`admin-company-fund-installments-due-${variant.name}.png`, { timeout: 15_000 })
      await dueCard.getByRole('button', { name: variant.labels.pay, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: variant.labels.confirmPay, exact: true })
      await expect(dialog).toBeVisible()
      await expect(dialog).toHaveScreenshot(`admin-company-fund-installments-confirm-${variant.name}.png`)
      return
    }

    const planCard = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.plan, exact: true }) })
    await planCard.getByRole('button', { name: variant.labels.create, exact: true }).click()
    await planCard.getByLabel(variant.labels.amount, { exact: true }).fill('125')
    await planCard.getByLabel(variant.labels.recurrence, { exact: true }).selectOption('weekly')
    await expect(planCard.getByLabel(variant.labels.weekday, { exact: true })).toBeVisible()
    await expect(dueCard.locator('tbody > tr').first()).toHaveCSS('display', 'block')
    await expect(planCard).toHaveScreenshot(`admin-company-fund-installments-plan-${variant.name}.png`, { timeout: 15_000 })
  })
}
