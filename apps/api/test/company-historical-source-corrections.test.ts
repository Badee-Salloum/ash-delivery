import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import type { CompanyHistoricalImportReceiptRecord } from '@ash/contracts'
import { minor } from '@ash/domain'
import { BRANCH,COMPANY_BRANCH,makeHarness,type Harness } from './harness.ts'

let h:Harness,gm:string
const receipt=(reference:string,overrides:Partial<CompanyHistoricalImportReceiptRecord>={}):CompanyHistoricalImportReceiptRecord=>({
  sourceReference:reference,sourcePosition:Number(reference.split('-').at(-1)),occurredOn:'2026-07-08',
  movementType:'expense',paidFrom:'owner_outside',currency:'SYP_NEW',amount:minor(5150000n),
  description:'حقائب عدد 10',originalAmount:'5,150,000 ل.س',originalDescription:'حقائب',sourceFunding:'جيب المالك',
  originalDeltas:[0,0,5150000,0],fromCurrency:null,fromAmount:null,toCurrency:null,toAmount:null,
  rateBasis:null,sypMinorPerUsd:null,sourceBranchId:null,journalEntryId:null,branchJournalEntryId:null,restorationId:null,...overrides,
})
const request=(method:'GET'|'POST',url:string,payload?:Record<string,unknown>,token=gm)=>h.app.inject({method,url,headers:{cookie:h.cookie(token)},...(payload===undefined?{}:{payload})})
const correction=(sourceReference='HQ-SRC-10',values:Record<string,unknown>={currency:'USD',amount:'390.00'},extra:Record<string,unknown>={})=>({
  idempotencyKey:crypto.randomUUID(),sourceReference,expectedVersion:1,reason:'تصحيح مؤكد من المالك',values,acknowledgeCashEffect:true,...extra,
})
beforeEach(async()=>{
  h=await makeHarness();gm=await h.loginAs('gm')
  const rows=[receipt('HQ-SRC-10'),receipt('HQ-SRC-25',{movementType:'branch_payment',amount:minor(1200000n),sourceBranchId:BRANCH,description:'تحويل مستقل عن الكرسي'}),
    receipt('HQ-SRC-26',{amount:minor(1160000n),description:'كرسي'})]
  vi.spyOn(h.deps.companyLedgerSource,'listHistoricalImportReceipts').mockResolvedValue(rows)
})
afterEach(async()=>{vi.restoreAllMocks();await h.app.close()})
describe('reviewed historical source revisions without cash duplication',()=>{
  it('deletes owner evidence with one confirmation, drops owner totals, and never touches either cash box',async()=>{
    const originalRows=structuredClone(await h.deps.companyLedgerSource.listHistoricalImportReceipts(COMPANY_BRANCH,{from:'2000-01-01',to:'2026-07-21'}))
    const before=structuredClone(h.deps.ledger.entries)
    const body=correction('HQ-SRC-10',{excluded:true},{reason:'Expense deleted after explicit user confirmation'})
    expect((await request('POST','/company/historical-source-corrections',body)).statusCode).toBe(201)
    expect((await request('POST','/company/historical-source-corrections',body)).statusCode).toBe(200)
    const feed=await request('GET','/company/historical-imports')
    expect(feed.statusCode,feed.body).toBe(200)
    expect(feed.json().rows.find((row:{sourceReference:string})=>row.sourceReference==='HQ-SRC-10')).toMatchObject({excluded:true,deleteCommandId:null})
    expect((await request('GET','/company/owner-payments')).json().payments.some((row:{externalReference:string})=>row.externalReference==='HQ-SRC-10')).toBe(false)
    expect(h.deps.ledger.entries).toEqual(before)
    expect(await h.deps.companyLedgerSource.listHistoricalImportReceipts(COMPANY_BRANCH,{from:'2000-01-01',to:'2026-07-21'})).toEqual(originalRows)
  })
  it('keeps a corrected cash expense visible until the effective replacement is deleted, then restores cash exactly once',async()=>{
    const categoryId=crypto.randomUUID()
    await h.deps.expenses.createCategory({id:categoryId,code:'DELETE-TEST',nameAr:'مصروف اختبار',active:true})
    const created=await request('POST','/company/historical-movements',{idempotencyKey:crypto.randomUUID(),type:'expense',
      occurredOn:'2026-07-08',currency:'SYP_NEW',amount:'20.00',categoryId,description:'Original cash expense'})
    expect(created.statusCode,created.body).toBe(201)
    const original=created.json().command
    const originalEntries=structuredClone(h.deps.ledger.entries)
    vi.mocked(h.deps.companyLedgerSource.listHistoricalImportReceipts).mockResolvedValue([receipt('HQ-SRC-10',{
      paidFrom:'pocket',amount:minor(2000n),journalEntryId:original.journalEntryId,originalDeltas:[-2000,0,0,0]})])
    const revised=await request('POST','/company/movement-corrections',{idempotencyKey:crypto.randomUUID(),targetId:original.id,
      expectedVersion:1,reason:'Correct the amount before deletion',values:{amount:'25.00'}})
    expect(revised.statusCode,revised.body).toBe(201)
    const accepted=await request('POST',`/company/movement-corrections/${revised.json().correction.id}/confirm`,{
      idempotencyKey:crypto.randomUUID(),expectedVersion:1,acknowledgeCashEffect:true})
    expect(accepted.statusCode,accepted.body).toBe(200)
    const feed=await request('GET','/company/historical-imports')
    expect(feed.statusCode,feed.body).toBe(200)
    const current=feed.json().rows[0]
    expect(current.excluded).toBe(false)
    expect(current.deleteCommandId).not.toBe(original.id)
    const body={idempotencyKey:crypto.randomUUID(),targetId:current.deleteCommandId,reason:'Expense deleted after explicit user confirmation'}
    const manager=await h.loginAs('manager')
    expect((await request('POST','/company/reversals',body,manager)).statusCode).toBe(403)
    expect((await request('POST','/company/reversals',body)).statusCode).toBe(201)
    const count=h.deps.ledger.entries.length
    expect((await request('POST','/company/reversals',body)).statusCode).toBe(200)
    expect(h.deps.ledger.entries).toHaveLength(count)
    expect(h.deps.ledger.entries.slice(0,originalEntries.length)).toEqual(originalEntries)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH,'company_cash:SYP_NEW')).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH,'office_cash')).toBe(0n)
    const deleted=(await request('GET','/company/historical-imports')).json()
    expect(deleted.rows[0]).toMatchObject({excluded:true,deleteCommandId:null,balanceAfter:{SYP_NEW:'-20.00'}})
    expect(deleted.sourceClosing.SYP_NEW).toBe('-20.00') // Original worksheet evidence, not actual cash.
    const overview=(await request('GET','/company/overview')).json()
    expect(overview.pockets.SYP_NEW).toBe('0.00')
    expect(overview.period.SYP_NEW.expense).toBe('0.00')
  })
  it('corrects bags to USD, excludes source25, retains chair and updates every current owner total without a journal',async()=>{
    const before=structuredClone(h.deps.ledger.entries)
    const body=correction()
    const {idempotencyKey,acknowledgeCashEffect,...preview}=body
    const proposed=await request('POST','/company/historical-source-corrections/preview',preview)
    expect(proposed.statusCode,proposed.body).toBe(200)
    expect(proposed.json().impact).toMatchObject({ownerPayments:{SYP_NEW:'-51500.00',USD:'390.00'},branchCash:'0.00',companyPnl:'0.00'})
    expect((await request('POST','/company/historical-source-corrections',body)).statusCode).toBe(201)
    expect((await request('POST','/company/historical-source-corrections',correction('HQ-SRC-25',{excluded:true}))).statusCode).toBe(201)
    const report=await request('GET','/company/owner-payments')
    expect(report.statusCode,report.body).toBe(200)
    expect(report.json()).toMatchObject({totals:{SYP_NEW:'11600.00',USD:'390.00'},branchFundingTotals:{SYP_NEW:'0.00'},combinedTotals:{SYP_NEW:'11600.00',USD:'390.00'},paymentCount:2})
    expect(report.json().payments.some((row:{externalReference:string})=>row.externalReference==='HQ-SRC-26')).toBe(true)
    expect(h.deps.ledger.entries).toEqual(before)
    const review=(await request('GET','/company/historical-imports/HQ-SRC-10/review')).json()
    expect(review.original).toMatchObject({currency:'SYP_NEW',amount:'51500.00'})
    expect(review.effective).toMatchObject({currency:'USD',amount:'390.00',version:2,sypMinorPerUsd:null,rateBasis:null})
  })
  it('replays originalUUID but refuses changed data and stale concurrent corrections',async()=>{
    const body=correction()
    expect((await request('POST','/company/historical-source-corrections',body)).statusCode).toBe(201)
    expect((await request('POST','/company/historical-source-corrections',body)).statusCode).toBe(200)
    expect((await request('POST','/company/historical-source-corrections',{...body,values:{amount:'391.00'}})).statusCode).toBe(409)
    const concurrent=await Promise.all([request('POST','/company/historical-source-corrections',correction('HQ-SRC-10',{amount:'391.00'},{expectedVersion:2})),
      request('POST','/company/historical-source-corrections',correction('HQ-SRC-10',{amount:'392.00'},{expectedVersion:2}))])
    expect(concurrent.map(row=>row.statusCode).sort()).toEqual([201,409])
    expect(await h.deps.companyMovementReview.listHistoricalSourceCorrections('10000000-0000-4000-8000-000000000100')).toHaveLength(2)
  })
  it('moves the effective owner payment into its corrected occurrence period without rewriting source',async()=>{
    expect((await request('POST','/company/historical-source-corrections',correction('HQ-SRC-10',{occurredOn:'2026-06-01'}))).statusCode).toBe(201)
    expect((await request('GET','/company/owner-payments?from=2026-06-01&to=2026-06-01')).json().totals.SYP_NEW).toBe('51500.00')
    expect((await request('GET','/company/owner-payments?from=2026-07-08&to=2026-07-08')).json().totals.SYP_NEW).toBe('11600.00')
  })
  it('blocks cash-backed revaluation or exclusion but permits audited description/date improvement',async()=>{
    vi.mocked(h.deps.companyLedgerSource.listHistoricalImportReceipts).mockResolvedValue([receipt('HQ-SRC-10',{journalEntryId:100,paidFrom:'pocket'})])
    expect((await request('POST','/company/historical-source-corrections',correction('HQ-SRC-10',{amount:'30.00'}))).statusCode).toBe(422)
    expect((await request('POST','/company/historical-source-corrections',correction('HQ-SRC-10',{excluded:true}))).statusCode).toBe(422)
    expect((await request('POST','/company/historical-source-corrections',correction('HQ-SRC-10',{description:'تفسير مؤكد'}))).statusCode).toBe(201)
    expect(h.deps.ledger.entries).toEqual([])
  })
  it('rejects unauthorized/invalid/future/no-change inputs and requires explicit confirmation',async()=>{
    const manager=await h.loginAs('manager')
    expect((await request('POST','/company/historical-source-corrections',correction(),manager)).statusCode).toBe(403)
    expect((await request('POST','/company/historical-source-corrections',correction('HQ-SRC-10',{amount:'-1.00'}))).statusCode).toBe(400)
    expect((await request('POST','/company/historical-source-corrections',correction('HQ-SRC-10',{occurredOn:'2026-02-30'}))).statusCode).toBe(400)
    expect((await request('POST','/company/historical-source-corrections',correction('HQ-SRC-10',{occurredOn:'2030-01-01'}))).statusCode).toBe(422)
    expect((await request('POST','/company/historical-source-corrections',correction('HQ-SRC-10',{}))).statusCode).toBe(422)
    expect((await request('POST','/company/historical-source-corrections',{...correction(),acknowledgeCashEffect:false})).statusCode).toBe(400)
  })
})
