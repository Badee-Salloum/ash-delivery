import { expect, test } from '@playwright/test'
import { preparePublicSurface, stubAdminShell, stubSignedOut } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'

const loginVariants = [
  { name: 'arabic-light', language: 'ar' as const, appearance: 'light' as const },
  { name: 'english-dark', language: 'en' as const, appearance: 'dark' as const },
]

for (const variant of loginVariants) {
  test(`admin login — ${variant.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'admin-desktop', 'Desktop-only admin surface.')
    await preparePublicSurface(page, variant)
    await stubSignedOut(page)
    await page.goto(adminUrl)
    await expect(page.locator('form')).toBeVisible()
    await expect(page.locator('#root')).toHaveScreenshot(`admin-login-${variant.name}.png`, { fullPage: true })
  })
}

test('admin navigation shell — arabic light', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'admin-desktop', 'Desktop-only admin surface.')
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubAdminShell(page)
  await page.goto(adminUrl)
  await expect(page.locator('aside')).toBeVisible()
  // Limit this assertion to the stable shell. Dashboard data belongs to API/component tests, while
  // the rail owns the cross-page visual system, language, and appearance controls.
  await expect(page.locator('aside')).toHaveScreenshot('admin-shell-arabic-light.png')
})
