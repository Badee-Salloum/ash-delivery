import { expect, test } from '@playwright/test'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'

const variants = [
  {
    name: 'english-light-desktop', project: 'admin-desktop', language: 'en' as const, appearance: 'light' as const,
    labels: { entry: 'Add a movement', kind: 'Kind', exchange: 'Currency exchange', sold: 'Amount sold', received: 'Amount received', rate: 'Exchange rate', reason: 'Reason', submit: 'Record exchange', retry: 'Try again', uncertain: 'The previous attempt has an uncertain outcome. Retry the same request before changing it.' },
  },
  {
    name: 'arabic-dark-mobile', project: 'admin-mobile', language: 'ar' as const, appearance: 'dark' as const,
    labels: { entry: 'إضافة عملية', kind: 'النوع', exchange: 'تحويل عملة', sold: 'المبلغ المباع', received: 'المبلغ المستلم', rate: 'سعر الصرف', reason: 'السبب', submit: 'تسجيل التحويل', retry: 'إعادة المحاولة', uncertain: 'نتيجة المحاولة السابقة غير مؤكدة. أعد الطلب نفسه قبل تغيير بياناته.' },
  },
]

for (const variant of variants) {
  test(`company-fund live exchange — ${variant.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== variant.project, `Only the ${variant.project} baseline owns this presentation.`)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page)

    await page.goto(`${adminUrl}#companyFund?tab=overview`)
    await expect(page.locator('form')).toHaveCount(0)
    await page.getByRole('button', { name: variant.labels.entry, exact: true }).click()
    await page.getByLabel(variant.labels.kind, { exact: true }).selectOption('exchange')
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

  test(`company exchange lost response survives reload without a new UUID — ${variant.name}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000)
    test.skip(testInfo.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page)
    let aborted = false
    await page.route('**/api/company/exchanges', async route => {
      if (route.request().method() === 'POST' && !aborted) {
        aborted = true; await route.abort('connectionreset'); return
      }
      await route.fallback()
    })
    const posts: Array<Record<string, unknown>> = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/company/exchanges') posts.push(request.postDataJSON() as Record<string, unknown>)
    })
    const openExchange = async (): Promise<void> => {
      await page.getByRole('button', { name: variant.labels.entry, exact: true }).click()
      await page.getByLabel(variant.labels.kind, { exact: true }).selectOption('exchange')
    }
    await page.goto(`${adminUrl}#companyFund?tab=overview`)
    await openExchange()
    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.exchange, exact: true }) })
    await card.getByLabel(variant.labels.sold, { exact: true }).fill('100')
    await card.getByLabel(variant.labels.rate, { exact: true }).fill('150')
    await card.getByLabel(variant.labels.reason, { exact: true }).fill('Visual uncertain exchange')
    await card.getByRole('button', { name: variant.labels.submit, exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: variant.labels.submit, exact: true }).click()
    await expect(card.getByText(variant.labels.uncertain, { exact: true })).toBeVisible()
    expect(posts).toHaveLength(1)
    const original = structuredClone(posts[0]!)
    expect(original).toMatchObject({ fromCurrency: 'USD', fromAmount: '100.00', toCurrency: 'SYP_NEW', toAmount: '15000.00', reason: 'Visual uncertain exchange' })
    expect(original.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openExchange()
    await expect(card.getByText(variant.labels.uncertain, { exact: true })).toBeVisible()
    await expect(card.getByLabel(variant.labels.sold, { exact: true })).toHaveValue('100.00')
    await expect(card.getByLabel(variant.labels.received, { exact: true })).toHaveValue('15000.00')
    await expect(card.getByLabel(variant.labels.sold, { exact: true })).toBeDisabled()
    await expect(card.getByLabel(variant.labels.reason, { exact: true })).toBeDisabled()
    const screenshot = testInfo.outputPath('finance-exchange-persisted-retry.png')
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' })
    await testInfo.attach('finance-exchange-persisted-retry', { path: screenshot, contentType: 'image/png' })
    await card.getByRole('button', { name: variant.labels.retry, exact: true }).click()
    await expect.poll(() => posts.length).toBe(2)
    expect(posts[1]).toEqual(original)
    await expect(card.getByText(variant.labels.uncertain, { exact: true })).toHaveCount(0)
    await expect(card.getByLabel(variant.labels.sold, { exact: true })).toHaveValue('')
  })
}
