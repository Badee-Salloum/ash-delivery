import { expect, test } from '@playwright/test'
import { stubTreasuryMovements } from './finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'

test('treasury movement register - rows and filtered empty state', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'admin-desktop', 'Desktop-only admin finance surface.')
  await preparePublicSurface(page, { language: 'en', appearance: 'light' })
  await stubTreasuryMovements(page)

  await page.goto(`${adminUrl}#treasuryMovements?range=this_month`)
  await expect(page.locator('h1', { hasText: 'Treasury movements' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Daily restoration', exact: true })).toBeVisible()
  await expect(page.locator('#root')).toHaveScreenshot('admin-treasury-movements-rows-english-light.png', { fullPage: true })

  await page.getByLabel('Search reason').fill('no matching reason')
  await page.getByRole('button', { name: 'Show', exact: true }).click()
  await expect(page.getByText('No treasury movements match these filters.')).toBeVisible()
  await expect(page.locator('#root')).toHaveScreenshot('admin-treasury-movements-empty-filters-english-light.png', { fullPage: true })
})
