import type { Page } from '@playwright/test'
import { stubAdminShell } from './fixtures.ts'

/**
 * The finance visual is intentionally a sealed fixture: it authenticates as a synthetic branch
 * manager and fulfills every API call its movement register makes.  This keeps screenshots useful
 * without allowing Vite's proxy, a cookie, or a developer's local database into the test.
 */
export async function stubTreasuryMovements(page: Page): Promise<void> {
  await stubAdminShell(page)

  await page.route('**/api/notifications**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ unreadCount: 0, notifications: [] }),
  }))
  await page.route('**/api/shifts**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ shifts: [] }),
  }))
  await page.route('**/api/dashboard/meta**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      today: '2026-09-19',
      goLiveBusinessDate: '2026-09-01',
      firstActivityDate: '2026-09-01',
      epoch: '2026-09-01',
      weekStart: '2026-09-13',
      monthStart: '2026-09-01',
      dayStartMinutes: 240,
      maxRangeDays: 366,
    }),
  }))
  await page.route('**/api/treasury/movements**', (route) => {
    const query = new URL(route.request().url()).searchParams
    const empty = query.get('q') === 'no matching reason'
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        from: query.get('from') ?? '2026-09-01',
        to: query.get('to') ?? '2026-09-19',
        rows: empty
          ? []
          : [
              {
                id: 902,
                createdAt: '2026-09-18T21:13:45.000Z',
                businessDate: '2026-09-19',
                eventType: 'restoration',
                reason: 'Synthetic daily restoration',
                shiftId: null,
                actorId: 'visual-manager',
                actorName: 'Visual manager',
                cash: '12500.00',
                wallet: '-2500.00',
                flow: 'in',
              },
              {
                id: 901,
                createdAt: '2026-09-18T18:01:02.000Z',
                businessDate: '2026-09-18',
                eventType: 'manual',
                reason: 'Synthetic office-wallet transfer',
                shiftId: null,
                actorId: 'visual-manager',
                actorName: 'Visual manager',
                cash: '-3000.00',
                wallet: '3000.00',
                flow: 'internal',
              },
            ],
        nextCursor: null,
        facets: {
          eventTypes: ['restoration', 'manual'],
          actors: [{ id: 'visual-manager', name: 'Visual manager' }],
        },
      }),
    })
  })
}
