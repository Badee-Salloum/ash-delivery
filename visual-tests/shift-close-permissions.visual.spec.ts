import {expect, test, type Page} from '@playwright/test'
import {preparePublicSurface, stubAdminShell} from './fixtures.ts'
import {ar} from '../packages/client/src/i18n/ar.ts'

const shiftId = 'close-permission-fixture'
const adminUrl = process.env.ASH_ADMIN_VISUAL_URL ?? 'http://127.0.0.1:4173'
const driverUrl = process.env.ASH_DRIVER_VISUAL_URL ?? 'http://127.0.0.1:4174'
const incident = {id:'1',shiftId,permission:'background',openedAt:'2026-11-04T14:42:00Z',
  observedAt:'2026-11-04T14:41:58Z',recoveredAt:null,appBuild:6}
const fields = {grossTotal:'4650.00',blueTotal:'3720.00',trips:'13',distanceKm:'72',onlineMinutes:'490'}

async function adminFixture(page: Page) {
  await stubAdminShell(page)
  const charges: Record<string, unknown>[] = []
  let amount = '0.00'
  let bps: number | null = null
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({contentType:'application/json',body:JSON.stringify(body)})
    if (path.includes('/close-reference')) return json({summary:{date:'2026-11-04',mediaId:'image',read:{status:'complete',field:'daily_summary',fields}},permissionEvents:[incident]})
    if (path.endsWith('/review')) {
      const pkg = {odometerKm:1602,batteryPercent:80,batteries:[],mediaSlots:[],floatTotal:'2000.00',topupTotal:'0.00'}
      return json({id:shiftId,state:'pending_review',driverId:'fixture-driver',vehicleId:'fixture-vehicle',driverNameAr:'سائق اختبار',vehicleCode:'TEST',shiftNo:1,businessDate:'2026-11-04',
        windowOpensAt:'2026-11-04T08:00:00Z',openApprovedAt:'2026-11-04T08:00:00Z',submittedAt:'2026-11-04T17:00:00Z',shiftFunding:{cash:'0.00',wallet:'0.00'},startPackage:pkg,
        endPackage:{...pkg,odometerKm:1683,cashDeclared:'5000.00',walletDeclared:'1000.00',walletDeclaredOcr:'1000.00'},
        orders:[{providerOrderNo:'YAL-1',payMode:'cash',fee:'5000.00',source:'ocr',kind:'yallago',included:true,occurredDate:'2026-11-04',occurredMinute:'14:00',points:[]}],
        cashDeductions:[],movements:[],media:[],decisions:[],br1:{expectedCash:'5000.00',expectedWallet:'1000.00',difference:'0.00',cashDifference:'0.00',walletDifference:'0.00',balanced:true,splitBalanced:true,minWalletBalance:'0.00',causes:[],ordersHash:'orders'}})
    }
    if (path.endsWith('/settlement')) return json({policyCode:'fixed_40_cash_close_v2_receivable',driverRateBps:4000,deliveryFeeTotal:'5000.00',fixedDriverShare:'2000.00',manualDriverShare:'0.00',grossDriverShare:'2000.00',cashDeductionTotal:'0.00',baseDriverShare:'2000.00',managerCharge:amount,managerChargeBps:bps,
      expectedTotal:'6000.00',actualCash:'5000.00',actualWallet:'1000.00',actualTotal:'6000.00',variance:'0.00',varianceDirection:'balanced',finalEmployeeCash:String(2000-Number(amount)),cashClaimToOffice:String(3000+Number(amount)),walletClaimToOffice:'1000.00',cashReceivableDeferred:'0.00',walletReceivableDeferred:'0.00',maximumCashShortageReceivable:'0.00',cashShortageReceivable:'0.00',walletToOffice:'1000.00',cashToOffice:String(3000+Number(amount)),walletAction:'collect',walletAmount:'1000.00',cashAction:'collect',cashAmount:String(3000+Number(amount)),settlementHash:(amount==='0.00'?'a':'b').repeat(64)})
    if (path.endsWith('/manager-charge')) {
      const body=route.request().postDataJSON()
      charges.push(body)
      bps=body.percentBps ?? null
      amount=bps===null?body.amount:String(2000*bps/10000)
      return json({id:shiftId,managerCharge:amount,managerChargeReason:body.reason})
    }
    return route.fallback()
  })
  await page.goto(`${adminUrl}/#shift:${shiftId}`, { waitUntil: 'domcontentloaded' })
  return charges
}

