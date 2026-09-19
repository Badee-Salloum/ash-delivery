import type { Page } from '@playwright/test'

export type Appearance = 'light' | 'dark'
export type Language = 'ar' | 'en'

/** Set preferences before either app's theme boot script gets a chance to paint. */
export async function preparePublicSurface(
  page: Page,
  options: { language: Language; appearance: Appearance },
): Promise<void> {
  await page.addInitScript(({ language, appearance }) => {
    localStorage.setItem('ash.lang', language)
    localStorage.setItem('ash.theme', appearance)
  }, options)

  // A fresh browser context should never inherit a PWA cache while making a pixel assertion.
  await page.addInitScript(() => {
    navigator.serviceWorker?.getRegistrations?.().then((registrations) => {
      for (const registration of registrations) void registration.unregister()
    }).catch(() => undefined)
  })
}

/** The logged-out state is intentional and must not talk to a real API. */
export async function stubSignedOut(page: Page): Promise<void> {
  await page.route('**/api/me', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'unauthorized' }),
  }))
}

/** Public registration can list branches; the fixture has no privileged or production data. */
export async function stubRegistrationBranches(page: Page): Promise<void> {
  await page.route('**/api/auth/register/branches', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      branches: [
        { id: 'visual-branch-1', code: 'VIS', nameAr: 'فرع الاختبار', nameEn: 'Visual branch' },
      ],
    }),
  }))
}

/** A signed-in shell fixture contains only a role and synthetic branch identifier. */
export async function stubAdminShell(page: Page): Promise<void> {
  // Register the fallback first: Playwright runs the most recently registered matching route first,
  // so the concrete `/api/me` fixture below still wins. Everything else fails locally and quietly
  // instead of leaking to Vite's proxy (or a real service) while the shell screenshot is taken.
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'visual_fixture_unavailable' }),
  }))
  await page.route('**/api/me', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      userId: 'visual-manager',
      roleKey: 'branch_manager',
      branchId: 'visual-branch-1',
      driverId: null,
      businessDate: '2026-09-19',
    }),
  }))
}
