import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
const variants = [
  {
    project: 'admin-desktop', language: 'en' as const, appearance: 'light' as const,
    labels: { tabs: ['Overview', 'Operations', 'Assets', 'Commitments', 'Reports'],
      owner: 'Owner-funded expenses and payments', asset: 'Register an existing motorcycle',
      entry: 'Add a movement', ledger: 'Unified register', occurredOn: 'Occurred on', postedOn: 'Posted on',
      ownerDirect: 'Direct owner payments outside branch treasury',
      ownerFunding: 'Direct owner funding received by branches',
      ownerExpenses: 'Owner-funded expenses', ownerCapital: 'Owner-funded asset and payable payments',
      fundingHint: 'Verified branch cash or wallet deposits, net of linked reversals. They increase branch cash, never reduce HQ cash and are not expenses. Shown on the original deposit date without posting them again.',
      cashBox: 'Office cash box', wallet: 'Office wallet', sypPocket: 'SYP pocket', usdPocket: 'USD pocket',
      vehicle: 'Vehicle', price: 'Purchase price', paidNow: 'Paid now', source: 'Payment source',
      preview: 'Review and confirm', saveAsset: 'Save asset', draft: 'Draft',
      uncertain: 'The previous attempt has an uncertain outcome. Retry the same request before changing it.',
      neutral: 'Saving the card does not change company cash, branch cash or owner funding.',
      review: 'Awaiting review', reason: 'Reason', revise: 'Save proposed revision',
      confirmedAmount: 'HQ proposed/confirmed amount · Office cash box · Branch to company',
      executed: 'The branch has executed; HQ revision or confirmation does not change the branch again.',
      correction: 'Expense correction request', edit: 'Edit', after: 'Proposed value', saveDraft: 'Save draft',
      acknowledge: 'I reviewed the cash and funding-source effects', confirmCorrection: 'Confirm correction',
      hint: 'The request does not change money until confirmed. The branch is unchanged and previous versions are retained.',
    },
  },
  {
    project: 'admin-mobile', language: 'ar' as const, appearance: 'dark' as const,
    labels: { tabs: ['نظرة عامة', 'العمليات', 'الأصول', 'الالتزامات', 'التقارير'],
      owner: 'المصاريف والمدفوعات من جيب المالك', asset: 'إضافة موتور موجود',
      entry: 'إضافة عملية', ledger: 'السجل الموحد', occurredOn: 'تاريخ حدوث العملية', postedOn: 'تاريخ الترحيل',
      ownerDirect: 'مدفوعات المالك المباشرة خارج خزينة الفرع',
      ownerFunding: 'تمويل مباشر من المالك إلى الفرع',
      ownerExpenses: 'صرفيات مدفوعة من المالك', ownerCapital: 'دفعات أصول وتسديد ذمم من المالك',
      fundingHint: 'إيداعات مثبتة في صندوق الفرع أو محفظته، بعد العكس المرتبط. تزيد نقد الفرع ولا تخصم صندوق الشركة ولا تعد صرفية. تعرض بتاريخ الإيداع الأصلي دون إعادة إدخالها.',
      cashBox: 'صندوق النقد في المكتب', wallet: 'محفظة المكتب', sypPocket: 'جيب الليرة السورية', usdPocket: 'جيب الدولار',
      vehicle: 'آلية', price: 'سعر الشراء', paidNow: 'المدفوع الآن', source: 'مصدر الدفع',
      preview: 'معاينة واعتماد', saveAsset: 'حفظ الأصل', draft: 'مسودة',
      uncertain: 'نتيجة المحاولة السابقة غير مؤكدة. أعد الطلب نفسه قبل تغيير بياناته.',
      neutral: 'لا تغيير في نقد الشركة أو الفرع أو تمويل المالك عند حفظ البطاقة.',
      review: 'بانتظار المراجعة', reason: 'السبب', revise: 'حفظ التعديل المقترح',
      confirmedAmount: 'مبلغ الشركة المقترح/المؤكد · صندوق النقد في المكتب · من الفرع إلى الشركة',
      executed: 'الفرع نفذ فعلياً؛ تعديل أو اعتماد الشركة لا يغيّر الفرع مجدداً.',
      correction: 'طلب تصحيح صرفية', edit: 'تعديل', after: 'القيمة المقترحة', saveDraft: 'حفظ مسودة',
      acknowledge: 'راجعت أثر التصحيح على نقد الشركة ومصدر الدفع', confirmCorrection: 'اعتماد التصحيح',
      hint: 'طلب التصحيح لا يغيّر المال حتى اعتماده. الفرع لا يتغير، والنسخة السابقة محفوظة.',
    },
  },
]

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
}
function writes(page: Page): Array<{ path: string; payload: Record<string, unknown> }> {
  const calls: Array<{ path: string; payload: Record<string, unknown> }> = []
  page.on('request', request => {
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.startsWith('/api/')) return
    calls.push({ path: new URL(request.url()).pathname, payload: request.postDataJSON() as Record<string, unknown> })
  })
  return calls
}

