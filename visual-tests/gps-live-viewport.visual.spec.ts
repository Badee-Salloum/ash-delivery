import { test, expect, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { preparePublicSurface } from './fixtures.ts'
import { gpsPreviewBranches, gpsPreviewData, gpsPreviewDirectory, gpsPreviewUser } from './gps-live-viewport-fixtures.ts'
const base = process.env.ASH_MAP_TEST_URL ?? 'http://127.0.0.1:4173', output = resolve('outputs/map-viewport-20261018')
const key = (branch = gpsPreviewBranches[0]!.id) => `ash.gpsLive.viewport.v1:${gpsPreviewUser}:${branch}`
const readView = (page: Page, storageKey = key()) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null') as {lat:number;lng:number;zoom:number}|null, storageKey)
test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await page.clock.install()
  // Local fixtures only. No real GPS data, production request or external tile request escapes.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    const data = path === '/api/me' ? { userId: gpsPreviewUser, roleKey: 'system_admin', branchId: null, driverId: null, businessDate: '2026-10-18' }
      : path === '/api/branches' ? { branches: gpsPreviewBranches }
      : path === '/api/drivers' ? gpsPreviewDirectory
      : path === '/api/gps/live' ? gpsPreviewData()
      : path === '/api/notifications' ? { unreadCount: 0, notifications: [] }
      : path === '/api/shifts' ? { shifts: [] } : null
    return route.fulfill({ status: data ? 200 : 503, json: data ?? { error: 'sealed_fixture_missing' } })
  })
})
test('zoom and pan survive polling, new names, language/theme changes and a full reload', async ({ page }, info) => {
  let reads = 0
  await page.route('**/api/gps/live?**', route => route.fulfill({ json: gpsPreviewData(reads++ === 0 ? 0 : 0.2) }))
  await page.goto(`${base}/#gpsLive`)
  await expect(page.locator('.leaflet-interactive')).toHaveCount(2)
  await expect.poll(() => readView(page)).not.toBeNull()
  const initial = (await readView(page))!
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.clock.fastForward(1000)
  await expect.poll(async () => (await readView(page))?.zoom).toBe(initial.zoom + 1)
  await page.locator('.leaflet-container').press('ArrowRight')
  await page.clock.fastForward(1000)
  const chosen = (await readView(page))!
  expect(chosen.lng).not.toBe(initial.lng)
  await page.clock.fastForward(10500)
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2)
  await expect.poll(() => readView(page)).toEqual(chosen)
  await mkdir(output, { recursive: true })
  await page.getByRole('region', { name: 'الخريطة الحية', exact: true }).screenshot({ path: resolve(output, `chosen-${info.project.name}.png`) })
  await page.reload()
  await expect(page.locator('.leaflet-interactive')).toHaveCount(2)
  await expect.poll(() => readView(page)).toEqual(chosen)
  const menu = page.getByRole('button', { name: 'القائمة', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: 'داكنة', exact: true }).click()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect.poll(() => readView(page)).toEqual(chosen)
  const closeMenu = page.getByRole('button', { name: 'Close', exact: true })
  if (await closeMenu.isVisible()) await closeMenu.click()
  await page.getByRole('region', { name: 'Live map', exact: true }).screenshot({ path: resolve(output, `chosen-english-dark-${info.project.name}.png`) })
  // View-all is explicit; it is the only operation that should fit the new distant positions.
  await page.getByRole('button', { name: 'Show all drivers', exact: true }).click()
  await expect.poll(() => readView(page)).not.toEqual(chosen)
  const all = await readView(page)
  await page.clock.fastForward(10500)
  await expect.poll(() => readView(page)).toEqual(all)
})
test('an empty first read and unavailable storage never break the map', async ({ page }) => {
  let reads = 0
  await page.route('**/api/gps/live?**', route => route.fulfill({ json: reads++ === 0 ? { drivers: [], silent: [], health: [] } : gpsPreviewData() }))
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw Error('storage denied') } })
  await page.goto(`${base}/#gpsLive`)
  await expect(page.getByRole('button', { name: 'إظهار جميع السائقين', exact: true })).toBeDisabled()
  await expect.poll(() => reads).toBe(1)
  await page.clock.fastForward(10500)
  await expect(page.locator('.leaflet-interactive')).toHaveCount(2)
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.clock.fastForward(1000)
  await expect(page.getByRole('button', { name: 'إظهار جميع السائقين', exact: true })).toBeEnabled()
})
test('each branch restores its own chosen view without fitting to the previous branch', async ({ page }) => {
  const one = { lat: 33.51, lng: 36.28, zoom: 16 }, two = { lat: 34.1, lng: 37.2, zoom: 11 }
  await page.addInitScript(({ one, two, first, second }) => { localStorage.setItem(first, JSON.stringify(one)); localStorage.setItem(second, JSON.stringify(two)) }, { one, two, first: key(), second: key(gpsPreviewBranches[1]!.id) })
  await page.goto(`${base}/#gpsLive`)
  await expect(page.locator('.leaflet-interactive')).toHaveCount(2)
  await expect.poll(() => readView(page)).toEqual(one)
  await page.getByRole('combobox', { name: 'الفرع', exact: true }).selectOption(gpsPreviewBranches[1]!.id)
  await expect.poll(() => readView(page, key(gpsPreviewBranches[1]!.id))).toEqual(two)
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.clock.fastForward(1000)
  await expect.poll(async () => (await readView(page, key(gpsPreviewBranches[1]!.id)))?.zoom).toBe(12)
  await page.getByRole('combobox', { name: 'الفرع', exact: true }).selectOption(gpsPreviewBranches[0]!.id)
  await expect.poll(() => readView(page)).toEqual(one)
})
test('manual zoom before the first location response wins over the initial auto-fit', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/gps/live?**', async route => { await gate; await route.fulfill({ json: gpsPreviewData() }) })
  await page.goto(`${base}/#gpsLive`)
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.clock.fastForward(1000)
  await expect.poll(async () => (await readView(page))?.zoom).toBe(13)
  const chosen = await readView(page)
  expect(chosen?.zoom).toBe(13)
  release()
  await expect(page.locator('.leaflet-interactive')).toHaveCount(2)
  await expect.poll(() => readView(page)).toEqual(chosen)
})

test('a delayed response from the previous branch cannot clear or replace the current pins', async ({ page }) => {
  let release!: () => void, firstRead = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/gps/live?**', async route => {
    const branch = new URL(route.request().url()).searchParams.get('branchId')
    if (branch === gpsPreviewBranches[0]!.id) { firstRead = true; await gate }
    await route.fulfill({ json: gpsPreviewData(branch === gpsPreviewBranches[0]!.id ? 0 : 0.2) })
  })
  await page.goto(`${base}/#gpsLive`)
  await expect.poll(() => firstRead).toBe(true)
  await page.getByRole('combobox', { name: 'الفرع', exact: true }).selectOption(gpsPreviewBranches[1]!.id)
  await expect(page.locator('.leaflet-interactive')).toHaveCount(2)
  const current = await page.getByRole('region', { name: 'السائقون', exact: true }).innerText()
  release()
  await page.clock.fastForward(1000)
  await expect(page.locator('.leaflet-interactive')).toHaveCount(2)
  await expect(page.getByRole('region', { name: 'السائقون', exact: true })).toHaveText(current, { useInnerText: true })
})
