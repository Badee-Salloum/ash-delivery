import { expect, test } from '@playwright/test'
import { ar } from '../packages/client/src/i18n/ar.ts'
import { preparePublicSurface } from './fixtures.ts'

// Entirely synthetic responses: no credentials, accounts or production API are used.
for (const failureAt of ['login', 'session'] as const) {
  test(`server failure during ${failureAt} is not reported as a password error`, async ({ page }, testInfo) => {
    const driver = testInfo.project.name.startsWith('driver-')
    const url = driver ? 'http://127.0.0.1:4174' : 'http://127.0.0.1:4173'
    await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
    let attemptedLogin = false
    await page.route('**/api/**', (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'database_busy' }),
    }))
    await page.route('**/api/me', (route) => route.fulfill({
      status: attemptedLogin ? 503 : 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: attemptedLogin ? 'database_busy' : 'unauthenticated' }),
    }))
    await page.route('**/api/auth/login', (route) => {
      attemptedLogin = true
      return route.fulfill({
        status: failureAt === 'login' ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify(failureAt === 'login' ? { error: 'database_busy' } : { ok: true }),
      })
    })
    await page.goto(url)
    await page.locator('input[autocomplete="username"]').fill('synthetic-driver')
    await page.locator('input[autocomplete="current-password"]').fill('synthetic-test-only')
    await page.getByRole('button', { name: ar.auth.signIn, exact: true }).click()
    await expect(page.getByText(ar.auth.loginUnavailable, { exact: true })).toBeVisible()
    await expect(page.getByText(ar.auth.invalidCredentials, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: ar.auth.signIn, exact: true })).toBeEnabled()
  })
}

test('driver retries assignment after a transient failure without starting a shift', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('driver-'), 'Driver-only assignment recovery.')
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  let attempts = 0
  const writes: string[] = []
  await page.route('**/api/**', (route) => {
    if (route.request().method() !== 'GET') writes.push(route.request().url())
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture_unavailable"}' })
  })
  await page.route('**/api/me', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ userId: 'test-user', driverId: 'test-driver', roleKey: 'driver', branchId: 'test-branch', businessDate: '2026-10-07' }),
  }))
  await page.route('**/api/me/assignment', (route) => {
    attempts += 1
    return route.fulfill({
      status: attempts === 1 ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(attempts === 1 ? { error: 'database_busy' } : {
        driverId: 'test-driver', branchId: 'test-branch', assigned: false,
        liveShiftId: null, liveShiftState: null, vehicles: [],
      }),
    })
  })
  await page.goto('http://127.0.0.1:4174')
  await expect(page.getByRole('button', { name: ar.common.retry, exact: true })).toBeVisible()
  await page.getByRole('button', { name: ar.common.retry, exact: true }).click()
  await expect(page.getByText(ar.shift.noAssignment, { exact: true })).toBeVisible()
  expect(attempts).toBe(2)
  expect(writes).toEqual([])
})
