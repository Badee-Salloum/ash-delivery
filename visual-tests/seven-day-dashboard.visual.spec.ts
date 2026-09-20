import { expect, test } from '@playwright/test'
import { stubSevenDayDashboard } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'

// Pair the two intentional presentation variants: together they cover RTL/LTR, both painted
// themes, and the desktop table plus its phone-card reflow without multiplying the same baseline.
const variants = [
  {
    name: 'arabic-light-desktop', project: 'admin-desktop', language: 'ar' as const, appearance: 'light' as const,
    heading: 'آخر 7 أيام', range: 'من 14 إلى 20 أيلول',
  },
  {
    name: 'english-dark-mobile', project: 'admin-mobile', language: 'en' as const, appearance: 'dark' as const,
    heading: 'Last 7 days', range: 'From 14 to 20 September',
  },
]

for (const variant of variants) {
  test(`last seven dashboard days — ${variant.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== variant.project, `Only the ${variant.project} baseline owns this presentation.`)
    await preparePublicSurface(page, variant)
    await stubSevenDayDashboard(page, { privileged: variant.project === 'admin-desktop' })

    await page.goto(`${adminUrl}#dashboard`)
    const section = page.locator('section[aria-labelledby="dashboard-last-seven-days"]')
    await expect(section.getByRole('heading', { name: variant.heading, exact: true })).toBeVisible()
    await expect(section.getByText(variant.range, { exact: true })).toBeVisible()
    await expect(section.locator('tbody > tr')).toHaveCount(7)
    await expect(section.getByRole('link')).toHaveCount(7)

    if (variant.project === 'admin-mobile') {
      // The visual baseline catches hierarchy/spacing; this semantic assertion catches the actual
      // responsive contract: a narrow row must become a readable card, never an overflow strip.
      await expect(section.locator('tbody > tr').first()).toHaveCSS('display', 'block')
    }

    await expect(section).toHaveScreenshot(`admin-dashboard-last-seven-days-${variant.name}.png`, { timeout: 15_000 })
  })
}
