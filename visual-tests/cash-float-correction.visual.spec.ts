import { expect, test, type Page } from '@playwright/test'
import { ar } from '../packages/client/src/i18n/ar.ts'
import { en } from '../packages/client/src/i18n/en.ts'
import { formatMinor, parseMinor } from '../packages/domain/src/index.ts'
import { preparePublicSurface, stubAdminShell } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
const shiftId = 'cash-float-fixture'

async function fixture(page: Page, options: { failFirst?: boolean; failRefresh?: boolean; state?: string } = {}) {
  await stubAdminShell(page)
  const writes: Record<string, unknown>[] = []
  const forbiddenWrites: string[] = []
  let total = '20000.00'
  let reviewReads = 0
  let settlementReads = 0
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === `/api/shifts/${shiftId}/review`) {
      reviewReads++
      if (options.failRefresh && writes.length) return json({ error: 'database_busy' }, 503)
      const pkg = { odometerKm: 100, odometerKmOcr: 100, batteryPercent: 80, batteries: [], mediaSlots: [], floatTotal: total, topupTotal: '0.00' }
      return json({
        id: shiftId, state: options.state ?? 'pending_review', driverId: 'fixture-driver', vehicleId: 'fixture-vehicle', driverNameAr: 'سائق اختبار', vehicleCode: 'TEST', shiftNo: 1,
        businessDate: '2026-11-03', openApprovedAt: '2026-11-03T08:30:00Z', windowOpensAt: '2026-11-03T08:30:00Z', submittedAt: '2026-11-03T20:30:00Z',
        shiftFunding: { cash: '0.00', wallet: '0.00' }, startPackage: pkg,
        endPackage: { ...pkg, odometerKm: 120, cashDeclared: '20000.00', walletDeclared: '0.00', walletDeclaredOcr: '0.00' },
        orders: [], cashDeductions: [], movements: [], media: [], decisions: [],
        br1: { expectedCash: total, expectedWallet: '0.00', difference: total === '20000.00' ? '0.00' : '18000.00', cashDifference: '0.00', walletDifference: '0.00', balanced: total === '20000.00', splitBalanced: true, minWalletBalance: '0.00', causes: [], ordersHash: 'fixture-orders' },
      })
    }
    if (path === `/api/shifts/${shiftId}/settlement`) {
      settlementReads++
      return json({
        policyCode: 'fixed_40_cash_close_v2_receivable', driverRateBps: 4000,
        deliveryFeeTotal: '0.00', fixedDriverShare: '0.00', manualDriverShare: '0.00', grossDriverShare: '0.00', cashDeductionTotal: '0.00', baseDriverShare: '0.00',
        expectedTotal: total, actualCash: '20000.00', actualWallet: '0.00', actualTotal: '20000.00', variance: total === '20000.00' ? '0.00' : '18000.00', varianceDirection: total === '20000.00' ? 'balanced' : 'surplus',
        finalEmployeeCash: '0.00', cashClaimToOffice: '20000.00', walletClaimToOffice: '0.00', cashReceivableDeferred: '0.00', walletReceivableDeferred: '0.00', maximumCashShortageReceivable: '0.00', cashShortageReceivable: '0.00',
        walletToOffice: '0.00', cashToOffice: '20000.00', walletAction: 'none', walletAmount: '0.00', cashAction: 'collect', cashAmount: '20000.00', settlementHash: (total === '20000.00' ? 'a' : 'b').repeat(64),
      })
    }
    if (path === `/api/shifts/${shiftId}/cash-float-adjustments`) {
      const body = route.request().postDataJSON()
      writes.push(body)
      if (options.failFirst && writes.length === 1) return json({ error: 'database_busy' }, 503)
      total = formatMinor(parseMinor(body.targetTotal))
      return json({ id: shiftId, from: body.expectedCurrentTotal, to: total, reduction: '18000.00', currentTotal: total, correctionEntryId: 123, replayed: false }, 201)
    }
    if (route.request().method() !== 'GET') forbiddenWrites.push(path)
    return route.fallback()
  })
  await page.goto(`${adminUrl}#shift:${shiftId}`, { waitUntil: 'domcontentloaded' })
  return { writes, forbiddenWrites, reviewReads: () => reviewReads, settlementReads: () => settlementReads }
}