for (const variant of variants) {
  test(`five finance sections and separate owner payments — ${variant.project}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page, { ownerBranchFunding: true })
    const calls = writes(page)
    await page.goto(`${adminUrl}#companyFund?tab=overview`)
    const tabs = page.getByRole('tablist').getByRole('tab')
    await expect(tabs).toHaveCount(5)
    await expect(page.locator('form')).toHaveCount(0)
    await expect(page.getByRole('button', { name: variant.labels.entry, exact: true })).toHaveCount(1)
    for (const label of variant.labels.tabs) await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible()
    const owner = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.owner, exact: true }) })
    await expect(owner).toBeVisible()
    await expect(owner.getByText(variant.labels.ownerDirect, { exact: true })).toBeVisible()
    await expect(owner.getByText(variant.labels.ownerExpenses, { exact: true })).toBeVisible()
    await expect(owner.getByText(variant.labels.ownerCapital, { exact: true })).toBeVisible()
    const directPayments = owner.locator('table').first()
    await expect(directPayments.locator('tbody tr')).toHaveCount(2)
    await expect(directPayments.getByText('Visual owner-funded motor', { exact: true })).toBeVisible()
    await expect(directPayments.getByText('Visual owner-funded direct expense', { exact: true })).toBeVisible()
    const funding = owner.getByText(variant.labels.ownerFunding, { exact: true }).locator('..')
    await expect(funding.getByText(variant.labels.fundingHint, { exact: true })).toBeVisible()
    await expect(funding).toContainText('200,000.00')
    expect(calls).toHaveLength(0)
    await funding.locator('summary').click()
    await expect(funding.locator('tbody tr')).toHaveCount(2)
    const cash = funding.locator('tbody tr').filter({ hasText: 'Visual owner cash funding' })
    const wallet = funding.locator('tbody tr').filter({ hasText: 'Visual owner wallet funding' })
    await expect(cash).toContainText(`فرع الاختبار · ${variant.labels.cashBox}`)
    await expect(cash).toContainText('150,000.00')
    await expect(cash).toContainText('2026-09-19')
    await expect(wallet).toContainText(`فرع الاختبار · ${variant.labels.wallet}`)
    await expect(wallet).toContainText('50,000.00')
    await expect(wallet).toContainText('2026-09-18')
    await expect(directPayments.getByText('Visual owner cash funding', { exact: true })).toHaveCount(0)
    await expect(directPayments.getByText('Visual owner wallet funding', { exact: true })).toHaveCount(0)
    await expect(page.getByText(variant.labels.sypPocket, { exact: true }).locator('..')).toContainText('650,000.00')
    await expect(page.getByText(variant.labels.usdPocket, { exact: true }).locator('..')).toContainText('1,500.00')
    expect(calls).toHaveLength(0)
    await capture(page, testInfo, 'finance-overview-owner-payments')
  })

  test(`current ledger uses one labelled mobile card or desktop row per movement — ${variant.project}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page, { expenseForCorrection: true, rawHeadquartersTransfers: true })
    const calls = writes(page)
    await page.goto(`${adminUrl}#companyFund?tab=movements`)
    const searchLabel = variant.language === 'ar' ? 'بحث في الوصف أو المرجع' : 'Search description or reference'
    const ledger = page.locator('section').filter({ has: page.getByRole('textbox', { name: searchLabel, exact: true }) })
    const rows = ledger.locator('tbody tr, article[data-company-movement]')
    await expect(rows).toHaveCount(4)
    if (variant.project === 'admin-mobile') {
      await expect(ledger.locator('table')).toHaveCount(0)
      await expect(ledger.locator('article[data-company-movement]')).toHaveCount(4)
      const movement = ledger.locator('article').filter({ hasText: 'Visual fixture exchange' })
      await expect(movement.getByText(variant.labels.occurredOn, { exact: true })).toBeVisible()
      await expect(movement.getByText(variant.labels.postedOn, { exact: true })).toBeVisible()
      await expect(movement.getByText(variant.language === 'ar' ? 'مصدر التمويل' : 'Funding source', { exact: true })).toBeVisible()
    } else {
      await expect(ledger.locator('article')).toHaveCount(0)
      await expect(ledger.locator('table')).toHaveCount(1)
      await expect(ledger.getByRole('columnheader')).toHaveCount(5)
    }
    await expect(ledger.locator('p.line-clamp-2').filter({ hasText: 'Visual fixture exchange' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Visual branch receipt' })).toContainText('8,420.00')
    await expect(rows.filter({ hasText: 'Visual outgoing branch transfer' })).toContainText('-2,750.50')
    await expect(ledger.getByRole('button', { name: variant.labels.edit, exact: true })).toHaveCount(1)
    expect(calls).toHaveLength(0)
    await capture(page, testInfo, 'finance-current-ledger-responsive')
    await ledger.getByRole('textbox', { name: searchLabel, exact: true }).fill('Visual outgoing branch transfer')
    await expect(rows).toHaveCount(1)
    await expect(ledger.getByRole('button', { name: variant.labels.edit, exact: true })).toHaveCount(0)
    expect(calls).toHaveLength(0)
  })

  for (const withPrice of [false, true]) {
    test(`neutral existing motorcycle ${withPrice ? 'individual price' : 'minimal draft'} — ${variant.project}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== variant.project)
      await preparePublicSurface(page, variant)
      await stubCompanyFund(page)
      const calls = writes(page)
      await page.goto(`${adminUrl}#companyFund?tab=assets`)
      const card = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.asset, exact: true }) })
      await expect(card).toBeVisible()
      await expect(card.getByText(variant.labels.neutral, { exact: true })).toBeVisible()
      await expect(card.getByLabel(variant.labels.price, { exact: true })).not.toHaveAttribute('required', '')
      await expect(card.getByLabel(variant.labels.paidNow, { exact: true })).toHaveCount(0)
      await card.getByLabel(variant.labels.vehicle, { exact: true }).selectOption('92000000-0000-4000-8000-000000000001')
      if (withPrice) await card.getByLabel(variant.labels.price, { exact: true }).fill('1375.50')
      await card.getByRole('button', { name: variant.labels.preview, exact: true }).click()
      await expect(card.getByRole('status')).toBeVisible()
      expect(calls).toHaveLength(0)
      await capture(page, testInfo, withPrice ? 'finance-existing-motor-individual-price' : 'finance-existing-motor-minimal-draft')
      await card.getByRole('button', { name: variant.labels.saveAsset, exact: true }).click()
      await expect.poll(() => calls.length).toBe(1)
      expect(calls[0]!.path).toBe('/api/company/existing-assets')
      expect(calls[0]!.payload).toMatchObject({
        vehicleId: '92000000-0000-4000-8000-000000000001',
        price: withPrice ? '1375.50' : null, currency: 'USD', fundingSource: 'unknown',
        purchasedOn: null, useStartedOn: null,
      })
      expect(calls[0]!.payload.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
      expect(calls.some(call => /expenses|deposits|debts|depreciation|\/treasury\//.test(call.path))).toBe(false)
      await expect(page.locator('tbody tr').filter({ hasText: '1-1-1-1' })).toBeVisible()
    })
  }

  test(`uncertain finance draft survives reload with the same request UUID — ${variant.project}`, async ({ page }) => {
    test.setTimeout(60_000)
    test.skip(test.info().project.name !== variant.project)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page, { secondBranch: true })
    let aborted = false
    await page.route('**/api/company/existing-assets', async route => {
      if (route.request().method() === 'POST' && !aborted) {
        aborted = true
        await route.abort('connectionreset')
        return
      }
      await route.fallback()
    })
    const calls = writes(page)
    await page.goto(`${adminUrl}#companyFund?tab=assets`)
    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.asset, exact: true }) })
    await card.getByLabel(variant.labels.vehicle, { exact: true }).selectOption('92000000-0000-4000-8000-000000000001')
    await card.getByLabel(variant.labels.price, { exact: true }).fill('1375.50')
    await card.getByRole('button', { name: variant.labels.preview, exact: true }).click()
    await card.getByRole('button', { name: variant.labels.saveAsset, exact: true }).click()
    await expect(card.getByText(variant.labels.uncertain, { exact: true })).toBeVisible()
    await expect(card.getByLabel(variant.labels.price, { exact: true })).toBeDisabled()
    expect(calls).toHaveLength(1)
    const first = calls[0]!.payload
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(card.getByText(variant.labels.uncertain, { exact: true })).toBeVisible()
    await expect(card.getByLabel(variant.labels.price, { exact: true })).toHaveValue('1375.50')
    await expect(card.getByLabel(variant.labels.price, { exact: true })).toBeDisabled()
    if (variant.project === 'admin-mobile') await page.getByRole('button', { name: 'القائمة', exact: true }).click()
    await page.getByRole('combobox', { name: variant.language === 'ar' ? 'الفرع' : 'Branch', exact: true }).selectOption('visual-branch-2')
    if (variant.project === 'admin-mobile') await page.getByRole('button', { name: 'إغلاق', exact: true }).click()
    await expect(card.getByLabel(variant.labels.price, { exact: true })).toHaveValue('1375.50')
    await card.getByRole('button', { name: variant.labels.preview, exact: true }).click()
    await card.getByRole('button', { name: variant.labels.saveAsset, exact: true }).click()
    await expect.poll(() => calls.length).toBe(2)
    expect(calls[1]!.payload).toEqual(first)
    await expect(page.locator('tbody tr').filter({ hasText: '1-1-1-1' })).toBeVisible()
    expect(calls.every(call => call.path === '/api/company/existing-assets')).toBe(true)
  })

  test(`HQ restoration review preview does not re-run branch — ${variant.project}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page)
    const calls = writes(page)
    await page.goto(`${adminUrl}#companyFund?tab=movements`)
    await page.getByRole('button', { name: variant.labels.review, exact: true }).click()
    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.review, exact: true }) })
    await card.getByRole('button', { name: variant.labels.review, exact: true }).click()
    const reviseForm = card.locator('form').filter({ has: page.getByLabel(variant.labels.confirmedAmount, { exact: true }) })
    await reviseForm.getByLabel(variant.labels.confirmedAmount, { exact: true }).fill('7900.00')
    await reviseForm.getByLabel(variant.labels.reason, { exact: true }).fill('Actual receipt requires review')
    await reviseForm.getByRole('button', { name: variant.labels.preview, exact: true }).click()
    await expect(reviseForm.getByRole('status')).toBeVisible()
    expect(calls).toHaveLength(0)
    await capture(page, testInfo, 'finance-HQ-restoration-proposal-preview')
    await reviseForm.getByRole('button', { name: variant.labels.revise, exact: true }).click()
    await expect.poll(() => calls.length).toBe(1)
    expect(calls[0]!.path).toMatch(/\/company\/restoration-reviews\/[^/]+\/revisions$/)
    expect(calls[0]!.payload).toMatchObject({ expectedVersion: 0,
      confirmedLegs: [{ sourceEntryId: 117, amount: '7900.00' }], reason: 'Actual receipt requires review' })
    expect(calls.some(call => call.path.includes('/treasury/'))).toBe(false)
    await expect(reviseForm.getByLabel(variant.labels.confirmedAmount, { exact: true })).toHaveValue('7900.00')
    const confirmForm = card.locator('form').filter({ hasNot: page.getByLabel(variant.labels.confirmedAmount, { exact: true }) }).first()
    await confirmForm.getByLabel(variant.labels.reason, { exact: true }).fill('Confirm actual HQ receipt')
    await confirmForm.getByRole('button', { name: variant.labels.preview, exact: true }).click()
    await expect(confirmForm.getByRole('status')).toContainText(variant.labels.executed)
    expect(calls).toHaveLength(1)
    await capture(page, testInfo, 'finance-HQ-only-confirmation-preview')
  })

  test(`expense correction remains proposed until cash-effect acknowledgement — ${variant.project}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    await stubCompanyFund(page, { expenseForCorrection: true })
    const calls = writes(page)
    await page.goto(`${adminUrl}#companyFund?tab=movements`)
    await page.getByRole('button', { name: variant.labels.edit, exact: true }).click()
    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: variant.labels.correction, exact: true }) })
    await card.getByLabel(variant.labels.after, { exact: true }).fill('26000.00')
    await card.getByLabel(variant.labels.reason, { exact: true }).fill('Recording correction with preserved history')
    await card.getByRole('button', { name: variant.labels.preview, exact: true }).click()
    expect(calls).toHaveLength(0)
    await card.getByRole('button', { name: variant.labels.saveDraft, exact: true }).click()
    await expect.poll(() => calls.length).toBe(1)
    expect(calls[0]!.path).toBe('/api/company/movement-corrections')
    await expect(card.getByRole('checkbox', { name: variant.labels.acknowledge, exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: variant.labels.confirmCorrection, exact: true })).toHaveCount(0)
    await capture(page, testInfo, 'finance-expense-correction-awaiting-acknowledgement')
    await card.getByRole('checkbox', { name: variant.labels.acknowledge, exact: true }).check()
    const confirmForm = card.locator('form').filter({ hasNot: page.getByLabel(variant.labels.after, { exact: true }) })
    await confirmForm.getByRole('button', { name: variant.labels.preview, exact: true }).click()
    await expect(confirmForm.getByRole('status')).toContainText(variant.labels.hint)
    expect(calls).toHaveLength(1)
  })
}
