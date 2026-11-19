import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'
import { companyReportTotals, type CompanyReportRow } from '../apps/admin/src/company-report.ts'

const destination = resolve('outputs/finance-implementation-20261013/preview')
const base = 'http://127.0.0.1:4173'
const motorId = '95000000-0000-4000-8000-000000000001', vehicleId = '92000000-0000-4000-8000-000000000001'
const row = (id: number, kind: string, amount: string, fund: string, side: 'D' | 'C', description: string): CompanyReportRow => ({
  id: `journal:${id}`, nature: 'business_event', kind, occurredOn: '2026-09-18', occurredPrecision: 'day', occurredMonth: null,
  occurrenceSource: 'recorded', postingDate: '2026-09-18', latestPostingDate: '2026-09-18', canonicalCommandId: null,
  activeCommandId: null, originalEntryId: id, activeEntryId: id, sourceEntryId: null, relatedEntryIds: [id], correctionIds: [],
  version: 1, reversed: false, currency: 'USD', grossAmount: amount, netAmount: amount,
  fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null, source: 'owner_custody', branchId: null,
  description, externalReference: null, receiptReference: null, sypMinorPerUsd: '13000', rateBasis: 'documented',
  lines: [{ fundCode: `company_custody:USD`, currency: 'USD', side, role: kind === 'expense' ? 'expense_paid' : 'custody_transfer', grossAmount: amount, netAmount: amount },
    { fundCode: `${fund}:USD${kind === 'expense' ? ':general' : ''}`, currency: 'USD', side: side === 'D' ? 'C' : 'D', role: kind === 'expense' ? 'expense_cost' : 'custody_transfer', grossAmount: amount, netAmount: amount }],
})