for (const lang of ['ar', 'en'] as const) {
  test(`cash float correction refreshes the close statement and confirmations — ${lang}`, async ({ page }, testInfo) => {
    await preparePublicSurface(page, { language: lang, appearance: testInfo.project.name === 'admin-mobile' ? 'dark' : 'light' })
    const data = await fixture(page)
    const t = lang === 'ar' ? ar : en
    const copy = t.approval.cashFloatCorrection
    const approve = page.getByRole('button', { name: t.approval.approveClose, exact: true })
    await page.getByLabel(t.settlement.walletConfirmed, { exact: true }).check()
    await page.getByLabel(t.settlement.cashConfirmed, { exact: true }).check()
    await expect(approve).toBeEnabled()
    const initialReviewReads = data.reviewReads()
    await page.getByRole('button', { name: copy.edit, exact: true }).click()
    await expect(approve).toBeDisabled()
    await expect(page.getByLabel(t.settlement.cashConfirmed, { exact: true })).not.toBeChecked()
    await page.getByLabel(copy.target, { exact: true }).fill(lang === 'ar' ? '٢٠٠٠' : '2000')
    await page.getByLabel(copy.reason, { exact: true }).fill('Correct the recorded opening float')
    const editor = page.getByRole('region', { name: copy.edit, exact: true })
    await expect(editor).toContainText('18,000.00')
    await editor.screenshot({ path: testInfo.outputPath(`cash-float-${lang}.png`) })
    await editor.getByRole('button', { name: t.common.save, exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('18000.00')
    await dialog.getByRole('button', { name: t.common.save, exact: true }).click()
    await expect.poll(() => data.writes.length).toBe(1)
    expect(data.writes[0]).toMatchObject({ expectedCurrentTotal: '20000.00', targetTotal: '2000', reason: 'Correct the recorded opening float' })
    expect(String(data.writes[0]?.occurrenceKey)).toMatch(/^[\da-f-]{36}$/)
    await expect.poll(data.reviewReads).toBeGreaterThan(initialReviewReads)
    await expect.poll(data.settlementReads).toBeGreaterThan(1)
    await expect(page.getByRole('button', { name: copy.edit, exact: true })).toBeEnabled()
    await expect(editor).toContainText('2,000.00')
    await expect(approve).toBeDisabled()
    await expect(page.getByLabel(t.settlement.walletConfirmed, { exact: true })).not.toBeChecked()
    expect(data.forbiddenWrites).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })
}

test('cash float validation, cancellation and a lost-response retry preserve the same command', async ({ page }) => {
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const data = await fixture(page, { failFirst: true })
  const copy = ar.approval.cashFloatCorrection
  await page.getByRole('button', { name: copy.edit, exact: true }).click()
  const editor = page.getByRole('region', { name: copy.edit, exact: true })
  const save = editor.getByRole('button', { name: ar.common.save, exact: true })
  for (const value of ['', '-1', '20000', '20001', '2.001']) {
    await page.getByLabel(copy.target).fill(value)
    await expect(save).toBeDisabled()
  }
  await page.getByLabel(copy.target).fill('0')
  await page.getByLabel(copy.reason).fill('\u200f')
  await expect(save).toBeDisabled()
  await page.getByLabel(copy.target).fill('2000')
  await page.getByLabel(copy.reason).fill('تحقق من القيمة الصحيحة')
  await save.click()
  await page.getByRole('dialog').getByRole('button', { name: ar.common.cancel, exact: true }).click()
  expect(data.writes).toHaveLength(0)
  for (let attempt = 1; attempt <= 2; attempt++) {
    await save.click()
    await page.getByRole('dialog').getByRole('button', { name: ar.common.save, exact: true }).click()
    await expect.poll(() => data.writes.length).toBe(attempt)
    if (attempt === 1) await expect(save).toBeEnabled()
  }
  expect(data.writes[0]).toEqual(data.writes[1])
  expect(data.forbiddenWrites).toEqual([])
})

test('failed refresh blocks approval and exposes retry after the correction is saved', async ({ page }) => {
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const data = await fixture(page, { failRefresh: true })
  const copy = ar.approval.cashFloatCorrection
  await page.getByRole('button', { name: copy.edit, exact: true }).click()
  const initialReviewReads = data.reviewReads()
  await page.getByLabel(copy.target).fill('2000')
  await page.getByLabel(copy.reason).fill('القيمة الصحيحة حسب التسليم')
  await page.getByRole('region', { name: copy.edit }).getByRole('button', { name: ar.common.save, exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: ar.common.save, exact: true }).click()
  await expect.poll(() => data.writes.length).toBe(1)
  await expect.poll(data.reviewReads).toBeGreaterThan(initialReviewReads)
  await expect(page.getByRole('button', { name: ar.approval.approveClose, exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: copy.edit, exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: ar.common.retry, exact: true }).first()).toBeEnabled()
})

test('approved shifts show the stored float without the correction editor', async ({ page }) => {
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const data = await fixture(page, { state: 'approved' })
  await expect(page.getByRole('heading', { name: 'سائق اختبار' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: ar.approval.cashFloatCorrection.edit, exact: true })).toHaveCount(0)
  expect(data.writes).toHaveLength(0)
})
