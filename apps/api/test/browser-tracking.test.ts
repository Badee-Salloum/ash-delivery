import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {DRIVER_ID,VEHICLE_ID,makeHarness,type Harness} from './harness.ts'

let h:Harness
beforeEach(async()=>{h=await makeHarness({minDriverAndroidTrackerBuild:6})})
afterEach(async()=>{await h.app.close()})

async function draft(){
  const driver=await h.loginAs('driver1')
  const headers={cookie:h.cookie(driver)}
  const id=(await h.app.inject({method:'POST',url:'/shifts',headers,payload:{driverId:DRIVER_ID,vehicleId:VEHICLE_ID}})).json().id as string
  await h.uploadPhoto(driver,id,'start','odometer')
  const readiness={client:'browser',appBuild:0,capturedAtMs:h.deps.clock.nowMs(),accuracyM:12,precise:true,locationEnabled:true}
  const read=(payload=readiness)=>h.app.inject({method:'POST',url:`/shifts/${id}/gps/readiness`,headers,payload})
  const start=(trackingClient='browser')=>h.app.inject({method:'PUT',url:`/shifts/${id}/start-package`,headers,payload:{trackingClient,odometerKm:100,batteryPercent:95}})
  return {id,headers,readiness,read,start}
}

describe('browser and Android opening in parallel',()=>{
  it('submits and approves a browser opening without claiming a location check',async()=>{
    const x=await draft()
    const started=await x.start()
    expect(started.statusCode,started.body).toBe(200)
    expect(h.deps.gpsHealth.rows.get(x.id)).toMatchObject({readinessClient:'browser',appBuild:null,readinessAtMs:null,readinessPrecise:null,readinessBackgroundPermission:null})
    expect(started.json().state).toBe('awaiting_open_approval')
    const manager=await h.loginAs('manager')
    const approved=await h.app.inject({method:'POST',url:`/shifts/${x.id}/approve-open`,headers:{cookie:h.cookie(manager)},payload:{floatTranches:[],topupTranches:[]}})
    expect(approved.statusCode,approved.body).toBe(200)
    expect(approved.json().state).toBe('open')
  })
  it('cannot reuse a browser check as an Android check',async()=>{
    const x=await draft()
    await x.read()
    expect((await x.start('android')).json().error).toBe('gps_preflight_required')
    expect(h.deps.ledger.entries).toHaveLength(0)
  })
  it('keeps the Android build and full permission requirements',async()=>{
    const x=await draft()
    expect((await x.read({...x.readiness,client:'android',appBuild:5})).statusCode).toBe(426)
    expect((await x.read({...x.readiness,client:'android',appBuild:6})).json().error).toBe('gps_background_permission_required')
    expect((await x.start('android')).json().error).toBe('gps_preflight_required')
  })
  it('retains diagnostic refusals without blocking browser operations',async()=>{
    const x=await draft()
    expect((await x.read({...x.readiness,precise:false})).json().error).toBe('gps_precise_location_required')
    expect((await x.read({...x.readiness,capturedAtMs:h.deps.clock.nowMs()-30_001})).statusCode).toBe(422)
    expect((await x.read({...x.readiness,accuracyM:101})).statusCode).toBe(400)
    expect((await x.start()).statusCode).toBe(200)
  })
  it('records browser permission revocation without Android permission incidents',async()=>{
    const x=await draft()
    await x.read()
    await x.start()
    const result=await h.app.inject({method:'POST',url:`/shifts/${x.id}/gps/diagnostics`,headers:x.headers,payload:{appBuild:0,service:'stopped',permission:'denied',locationEnabled:null,network:'online',pendingCount:0}})
    expect(result.statusCode,result.body).toBe(202)
    expect(h.deps.gpsHealth.rows.get(x.id)?.readinessClient).toBe('browser')
    expect(await h.deps.gpsHealth.permissionEvents(x.id)).toMatchObject([{permission:'location',recoveredAt:null}])
    const manager=await h.loginAs('manager')
    const rejected=await h.app.inject({method:'POST',url:`/shifts/${x.id}/approve-open`,headers:{cookie:h.cookie(manager)},payload:{floatTranches:[],topupTranches:[]}})
    expect(rejected.statusCode,rejected.body).toBe(200)
    expect(h.deps.ledger.entries).toHaveLength(0)
    h.deps.clock.advance(180_000)
    await h.app.inject({method:'POST',url:`/shifts/${x.id}/gps/diagnostics`,headers:x.headers,payload:{appBuild:0,service:'running',permission:'precise',locationEnabled:true,network:'online',pendingCount:0}})
    expect((await h.deps.gpsHealth.permissionEvents(x.id))[0]?.recoveredAt).not.toBeNull()
    expect(h.deps.shifts.rows.get(x.id)?.state).toBe('open')
  })
})
