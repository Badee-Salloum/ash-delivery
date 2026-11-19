import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { copyFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
const variants = [
  { project: 'admin-desktop', language: 'en' as const, appearance: 'light' as const,
    labels: { entry: 'Add a movement', kind: 'Kind', transfer: 'Company and branch transfer',
      mode: 'From where to where?', branch: 'Branch', channel: 'Branch pocket', amount: 'Amount (SYP)',
      date: 'Occurred on', description: 'Description', preview: 'Review and confirm', submit: 'Record movement',
      uncertain: 'The previous attempt has an uncertain outcome. Retry the same request before changing it.',
      ownerEffect: 'Branch cash increases from owner funding. No company cash or expense effect; funding appears in the owner panel.',
      companyEffect: 'Company cash decreases and branch cash increases equally. Not an expense; restoration is never rerun.',
      branchEffect: 'Branch cash decreases and company cash increases equally. Not operating income; restoration is never rerun.',
      cutover: 'This branch has no reviewed cutover into HQ yet. Ask the system administrator to reconcile its actual company-box balance, verify the HQ opening balance, then explicitly confirm the cutover. This screen never creates an opening balance or cutover automatically; do not replace the transfer with an owner deposit.',
    } },
  { project: 'admin-mobile', language: 'ar' as const, appearance: 'dark' as const,
    labels: { entry: 'إضافة عملية', kind: 'النوع', transfer: 'تحويل بين الشركة والفرع',
      mode: 'من أين وإلى أين؟', branch: 'الفرع', channel: 'جيب الفرع', amount: 'المبلغ (ل.س)',
      date: 'تاريخ حدوث العملية', description: 'الوصف', preview: 'معاينة واعتماد', submit: 'تسجيل الحركة',
      uncertain: 'نتيجة المحاولة السابقة غير مؤكدة. أعد الطلب نفسه قبل تغيير بياناته.',
      ownerEffect: 'نقد الفرع يزيد من تمويل المالك. أثر نقد الشركة والمصروف صفر، ويظهر التمويل في قسم جيب المالك.',
      companyEffect: 'نقد الشركة ينقص ونقد الفرع يزيد بالقيمة نفسها. ليس صرفية، ولا يعاد تشغيل الترميم.',
      branchEffect: 'نقد الفرع ينقص ونقد الشركة يزيد بالقيمة نفسها. ليس دخلاً تشغيلياً، ولا يعاد تشغيل الترميم.',
      cutover: 'لم تعتمد مطابقة انتقال هذا الفرع إلى دفتر الشركة بعد. اطلب من مدير النظام مراجعة رصيد صندوق الشركة لدى الفرع، والتحقق من رصيد افتتاح الشركة، ثم اعتماد الانتقال صراحة. هذه الشاشة لا تنشئ رصيداً افتتاحياً أو انتقالاً تلقائياً؛ لا تستبدل التحويل بإيداع من المالك.',
    } },
]

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
  await info.attach(name, { path, contentType: 'image/png' })
  const permanent = resolve('outputs', 'finance-implementation-20261003', 'qa', info.project.name)
  await mkdir(permanent, { recursive: true })
  await copyFile(path, resolve(permanent, `${name}.png`))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
}

async function stubTransfers(page: Page): Promise<void> {
  await stubCompanyFund(page, { secondBranch: true })
  // Dedicated narrow fixture: the shared company-screen stub deliberately omits this dashboard
  // compatibility read, and must stay sealed rather than falling through to a live proxy.
  await page.route(/\/api\/company-fund(?:\?.*)?$/, route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ branches: [{ branchId: 'visual-branch-1', cutOver: true }, { branchId: 'visual-branch-2', cutOver: false }] }) }))
}

