import {test,expect} from '@playwright/test'
import {mkdir} from 'node:fs/promises'
import {resolve} from 'node:path'
import {stubCompanyFund} from './dashboard-company-finance-fixtures.ts'
import {preparePublicSurface} from './fixtures.ts'
import {ownerWithdrawalFixture} from './owner-withdrawal-fixtures.ts'
const base='http://127.0.0.1:4173',out=resolve('outputs/owner-withdrawals-20261017/preview')

test.beforeEach(async({page},info)=>{
  test.skip(!info.project.name.startsWith('admin-'))
  await preparePublicSurface(page,{language:'ar',appearance:'light'})
  await stubCompanyFund(page)
  await page.route('**/api/me',route=>route.fulfill({json:{userId:'preview',roleKey:'system_admin',branchId:null,driverId:null,businessDate:'2026-10-17'}}))
  await page.route('**/api/company/owner-withdrawals?**',route=>route.fulfill({json:ownerWithdrawalFixture()}))
})

test('full-history summary, detail filters, source references and read-only original dialog',async({page},info)=>{
  const writes:string[]=[];page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url())})
  await page.goto(`${base}#companyFund`)
  const panel=page.locator('[data-owner-withdrawals]'),summary=panel.locator('[data-owner-withdrawals-summary]'),filters=panel.locator('[data-owner-withdrawals-filters]')
  await expect(panel.getByRole('heading',{name:'مسحوبات المالك الشخصية',exact:true})).toBeVisible()
  await expect(summary).toContainText('70,000.00');await expect(summary).toContainText('960.00')
  await expect(panel.locator('[data-owner-withdrawal-row]')).toHaveCount(2)
  await expect(panel.locator('[data-owner-withdrawal-row]').first()).toContainText('2026-10-17')
  const order=await page.locator('[data-owner-summary], [data-owner-withdrawals]').evaluateAll(els=>els.map(el=>el.hasAttribute('data-owner-withdrawals')?'withdrawals':'payments'))
  expect(order).toEqual(['payments','withdrawals'])
  await panel.scrollIntoViewIfNeeded();await mkdir(out,{recursive:true})
  await panel.screenshot({path:resolve(out,`01-section-${info.project.name}.png`)})
  await filters.getByLabel('إلى تاريخ',{exact:true}).fill('2026-10-14')
  await expect(panel.getByText('لا توجد مسحوبات ضمن الفلاتر المختارة. المحصلة الكاملة ما زالت ظاهرة أعلاه.',{exact:true})).toBeVisible()
  await expect(summary).toContainText('960.00');await expect(summary).toContainText('70,000.00')
  await filters.getByRole('button',{name:'مسح الفلاتر',exact:true}).click()
  await filters.getByLabel('العملة',{exact:true}).selectOption('USD')
  await expect(panel.locator('[data-owner-withdrawal-row]')).toHaveCount(1)
  await expect(summary).toContainText('70,000.00')
  await panel.getByRole('button',{name:'عرض الحركة الأصلية',exact:true}).click()
  const dialog=page.getByRole('dialog')
  await expect(dialog).toContainText('PREVIEW-ONLY-51')
  await expect(dialog).toContainText('139.00')
  await expect(dialog.getByRole('button')).toHaveCount(1)
  await dialog.locator('summary').click()
  await expect(dialog.getByText('company_cash:USD',{exact:true})).toBeVisible()
  await dialog.screenshot({path:resolve(out,`02-original-${info.project.name}.png`)})
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0)
  await filters.getByRole('button',{name:'مسح الفلاتر',exact:true}).click()
  await filters.getByLabel('مصدر السحب',{exact:true}).selectOption('branch_cash:visual-branch-1')
  await expect(panel.locator('[data-owner-withdrawal-row]')).toHaveCount(1)
  await expect(panel.locator('[data-owner-withdrawal-row]')).toContainText('70,000.00')
  expect(writes).toEqual([])
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
})

test('load failure is not shown as zero; retry recovers; genuine empty state stays distinct',async({page})=>{
  let fail=true
  await page.route('**/api/company/owner-withdrawals?**',route=>route.fulfill({status:fail?503:200,json:fail?{error:'database_busy'}:ownerWithdrawalFixture()}))
  await page.goto(`${base}#companyFund`)
  const panel=page.locator('[data-owner-withdrawals]')
  await expect(panel.getByRole('button',{name:'إعادة المحاولة',exact:true})).toBeVisible()
  await expect(panel.locator('[data-owner-withdrawals-summary]')).toHaveCount(0)
  fail=false;await panel.getByRole('button',{name:'إعادة المحاولة',exact:true}).click()
  await expect(panel.locator('[data-owner-withdrawals-summary]')).toContainText('960.00')
  await page.route('**/api/company/owner-withdrawals?**',route=>route.fulfill({json:{...ownerWithdrawalFixture(),totals:{SYP_NEW:'0.00',USD:'0.00'},withdrawals:[]}}))
  await page.reload();await expect(panel.getByText('لا توجد مسحوبات شخصية مسجلة.',{exact:true})).toBeVisible()
})

test('English dark appearance uses the same section and currency-specific figures',async({page},info)=>{
  await preparePublicSurface(page,{language:'en',appearance:'dark'})
  await page.goto(`${base}#companyFund`)
  const panel=page.locator('[data-owner-withdrawals]')
  await expect(panel.getByRole('heading',{name:'Owner personal withdrawals',exact:true})).toBeVisible()
  await expect(panel.locator('[data-owner-withdrawals-summary]')).toContainText('960.00')
  await mkdir(out,{recursive:true});await panel.screenshot({path:resolve(out,`03-english-dark-${info.project.name}.png`)})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
})

test('company expenses show newest occurrence and recording first without mutation',async({page},info)=>{
  const writes:string[]=[];page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url())})
  const movement=(id:number,date:string,createdAtMs:number,description:string)=>({entry:{id,businessDate:date,createdAtMs,eventType:'company_expense',reason:description,sypMinorPerUsd:null,lines:[]},
    command:{id:`preview-expense-${id}`,kind:'expense',occurredOn:date,createdAtMs,currency:'SYP_NEW',amount:'10.00',description,paidFrom:'pocket',categoryId:'preview-category'},reversed:false})
  await page.route('**/api/company/movements?**',route=>route.fulfill({json:{movements:[movement(900,'2026-10-16',9000,'صرفية أقدم تاريخاً'),movement(99,'2026-10-17',1000,'صرفية سابقة في اليوم نفسه'),movement(1,'2026-10-17',5000,'أحدث صرفية مسجلة') ]}}))
  await page.goto(`${base}#companyFund?tab=movements`)
  const descriptions=page.locator('[data-company-movement] p.line-clamp-2')
  await expect(descriptions).toHaveCount(3)
  await expect(descriptions).toHaveText(['أحدث صرفية مسجلة','صرفية سابقة في اليوم نفسه','صرفية أقدم تاريخاً'])
  await mkdir(out,{recursive:true});await page.locator('[data-company-movement]').first().locator('..').screenshot({path:resolve(out,`04-expense-order-${info.project.name}.png`)})
  expect(writes).toEqual([])
})
