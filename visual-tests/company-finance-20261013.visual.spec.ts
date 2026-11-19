import { expect, test } from '@playwright/test'
import { stubCompanyFund } from './dashboard-company-finance-fixtures.ts'
import { preparePublicSurface } from './fixtures.ts'
const url='http://127.0.0.1:4173'
test.beforeEach(async ({page},info)=>{
  test.skip(!info.project.name.startsWith('admin-'))
  await preparePublicSurface(page,{language:'ar',appearance:'light'})
  await stubCompanyFund(page,{ownerBranchFunding:true})
})
test('cash, owner custody and personal funding stay distinct; custody modal is accessible and closes without writing',async({page})=>{
  const writes:string[]=[]
  page.on('request',r=>{if(['POST','PATCH','DELETE'].includes(r.method()))writes.push(r.url())})
  await page.goto(`${url}#companyFund`)
  await expect(page.getByRole('heading',{name:'احتياطي الشركة بعهدة المالك',exact:true})).toBeVisible()
  await expect(page.getByText('رصيد يامن الفعلي',{exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'تسليم من صندوق الشركة إلى العهدة',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'تسليم من صندوق الشركة إلى العهدة',exact:true})
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('العملة',{exact:true}).selectOption('USD')
  await expect(dialog.getByLabel('سعر الصرف التاريخي',{exact:true})).toBeVisible()
  await expect(dialog.getByLabel('تاريخ حدوث العملية',{exact:true})).toHaveAttribute('min','2000-01-01')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(writes).toEqual([])
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
})
test('ordinary entry permits old dates and previews the actual financial date',async({page})=>{
  await page.goto(`${url}#companyFund?tab=movements`)
  await page.getByRole('button',{name:'إضافة عملية',exact:true}).click()
  await page.getByLabel('العملة',{exact:true}).selectOption('USD')
  await expect(page.getByLabel('سعر الصرف التاريخي',{exact:true})).toBeVisible()
  await page.getByLabel('تاريخ حدوث العملية',{exact:true}).fill('2025-06-01')
  await expect(page.getByLabel('تاريخ حدوث العملية',{exact:true})).toHaveValue('2025-06-01')
  await page.getByLabel('النوع',{exact:true}).selectOption('exchange')
  await expect(page.getByLabel('تاريخ حدوث العملية',{exact:true})).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
})
