import { defineConfig } from '@playwright/test'

/**
 * Public-surface visual checks deliberately run against Vite, not a deployed environment.  The
 * tests stub the small unauthenticated API contract they need, so no real account, database, or
 * credentials can appear in screenshots.
 */
export default defineConfig({
  testDir: './visual-tests',
  testMatch: '**/*.visual.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  timeout: 30_000,
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.005,
    },
  },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  use: {
    browserName: 'chromium',
    colorScheme: 'light',
    locale: 'ar-SY',
    timezoneId: 'Asia/Damascus',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'admin-desktop',
      use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    },
    {
      // The console uses the same responsive table/card primitives on a manager's phone. Keep an
      // admin project here instead of borrowing a Driver viewport so admin visual specs exercise
      // the real compact shell, drawer and reflow rules.
      name: 'admin-mobile',
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    },
    {
      name: 'driver-320',
      use: { viewport: { width: 320, height: 740 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    },
    {
      name: 'driver-390',
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @ash/admin exec vite --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'pnpm --filter @ash/driver exec vite --host 127.0.0.1 --port 4174 --strictPort',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
})
