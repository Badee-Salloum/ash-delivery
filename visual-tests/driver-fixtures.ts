import type { Page } from '@playwright/test'

const driverId = 'visual-driver-1'
const vehicleId = 'visual-vehicle-17'
const shiftId = 'visual-shift-suspended-17'

/**
 * A complete, authenticated driver fixture for a shift deliberately put on hold by the branch.
 * It is kept separate from the public fixtures so a visual assertion cannot accidentally acquire
 * a real session or fall through to a development API while exercising a signed-in surface.
 */
export async function stubSuspendedDriverShift(page: Page): Promise<void> {
  // Register the safety net first: later, exact fixtures take precedence in Playwright. Any
  // unexpected request is visibly local and cannot leave the test process for an API server.
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'visual_fixture_unavailable' }),
  }))

  await page.route('**/api/me', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      userId: 'visual-user-1',
      roleKey: 'driver',
      branchId: 'visual-branch-1',
      driverId,
      businessDate: '2026-09-19',
    }),
  }))

  await page.route('**/api/me/assignment', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      driverId,
      branchId: 'visual-branch-1',
      assigned: true,
      liveShiftId: shiftId,
      liveShiftState: 'suspended',
      vehicles: [
        {
          id: vehicleId,
          code: 'VIS-17',
          groundNo: '17',
          state: 'active',
          busy: true,
          busyByMe: true,
          batteries: [],
        },
      ],
      spareBatteries: [],
    }),
  }))

  await page.route(`**/api/shifts/${shiftId}/state`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      id: shiftId,
      state: 'suspended',
      driverId,
      vehicleId,
      shiftNo: 17,
      businessDate: '2026-09-19',
      openApprovedAt: '2026-09-19T08:00:00.000Z',
      submittedAt: null,
      startPackage: {
        odometerKm: 1200,
        batteryPercent: null,
        floatTotal: '25000',
        topupTotal: '50000',
        mediaSlots: [],
        batteries: [],
      },
      endPackage: {
        odometerKm: null,
        batteryPercent: null,
        cashDeclared: null,
        walletDeclared: null,
        mediaSlots: [],
        batteries: [],
      },
      orders: [],
      movements: [],
      cashDeductions: [],
      batterySwaps: [],
      lastDecision: null,
    }),
  }))
}