test('capture implemented finance pages without any real API or financial write', async ({ page }, info) => {
  test.skip(info.project.name !== 'admin-desktop')
  test.setTimeout(90000)
  await mkdir(destination, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await preparePublicSurface(page, { language: 'ar', appearance: 'light' })
  await stubCompanyFund(page, { ownerBranchFunding: true, expenseForCorrection: true, existingAsset: true })
  const writes: string[] = []
  page.on('request', request => { if (['POST', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()) })
  const custodyRows = [row(601, 'company_custody_transfer', '100.00', 'company_cash', 'D', 'تسليم مال الشركة إلى العهدة'),
    row(602, 'company_custody_transfer', '20.00', 'company_cash', 'C', 'إعادة جزء من العهدة إلى صندوق الشركة'),
    row(603, 'expense', '30.00', 'company_expense', 'C', 'صرف من مال الشركة الموجود في العهدة')]
  const confirmedId = '94000000-0000-4000-8000-000000000002'
  const transfer = { ...row(604, 'company_restoration_mirror', '3600.00', 'branch_clearing', 'D', 'ترميم جديد سجل الطرفين مباشرة'),
    canonicalCommandId: confirmedId, branchId: 'visual-branch-1', currency: 'SYP_NEW' as const, occurredOn: '2026-09-20',
    source: 'to_company', lines: [
      { fundCode: 'company_cash:SYP_NEW', currency: 'SYP_NEW' as const, side: 'D' as const, role: 'kaish_mirror', grossAmount: '3600.00', netAmount: '3600.00' },
      { fundCode: 'branch_clearing:visual-branch-1', currency: 'SYP_NEW' as const, side: 'C' as const, role: 'kaish_mirror', grossAmount: '3600.00', netAmount: '3600.00' },
    ] }
  await page.route('**/api/company/overview?**', route => route.fulfill({ json: {
    pockets: { SYP_NEW: '650000.00', USD: '920.00' }, reserves: { SYP_NEW: '0.00', USD: '0.00' },
    branches: [{ branchId: 'visual-branch-1', nameAr: 'فرع الاختبار', code: 'VIS', companyBox: '12020.00', clearing: '-3600.00', cutOver: true,
      balanced: false, pendingReviewCount: 1, unlinkedHistoricalCount: 0, confirmedVarianceCount: 0, totalDifference: '8420.00',
      pendingRestorationDifference: '8420.00', unexplainedDifference: '0.00', pendingToCompany: '8420.00', pendingFromCompany: '0.00', settlementStatus: 'waiting_review' }],
    period: { SYP_NEW: { income: '0.00', expense: '0.00', deposits: '0.00', withdrawals: '0.00', net: '0.00' },
      USD: { income: '0.00', expense: '30.00', deposits: '0.00', withdrawals: '0.00', net: '-30.00', companyFundedExpense: '30.00', ownerOutsideExpense: '0.00' } },
  } }))
  await page.route('**/api/company/restoration-reviews', route => route.fulfill({ json: { enabled: true, branches: [],
    proposals: [
      { id: '94000000-0000-4000-8000-000000000001', branchId: 'visual-branch-1', businessDate: '2026-09-19', status: 'pending_review', version: 0,
        legs: [{ sourceEntryId: 117, direction: 'to_company', amount: '8420.00' }], revisions: [] },
      { id: confirmedId, branchId: 'visual-branch-1', businessDate: '2026-09-20', status: 'confirmed', version: 1,
        legs: [{ sourceEntryId: 118, direction: 'to_company', amount: '3600.00' }], revisions: [{ kind: 'confirm' }] },
    ], linkedHistorical: [], historicalGroups: [], unlinkedHistorical: [], legacy: [],
  } }))
  await page.route('**/api/company/owner-payments?**', route => route.fulfill({ json: {
    from: '2026-09-01', to: '2026-09-20', totals: { SYP_NEW: '51000.00', USD: '1200.00' },
    expenseTotals: { SYP_NEW: '51000.00', USD: '0.00' }, capitalAndDebtTotals: { SYP_NEW: '0.00', USD: '1200.00' },
    branchFundingTotals: { SYP_NEW: '200000.00', USD: '0.00' },
    payments: [
      { id: 'outside-expense', kind: 'expense', currency: 'SYP_NEW', amount: '51000.00', description: 'صرفية مولت مباشرة من جيب المالك — مثال', occurredOn: '2026-09-18' },
      { id: 'outside-asset', kind: 'asset_payment', currency: 'USD', amount: '1200.00', description: 'دفعة موتور مولت من جيب المالك — مثال', occurredOn: '2026-09-10' },
    ], branchFundingPayments: [{ id: 'outside-branch', branchNameAr: 'فرع الاختبار', channel: 'cash', currency: 'SYP_NEW', amount: '200000.00',
      description: 'تمويل مباشر للفرع من جيب المالك — مثال', occurredOn: '2026-09-19' }],
  } }))
  await page.route('**/api/company/reports?**', route => {
    const q = new URL(route.request().url()).searchParams
    return route.fulfill({ json: { from: q.get('from') ?? '2026-09-01', to: q.get('to') ?? '2026-09-20',
      view: q.get('view'), dateBasis: q.get('dateBasis'), generatedAtMs: 1789905600000,
      periodSemantics: 'current_snapshot_original_posting_anchor', historicalBookCostPolicy: 'not_reclassified',
      rows: [...custodyRows, transfer], totals: companyReportTotals([...custodyRows, transfer]), occurrenceFallbackCount: 0, journalOnlyCount: 0, pendingRestorationCount: 1,
      cashBalances: { SYP_NEW: { opening: '646400.00', closing: '650000.00' }, USD: { opening: '1000.00', closing: '920.00' } },
      custodyBalances: { SYP_NEW: { opening: '0.00', closing: '0.00' }, USD: { opening: '0.00', closing: '50.00' } },
    } })
  })
  await page.route('**/api/company/custody', route => route.fulfill({ json: {
    balances: { SYP_NEW: '0.00', USD: '50.00' }, transfers: [
      { id: 'example-2', occurredOn: '2026-09-18', direction: 'to_company', currency: 'USD', amount: '20.00', reason: 'إعادة جزء من العهدة إلى صندوق الشركة' },
      { id: 'example-1', occurredOn: '2026-09-18', direction: 'to_custody', currency: 'USD', amount: '100.00', reason: 'تسليم مال الشركة إلى العهدة' },
    ],
  } }))
  await page.route('**/api/expense-categories**', route => route.fulfill({ json: { categories: [
    { id: '90000000-0000-4000-8000-000000000001', code: 'MAINTENANCE', nameAr: 'صيانة', active: true },
  ] } }))
  const card = { id: motorId, vehicleId, name: 'موتور D12 — مثال للمعاينة', currency: 'USD', price: '1200.00',
    purchasedOn: '2026-07-10', useStartedOn: '2026-07-15', fundingSource: 'owner_outside', description: 'بطاقة فقط، لا تسجل دفعاً جديداً',
    status: 'registered', accountingStatus: 'pending_review', version: 2, recognition: null, sale: null, pendingEdit: null, bookValue: null,
    depreciation: { startsOn: '2026-08-15', usefulMonths: 12, residualValue: '0.00' },
    calculatedSchedule: [
      { period: 1, startsOn: '2026-08-15', endsOn: '2026-08-31', amount: '100.00', status: 'calculated_not_posted' },
      { period: 2, startsOn: '2026-09-01', endsOn: '2026-09-30', amount: '100.00', status: 'scheduled' },
      { period: 3, startsOn: '2026-10-01', endsOn: '2026-10-31', amount: '100.00', status: 'scheduled' },
    ],
  }
  await page.route('**/api/company/existing-assets', route => route.fulfill({ json: { assets: [card], legacyAssets: [] } }))
  await page.route(`**/api/company/existing-assets/${motorId}`, route => route.fulfill({ json: { asset: card, evidence: [], events: [
    { id: 'event-1', version: 1, reason: 'تسجيل بطاقة موتور موجود دون إنشاء صرفية شراء', createdBy: 'example-user' },
    { id: 'event-2', version: 2, reason: 'تفعيل الحساب التقديري من 15 آب فقط، دون احتساب اهتلاك سابق', createdBy: 'example-user' },
  ] } }))
  const capture = async (name: string) => {
    await expect(page.locator('body')).not.toContainText('visual_fixture_unavailable')
    await page.screenshot({ path: resolve(destination, `${name}.png`), fullPage: true, animations: 'disabled' })
  }
  await page.goto(`${base}#companyFund`)
  await expect(page.getByRole('heading', { name: 'احتياطي الشركة بعهدة المالك', exact: true })).toBeVisible()
  await expect(page.locator('[data-company-workspace]')).toContainText('50.00')
  await capture('01-overview-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await capture('02-overview-mobile')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'تسليم من صندوق الشركة إلى العهدة', exact: true }).click()
  const custody = page.getByRole('dialog')
  await custody.getByLabel('العملة', { exact: true }).selectOption('USD')
  await custody.getByLabel('المبلغ', { exact: true }).fill('200.00')
  await custody.getByLabel('سعر الصرف التاريخي', { exact: true }).fill('130.00')
  await custody.getByLabel('السبب', { exact: true }).fill('تسليم احتياطي الشركة للتجديد — مثال')
  await capture('03-custody-handover')
  await page.keyboard.press('Escape')
  await page.goto(`${base}#companyFund?tab=movements`)
  await page.getByRole('button', { name: 'إضافة عملية', exact: true }).click()
  await page.getByLabel('العملة', { exact: true }).selectOption('USD')
  await page.getByLabel('المبلغ', { exact: true }).fill('125.00')
  await page.getByLabel('تاريخ حدوث العملية', { exact: true }).fill('2026-07-10')
  await page.getByLabel('سعر الصرف التاريخي', { exact: true }).fill('130.00')
  await page.getByLabel('الوصف', { exact: true }).fill('صرفية قديمة من صندوق الشركة — مثال')
  await page.getByLabel('الفئة', { exact: true }).selectOption('90000000-0000-4000-8000-000000000001')
  await page.getByRole('button', { name: 'معاينة واعتماد', exact: true }).click()
  await expect(page.getByText('تُسجّل في يومها المالي وتؤثر على تقاريره.', { exact: false })).toBeVisible()
  await capture('04-prior-expense')
  await page.goto(`${base}#companyFund?tab=reports`)
  await page.reload()
  await page.getByLabel('ماذا تريد أن تعرف؟', { exact: true }).selectOption('custody')
  await expect(page.locator('[data-report-summary="USD"]')).toContainText('50.00')
  await capture('05-custody-report')
  await page.goto(`${base}#companyFund?tab=assets&vehicle=${vehicleId}`)
  await page.reload()
  const assetDialog = page.getByRole('dialog', { name: card.name, exact: true })
  await expect(assetDialog).toBeVisible()
  await assetDialog.getByText('بطاقة الموتور وجدول الاهتلاك وسجله', { exact: true }).click()
  await expect(assetDialog.getByText('2026-08-15', { exact: true })).toBeVisible()
  await capture('06-motor-depreciation')
  await page.keyboard.press('Escape')
  const proposedCard = {...card,version:3,pendingEdit:{requestId:'96000000-0000-4000-8000-000000000002',price:'1400.00',currency:'USD',sourceVersion:2,reason:'تصحيح سعر الموتور بعد مراجعة فاتورته — مثال'}}
  await page.route('**/api/company/existing-assets',route=>route.fulfill({json:{assets:[proposedCard],legacyAssets:[]}}))
  await page.route(`**/api/company/existing-assets/${motorId}/edit-preview?**`,route=>route.fulfill({json:{requestId:proposedCard.pendingEdit.requestId,version:3,effectiveOn:'2026-10-01',afterPrice:'1400.00',frozenPeriods:2,remainingPeriods:10,futureMonthly:'120.00',requiresJournal:false,cashEffect:'none'}}))
  await page.reload()
  const review=page.getByRole('dialog',{name:card.name,exact:true})
  await expect(review.getByText('الفترات المحفوظة: 2',{exact:false})).toBeVisible()
  await capture('07-motor-edit-review')
  await page.setViewportSize({width:390,height:844})
  await capture('08-motor-edit-mobile')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  await page.setViewportSize({width:1440,height:1000})
  await page.keyboard.press('Escape')
  await page.route('**/api/company/branch-transfers/historical-sources?**',route=>route.fulfill({json:{sources:[{sourceEntryId:401,occurredOn:'2026-07-28',amount:'7080.00',direction:'to_company',description:'تحويل قديم موجود في دفتر الفرع — مثال'}],companyReceipts:[],links:[]}}))
  await page.goto(`${base}#companyFund?tab=movements`)
  await page.reload()
  await page.getByRole('button',{name:'إضافة عملية',exact:true}).click()
  await page.getByLabel('النوع',{exact:true}).selectOption('branch_transfer')
  await page.getByRole('button',{name:'ربط تحويل سابق',exact:true}).click()
  await page.getByRole('region',{name:'ربط تحويل سابق',exact:true}).getByLabel('الفرع',{exact:true}).selectOption('visual-branch-1')
  await page.getByLabel('التحويل الموجود في الفرع',{exact:true}).selectOption('401')
  await page.getByLabel('السبب',{exact:true}).fill('استكمال طرف الشركة الناقص دون إعادة قبض الفرع — مثال')
  await page.getByRole('button',{name:'معاينة واعتماد',exact:true}).click()
  await expect(page.getByText('إضافة طرف الشركة في تاريخ التحويل فقط؛ أثر صندوق الفرع صفر.',{exact:true})).toBeVisible()
  await capture('09-historical-transfer-link')
  await page.setViewportSize({width:390,height:844})
  await capture('10-historical-transfer-mobile')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  await page.setViewportSize({width:1440,height:1000})
  await page.goto(`${base}#companyFund?tab=commitments`)
  await page.reload()
  await page.getByRole('button',{name:'دفع',exact:true}).click()
  const payment=page.getByRole('dialog',{name:'Visual supplier',exact:true})
  await payment.getByLabel('مصدر الدفع',{exact:true}).selectOption('owner_custody')
  await payment.getByLabel('المبلغ',{exact:true}).fill('25.00')
  await payment.getByLabel('السبب',{exact:true}).fill('تسديد جزء من ذمة المورد من مال الشركة بعهدة المالك — مثال')
  await payment.getByRole('button',{name:'معاينة واعتماد',exact:true}).click()
  await capture('11-custody-debt-payment')
  expect(writes).toEqual([])
})
