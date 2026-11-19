import { copyFile, mkdir } from 'node:fs/promises'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { ar } from '../packages/client/src/i18n/ar.ts'
import { en } from '../packages/client/src/i18n/en.ts'
import type { CompanyHistoricalDraft, HistoricalDraftPayload } from '../apps/admin/src/company-historical-draft.ts'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'

const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
const storage = 'ash.historical-request:visual-system-admin:HQ:administrative'
const branchId = 'cc211111-1111-4111-8111-111111111111'
const variants = [
  { project: 'admin-desktop', language: 'en' as const, appearance: 'light' as const },
  { project: 'admin-mobile', language: 'ar' as const, appearance: 'dark' as const },
]

/** Narrow administrative-only fixture layered over the sealed general screen fixture. */
async function stubDrafts(page: Page, failure: 'abort' | 'unauthorized' | 'none', abortFirstPatch = false, initialDrafts: CompanyHistoricalDraft[] = []) {
  await stubCompanyFund(page)
  const drafts = structuredClone(initialDrafts), writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
  const financialWrites: string[] = [], receipts = new Map<string, { fingerprint: string; draft: CompanyHistoricalDraft }>()
  let failedPost = false, failedPatch = false
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method()
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/api/branches' && method === 'GET') return json({ branches: [{ id: branchId, code: 'VIS', nameAr: 'فرع الاختبار', nameEn: 'Visual branch' }] })
    if (path === '/api/company/historical-movements/preflight') return json({
      postingEnabled: false, canStart: false, pockets: { SYP_NEW: '650000.00', USD: '1500.00' },
    })
    if (path === '/api/company/historical-drafts' && method === 'GET') return json({ drafts })
    if (/^\/api\/company\/historical-drafts(?:\/[0-9a-f-]{36})?$/.test(path) && (method === 'POST' || method === 'PATCH')) {
      const body = request.postDataJSON() as Record<string, unknown>, key = String(body.idempotencyKey)
      writes.push({ path, method, body })
      const fingerprint = JSON.stringify({ method, path, body }), receipt = receipts.get(key)
      if (receipt) return receipt.fingerprint !== fingerprint ? json({ error: 'idempotency_key_conflict' }, 409) : json({ draft: receipt.draft, replayed: true })
      const draftId = method === 'POST' ? key : path.split('/').at(-1)!
      const previous = drafts.find(row => row.id === draftId), version = (previous?.version ?? 0) + 1
      if (method === 'PATCH' && (!previous || previous.version !== body.expectedVersion)) return json({ error: 'historical_draft_version_conflict' }, 409)
      const payload: HistoricalDraftPayload = {
        type: body.type as HistoricalDraftPayload['type'], occurredOn: String(body.occurredOn),
        occurredPrecision: body.occurredPrecision as 'day' | 'month', occurredMonth: body.occurredMonth == null ? null : String(body.occurredMonth),
        description: String(body.description), currency: body.currency as HistoricalDraftPayload['currency'], amount: String(body.amount),
        paidFrom: body.paidFrom == null ? 'pocket' : body.paidFrom as HistoricalDraftPayload['paidFrom'], categoryId: body.categoryId == null ? null : String(body.categoryId),
        account: body.account == null ? null : body.account as HistoricalDraftPayload['account'],
        historicalRate: body.historicalRate == null ? null : String(body.historicalRate),
        sypMinorPerUsd: body.historicalRate == null ? null : String(body.historicalRate).replace('.', ''),
        rateBasis: body.rateBasis as HistoricalDraftPayload['rateBasis'],
        fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null,
        sourceUnit: body.sourceUnit == null ? null : String(body.sourceUnit), receiptReference: body.receiptReference == null ? null : String(body.receiptReference),
        branchId: body.branchId == null ? null : String(body.branchId), assetId: body.assetId == null ? null : String(body.assetId),
      }
      const draft: CompanyHistoricalDraft = { id: draftId, companyBranchId: 'visual-company', status: 'draft', version, payload,
        revisions: [...previous?.revisions ?? [], { requestId: key, version, actorId: 'visual-system-admin', createdAtMs: 0, payload }] }
      if (previous) drafts.splice(drafts.indexOf(previous), 1, draft); else drafts.push(draft)
      receipts.set(key, { fingerprint, draft: structuredClone(draft) })
      // Commit source evidence first: even the worst-case lost/unauthorized response must retry
      // the same UUID rather than create a second administrative record.
      if (method === 'POST' && failure !== 'none' && !failedPost) {
        failedPost = true
        return failure === 'abort' ? route.abort('connectionreset') : json({ error: 'unauthorized' }, 401)
      }
      if (method === 'PATCH' && abortFirstPatch && !failedPatch) { failedPatch = true; return route.abort('connectionreset') }
      return json({ draft, replayed: false }, method === 'POST' ? 201 : 200)
    }
    if (method !== 'GET') {
      financialWrites.push(`${method} ${path}`)
      return json({ error: 'visual_financial_write_forbidden' }, 409)
    }
    return route.fallback()
  })
  return { drafts, writes, financialWrites }
}

