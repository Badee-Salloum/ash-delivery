import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {makeHarness,type Harness} from './harness.ts'
let h:Harness,gm:string
beforeEach(async()=>{h=await makeHarness({companyRestorationReviewEnabled:true});gm=await h.loginAs('gm')})
afterEach(async()=>{await h.app.close()})
describe('company read snapshots never borrow a second pooled connection',()=>{
  for(const url of ['/company/overview','/company-fund','/company/movements','/company/historical-imports','/company/reports?all=true','/company/restoration-reviews','/company/existing-assets/payment-summaries','/company/owner-payments','/company/owner-withdrawals']){
    it(url,async()=>{
      let inside=0
      const originalRun=h.deps.financialUnitOfWork.run.bind(h.deps.financialUnitOfWork)
      h.deps.financialUnitOfWork.run=(input,work)=>{
        expect(input.mode).toBe('read_snapshot')
        return originalRun(input,async tx=>{inside++;try{return await work(tx)}finally{inside--}})
      }
      const escaped=<T extends object>(repo:T):T=>new Proxy(repo,{get(target,property,receiver){
        const value=Reflect.get(target,property,receiver)
        return typeof value==='function' ? (...args:unknown[])=>{if(inside)throw new Error(`Financial read escaped to global pool: ${String(property)}`);return value.apply(target,args)} : value
      }})
      h.deps.directory=escaped(h.deps.directory)
      h.deps.companyLedgerSource=escaped(h.deps.companyLedgerSource)
      h.deps.companyFinance=escaped(h.deps.companyFinance)
      const response=await h.app.inject({method:'GET',url,headers:{cookie:h.cookie(gm)}})
      expect(response.statusCode,response.body).toBe(200)
    })
  }
})
