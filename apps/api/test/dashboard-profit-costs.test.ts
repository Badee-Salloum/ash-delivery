import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {minor,parseMinor,weekStartFor,type Currency} from '@ash/domain'
import {BRANCH,OTHER_BRANCH,VEHICLE_ID,makeHarness,type Harness,NOW_MS} from './harness.ts'

let h:Harness,gm:string
beforeEach(async()=>{h=await makeHarness();gm=await h.loginAs('gm')})
afterEach(async()=>{await h.app.close()})
const get=(query='')=>h.app.inject({method:'GET',url:`/dashboard/profit-costs?branchId=${BRANCH}&from=2026-07-21&to=2026-07-21${query}`,headers:{cookie:h.cookie(gm)}})
function line(code:string,amount:bigint,side:'D'|'C'='D',branchId=BRANCH,currency:Currency='SYP_NEW'){
  h.deps.ledger.entries.push({id:20000+h.deps.ledger.entries.length,branchId,eventType:'manual',shiftId:null,
    occurrenceKey:crypto.randomUUID(),externalReference:null,businessDate:'2026-07-21',postingDate:'2026-07-21',
    weekStartDate:weekStartFor('2026-07-21'),fxDayId:1,sypMinorPerUsd:null,weekLockId:null,
    reason:'verified cost detail',createdBy:'u-gm',createdAtMs:NOW_MS,
    lines:[{fundCode:code,side,amount:minor(amount),currency},{fundCode:'office_cash',side:side==='D'?'C':'D',amount:minor(amount),currency}]})
}
describe('dashboard cost drill reconstructs its exact ledger net',()=>{
  it('includes credits/reversals and losses, excludes funding/other branches, and totals whole pages',async()=>{
    line(`cost_center:general:${BRANCH}`,9007199254740992n)
    line(`cost_center:branch:${BRANCH}`,200n,'C')
    line(`cost_center:${VEHICLE_ID}`,301n)
    line('cost_center:receivable_writeoff_loss',42n)
    line('cost_center:owner_funding',90000n)
    line(`cost_center:general:${OTHER_BRANCH}`,500n,'D',OTHER_BRANCH)
    const before=structuredClone(h.deps.ledger.entries)
    const page1=await get('&limit=2'),page2=await get('&limit=2&offset=2')
    expect(page1.statusCode,page1.body).toBe(200)
    expect(page1.json()).toMatchObject({count:4,total:'90071992547411.35',basis:'immutable_ledger_net',includesReversals:true,currency:'SYP_NEW'})
    const amount=[...page1.json().rows,...page2.json().rows].reduce((sum:bigint,row:{amount:string})=>sum+parseMinor(row.amount),0n)
    expect(amount).toBe(parseMinor(page1.json().total))
    const profit=await h.app.inject({method:'GET',url:`/dashboard/profit?branchId=${BRANCH}&from=2026-07-21&to=2026-07-21`,headers:{cookie:h.cookie(gm)}})
    expect(profit.json().expenseSyp).toBe(page1.json().total)
    expect((await get('&kind=operating_cost')).json().total).toBe(profit.json().operatingCostSyp)
    expect((await get('&kind=vehicle_cost')).json().total).toBe(profit.json().vehicleCostSyp)
    expect(h.deps.ledger.entries).toEqual(before)
  })
  it('scopes vehicle details and refuses unrelated vehicles, forbidden roles and invalid dates',async()=>{
    line(`cost_center:${VEHICLE_ID}`,1234n)
    expect((await get(`&vehicleId=${VEHICLE_ID}`)).json()).toMatchObject({count:1,total:'12.34'})
    expect((await get('&vehicleId=unknown')).statusCode).toBe(404)
    const manager=await h.loginAs('manager')
    expect((await h.app.inject({method:'GET',url:`/dashboard/profit-costs?branchId=${BRANCH}`,headers:{cookie:h.cookie(manager)}})).statusCode).toBe(403)
    expect((await h.app.inject({method:'GET',url:`/dashboard/profit-costs?branchId=${BRANCH}&from=2026-02-31`,headers:{cookie:h.cookie(gm)}})).statusCode).toBe(400)
  })
  it('never converts a failed currency-integrity check to an apparent zero cost',async()=>{
    line(`cost_center:general:${BRANCH}`,100n,'D',BRANCH,'USD')
    expect((await get()).statusCode).toBe(500)
  })
  it('disables new historical creation independently of old posting flags and keeps reads',async()=>{
    await h.app.close();h=await makeHarness({companyHistoricalCreationEnabled:false,companyHistoricalPostingEnabled:true});gm=await h.loginAs('gm')
    for(const url of ['/company/historical-movements','/company/historical-drafts']){
      const response=await h.app.inject({method:'POST',url,headers:{cookie:h.cookie(gm)},payload:{}})
      expect(response.statusCode,response.body).toBe(409)
      expect(response.json().error).toBe('historical_creation_retired')
    }
    expect((await h.app.inject({method:'GET',url:'/company/historical-imports',headers:{cookie:h.cookie(gm)}})).statusCode).toBe(200)
  })
})
