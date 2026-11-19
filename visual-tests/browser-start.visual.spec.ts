import {test,expect,type Page} from '@playwright/test'
import {preparePublicSurface} from './fixtures.ts'
import {ar} from '../packages/client/src/i18n/ar.ts'

const driverUrl=process.env.ASH_DRIVER_VISUAL_URL??'http://127.0.0.1:4174'

async function fixture(page:Page){
  const writes:Array<{path:string,body:Record<string,unknown>}>=[]
  let state='draft'
  const pkg={odometerKm:100,odometerKmOcr:100,batteryPercent:null,floatTotal:'0.00',topupTotal:'0.00',mediaSlots:['odometer'],batteries:[]}
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname
    const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
    if(path==='/api/me')return json({userId:'browser-fixture',roleKey:'driver',driverId:'driver',branchId:'branch',businessDate:'2026-11-04'})
    if(path==='/api/me/assignment')return json({driverId:'driver',branchId:'branch',assigned:true,liveShiftId:'browser-shift',liveShiftState:state,vehicles:[{id:'vehicle',code:'TEST',state:'active',busy:true,busyByMe:true,batteries:[],chargeReadingSource:'bms'}],spareBatteries:[]})
    if(path.endsWith('/state'))return json({id:'browser-shift',driverId:'driver',vehicleId:'vehicle',state,shiftNo:1,businessDate:'2026-11-04',startPackage:pkg,endPackage:{...pkg,mediaSlots:[]},orders:[],movements:[],cashDeductions:[],batterySwaps:[],lastDecision:null})
    if(path.endsWith('/gps/readiness')){
      writes.push({path,body:route.request().postDataJSON()})
      return json({ready:true,expiresAt:new Date(Date.now()+120_000).toISOString()},202)
    }
    if(path.endsWith('/start-package')){
      writes.push({path,body:route.request().postDataJSON()})
      state='awaiting_open_approval'
      return json({id:'browser-shift',state,businessDate:'2026-11-04',startPackage:pkg})
    }
    if(path.endsWith('/break'))return json({breaks:[],activeBreak:null,totalBreakMs:0,limitMinutes:60,overLimitMs:0,serverNowMs:Date.now()})
    return json({error:'local_fixture_only'},503)
  })
  await page.goto(driverUrl,{waitUntil:'domcontentloaded'})
  return writes
}

test('browser starts with denied location without a mandatory location check',async({page},info)=>{
  test.skip(!info.project.name.startsWith('driver'))
  await preparePublicSurface(page,{language:'ar',appearance:'light'})
  await page.addInitScript(()=>{
    Object.assign(globalThis,{browserLocationChecks:0})
    Object.defineProperty(navigator,'geolocation',{value:{
      getCurrentPosition:(_ok:PositionCallback,fail:PositionErrorCallback)=>{
        Object.assign(globalThis,{browserLocationChecks:1})
        fail({code:1} as GeolocationPositionError)
      },watchPosition:()=>1,clearWatch:()=>{},
    }})
  })
  const writes=await fixture(page)
  const confirm=page.getByRole('button',{name:ar.shift.confirmStart,exact:true})
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect.poll(()=>writes.length).toBe(1)
  expect(writes[0]?.path).toContain('/start-package')
  expect(writes[0]?.body.trackingClient).toBe('browser')
  expect(await page.evaluate(()=>(globalThis as {browserLocationChecks?:number}).browserLocationChecks)).toBe(0)
  await expect(page.getByText(`${ar.shift.states.awaiting_open_approval}…`,{exact:true})).toBeVisible()
  await page.screenshot({path:info.outputPath('browser-awaiting-approval.png'),fullPage:true})
})

test('browser starts when geolocation is unavailable',async({page},info)=>{
  test.skip(!info.project.name.startsWith('driver'))
  await preparePublicSurface(page,{language:'ar',appearance:'light'})
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'geolocation',{value:undefined})
  })
  const writes=await fixture(page)
  await page.getByRole('button',{name:ar.shift.confirmStart,exact:true}).click()
  await expect.poll(()=>writes.length).toBe(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('link',{name:ar.gpsTracking.downloadAndroidApp,exact:true})).toHaveCount(0)
  await expect(page.getByText(`${ar.shift.states.awaiting_open_approval}…`,{exact:true})).toBeVisible()
  await page.screenshot({path:info.outputPath('browser-without-location.png'),fullPage:true})
})

test('Android still checks its native permissions and starts its tracking service',async({page},info)=>{
  test.skip(!info.project.name.startsWith('driver'))
  await preparePublicSurface(page,{language:'ar',appearance:'light'})
  await page.addInitScript(()=>{
    let activeShiftId:string|null=null
    const flags={backgroundPermission:true,notificationPermission:true,batteryOptimizationExempt:true,autostartAcknowledged:true,autostartGuidanceRequired:false}
    Object.assign(globalThis,{Capacitor:{Plugins:{AshTracker:{
      preflight:async()=>({ready:true,nativeVersionCode:6,capturedAtMs:Date.now(),accuracyM:12,...flags}),
      setupReliability:async()=>({precisePermission:true,locationEnabled:true,...flags}),
      status:async()=>({available:true,permission:true,permissionState:'precise',locationEnabled:true,nativeVersionCode:6,queueAvailable:true,serviceRunning:activeShiftId!==null,activeShiftId,...flags}),
      start:async(input:{shiftId:string})=>{activeShiftId=input.shiftId;return{started:true}},
      stop:async()=>{activeShiftId=null},
    }}}})
  })
  const writes=await fixture(page)
  await page.getByRole('button',{name:ar.shift.confirmStart,exact:true}).click()
  await expect.poll(()=>writes.length).toBe(2)
  expect(writes[0]?.body).toMatchObject({appBuild:6,backgroundPermission:true,notificationPermission:true,batteryOptimizationExempt:true,queueAvailable:true})
  expect(writes[1]?.body.trackingClient).toBe('android')
  await expect(page.getByText(`${ar.shift.states.awaiting_open_approval}…`,{exact:true})).toBeVisible()
})
