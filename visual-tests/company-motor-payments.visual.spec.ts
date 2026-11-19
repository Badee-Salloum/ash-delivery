import {expect,test} from '@playwright/test'
import {mkdir} from 'node:fs/promises'
import {resolve} from 'node:path'
import {stubCompanyFund} from './dashboard-company-finance-fixtures.ts'
import {preparePublicSurface} from './fixtures.ts'
const assetId='95000000-0000-4000-8000-000000000001',sourceKey='command:96000000-0000-4000-8000-000000000001'
const base='http://127.0.0.1:4173',destination=resolve('outputs/finance-implementation-20261013/preview')
test('motor payments link, fresh expense and future installments refresh without real API writes',async({page},info)=>{
  test.skip(!info.project.name.startsWith('admin-'));test.setTimeout(60000)
  await mkdir(destination,{recursive:true})
  await preparePublicSurface(page,{language:'ar',appearance:'light'})
  await stubCompanyFund(page,{existingAsset:true})
  await page.route('**/api/company/existing-assets',route=>route.fulfill({json:{assets:[{id:assetId,vehicleId:'92000000-0000-4000-8000-000000000001',name:'موتور اختبار — 01',currency:'USD',price:'1200.00',purchasedOn:'2026-07-01',useStartedOn:'2026-07-01',fundingSource:'unknown',description:'بطاقة قديمة',status:'registered',accountingStatus:'pending_review',version:1,depreciation:null,recognition:null,sale:null,pendingEdit:null,bookValue:null}],legacyAssets:[]}}))
  await page.route('**/api/expense-categories*',route=>route.fulfill({json:{categories:[{id:'98000000-0000-4000-8000-000000000001',nameAr:'دفعات موتور',nameEn:'Motor payments',active:true}]}}))
  let version=1,paid=300,plan=false,planPaid=0
  const payments=[{id:'97000000-0000-4000-8000-000000000001',kind:'link',reason:'دفعة قديمة موثقة',needsReview:false,
    data:{amount:'300.00',currency:'USD',occurredOn:'2026-07-01',paidFrom:'owner_outside',description:'دفعة ثمن الموتور من جيب المالك',sourceKey:'historical:HQ-SRC-7',newExpense:false}}]
  const writes:Array<{path:string;body:Record<string,unknown>}>=[]
  const capture=async(name:string)=>{
    const original=page.viewportSize()!
    const height=await page.getByRole('dialog').evaluate(element=>element.scrollHeight)
    await page.setViewportSize({width:original.width,height:Math.max(original.height,height+90)})
    await page.screenshot({path:resolve(destination,`${name}-${info.project.name==='admin-mobile'?'mobile':'desktop'}.png`),fullPage:true})
    await page.setViewportSize(original)
  }
  const data=()=>({assetId,name:'1-1-1-1',currency:'USD',version,totalPaid:paid.toFixed(2),remaining:(1200-paid).toFixed(2),status:'documented',payments,
    history:payments.map(row=>({...row,createdAtMs:0})),plan:plan?{data:{supplier:'مورد الموتور'}}:null,
    installments:plan?['2026-10-15','2026-11-15','2026-12-15','2027-01-15','2027-02-15'].map((dueOn,index)=>{
      const amount=index===4?100:150,settled=Math.min(amount,Math.max(0,planPaid-index*150))
      return {dueOn,amount:amount.toFixed(2),paid:settled.toFixed(2),remaining:(amount-settled).toFixed(2),status:settled===amount?'paid':'scheduled',remind:false}
    }):[],
    sources:[{key:sourceKey,hash:'a'.repeat(64),available:'200.00',amount:'200.00',currency:'USD',occurredOn:'2026-09-18',description:'دفعة موجودة للبائع',paidFrom:'pocket'}]})
  await page.route('**/api/company/existing-assets/payment-summaries',route=>route.fulfill({json:{summaries:[data()],reminders:[]}}))
  await page.route(`**/api/company/existing-assets/${assetId}/payments`,route=>route.fulfill({json:data()}))
  await page.route(`**/api/company/existing-assets/${assetId}/payments/*`,route=>{
    const body=route.request().postDataJSON(),path=new URL(route.request().url()).pathname
    writes.push({path,body});expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    if(path.endsWith('/link')){
      expect(body).toMatchObject({sourceKey,sourceHash:'a'.repeat(64),amount:'200.00',expectedPaymentVersion:1})
      paid+=200;version++
      payments.push({...payments[0]!,id:String(body.idempotencyKey),reason:String(body.reason),data:{...payments[0]!.data,sourceKey,amount:'200.00',paidFrom:'pocket',description:'دفعة موجودة للبائع'}})
    }else if(path.endsWith('/schedule')){
      expect(body).toMatchObject({supplier:'مورد الموتور',installmentAmount:'150.00',firstDueOn:'2026-10-15',recurrence:'monthly',reminderDays:3})
      plan=true;version++
    }
    return route.fulfill({status:201,json:{replayed:false,cashEffect:'none',administrativeOnly:true}})
  })
  await page.route('**/api/company/expenses',route=>{
    const body=route.request().postDataJSON();writes.push({path:'/api/company/expenses',body})
    expect(body).toMatchObject({amount:'100.00',currency:'USD',paidFrom:'owner_custody',occurredOn:'2026-09-20',
      historicalRate:'13000.00',existingAssetPayment:{assetId,expectedVersion:1,expectedPaymentVersion:3,acknowledgedNewExpense:true}})
    paid+=100;planPaid+=100;version++
    payments.push({...payments[0]!,id:String(body.idempotencyKey),reason:'دفعة فعلية جديدة',data:{...payments[0]!.data,sourceKey:`command:${body.idempotencyKey}`,amount:'100.00',paidFrom:'owner_custody',description:'دفعة فعلية جديدة للبائع',newExpense:true}})
    return route.fulfill({status:201,json:{replayed:false}})
  })
  await page.goto(`${base}#companyFund?tab=assets`)
  await page.getByRole('button',{name:'الدفعات والمتبقي',exact:true}).click()
  let dialog=page.getByRole('dialog')
  await expect(dialog).toContainText('300.00');await expect(dialog).toContainText('900.00')
  await dialog.getByLabel('الدفعة المسجلة',{exact:true}).selectOption(sourceKey)
  await dialog.getByLabel('المبلغ المخصص لهذا الموتور',{exact:true}).fill('200.00')
  await dialog.getByLabel('السبب',{exact:true}).fill('ربط دفعة موجودة فقط')
  await dialog.getByRole('button',{name:'معاينة واعتماد',exact:true}).click()
  await capture('12-motor-payment-link')
  await dialog.getByRole('button',{name:'تأكيد الربط دون دفع جديد',exact:true}).click()
  await expect(page.getByRole('dialog')).toContainText('500.00');await expect(page.getByRole('dialog')).toContainText('700.00')
  dialog=page.getByRole('dialog')
  await dialog.getByRole('button',{name:'جدولة الدفعات',exact:true}).click()
  await expect(dialog.getByLabel('موعد أول دفعة',{exact:true})).not.toHaveAttribute('max')
  await dialog.getByLabel('البائع / الجهة المستحقة',{exact:true}).fill('مورد الموتور')
  await dialog.getByLabel('قيمة الدفعة',{exact:true}).fill('150.00')
  await dialog.getByLabel('موعد أول دفعة',{exact:true}).fill('2026-10-15')
  await dialog.getByLabel('السبب',{exact:true}).fill('جدول متفق عليه دون دفع')
  await dialog.getByRole('button',{name:'معاينة واعتماد',exact:true}).click()
  await capture('13-motor-payment-schedule')
  await dialog.getByRole('button',{name:'حفظ جدول الدفعات والتذكير',exact:true}).click()
  await expect(page.getByRole('dialog')).toContainText('2026-10-15')
  dialog=page.getByRole('dialog')
  await dialog.getByLabel('كيف تريد تسجيل الدفعة؟',{exact:true}).selectOption('new')
  await dialog.getByLabel('المبلغ',{exact:true}).fill('100.00')
  await dialog.getByLabel('مصدر التمويل',{exact:true}).selectOption('owner_custody')
  await dialog.getByLabel('الفئة',{exact:true}).selectOption('98000000-0000-4000-8000-000000000001')
  await dialog.getByLabel('سعر الصرف التاريخي',{exact:true}).fill('13000.00')
  await dialog.getByLabel('الوصف',{exact:true}).fill('دفعة فعلية جديدة للبائع')
  await dialog.getByRole('button',{name:'معاينة واعتماد',exact:true}).click()
  await expect(dialog).toContainText('هذا الخيار ينشئ صرفية فعلية')
  await capture('14-motor-payment-new')
  await dialog.getByRole('button',{name:'تأكيد الصرفية الجديدة وربطها',exact:true}).click()
  await expect(page.getByRole('dialog')).toContainText('600.00')
  expect(writes.map(row=>row.path)).toEqual([`/api/company/existing-assets/${assetId}/payments/link`,`/api/company/existing-assets/${assetId}/payments/schedule`,'/api/company/expenses'])
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
})