async function capture(page: Page, info: TestInfo, name: string) {
  const screenshot = info.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' })
  await info.attach(name, { path: screenshot, contentType: 'image/png' })
  const permanent = 'outputs/historical-draft-qa-20261003'
  await mkdir(permanent, { recursive: true }); await copyFile(screenshot, `${permanent}/${name}-${info.project.name}.png`)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
}

for (const variant of variants) {
  const t = variant.language === 'ar' ? ar : en
  const entry = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: t.companyFinance.historicalEntry, exact: true }) })
  const retry = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: t.financeReview.retryDraft, exact: true }) })
  async function fill(page: Page, description: string) {
    const form = entry(page)
    await form.getByLabel(t.companyFinance.kind, { exact: true }).selectOption('expense')
    await form.getByLabel(t.financeReview.precision, { exact: true }).selectOption('month')
    await form.getByLabel(t.financeReview.occurredMonth, { exact: true }).fill('2025-06')
    await form.getByLabel(t.financeReview.source, { exact: true }).selectOption('owner_outside')
    await form.getByLabel(t.companyFinance.currency, { exact: true }).selectOption('USD')
    await form.getByLabel(t.companyFinance.amount, { exact: true }).fill('135')
    await form.getByLabel(t.companyFinance.historicalRate, { exact: true }).fill('165.25')
    await form.getByLabel(t.financeReview.rateBasis, { exact: true }).selectOption('estimated')
    await form.getByLabel(t.financeReview.sourceUnit, { exact: true }).fill('USD')
    await form.getByLabel(t.companyFinance.description, { exact: true }).fill(description)
    await expect(form.getByLabel(t.expenses.category, { exact: true })).toHaveValue('')
    expect(await form.getByLabel(t.expenses.category, { exact: true }).evaluate(element => (element as HTMLSelectElement).required)).toBe(false)
    await expect(form.getByLabel(t.companyFinance.auditReference, { exact: true })).toHaveCount(0)
    await expect(form.locator('input[name="idempotencyKey"], input[name="uuid"], input[name="operationNumber"]')).toHaveCount(0)
  }
  async function save(page: Page, frozenRate: string | null = '165.25') {
    await entry(page).getByRole('button', { name: t.financeReview.saveForReview, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: t.financeReview.saveForReview, exact: true })
    await expect(dialog).toContainText(t.financeReview.historicalDraftHint)
    if (frozenRate) await expect(dialog).toContainText(frozenRate)
    await dialog.getByRole('button', { name: t.financeReview.saveForReview, exact: true }).click()
  }

  test(`administrative history saves missing-category USD/month evidence and exact POST/PATCH retries — ${variant.project}`, async ({ page }, info) => {
    test.setTimeout(90_000); test.skip(info.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    const state = await stubDrafts(page, 'abort', true)
    await page.goto(`${adminUrl}#companyFund?tab=historical`)
    await expect(entry(page).getByText(t.financeReview.historicalPostingBlocked, { exact: true })).toBeVisible()
    await expect(page.locator('summary').filter({ hasText: t.financeReview.intake })).toHaveCount(0)
    await fill(page, 'Administrative source expense, classification not known')
    await save(page)
    await expect(retry(page)).toBeVisible(); await expect(entry(page).getByLabel(t.companyFinance.amount, { exact: true })).toBeDisabled()
    expect(state.writes).toHaveLength(1)
    const create = state.writes[0]!
    expect(create.body).toMatchObject({ type: 'expense', amount: '135.00', currency: 'USD', paidFrom: 'owner_outside', occurredPrecision: 'month', occurredMonth: '2025-06', occurredOn: '2025-06-01', historicalRate: '165.25', rateBasis: 'estimated', sourceUnit: 'USD' })
    expect(create.body.categoryId).toBeUndefined(); expect(create.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), storage))!)).toMatchObject({ path: '/company/historical-drafts', method: 'post', payload: create.body })
    await page.reload({ waitUntil: 'commit' })
    await expect(retry(page)).toBeVisible({ timeout: 45_000 }); await expect(entry(page).getByLabel(t.companyFinance.amount, { exact: true })).toBeDisabled()
    await capture(page, info, 'administrative-POST-preserved-after-reload')
    await retry(page).getByRole('button', { name: t.common.retry, exact: true }).click()
    await expect.poll(() => state.writes.length).toBe(2); expect(state.writes[1]).toEqual(create)
    await expect(retry(page)).toHaveCount(0); expect(state.drafts).toHaveLength(1)
    expect(state.drafts[0]!.payload).toMatchObject({ categoryId: null, sypMinorPerUsd: '16525', rateBasis: 'estimated' })
    await page.getByRole('button', { name: t.financeReview.editHistoricalDraft, exact: true }).click()
    await expect(entry(page).getByLabel(t.companyFinance.amount, { exact: true })).toHaveValue('135.00')
    await entry(page).getByLabel(t.companyFinance.amount, { exact: true }).fill('140.25')
    await entry(page).getByLabel(t.companyFinance.description, { exact: true }).fill('Revised administrative evidence')
    await save(page)
    await expect(retry(page)).toBeVisible()
    const patch = state.writes[2]!
    expect(patch).toMatchObject({ method: 'PATCH', path: `/api/company/historical-drafts/${create.body.idempotencyKey}`, body: { expectedVersion: 1, amount: '140.25', historicalRate: '165.25', occurredPrecision: 'month' } })
    expect(patch.body.idempotencyKey).not.toBe(create.body.idempotencyKey)
    await page.reload({ waitUntil: 'commit' })
    await expect(retry(page)).toBeVisible({ timeout: 45_000 }); await expect(entry(page).getByLabel(t.companyFinance.amount, { exact: true })).toBeDisabled()
    await capture(page, info, 'administrative-PATCH-preserved-after-reload')
    await retry(page).getByRole('button', { name: t.common.retry, exact: true }).click()
    await expect.poll(() => state.writes.length).toBe(4); expect(state.writes[3]).toEqual(patch)
    await expect(retry(page)).toHaveCount(0)
    expect(state.drafts).toHaveLength(1); expect(state.drafts[0]).toMatchObject({ version: 2, payload: { amount: '140.25', description: 'Revised administrative evidence' } })
    expect(state.drafts[0]!.revisions).toHaveLength(2)
    expect(await page.evaluate(key => sessionStorage.getItem(key), storage)).toBeNull()
    expect(state.financialWrites).toEqual([])
  })

  test(`administrative history retains the exact request after expired session and renewed-session reload — ${variant.project}`, async ({ page }, info) => {
    test.setTimeout(90_000); test.skip(info.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    const state = await stubDrafts(page, 'unauthorized')
    await page.goto(`${adminUrl}#companyFund?tab=historical`)
    await fill(page, 'Administrative source with expired response')
    await save(page)
    await expect.poll(() => state.writes.length).toBe(1)
    // A 401 correctly sends the app to sign-in; the record must survive that unmount.
    await expect(entry(page)).toHaveCount(0)
    const original = state.writes[0]!
    expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), storage))!).payload).toEqual(original.body)
    // /me models a renewed session for the same actor; no real login or credentials are used.
    await page.reload({ waitUntil: 'commit' })
    await expect(retry(page)).toBeVisible({ timeout: 45_000 })
    await capture(page, info, 'administrative-expired-session-exact-retry')
    await retry(page).getByRole('button', { name: t.common.retry, exact: true }).click()
    await expect.poll(() => state.writes.length).toBe(2); expect(state.writes[1]).toEqual(original)
    await expect(retry(page)).toHaveCount(0)
    expect(state.drafts).toHaveLength(1)
    expect(await page.evaluate(key => sessionStorage.getItem(key), storage)).toBeNull()
    expect(state.financialWrites).toEqual([])
  })

  test(`administrative branch directions require branch evidence without changing branch cash — ${variant.project}`, async ({ page }, info) => {
    test.setTimeout(90_000); test.skip(info.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    const state = await stubDrafts(page, 'none')
    await page.goto(`${adminUrl}#companyFund?tab=historical`)
    const form = entry(page), kind = form.getByLabel(t.companyFinance.kind, { exact: true })
    await expect(form.getByLabel(t.financeReview.draftDepositAccount, { exact: true })).toHaveValue('')
    expect(await form.getByLabel(t.financeReview.draftDepositAccount, { exact: true }).evaluate(element => (element as HTMLSelectElement).required)).toBe(false)
    expect(await kind.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual([
      'deposit', 'withdrawal', 'expense', 'income', 'exchange', 'branch_receipt', 'branch_payment', 'asset_payment', 'refund',
    ])
    await kind.selectOption('branch_receipt')
    await expect(form.getByLabel(t.accounts.branch, { exact: true })).toHaveValue('')
    expect(await form.getByLabel(t.accounts.branch, { exact: true }).evaluate(element => (element as HTMLSelectElement).required)).toBe(true)
    await expect(form.getByLabel(t.financeReview.source, { exact: true })).toHaveCount(0)
    await expect(form.getByLabel(t.expenses.category, { exact: true })).toHaveCount(0)
    await form.getByLabel(t.companyFinance.currency, { exact: true }).selectOption('SYP_NEW')
    await form.getByLabel(t.companyFinance.amount, { exact: true }).fill('25000.50')
    await form.getByLabel(t.companyFinance.description, { exact: true }).fill('Old return from branch to company')
    await form.getByRole('button', { name: t.financeReview.saveForReview, exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0); expect(state.writes).toHaveLength(0)
    await form.getByLabel(t.accounts.branch, { exact: true }).selectOption(branchId)
    await capture(page, info, 'administrative-branch-to-company-evidence')
    await save(page, null)
    await expect.poll(() => state.writes.length).toBe(1)
    expect(state.writes[0]!.body).toMatchObject({ type: 'branch_receipt', branchId, amount: '25000.50', currency: 'SYP_NEW' })
    expect(state.writes[0]!.body.paidFrom).toBeUndefined()
    await expect(form.getByLabel(t.companyFinance.amount, { exact: true })).toHaveValue('')
    await kind.selectOption('branch_payment')
    await expect(form.getByLabel(t.accounts.branch, { exact: true })).toHaveValue('')
    await form.getByLabel(t.accounts.branch, { exact: true }).selectOption(branchId)
    await form.getByLabel(t.financeReview.source, { exact: true }).selectOption('pocket')
    await form.getByLabel(t.companyFinance.amount, { exact: true }).fill('50000')
    await form.getByLabel(t.companyFinance.description, { exact: true }).fill('Old payment from company to branch')
    await capture(page, info, 'administrative-company-to-branch-evidence')
    await save(page, null)
    await expect.poll(() => state.writes.length).toBe(2)
    expect(state.writes[1]!.body).toMatchObject({ type: 'branch_payment', branchId, paidFrom: 'pocket', amount: '50000.00' })
    expect(state.drafts).toHaveLength(2)
    expect(state.drafts.every(draft => draft.status === 'draft' && draft.version === 1)).toBe(true)
    expect(state.financialWrites).toEqual([])
  })

  test(`administrative owner motorcycle payment keeps optional asset evidence on edit without recognizing or paying an asset — ${variant.project}`, async ({ page }, info) => {
    test.setTimeout(90_000); test.skip(info.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    const seedId = 'aa211111-1111-4111-8111-111111111111', assetId = 'bb211111-1111-4111-8111-111111111111'
    const payload: HistoricalDraftPayload = {
      type: 'asset_payment', occurredOn: '2025-08-01', occurredPrecision: 'month', occurredMonth: '2025-08',
      description: 'Previously linked owner motorcycle payment', currency: 'USD', amount: '875.00', paidFrom: 'owner_outside',
      categoryId: null, account: null, historicalRate: '165.25', sypMinorPerUsd: '16525', rateBasis: 'estimated',
      fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null, sourceUnit: 'USD', receiptReference: null,
      branchId: null, assetId,
    }
    const seed: CompanyHistoricalDraft = { id: seedId, companyBranchId: 'visual-company', status: 'draft', version: 1, payload,
      revisions: [{ requestId: seedId, version: 1, actorId: 'visual-system-admin', createdAtMs: 0, payload }] }
    const state = await stubDrafts(page, 'none', false, [seed])
    await page.goto(`${adminUrl}#companyFund?tab=historical`)
    const form = entry(page)
    await form.getByLabel(t.companyFinance.kind, { exact: true }).selectOption('asset_payment')
    await expect(form.getByLabel(t.accounts.branch, { exact: true })).toHaveCount(0)
    await expect(form.getByLabel(t.expenses.category, { exact: true })).toHaveCount(0)
    await form.getByLabel(t.financeReview.source, { exact: true }).selectOption('owner_outside')
    await form.getByLabel(t.companyFinance.currency, { exact: true }).selectOption('USD')
    await form.getByLabel(t.companyFinance.amount, { exact: true }).fill('1200')
    await form.getByLabel(t.companyFinance.historicalRate, { exact: true }).fill('165.25')
    await form.getByLabel(t.companyFinance.description, { exact: true }).fill('Owner motorcycle payment, asset link not supplied')
    await save(page)
    await expect.poll(() => state.writes.length).toBe(1)
    expect(state.writes[0]!.body).toMatchObject({ type: 'asset_payment', paidFrom: 'owner_outside', currency: 'USD', amount: '1200.00', historicalRate: '165.25' })
    expect(state.writes[0]!.body.assetId).toBeUndefined()
    const savedCard = page.locator('section').filter({ has: page.getByText(payload.description, { exact: true }) })
      .filter({ has: page.getByRole('button', { name: t.financeReview.editHistoricalDraft, exact: true }) }).last()
    await savedCard.getByRole('button', { name: t.financeReview.editHistoricalDraft, exact: true }).click()
    await expect(form.getByLabel(t.companyFinance.amount, { exact: true })).toHaveValue('875.00')
    await expect(form.getByLabel(t.financeReview.source, { exact: true })).toHaveValue('owner_outside')
    await form.getByLabel(t.companyFinance.amount, { exact: true }).fill('900')
    await capture(page, info, 'administrative-owner-asset-payment-edit')
    await save(page)
    await expect.poll(() => state.writes.length).toBe(2)
    expect(state.writes[1]).toMatchObject({ method: 'PATCH', path: `/api/company/historical-drafts/${seedId}`, body: { type: 'asset_payment', expectedVersion: 1, paidFrom: 'owner_outside', amount: '900.00', assetId, occurredPrecision: 'month', occurredMonth: '2025-08' } })
    expect(state.drafts.find(draft => draft.id === seedId)).toMatchObject({ version: 2, payload: { assetId, paidFrom: 'owner_outside', amount: '900.00' } })
    expect(state.financialWrites).toEqual([])
  })

  test(`administrative deposit keeps unknown source unknown and explicit opening source across edits — ${variant.project}`, async ({ page }, info) => {
    test.setTimeout(90_000); test.skip(info.project.name !== variant.project)
    await preparePublicSurface(page, variant)
    const state = await stubDrafts(page, 'none')
    await page.goto(`${adminUrl}#companyFund?tab=historical`)
    const form = entry(page), account = form.getByLabel(t.financeReview.draftDepositAccount, { exact: true })
    await expect(account).toHaveValue('')
    await form.getByLabel(t.companyFinance.amount, { exact: true }).fill('708000')
    await form.getByLabel(t.companyFinance.description, { exact: true }).fill('Unknown receipt source')
    await save(page, null)
    await expect.poll(() => state.writes.length).toBe(1)
    expect(state.writes[0]!.body.account).toBeUndefined()
    expect(state.drafts[0]!.payload.account).toBeNull()
    await expect(form.getByLabel(t.companyFinance.amount, { exact: true })).toHaveValue('')
    await account.selectOption('opening')
    await form.getByLabel(t.companyFinance.amount, { exact: true }).fill('708000')
    await form.getByLabel(t.companyFinance.description, { exact: true }).fill('Documented opening cash source')
    await save(page, null)
    await expect.poll(() => state.writes.length).toBe(2)
    const original = state.writes[1]!
    expect(original.body).toMatchObject({ account: 'opening', type: 'deposit' })
    const card = page.locator('section').filter({ has: page.getByText('Documented opening cash source', { exact: true }) })
      .filter({ has: page.getByRole('button', { name: t.financeReview.editHistoricalDraft, exact: true }) }).last()
    await card.getByRole('button', { name: t.financeReview.editHistoricalDraft, exact: true }).click()
    await expect(account).toHaveValue('opening')
    await form.getByLabel(t.companyFinance.amount, { exact: true }).fill('709000')
    await capture(page, info, 'administrative-opening-source-preserved')
    await save(page, null)
    await expect.poll(() => state.writes.length).toBe(3)
    expect(state.writes[2]).toMatchObject({ method: 'PATCH', path: `/api/company/historical-drafts/${original.body.idempotencyKey}`, body: { account: 'opening', amount: '709000.00', expectedVersion: 1 } })
    expect(state.drafts.find(draft => draft.id === original.body.idempotencyKey)).toMatchObject({ version: 2, payload: { account: 'opening', amount: '709000.00' } })
    expect(state.financialWrites).toEqual([])
  })
}