test('manager sees the revoked permission and can apply a percentage charge', async ({page}, info) => {
  test.skip(!info.project.name.startsWith('admin'))
  await preparePublicSurface(page,{language:'ar',appearance:'light'})
  const charges=await adminFixture(page)
  await expect(page.getByText(ar.dailySummary.permissionOpen,{exact:false})).toBeVisible()
  await expect(page.getByText(ar.dailySummary.background,{exact:false})).toBeVisible()
  await expect(page.getByText(ar.settlement.receivableDeferralTitle,{exact:true})).toHaveCount(0)
  await expect(page.getByText(ar.settlement.shortageReceivableTitle,{exact:true})).toHaveCount(0)
  await page.getByRole('combobox',{name:ar.dailySummary.chargeMode,exact:true}).selectOption('percentage')
  await page.getByLabel(ar.dailySummary.rate,{exact:true}).fill('10')
  await page.getByLabel(ar.settlement.chargeReason,{exact:true}).fill('حسم تجريبي')
  await page.getByRole('button',{name:ar.settlement.chargeSave,exact:true}).click()
  await expect.poll(()=>charges.length).toBe(1)
  expect(charges[0]).toMatchObject({amount:'0.00',percentBps:1000,reason:'حسم تجريبي'})
  await expect(page.getByLabel(ar.settlement.cashConfirmed,{exact:true})).not.toBeChecked()
  await page.getByText(ar.dailySummary.permissionsTitle,{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('permission-revoked-admin.png'),fullPage:true})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
})

for (const summaryState of ['missing','failed','difference','running'] as const) test(`driver can submit close with revoked permission and optional summary ${summaryState}`, async ({page}, info) => {
  test.skip(!info.project.name.startsWith('driver'))
  await preparePublicSurface(page,{language:'ar',appearance:'light'})
  let submissions=0
  const pkg={odometerKm:1602,batteryPercent:80,floatTotal:'2000.00',topupTotal:'0.00',mediaSlots:[],batteries:[]}
  const attachment=(slot:string)=>({package:'end',slot,mediaId:`media-${slot}`,attachmentToken:`token-${slot}`,attachedAtMs:Date.now(),read:null})
  const draft={shiftId,revision:0,draftHash:'a'.repeat(64),updatedAt:'2026-11-04T17:00:00Z',submittedAt:null,restored:true,
    figures:{odometerKm:1683,odometerKmOcr:1683,odometerAnomalyConfirmed:false,batteryPercent:null,cashDeclared:'5000.00',walletDeclared:'1000.00',walletDeclaredOcr:'1000.00'},
    attachments:['dashboard','wallet','odometer'].map(attachment),operations:{orders:[{clientKey:'row',matchKey:'row',providerOrderNo:'YAL-1',payMode:'cash',fee:'5000.00',feeOcr:'5000.00',included:true,reviewRequired:false,reviewReasons:[],occurredDate:'2026-11-04',occurredMinute:'14:00',pointA:'A',pointB:'B',source:'cloud_ocr',sightings:[],windowBasis:'printed_time'}],cashDeductions:[],movements:[]}}
  if (summaryState !== 'missing') {
    draft.attachments.push({...attachment('daily_summary'),read:{readId:'home-read',field:'daily_summary',status:summaryState === 'difference' ? 'complete' : summaryState,failure:summaryState === 'failed' ? 'unavailable' : null,attempts:1,fields}} as unknown as typeof draft.attachments[number])
  }
  await page.route('**/api/**', async route=>{
    const path=new URL(route.request().url()).pathname
    const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
    if(path==='/api/me')return json({userId:'driver-user',roleKey:'driver',branchId:'branch',driverId:'driver',businessDate:'2026-11-04'})
    if(path==='/api/me/assignment')return json({driverId:'driver',branchId:'branch',assigned:true,liveShiftId:shiftId,liveShiftState:'open',vehicles:[{id:'vehicle',code:'TEST',state:'active',busy:true,busyByMe:true,batteries:[]}],spareBatteries:[]})
    if(path.endsWith('/state'))return json({id:shiftId,state:'open',driverId:'driver',vehicleId:'vehicle',shiftNo:1,businessDate:'2026-11-04',openApprovedAt:'2026-11-04T08:00:00Z',submittedAt:null,startPackage:pkg,endPackage:{...pkg,odometerKm:1683,cashDeclared:'5000.00',walletDeclared:'1000.00',mediaSlots:['dashboard','wallet','odometer']},orders:[],movements:[],cashDeductions:[],batterySwaps:[],lastDecision:null})
    if(path.endsWith('/break'))return json({breaks:[],activeBreak:null,totalBreakMs:0,limitMinutes:60,overLimitMs:0,serverNowMs:Date.now()})
    if(path.includes('/close-reference'))return json({summary:null,permissionEvents:[incident]})
    if(path.endsWith('/close-draft'))return json(draft)
    if(path.endsWith('/end-package')){submissions++;return json({id:shiftId,state:'pending_review'})}
    if(path.endsWith('/br1'))return json({balanced:true,difference:'0.00',ordersHash:'orders',causes:[]})
    if(path.endsWith('/gps/status'))return json({live:true,state:'open',health:{reportedAt:null,cause:'background_permission_missing'}})
    return json({error:'local_fixture_only'},503)
  })
  await page.goto(driverUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button',{name:ar.shift.finishShift,exact:true}).click()
  await expect(page.getByText(ar.dailySummary.permissionOpen,{exact:false})).toBeVisible()
  await expect(page.getByText(ar.dailySummary.optionalHint,{exact:true})).toBeVisible()
  const submit=page.getByRole('button',{name:ar.shift.submitEnd,exact:true})
  await expect(submit).toBeEnabled()
  await page.screenshot({path:info.outputPath('permission-revoked-driver.png'),fullPage:true})
  await submit.click()
  await expect.poll(()=>submissions).toBe(1)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
})
