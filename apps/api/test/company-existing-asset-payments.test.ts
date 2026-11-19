import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeHarness, COMPANY_BRANCH, VEHICLE_ID, BRANCH, type Harness } from './harness.ts'
import { minor } from '@ash/domain'
import { buildAssetInstallments, paymentSummary, type AssetPaymentSource } from '../src/company-existing-asset-payments.service.ts'
let h: Harness, gm: string, categoryId: string, assetId: string, motorVehicleId: string
const id=()=>crypto.randomUUID()
const post=(url:string,payload:Record<string,unknown>,token=gm)=>h.app.inject({method:'POST',url,headers:{cookie:h.cookie(token)},payload})
const get=(url:string)=>h.app.inject({method:'GET',url,headers:{cookie:h.cookie(gm)}})
const root=()=>`/company/existing-assets/${assetId}/payments`
const expense=(amount='300.00',extra:Record<string,unknown>={}):Record<string,unknown>=>({idempotencyKey:id(),currency:'USD',amount,categoryId,paidFrom:'owner_outside',occurredOn:'2026-07-21',description:'motor supplier payment',...extra})
async function detail(){const result=await get(root());expect(result.statusCode,result.body).toBe(200);return result.json()}
async function link(amount='300.00',sourceKey?:string){const feed=await detail(),source=feed.sources.find((row:{key:string})=>!sourceKey||row.key===sourceKey);return {idempotencyKey:id(),expectedVersion:1,expectedPaymentVersion:feed.version,reason:'Verified individual motor payment',sourceKey:source.key,sourceHash:source.hash,amount}}
const schedule=(version=1,extra:Record<string,unknown>={})=>({idempotencyKey:id(),expectedVersion:1,expectedPaymentVersion:version,reason:'Agreed supplier installments',supplier:'Motor supplier',installmentAmount:'150.00',firstDueOn:'2026-07-21',recurrence:'monthly',reminderDays:3,...extra})
beforeEach(async()=>{
  h=await makeHarness();gm=await h.loginAs('gm');categoryId=id();assetId=id()
  motorVehicleId=id();h.deps.directory.vehicles.set(motorVehicleId,{...(await h.deps.directory.vehicle(VEHICLE_ID))!,id:motorVehicleId,code:'test-motor'})
  await h.deps.expenses.createCategory({id:categoryId,code:categoryId,nameAr:'Motor payment',active:true})
  const result=await post('/company/existing-assets',{idempotencyKey:assetId,vehicleId:motorVehicleId,name:'Existing motor',currency:'USD',price:'1200.00',useStartedOn:'2026-07-01'})
  expect(result.statusCode,result.body).toBe(201)
})
afterEach(async()=>{vi.restoreAllMocks();await h.app.close()})
describe('existing motor payment tracking without double cash',()=>{
  it('links an existing expense with exact retry and reports paid/remaining without cash, debt or recognition',async()=>{
    await post('/company/expenses',expense());const before=structuredClone(h.deps.ledger.entries),body=await link()
    const result=await post(`${root()}/link`,body);expect(result.statusCode,result.body).toBe(201)
    expect(result.json()).toMatchObject({cashEffect:'none',administrativeOnly:true})
    expect((await post(`${root()}/link`,body)).statusCode).toBe(200)
    expect((await post(`${root()}/link`,{...body,amount:'301.00'})).statusCode).toBe(409)
    expect(await detail()).toMatchObject({totalPaid:'300.00',remaining:'900.00',createsDebt:false,status:'documented'})
    expect(h.deps.ledger.entries).toEqual(before)
    expect(await h.deps.companyFinance.listDebts(COMPANY_BRANCH)).toEqual([])
    expect((await h.deps.existingAssets.get(assetId))?.recognition).toBeNull()
  })
  it('creates and links a new expense atomically once and rejects a retry dropping or changing the card linkage',async()=>{
    const payload=expense('150.00',{existingAssetPayment:{assetId,expectedVersion:1,expectedPaymentVersion:0,acknowledgedNewExpense:true}})
    const result=await post('/company/expenses',payload);expect(result.statusCode,result.body).toBe(201)
    expect((await post('/company/expenses',payload)).statusCode).toBe(200)
    const {existingAssetPayment,...withoutLink}=payload
    expect((await post('/company/expenses',withoutLink)).statusCode).toBe(409)
    expect((await post('/company/expenses',{...payload,existingAssetPayment:{...existingAssetPayment as object,assetId:id()}})).statusCode).toBe(409)
    expect(h.deps.ledger.entries).toHaveLength(1)
    expect(await detail()).toMatchObject({totalPaid:'150.00',remaining:'1050.00',version:1})
  })
  it('rolls back the new expense when allocation validation fails or persistence fails',async()=>{
    const payload=expense('1300.00',{existingAssetPayment:{assetId,expectedVersion:1,expectedPaymentVersion:0,acknowledgedNewExpense:true}})
    expect((await post('/company/expenses',payload)).statusCode).toBe(422)
    expect(h.deps.ledger.entries).toHaveLength(0)
    vi.spyOn(h.deps.existingAssets,'addPaymentEvent').mockRejectedValueOnce(new Error('storage failure'))
    const result=await post('/company/expenses',{...payload,amount:'100.00'})
    expect(result.statusCode).toBe(500)
    expect(h.deps.ledger.entries).toHaveLength(0)
    expect(await h.deps.companyLedger.findCommand(payload.idempotencyKey as string)).toBeNull()
  })
  it('does not add a link to an ordinary expense retry that was originally saved without one',async()=>{
    const payload=expense();expect((await post('/company/expenses',payload)).statusCode).toBe(201)
    expect((await post('/company/expenses',{...payload,existingAssetPayment:{assetId,expectedVersion:1,expectedPaymentVersion:0,acknowledgedNewExpense:true}})).statusCode).toBe(409)
    expect((await detail()).payments).toHaveLength(0)
  })
  it('permits partial allocation, rejects duplicated capacity and invalid amounts/currency',async()=>{
    await post('/company/expenses',expense());const body=await link('200.00')
    expect((await post(`${root()}/link`,body)).statusCode).toBe(201)
    expect((await post(`${root()}/link`,{...body,idempotencyKey:id(),expectedPaymentVersion:1,amount:'101.00'})).statusCode).toBe(409)
    expect((await detail()).sources[0].available).toBe('100.00')
    expect((await post(`${root()}/link`,{...body,idempotencyKey:id(),expectedPaymentVersion:1,amount:'-1.00'})).statusCode).toBe(400)
    expect((await post(`${root()}/link`,{...body,idempotencyKey:id(),expectedPaymentVersion:1,sourceHash:'0'.repeat(64)})).statusCode).toBe(409)
  })
  it('serializes concurrent links and prevents using the same full expense on two motors',async()=>{
    await post('/company/expenses',expense())
    const vehicleId=id();h.deps.directory.vehicles.set(vehicleId,{...(await h.deps.directory.vehicle(VEHICLE_ID))!,id:vehicleId,code:'motor-two'})
    const second=id();await post('/company/existing-assets',{idempotencyKey:second,vehicleId,name:'Second',currency:'USD',price:'1200.00',useStartedOn:'2026-07-01'})
    const body=await link()
    const results=await Promise.all([post(`${root()}/link`,body),post(`/company/existing-assets/${second}/payments/link`,{...body,idempotencyKey:id()})])
    expect(results.map(row=>row.statusCode).sort()).toEqual([201,409])
    expect(h.deps.ledger.entries).toHaveLength(1)
  })
  it('links owner historical asset-payment evidence without making a cash expense',async()=>{
    vi.spyOn(h.deps.companyLedgerSource,'listHistoricalImportReceipts').mockResolvedValue([{sourceReference:'HQ-SRC-7',sourcePosition:7,occurredOn:'2026-07-01',movementType:'asset_payment',paidFrom:'owner_outside',currency:'USD',amount:minor(90000n),description:'Historical motor purchase',originalAmount:'900$',originalDescription:'motor',sourceFunding:'owner',originalDeltas:[0,0,0,900],fromCurrency:null,fromAmount:null,toCurrency:null,toAmount:null,rateBasis:null,sypMinorPerUsd:null,sourceBranchId:null,journalEntryId:null,branchJournalEntryId:null,restorationId:null}])
    expect((await post(`${root()}/link`,await link('900.00'))).statusCode).toBe(201)
    expect(await detail()).toMatchObject({totalPaid:'900.00',remaining:'300.00'})
    expect(h.deps.ledger.entries).toEqual([])
  })
  it('schedules exact remaining price, exposes reminders, and settles oldest rows only when real payments are linked',async()=>{
    await post('/company/expenses',expense());await post(`${root()}/link`,await link())
    const before=structuredClone(h.deps.ledger.entries),plan=schedule()
    expect((await post(`${root()}/schedule`,plan)).statusCode).toBe(201)
    expect((await post(`${root()}/schedule`,plan)).statusCode).toBe(200)
    let feed=await detail();expect(feed.installments).toHaveLength(6);expect(feed.installments[0]).toMatchObject({status:'due',remind:true,remaining:'150.00'})
    expect(h.deps.ledger.entries).toEqual(before)
    const payment=expense('200.00');await post('/company/expenses',payment);await post(`${root()}/link`,await link('200.00',`command:${payment.idempotencyKey}`))
    feed=await detail();expect(feed).toMatchObject({totalPaid:'500.00',remaining:'700.00'})
    expect(feed.installments[0]).toMatchObject({status:'paid',remaining:'0.00'})
    expect(feed.installments[1]).toMatchObject({paid:'50.00',remaining:'100.00'})
    expect((await get('/company/existing-assets/payment-summaries')).json().reminders).toHaveLength(0)
  })
  it('unlinks administratively, retains expense and history, invalidates pre-plan allocation removal, and cancels schedule',async()=>{
    await post('/company/expenses',expense());const body=await link();await post(`${root()}/link`,body);await post(`${root()}/schedule`,schedule())
    const before=structuredClone(h.deps.ledger.entries),unlink={idempotencyKey:id(),expectedVersion:1,expectedPaymentVersion:2,reason:'Wrong motor association',paymentId:body.idempotencyKey}
    expect((await post(`${root()}/unlink`,unlink)).statusCode).toBe(201)
    expect((await post(`${root()}/unlink`,unlink)).statusCode).toBe(200)
    let feed=await detail();expect(feed).toMatchObject({totalPaid:'0.00',remaining:'1200.00'});expect(feed.installments[0].status).toBe('needs_review')
    const cancel={idempotencyKey:id(),expectedVersion:1,expectedPaymentVersion:3,reason:'Reschedule based on corrected payment links'}
    expect((await post(`${root()}/cancel_schedule`,cancel)).statusCode).toBe(201)
    feed=await detail();expect(feed.installments).toHaveLength(0);expect(feed.history).toHaveLength(4)
    expect(h.deps.ledger.entries).toEqual(before)
  })
  it('unlinks cancelled expense payments atomically, restores unpaid price, and retains original facts',async()=>{
    const payload=expense();await post('/company/expenses',payload);await post(`${root()}/link`,await link())
    expect((await post('/company/reversals',{idempotencyKey:id(),targetId:payload.idempotencyKey,reason:'Payment was canceled'})).statusCode).toBe(201)
    expect(await detail()).toMatchObject({totalPaid:'0.00',remaining:'1200.00',status:'not_documented',payments:[]})
    expect((await detail()).history.map((row:{kind:string})=>row.kind)).toEqual(['link','unlink'])
  })
  it('protects currency and prices below allocated payments, rejects manager access and stale versions',async()=>{
    await post('/company/expenses',expense());const body=await link();await post(`${root()}/link`,body)
    const edit={idempotencyKey:id(),expectedVersion:1,reason:'Price correction',vehicleId:motorVehicleId,name:'Existing',currency:'USD',price:'200.00',useStartedOn:'2026-07-01'}
    expect((await post(`/company/existing-assets/${assetId}/edit`,edit)).statusCode).toBe(422)
    expect((await post(`/company/existing-assets/${assetId}/edit`,{...edit,currency:'SYP_NEW',price:'1200.00'})).statusCode).toBe(422)
    const manager=await h.loginAs('manager');expect((await post(`${root()}/schedule`,schedule(),manager)).statusCode).toBe(403)
    expect((await post(`${root()}/schedule`,schedule(0))).statusCode).toBe(409)
    expect(h.deps.ledger.entries.filter(row=>row.branchId===BRANCH)).toEqual([])
  })
  it('caps schedule count, preserves month day, trims final payment, rejects zero or negative',()=>{
    expect(buildAssetInstallments(15000n,32000n,'2026-01-31','monthly',30)).toEqual([{dueOn:'2026-01-31',amount:'150.00'},{dueOn:'2026-02-28',amount:'150.00'},{dueOn:'2026-03-31',amount:'20.00'}])
    expect(()=>buildAssetInstallments(1n,601n,'2026-07-21','weekly',7)).toThrow()
    expect(()=>buildAssetInstallments(0n,10n,'2026-07-21','weekly',7)).toThrow()
  })
  it('reminds exactly at the configured threshold, marks overdue, and stops reminders after a price change',async()=>{
    await post('/company/expenses',expense());await post(`${root()}/link`,await link())
    expect((await post(`${root()}/schedule`,schedule(1,{firstDueOn:'2026-08-21'}))).statusCode).toBe(201)
    const card=(await h.deps.existingAssets.get(assetId))!,events=await h.deps.existingAssets.paymentEvents(COMPANY_BRANCH),payment=events.find(row=>row.kind==='link')!.data
    const sources:AssetPaymentSource[]=[{key:payment.sourceKey!,amount:'300.00',currency:'USD',occurredOn:'2026-07-21',paidFrom:'owner_outside',description:'motor payment',hash:payment.sourceHash!}]
    expect(paymentSummary(card,events,sources,'2026-08-17').reminderCount).toBe(0)
    expect(paymentSummary(card,events,sources,'2026-08-18').reminderCount).toBe(1)
    expect(paymentSummary(card,events,sources,'2026-08-21').installments[0]?.status).toBe('due')
    expect(paymentSummary(card,events,sources,'2026-08-22').installments[0]?.status).toBe('overdue')
    expect(paymentSummary({...card,price:minor(150000n)},events,sources,'2026-08-22').reminderCount).toBe(0)
    expect(paymentSummary({...card,price:minor(150000n)},events,sources,'2026-08-22').installments[0]?.status).toBe('needs_review')
  })
})
