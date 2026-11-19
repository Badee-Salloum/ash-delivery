import {expect,test} from '@playwright/test'
import {preparePublicSurface} from './fixtures.ts'
import {stubCompanyFund} from './dashboard-company-finance-fixtures.ts'

const base='http://127.0.0.1:4173',assetId='95000000-0000-4000-8000-000000000001',vehicleId='92000000-0000-4000-8000-000000000001'
// Every API is intercepted locally. These exercise the real React refresh/confirmation workflow,
// not production accounts. Journal/accounting consequences are tested separately through the API and PG.
test.beforeEach(async({page},info)=>{
  test.skip(!info.project.name.startsWith('admin-'))
  await preparePublicSurface(page,{language:'ar',appearance:'light'})
  await stubCompanyFund(page,{existingAsset:true})
})
test('approved motor edit refreshes the card and removes its review form without hanging',async({page})=>{
  let card={id:assetId,vehicleId,name:'موتور الاختبار',currency:'USD',price:'1200.00',purchasedOn:'2026-07-10',useStartedOn:'2026-07-15',fundingSource:'unknown',description:'',status:'registered',accountingStatus:'pending_review',version:3,recognition:null,sale:null,bookValue:null,depreciation:{startsOn:'2026-08-15',usefulMonths:12,residualValue:'0.00'},calculatedSchedule:[],pendingEdit:{requestId:'96000000-0000-4000-8000-000000000001',price:'1400.00',currency:'USD',sourceVersion:2,reason:'تصحيح فاتورة'} as null|{requestId:string;price:string;currency:string;sourceVersion:number;reason:string}}
  const requests:Array<Record<string,unknown>>=[]
  await page.route('**/api/company/existing-assets',route=>route.fulfill({json:{assets:[card],legacyAssets:[]}}))
  await page.route(`**/api/company/existing-assets/${assetId}`,route=>route.fulfill({json:{asset:card,events:[],evidence:[]}}))
  await page.route(`**/api/company/existing-assets/${assetId}/edit-preview?**`,route=>route.fulfill({json:{requestId:card.pendingEdit?.requestId,version:3,afterPrice:'1400.00',frozenPeriods:2,remainingPeriods:10,futureMonthly:'120.00',requiresJournal:false}}))
  await page.route(`**/api/company/existing-assets/${assetId}/edit-confirm`,route=>{
    requests.push(route.request().postDataJSON() as Record<string,unknown>)
    card={...card,version:4,price:'1400.00',pendingEdit:null}
    return route.fulfill({status:201,json:{asset:card,replayed:false,cashEffect:'none'}})
  })
  await page.goto(`${base}#companyFund?tab=assets&vehicle=${vehicleId}`)
  const dialog=page.getByRole('dialog',{name:'موتور الاختبار',exact:true})
  await expect(dialog.getByText('راجع أثر التعديل قبل اعتماده',{exact:true})).toBeVisible()
  await dialog.locator('form').first().getByLabel('السبب',{exact:true}).fill('معاينة واعتماد التصحيح دون صرف جديد')
  await dialog.locator('form').first().getByRole('button',{name:'معاينة واعتماد',exact:true}).click()
  await dialog.getByRole('button',{name:'اعتماد تعديل البطاقة',exact:true}).click()
  await expect(dialog.getByText('راجع أثر التعديل قبل اعتماده',{exact:true})).toHaveCount(0)
  await expect(dialog.getByLabel('سعر الشراء',{exact:true})).toHaveValue('1400.00')
  expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({expectedVersion:3,effectiveOn:'2026-10-01',acknowledged:true,journalEntryId:null})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
})
test('linking an old receipt clears the list and never calls branch restoration or ordinary transfer',async({page})=>{
  let linked=false
  const writes:string[]=[]
  page.on('request',request=>{if(request.method()==='POST')writes.push(new URL(request.url()).pathname)})
  await page.route('**/api/company/branch-transfers/historical-sources?**',route=>route.fulfill({json:{sources:linked?[]:[{sourceEntryId:401,occurredOn:'2026-07-28',amount:'7080.00',direction:'to_company',description:'تحويل قديم'}],companyReceipts:[],links:[]}}))
  await page.route('**/api/company/branch-transfers/historical-link',route=>{
    expect(route.request().postDataJSON()).toMatchObject({sourceEntryId:401,companyEntryId:null,acknowledged:true})
    linked=true;return route.fulfill({status:201,json:{replayed:false,branchCashEffect:'0.00',companyCashEffect:'7080.00'}})
  })
  await page.goto(`${base}#companyFund?tab=movements`)
  await page.getByRole('button',{name:'إضافة عملية',exact:true}).click()
  await page.getByLabel('النوع',{exact:true}).selectOption('branch_transfer')
  await page.getByRole('button',{name:'ربط تحويل سابق',exact:true}).click()
  const region=page.getByRole('region',{name:'ربط تحويل سابق',exact:true})
  await region.getByLabel('الفرع',{exact:true}).selectOption('visual-branch-1')
  await region.getByLabel('التحويل الموجود في الفرع',{exact:true}).selectOption('401')
  await region.getByLabel('السبب',{exact:true}).fill('استكمال الطرف الناقص فقط')
  await region.getByRole('button',{name:'معاينة واعتماد',exact:true}).click()
  await region.getByRole('button',{name:'تسجيل الحركة',exact:true}).click()
  await expect(region.getByText('لا توجد تحويلات يدوية قديمة غير مربوطة مؤهلة في هذا الفرع.',{exact:false})).toBeVisible()
  expect(writes).toEqual(['/api/company/branch-transfers/historical-link'])
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
})
test('debt payment from custody closes the dialog after success and refreshes the outstanding balance',async({page})=>{
  let outstanding='420.00',count=0
  await page.route('**/api/company/debts',route=>route.fulfill({json:{debts:[{id:'visual-debt-1',direction:'payable',partyName:'مورد الاختبار',currency:'USD',principal:'420.00',outstanding,openedOn:'2026-09-01',dueOn:null}]}}))
  await page.route('**/api/company/debts/visual-debt-1/payments',route=>{
    expect(route.request().postDataJSON()).toMatchObject({source:'owner_custody',amount:'25.00',occurredOn:'2026-09-20'})
    outstanding='395.00';count++;return route.fulfill({status:201,json:{outstanding,replayed:false}})
  })
  await page.goto(`${base}#companyFund?tab=commitments`)
  await page.getByRole('button',{name:'دفع',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'مورد الاختبار',exact:true})
  await dialog.getByLabel('مصدر الدفع',{exact:true}).selectOption('owner_custody')
  await dialog.getByLabel('المبلغ',{exact:true}).fill('25.00')
  await dialog.getByLabel('السبب',{exact:true}).fill('دفع من العهدة')
  await dialog.getByRole('button',{name:'معاينة واعتماد',exact:true}).click()
  await dialog.getByRole('button',{name:'تسجيل الحركة',exact:true}).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('region',{name:'سجل الذمم',exact:true})).toContainText('395.00')
  expect(count).toBe(1)
})
