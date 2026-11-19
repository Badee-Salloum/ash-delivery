import { expect, test, type Page } from '@playwright/test'
import { preparePublicSurface, stubAdminShell } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
const shiftId = 'visual-decision-shift'
async function fixture(page: Page, failWrite = false) {
  await stubAdminShell(page)
  const pkg = { odometerKm: 100, batteryPercent: 80, odometerKmOcr: 100, batteryPercentOcr: 80, floatTotal: '0.00', topupTotal: '0.00', mediaSlots: [], batteries: [] }
  const review = {
    id: shiftId, state: 'pending_review', driverId: 'visual-driver', vehicleId: 'visual-vehicle', driverNameAr: 'سائق اختبار', driverNameEn: 'Test driver', vehicleCode: 'VIS1',
    shiftNo: 1, businessDate: '2026-10-12', openApprovedAt: '2026-10-12T08:30:00Z', windowOpensAt: '2026-10-12T08:30:00Z', submittedAt: '2026-10-12T20:30:00Z',
    shiftFunding: { cash: '0.00', wallet: '0.00' }, startPackage: pkg,
    endPackage: { ...pkg, odometerKm: 120, odometerKmOcr: 120, cashDeclared: '0.00', walletDeclared: '0.00', walletDeclaredOcr: '0.00' },
    orders: [
      { providerOrderNo: 'A', kind: 'yallago', source: 'ocr', payMode: 'cash', fee: '330.00', zone: null, included: true, occurredDate: '2026-10-12', occurredMinute: '14:33', windowStatus: 'in_window', windowBasis: 'printed_time', closeDraftReviewReasons: ['duplicate_suspect'], points: [{ role: 'start', label: 'بداية المسار', lat: null, lng: null }, { role: 'end', label: 'نهاية المسار', lat: null, lng: null }] },
      { providerOrderNo: 'B', kind: 'yallago', source: 'ocr', payMode: 'cash', fee: '230.00', zone: null, included: true, occurredDate: '2026-10-12', occurredMinute: '14:33', windowStatus: 'in_window', windowBasis: 'printed_time', closeDraftReviewReasons: ['duplicate_suspect'] },
      { providerOrderNo: 'C', kind: 'yallago', source: 'ocr', payMode: 'cash', fee: '280.00', zone: null, included: false, occurredDate: null, occurredMinute: null, windowStatus: 'unknown', windowBasis: null, closeDraftReviewReasons: ['missing_time'] },
    ],
    cashDeductions: [{ id: 'D', operationKey: 'recent-orders:D', amount: '10.00', occurredDate: null, occurredMinute: null, source: 'ocr', pointA: null, pointB: null, included: false, windowStatus: 'unknown', decisionReason: null }],
    movements: [], media: [], decisions: [],
    duplicateHints: [{ earlier: { slot: 'dashboard', mediaId: 'page-A' }, later: { slot: 'dashboard_2', mediaId: 'page-B' }, length: 1, causes: ['scan_overlap_amount_disagrees'], pairs: [{ earlier: { kind: 'order', providerOrderNo: 'A', observationId: 'ob-A', rowIndex: 0 }, later: { kind: 'order', providerOrderNo: 'B', observationId: 'ob-B', rowIndex: 0 }, causes: ['scan_overlap_pair_minute_agrees', 'scan_overlap_pair_route_agrees', 'scan_overlap_pair_amount_disagrees'] }] }],
    br1: { expectedCash: '0.00', expectedWallet: '0.00', difference: '0.00', cashDifference: '0.00', walletDifference: '0.00', balanced: true, splitBalanced: true, minWalletBalance: '0.00', causes: [], ordersHash: 'fixture-hash', cashDeductionTotal: '0.00' },
  }
  // Use a real review-reason code; duplicate hints are a separate contract, not reason codes.
  for (const order of review.orders) if (order.providerOrderNo !== 'C') order.closeDraftReviewReasons = ['reader_conflict']
  const writes: Record<string, unknown>[] = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === `/api/shifts/${shiftId}/review`) return json(review)
    if (path === `/api/shifts/${shiftId}/operations/revise`) {
      const body = route.request().postDataJSON()
      writes.push(body)
      if (failWrite) return json({ error: 'conflict' }, 409)
      for (const change of body.orders ?? []) Object.assign(review.orders.find((row) => row.providerOrderNo === change.providerOrderNo)!, change, { decisionReason: change.reason, windowBasis: 'manager', closeDraftReviewReasons: [] })
      for (const change of body.cashDeductions ?? []) Object.assign(review.cashDeductions.find((row) => row.id === change.id)!, change, { decisionReason: change.reason, windowBasis: 'manager', closeDraftReviewReasons: [] })
      return json({ ok: true })
    }
    return route.fallback()
  })
  await page.goto(`${adminUrl}#shift:${shiftId}`)
  return { writes }
}

