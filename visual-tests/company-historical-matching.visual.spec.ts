import { expect, test, type Page } from '@playwright/test'
import type { HistoricalMatchingPreview } from '../apps/admin/src/screens/CompanyHistoricalRestorationMatching.tsx'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
const branchId = '10000000-0000-4000-8000-000000000001'
const zero = { SYP_NEW: '0.00', USD: '0.00' }
const fixture = (): HistoricalMatchingPreview => ({
  branchId, companyBranchId: '10000000-0000-4000-8000-000000000999', version: 0, evidenceHash: 'a'.repeat(64), eligible: true, blockingReasons: [],
  counts: { sourceCount: 3, hqJournalCount: 3, branchSourceCount: 3, groupCount: 2 },
  totals: { currency: 'SYP_NEW', hqNet: '120.00', branchNet: '121.00', amountDifference: '1.00' },
  groups: [{ restorationId: 11, businessDate: '2026-09-11', branchEntryIds: [600], sourceReferences: ['HQ-SRC-1'], hqEntryIds: [700], branchNet: '51.00', companyNet: '50.00', variance: '1.00', sources: [{ sourceReference: 'HQ-SRC-1', occurredOn: '2026-09-12', description: 'قبض مرتبط بترميم اليوم السابق', journalEntryId: 700, amount: '50.00', direction: 'to_company', linkStatus: 'probable_amount_date', linkNote: null }] },
    { restorationId: 13, businessDate: '2026-09-13', branchEntryIds: [601, 602], sourceReferences: ['HQ-SRC-2', 'HQ-SRC-3'], hqEntryIds: [701, 702], branchNet: '70.00', companyNet: '70.00', variance: '0.00', sources: [{ sourceReference: 'HQ-SRC-2', occurredOn: '2026-09-13', description: 'قبض أول', journalEntryId: 701, amount: '30.00', direction: 'to_company', linkStatus: 'confirmed_by_user', linkNote: 'راجع الربط المتعدد' }, { sourceReference: 'HQ-SRC-3', occurredOn: '2026-09-14', description: 'قبض ثان', journalEntryId: 702, amount: '40.00', direction: 'to_company', linkStatus: 'future_link_code', linkNote: null }] }],
  plan: { before: { historicalTransit: '-120.00', clearing: '0.00', matchingDifference: '121.00' }, after: { historicalTransit: '0.00', clearing: '-120.00', matchingDifference: '1.00' } },
  impacts: { companyCash: { ...zero }, branchCash: { ...zero }, pnl: { ...zero } }, settlements: [], unlinkedHistoricalCount: 2,
})
async function setup(page: Page) {
  await stubCompanyFund(page)
  await page.route('**/api/branches', route => route.fulfill({ json: { branches: [{ id: branchId, code: 'DAM', nameAr: 'فرع دمشق', nameEn: 'Damascus' }] } }))
  let current = fixture(), mode: 'success' | 'unknown' | 'stale' = 'success'
  const writes: Record<string, unknown>[] = []
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/')) writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }) })
  await page.route('**/api/company/historical-restoration-settlements/preview?**', route => route.fulfill({ json: current }))
  await page.route('**/api/company/historical-restoration-settlements', async route => {
    if (mode === 'unknown') { current = { ...current, eligible: false, version: 1, evidenceHash: 'b'.repeat(64) }; mode = 'success'; return route.fulfill({ status: 503, json: { error: 'reply_lost' } }) }
    if (mode === 'stale') { current = { ...current, evidenceHash: 'c'.repeat(64) }; mode = 'success'; return route.fulfill({ status: 409, json: { error: 'historical_settlement_source_changed' } }) }
    return route.fulfill({ status: 201, json: { id: '90000000-0000-4000-8000-000000000001', version: 1, businessDate: '2026-10-04', reason: String(route.request().postDataJSON().reason), sourceCount: 3, groupCount: 2, createdAtMs: 1, replayed: writes.length > 1 } })
  })
  return { writes, setMode: (value: typeof mode) => { mode = value }, setPreview: (value: HistoricalMatchingPreview) => { current = value } }
}
async function openDialog(page: Page) {
  await page.goto(`${adminUrl}#companyFund?tab=review`)
  const section = page.getByRole('region', { name: 'مطابقة الترميمات المسجلة سابقاً', exact: true })
  await section.getByRole('button', { name: 'مراجعة تصحيح الحساب المقابل', exact: true }).click()
  return page.getByRole('dialog', { name: 'مراجعة تصحيح الحساب المقابل', exact: true })
}
test('runtime historical mapping review shows neutral effects and confirms only after explicit review', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('admin-'))
  await preparePublicSurface(page, { language: 'ar', appearance: info.project.name === 'admin-mobile' ? 'dark' : 'light' })
  const { writes } = await setup(page)
  const dialog = await openDialog(page)
  await expect(dialog.getByText('صافي الحركات المسجلة في الشركة', { exact: true }).first()).toBeVisible()
  await expect(dialog.getByText('فرق المبالغ لا يُصفّر بهذا الإجراء، وأي ترميم غير مربوط يبقى في طابور المراجعة المنفصل.', { exact: true })).toBeVisible()
  const confirm = dialog.getByRole('button', { name: 'اعتماد تصحيح الحساب المقابل', exact: true })
  await expect(confirm).toBeDisabled()
  await expect(dialog.getByRole('heading', { name: 'مراجعة تصحيح الحساب المقابل', exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('historical-counterpart-preview.png') })
  await dialog.getByText('ربط متعدد — راجع المجموعة كاملة', { exact: false }).click()
  await expect(dialog.getByText('HQ-SRC-3', { exact: true }).first()).toBeVisible()
  await expect(dialog.locator('details[open]').getByText('702', { exact: true }).first()).toBeVisible()
  await expect(dialog.getByText('حالة الربط المسجلة: ربط أكّده المستخدم', { exact: true })).toBeVisible()
  await expect(dialog.getByText('حالة الربط المسجلة: حالة الربط غير معروفة — تحتاج مراجعتك', { exact: true })).toBeVisible()
  await expect(dialog.getByText('future_link_code', { exact: true })).not.toBeVisible()
  await dialog.getByText('رمز الربط التقني', { exact: true }).click()
  await expect(dialog.getByText('future_link_code', { exact: true })).toBeVisible()
  await dialog.getByLabel('السبب', { exact: true }).fill('مراجعة الحساب المقابل مع إبقاء فرق المبالغ')
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('checkbox').check()
  await expect(confirm).toBeEnabled()
  expect(writes).toHaveLength(0)
  await page.screenshot({ path: info.outputPath('historical-counterpart-links-and-confirm.png') })
  await confirm.click()
  await expect(dialog).toHaveCount(0)
  expect(writes).toHaveLength(1)
  expect(writes[0]!.path).toBe('/api/company/historical-restoration-settlements')
  expect(writes[0]!.body).toMatchObject({ branchId, evidenceHash: 'a'.repeat(64), expectedVersion: 0, reviewedLinks: true })
  expect((writes[0]!.body as Record<string, unknown>).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  expect(Object.keys(writes[0]!.body as Record<string, unknown>).sort()).toEqual(['branchId', 'evidenceHash', 'expectedVersion', 'idempotencyKey', 'reason', 'reviewedLinks'])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
})
test('uncertain counterpart correction retains reason and UUID across route changes despite a newer ineligible preview', async ({ page }, info) => {
  test.skip(info.project.name !== 'admin-desktop')
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const { writes, setMode } = await setup(page); setMode('unknown')
  let dialog = await openDialog(page)
  await dialog.getByLabel('السبب', { exact: true }).fill('اعتماد الربط دون تغيير نقد الفرع')
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'اعتماد تصحيح الحساب المقابل', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'إعادة نفس طلب تصحيح الحساب المقابل', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.goto(`${adminUrl}#companyFund?tab=reports`)
  dialog = await openDialog(page)
  await expect(dialog.getByLabel('السبب', { exact: true })).toHaveValue('اعتماد الربط دون تغيير نقد الفرع')
  await expect(dialog.getByLabel('السبب', { exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'إعادة نفس طلب تصحيح الحساب المقابل', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(writes).toHaveLength(2)
  expect(writes[1]!.body).toEqual(writes[0]!.body)
})
test('changed evidence preserves the typed reason but requires reviewing the refreshed links again', async ({ page }, info) => {
  test.skip(info.project.name !== 'admin-desktop')
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const { writes, setMode } = await setup(page); setMode('stale')
  const dialog = await openDialog(page)
  await dialog.getByLabel('السبب', { exact: true }).fill('سبب محفوظ خلال تحديث المعاينة')
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'اعتماد تصحيح الحساب المقابل', exact: true }).click()
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
  await expect(dialog.getByLabel('السبب', { exact: true })).toHaveValue('سبب محفوظ خلال تحديث المعاينة')
  await expect(dialog.getByRole('button', { name: 'اعتماد تصحيح الحساب المقابل', exact: true })).toBeDisabled()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'اعتماد تصحيح الحساب المقابل', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect((writes[1]!.body as Record<string, unknown>).evidenceHash).toBe('c'.repeat(64))
  expect((writes[1]!.body as Record<string, unknown>).idempotencyKey).not.toBe((writes[0]!.body as Record<string, unknown>).idempotencyKey)
})
test('an incomplete cash-neutrality proof blocks confirmation', async ({ page }, info) => {
  test.skip(info.project.name !== 'admin-desktop')
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  const { writes, setPreview } = await setup(page)
  const invalid = fixture(); delete (invalid.impacts.pnl as Partial<typeof zero>).USD; setPreview(invalid)
  const dialog = await openDialog(page)
  await expect(dialog.getByRole('checkbox')).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'اعتماد تصحيح الحساب المقابل', exact: true })).toBeDisabled()
  expect(writes).toHaveLength(0)
})
