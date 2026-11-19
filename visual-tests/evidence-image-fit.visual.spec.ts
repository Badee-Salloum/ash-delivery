import { expect, test } from '@playwright/test'
import { preparePublicSurface, stubAdminShell } from './fixtures.ts'
const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
test('uploaded photos fit the available screen height and remain zoomable', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubAdminShell(page)
  const pkg = { odometerKm: 100, batteryPercent: 80, odometerKmOcr: 100, batteryPercentOcr: 80, floatTotal: '0.00', topupTotal: '0.00', mediaSlots: [], batteries: [] }
  await page.route('**/api/shifts/fit-fixture/review', route => route.fulfill({ json: {
    id: 'fit-fixture', state: 'pending_review', driverId: 'visual-driver', vehicleId: 'visual-vehicle', driverNameAr: 'سائق اختبار', vehicleCode: 'TEST',
    shiftNo: 1, businessDate: '2026-10-21', windowOpensAt: '2026-10-21T08:30:00Z', submittedAt: '2026-10-21T20:00:00Z',
    shiftFunding: { cash: '0.00', wallet: '0.00' }, startPackage: pkg,
    endPackage: { ...pkg, cashDeclared: '0.00', walletDeclared: '0.00', walletDeclaredOcr: '0.00' },
    orders: [], cashDeductions: [], movements: [], decisions: [],
    media: [{ package: 'end', slot: 'dashboard', mediaId: 'fit-tall' }, { package: 'end', slot: 'dashboard_2', mediaId: 'fit-wide' }],
    br1: { expectedCash: '0.00', expectedWallet: '0.00', difference: '0.00', cashDifference: '0.00', walletDifference: '0.00', balanced: true, splitBalanced: true, minWalletBalance: '0.00', causes: [], ordersHash: 'fixture', cashDeductionTotal: '0.00' },
  } }))
  await page.route('**/api/media/fit-*', route => {
    const tall = route.request().url().endsWith('fit-tall')
    return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${tall ? 1080 : 4000}" height="${tall ? 6000 : 1000}"><rect width="100%" height="100%" fill="white"/><rect x="1" y="1" width="${tall ? 1078 : 3998}" height="${tall ? 5998 : 998}" fill="none" stroke="black" stroke-width="12"/><text x="20" y="100" font-size="72">TEST IMAGE</text></svg>` })
  })
  const writes: string[] = []
  page.on('request', request => { if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.method()) })
  await page.goto(`${adminUrl}#shift:fit-fixture`)
  // Expand the real evidence disclosure rather than rendering a detached imitation of the viewer.
  await page.locator('details').evaluateAll(elements => elements.forEach(element => { element.open = true }))
  await page.locator('button').filter({ has: page.locator('img[src="/api/media/fit-tall"]') }).first().click()
  const dialog = page.getByRole('dialog'), viewport = dialog.locator('[data-evidence-viewport]'), image = dialog.locator('img')
  const assertFit = async () => {
    await expect.poll(async () => image.evaluate(img => img.complete && img.naturalHeight > 0)).toBe(true)
    await expect.poll(async () => {
      const img = await image.boundingBox(), area = await viewport.boundingBox()
      return Boolean(img && area && img.height <= area.height + 1 && img.width <= area.width + 1 && img.y >= area.y - 1 && img.y + img.height <= area.y + area.height + 1)
    }).toBe(true)
    expect(await viewport.evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
  await assertFit()
  await dialog.screenshot({ path: testInfo.outputPath('fitted-tall.png') })
  const original = (await image.boundingBox())!
  await dialog.getByRole('button', { name: '+', exact: true }).click()
  await expect.poll(async () => (await image.boundingBox())!.height).toBeCloseTo(original.height * 1.5, 0)
  expect(await viewport.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  await viewport.evaluate(el => el.scrollTo(0, el.scrollHeight))
  await dialog.getByRole('button', { name: '›', exact: true }).click()
  await expect(image).toHaveAttribute('src', '/api/media/fit-wide')
  await assertFit()
  await expect(dialog.getByText('100%', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 740, height: 360 })
  await assertFit()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(writes).toEqual([])
})