for (const lang of ['ar', 'en'] as const) {
  test(`exceptional inclusion and duplicate preview — ${lang}`, async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('admin-'))
    await preparePublicSurface(page, { language: lang, appearance: testInfo.project.name === 'admin-mobile' ? 'dark' : 'light' })
    const { writes } = await fixture(page)
    const reasonLabel = lang === 'ar' ? 'السبب المدقّق' : 'Audited reason'
    const confirmLabel = lang === 'ar' ? 'تأكيد القرار وحفظه' : 'Confirm and save decision'
    const exception = page.locator('article').filter({ has: page.getByText('280.00', { exact: false }) }).last()
    await exception.getByRole('button', { name: lang === 'ar' ? 'تضمين استثنائي' : 'Include exceptionally', exact: true }).click()
    await expect(exception.getByRole('button', { name: confirmLabel })).toBeDisabled()
    await expect(exception).toContainText(lang === 'ar' ? 'لا يُنشئ هذا القرار وقتاً مقروءاً' : 'does not create a read clock')
    expect(writes).toHaveLength(0)
    await exception.getByLabel(reasonLabel).fill('راجعت الصورة الأصلية وتأكدت من الطلب')
    await exception.getByRole('button', { name: confirmLabel }).click()
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0]?.orders).toEqual([{ providerOrderNo: 'C', included: true, reason: 'راجعت الصورة الأصلية وتأكدت من الطلب' }])
    expect(JSON.stringify(writes[0])).not.toContain('occurred')

    const duplicate = page.locator('article').filter({ has: page.getByText('بداية المسار', { exact: false }) }).first()
    await expect(duplicate.locator('input[type=radio]:checked')).toHaveCount(0)
    await duplicate.getByLabel(reasonLabel).fill('راجعت الصورتين؛ أبقي الطلب الأول')
    await duplicate.locator('input[type=radio]').first().check()
    await expect(duplicate).toContainText('330.00')
    await expect(duplicate).toContainText('2026-10-12')
    expect(writes).toHaveLength(1)
    await duplicate.screenshot({ path: testInfo.outputPath(`duplicate-preview-${lang}.png`) })
    await duplicate.getByRole('button', { name: confirmLabel }).click()
    await expect.poll(() => writes.length).toBe(2)
    expect(writes[1]?.orders).toEqual([
      { providerOrderNo: 'A', included: true, reason: 'راجعت الصورتين؛ أبقي الطلب الأول' },
      { providerOrderNo: 'B', included: false, reason: 'راجعت الصورتين؛ أبقي الطلب الأول' },
    ])
    await expect(page.getByRole('heading', { name: lang === 'ar' ? 'يحتاج انتباهك — 1' : 'Needs your attention — 1', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: confirmLabel })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })
}

test('failed save keeps the preview and reason; unsaved time blocks decisions', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const { writes } = await fixture(page, true)
  const card = page.locator('article').filter({ has: page.getByRole('button', { name: 'تضمين استثنائي', exact: true }) }).first()
  await card.getByRole('button', { name: 'تضمين استثنائي', exact: true }).click()
  await card.getByLabel('السبب المدقّق').fill('تحقق مستقل من الصورة')
  await card.getByRole('button', { name: 'تأكيد القرار وحفظه' }).click()
  await expect.poll(() => writes.length).toBe(1)
  await expect(card.getByLabel('السبب المدقّق')).toHaveValue('تحقق مستقل من الصورة')
  await expect(card.getByRole('button', { name: 'تأكيد القرار وحفظه' })).toBeEnabled()
  await card.getByRole('button', { name: 'إلغاء', exact: true }).click()
  await card.locator('summary').last().click()
  await card.locator('input[type=time]').fill('15:30')
  await expect(card.getByRole('button', { name: 'تضمين استثنائي', exact: true })).toBeDisabled()
  expect(writes).toHaveLength(1)
})

test('a time draft on the counterpart also blocks duplicate confirmation', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const { writes } = await fixture(page)
  const cards = page.locator('article').filter({ has: page.getByText('يُحتمل أنّ هذين صفّان لتوصيلة واحدة', { exact: true }) })
  const first = cards.first(), other = cards.nth(1)
  await first.getByLabel('السبب المدقّق').fill('مطابقة الصورتين')
  await first.locator('input[type=radio]').first().check()
  await expect(first.getByRole('button', { name: 'تأكيد القرار وحفظه' })).toBeEnabled()
  await other.locator('summary').last().click()
  await other.locator('input[type=time]').fill('15:30')
  await expect(first.getByRole('button', { name: 'تأكيد القرار وحفظه' })).toBeDisabled()
  expect(writes).toHaveLength(0)
})

test('cash deduction inclusion uses the same preview without changing its time', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const { writes } = await fixture(page)
  const card = page.locator('article').filter({ has: page.getByText('حسم نقدي', { exact: true }) })
  await card.getByRole('button', { name: 'تضمين استثنائي', exact: true }).click()
  await card.getByLabel('السبب المدقّق').fill('تأكدت من الحسم')
  const preview = card.getByRole('region', { name: 'راجع أثر القرار قبل الحفظ' })
  await expect(preview).toContainText('التغيير في إجمالي الحسميات النقدية')
  await expect(preview).toContainText('10.00')
  await preview.getByRole('button', { name: 'تأكيد القرار وحفظه' }).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]?.cashDeductions).toEqual([{ id: 'D', included: true, reason: 'تأكدت من الحسم' }])
})

test('correct-and-include previews the verified time and posts one atomic decision', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const { writes } = await fixture(page)
  const card = page.locator('article').filter({ has: page.getByRole('button', { name: 'تضمين استثنائي', exact: true }) }).first()
  await card.getByLabel('السبب المدقّق').fill('الوقت ظاهر في الصورة الأصلية')
  await card.locator('summary').last().click()
  await card.locator('input[type=time]').fill('12:14')
  await card.getByRole('button', { name: 'تصحيح الوقت وتضمين الطلب' }).click()
  const preview = card.getByRole('region', { name: 'راجع أثر القرار قبل الحفظ' })
  await expect(preview).toContainText('12:14')
  expect(writes).toHaveLength(0)
  await preview.getByRole('button', { name: 'تأكيد القرار وحفظه' }).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]?.orders).toEqual([{ providerOrderNo: 'C', occurredDate: '2026-10-12', occurredMinute: '12:14', included: true, reason: 'الوقت ظاهر في الصورة الأصلية' }])
})
