import { expect, test } from '@playwright/test'
import { preparePublicSurface, stubRegistrationBranches, stubSignedOut } from './fixtures.ts'
import { stubSuspendedDriverShift } from './driver-fixtures.ts'

const driverUrl = process.env.ASH_DRIVER_VISUAL_URL ?? 'http://127.0.0.1:4174'

const matrix = {
  'driver-320': [
    { name: 'login-arabic-light', language: 'ar' as const, appearance: 'light' as const, surface: 'login' as const },
    { name: 'register-arabic-dark', language: 'ar' as const, appearance: 'dark' as const, surface: 'register' as const },
  ],
  'driver-390': [
    { name: 'login-english-light', language: 'en' as const, appearance: 'light' as const, surface: 'login' as const },
    { name: 'register-english-dark', language: 'en' as const, appearance: 'dark' as const, surface: 'register' as const },
  ],
} as const

for (const [projectName, variants] of Object.entries(matrix)) {
  for (const variant of variants) {
    test(`driver ${variant.name}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== projectName, 'Viewport-specific driver surface.')
      await preparePublicSurface(page, variant)
      await stubSignedOut(page)
      await stubRegistrationBranches(page)
      await page.goto(driverUrl)
      await expect(page.locator('form')).toBeVisible()

      if (variant.surface === 'register') {
        const buttonName = variant.language === 'ar' ? 'إنشاء حساب سائق' : 'Create driver account'
        await page.getByRole('button', { name: buttonName }).click()
        await expect(page.locator('select')).toBeVisible()
      }

      await expect(page.locator('#root')).toHaveScreenshot(`${variant.name}.png`, { fullPage: true })
    })
  }
}

test('driver suspended shift — arabic dark', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'driver-390', 'Authenticated mobile shift state at 390px.')
  await preparePublicSurface(page, { language: 'ar', appearance: 'dark' })
  await stubSuspendedDriverShift(page)
  await page.goto(driverUrl)

  // The state comes from the authenticated shift endpoint, rather than a component-only render:
  // this catches regressions in session restoration, the assigned vehicle path, and the hold alert.
  await expect(page.getByRole('heading', { name: 'معلّقة' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'متابعة نوبتك' })).toBeVisible()
  await expect(page.locator('#root')).toHaveScreenshot('suspended-shift-arabic-dark.png', { fullPage: true })
})