for (const variant of variants) {
  test(`ordinary transfer preview and durable exact-UUID retry — ${variant.project}`, async ({ page }, info) => {
    test.setTimeout(90_000)
    test.skip(info.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    await stubTransfers(page)
    let abort = true
    const posts: Array<Record<string, unknown>> = []
    await page.route('**/api/company/branch-transfers', async route => {
      expect(route.request().method()).toBe('POST')
      posts.push(route.request().postDataJSON() as Record<string, unknown>)
      if (abort) { abort = false; await route.abort('connectionreset'); return }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ replayed: true, transfer: {} }) })
    })
    await page.goto(`${adminUrl}#companyFund?tab=movements`, { waitUntil: 'commit' })
    await expect(page.getByRole('button', { name: variant.labels.entry, exact: true })).toBeVisible({ timeout: 45_000 })
    await page.getByRole('button', { name: variant.labels.entry, exact: true }).click()
    await page.getByLabel(variant.labels.kind, { exact: true }).selectOption('branch_transfer')
    const form = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.transfer, exact: true }) })
    await form.getByLabel(variant.labels.branch, { exact: true }).selectOption('visual-branch-1')
    await form.getByLabel(variant.labels.amount, { exact: true }).fill('1250.25')
    await form.getByLabel(variant.labels.description, { exact: true }).fill('Visual ordinary transfer')
    await form.getByRole('button', { name: variant.labels.preview, exact: true }).click()
    await expect(form.getByRole('status')).toContainText(variant.labels.companyEffect)
    await expect(form.getByRole('status')).toContainText('2026-09-20')
    expect(posts).toHaveLength(0)
    await form.getByLabel(variant.labels.mode, { exact: true }).selectOption('branch_to_company')
    await form.getByRole('button', { name: variant.labels.preview, exact: true }).click()
    await expect(form.getByRole('status')).toContainText(variant.labels.branchEffect)
    expect(posts).toHaveLength(0)
    await form.getByLabel(variant.labels.mode, { exact: true }).selectOption('owner_to_branch')
    await form.getByLabel(variant.labels.branch, { exact: true }).selectOption('visual-branch-2')
    await form.getByLabel(variant.labels.channel, { exact: true }).selectOption('wallet')
    await form.getByRole('button', { name: variant.labels.preview, exact: true }).click()
    await expect(form.getByRole('status')).toContainText(variant.labels.ownerEffect)
    await expect(form.getByRole('status')).toContainText('فرع الاختبار الثاني')
    expect(posts).toHaveLength(0)
    await capture(page, info, 'owner-branch-transfer-preview')
    await form.getByRole('button', { name: variant.labels.submit, exact: true }).click()
    await expect(form.getByText(variant.labels.uncertain, { exact: true })).toBeVisible()
    await expect(form.getByLabel(variant.labels.branch, { exact: true })).toBeDisabled()
    expect(posts).toHaveLength(1)
    const original = posts[0]!
    expect(original).toMatchObject({ branchId: 'visual-branch-2', direction: 'to_branch', source: 'owner_outside',
      channel: 'wallet', currency: 'SYP_NEW', amount: '1250.25', occurredOn: '2026-09-20', description: 'Visual ordinary transfer' })
    expect(original.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    await page.reload({ waitUntil: 'commit' })
    await expect(page.getByRole('button', { name: variant.labels.entry, exact: true })).toBeVisible({ timeout: 45_000 })
    await page.getByRole('button', { name: variant.labels.entry, exact: true }).click()
    await page.getByLabel(variant.labels.kind, { exact: true }).selectOption('branch_transfer')
    await expect(form.getByLabel(variant.labels.branch, { exact: true })).toHaveValue('visual-branch-2')
    await expect(form.getByLabel(variant.labels.branch, { exact: true })).toBeDisabled()
    await expect(form.getByLabel(variant.labels.mode, { exact: true })).toHaveValue('owner_to_branch')
    await expect(form.getByLabel(variant.labels.amount, { exact: true })).toHaveValue('1250.25')
    await form.getByRole('button', { name: variant.labels.preview, exact: true }).click()
    await expect(form.getByRole('status')).toContainText(variant.labels.ownerEffect)
    await capture(page, info, 'owner-branch-transfer-persisted-retry')
    await form.getByRole('button', { name: variant.labels.submit, exact: true }).click()
    await expect.poll(() => posts.length).toBe(2)
    expect(posts[1]).toEqual(original)
    await expect(form.getByLabel(variant.labels.branch, { exact: true })).toBeEnabled()
    expect(await page.evaluate(() => sessionStorage.getItem('ash.finance-draft:visual-system-admin:/company/branch-transfers::request'))).toBeNull()
  })

  test(`uncutover transfer explains the explicit reconciliation gate without posting — ${variant.project}`, async ({ page }, info) => {
    test.setTimeout(90_000)
    test.skip(info.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    await stubTransfers(page)
    const writes: string[] = []
    page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname) })
    await page.goto(`${adminUrl}#companyFund?tab=movements`, { waitUntil: 'commit' })
    await expect(page.getByRole('button', { name: variant.labels.entry, exact: true })).toBeVisible({ timeout: 45_000 })
    await page.getByRole('button', { name: variant.labels.entry, exact: true }).click()
    await page.getByLabel(variant.labels.kind, { exact: true }).selectOption('branch_transfer')
    const form = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.transfer, exact: true }) })
    await form.getByLabel(variant.labels.branch, { exact: true }).selectOption('visual-branch-2')
    await form.getByLabel(variant.labels.amount, { exact: true }).fill('100')
    await form.getByLabel(variant.labels.description, { exact: true }).fill('Visual unavailable cutover')
    await form.getByRole('button', { name: variant.labels.preview, exact: true }).click()
    await expect(form.getByText(variant.labels.cutover, { exact: true })).toBeVisible()
    expect(writes).toEqual([])
    await capture(page, info, 'company-branch-transfer-cutover-gate')
  })
}
