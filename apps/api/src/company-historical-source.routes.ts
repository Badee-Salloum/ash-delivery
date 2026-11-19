import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Deps, CompanyHistoricalSourceCorrection, CompanyHistoricalSourceValues, FinancialTransactionDeps } from '@ash/contracts'
import { moneySchema, serializeMoney } from '@ash/contracts'
import { hasVisibleText, isCalendarDate, minor } from '@ash/domain'
import { ServiceError, todayFor } from './shifts.service.ts'
import { sourceValues, effectiveHistoricalSource, historicalSourceCapabilities } from './company-historical-source.service.ts'
import { refreshCorrectedExpensePayments, unlinkDeletedExpensePayments } from './company-operation-links.service.ts'

const reference = z.string().regex(/^HQ-SRC-[0-9]+(?:[–-][0-9]+)?$/)
const reason = z.string().trim().min(1).max(1000).refine(hasVisibleText)
const valuesSchema = z.object({ currency:z.enum(['SYP_NEW','USD']).optional(),
  amount:moneySchema.refine(value=>value>0n).optional(),
  occurredOn:z.string().refine(isCalendarDate).refine(value=>value>='2000-01-01').optional(),
  description:reason.optional(), excluded:z.boolean().optional(),
  sypMinorPerUsd:z.string().regex(/^[1-9][0-9]*$/).refine(value=>BigInt(value)<=9223372036854775807n).nullable().optional(),
  rateBasis:z.enum(['documented','estimated']).nullable().optional(),
}).strict()
const input = z.object({ sourceReference:reference, expectedVersion:z.number().int().positive(), reason,
  values:valuesSchema }).strict()
const confirmInput = input.extend({idempotencyKey:z.string().uuid().transform(x=>x.toLowerCase()),acknowledgeCashEffect:z.literal(true)})
const wire = (receipt: ReturnType<typeof effectiveHistoricalSource>) => ({...receipt,
  amount:receipt.amount===null ? null : serializeMoney(receipt.amount),
  fromAmount:receipt.fromAmount===null ? null : serializeMoney(receipt.fromAmount),
  toAmount:receipt.toAmount===null ? null : serializeMoney(receipt.toAmount),
  sypMinorPerUsd:receipt.sypMinorPerUsd?.toString() ?? null })

export function registerCompanyHistoricalSourceRoutes(app:FastifyInstance,deps:Deps):void {
  const permission={config:{permission:'company_fund.manage' as const}}
  const role=(req:FastifyRequest)=>{
    if(req.actor?.roleKey!=='general_manager' && req.actor?.roleKey!=='system_admin') throw new ServiceError(403,'forbidden')
  }
  const companyId=async()=>{
    const company=await deps.directory.companyBranch()
    if(!company) throw new ServiceError(500,'company_branch_missing')
    return company.id
  }
  async function state(branchId:string, sourceReference:string, repo:Pick<FinancialTransactionDeps,'companyMovementReview'|'companyLedgerSource'>){
    const receipts=await repo.companyLedgerSource.listHistoricalImportReceipts(branchId,{from:'2000-01-01',to:todayFor(deps)})
    const original=receipts.find(row=>row.sourceReference===sourceReference)
    if(!original) throw new ServiceError(404,'historical_source_not_found')
    const history=await repo.companyMovementReview.listHistoricalSourceCorrections(branchId,sourceReference)
    const effective=effectiveHistoricalSource(original,history)
    return {original,effective,history,version:effective.version,capabilities:historicalSourceCapabilities(original)}
  }
  async function preview(branchId:string, body:z.infer<typeof input>, repo:Pick<FinancialTransactionDeps,'companyMovementReview'|'companyLedgerSource'>){
    const current=await state(branchId,body.sourceReference,repo)
    if(current.version!==body.expectedVersion) throw new ServiceError(409,'company_movement_version_conflict',{currentVersion:current.version})
    const before:CompanyHistoricalSourceValues={...sourceValues(current.original),...current.effective.originalValues,
      ...current.history.at(-1)?.values}
    const {amount,...changes}=body.values
    const after:CompanyHistoricalSourceValues={...before,amount:amount===undefined ? before.amount : serializeMoney(amount)}
    for(const key of Object.keys(changes) as Array<keyof typeof changes>){
      if(changes[key]!==undefined) Object.assign(after,{[key]:changes[key]})
    }
    if(after.occurredOn>todayFor(deps)) throw new ServiceError(422,'future_company_event')
    const changed=Object.keys(after).filter(key=>after[key as keyof typeof after]!==before[key as keyof typeof before])
    if(changed.length===0) throw new ServiceError(422,'no_movement_changes')
    if(changed.some(key=>!current.capabilities.editableFields.includes(key)))
      throw new ServiceError(422,'historical_source_financial_correction_required',{blockingReason:current.capabilities.blockingReason})
    if(after.currency==='SYP_NEW'){
      if(body.values.sypMinorPerUsd!=null || body.values.rateBasis!=null) throw new ServiceError(422,'historical_rate_not_applicable')
      after.sypMinorPerUsd=null;after.rateBasis=null
    } else if(before.currency!=='USD' && after.currency==='USD'){
      // External payment evidence may have no documented conversion rate; do not invent one.
      after.sypMinorPerUsd=body.values.sypMinorPerUsd ?? null;after.rateBasis=body.values.rateBasis ?? null
    }
    if((after.sypMinorPerUsd===null)!==(after.rateBasis===null)) throw new ServiceError(422,'historical_rate_required')
    const owner={SYP_NEW:0n,USD:0n}
    if(current.original.paidFrom==='owner_outside') for(const [v,sign] of [[before,-1n],[after,1n]] as const){
      if(!v.excluded && v.currency!==null && v.amount!==null) owner[v.currency]+=moneySchema.parse(v.amount)*sign
    }
    return {...current,before,after,impact:{companyCash:{SYP_NEW:'0.00',USD:'0.00'},branchCash:'0.00',
      ownerPayments:{SYP_NEW:serializeMoney(minor(owner.SYP_NEW)),USD:serializeMoney(minor(owner.USD))},
      companyPnl:'0.00',branchEffect:'none',administrativeOnly:true}}
  }
  app.get('/company/historical-imports/:reference/review',permission,async req=>{
    role(req)
    const params=z.object({reference}).parse(req.params)
    const current=await state(await companyId(),params.reference,deps)
    return {...current,original:wire(effectiveHistoricalSource(current.original,[])),effective:wire(current.effective)}
  })
  app.post('/company/historical-source-corrections/preview',permission,async req=>{
    role(req)
    const result=await preview(await companyId(),input.parse(req.body),deps)
    return {before:result.before,after:result.after,impact:result.impact,version:result.version,capabilities:result.capabilities}
  })
  app.post('/company/historical-source-corrections',permission,async(req,reply)=>{
    role(req)
    const body=confirmInput.parse(req.body),branchId=await companyId()
    const canonical={...body,values:Object.fromEntries(Object.entries(body.values).sort(([a],[b])=>a.localeCompare(b)))}
    const fingerprint=createHash('sha256').update(JSON.stringify(canonical,(_,v)=>typeof v==='bigint'?v.toString():v)+req.actor!.userId).digest('hex')
    const outcome=await deps.financialUnitOfWork.run({lockKey:`receivables:${branchId}`,actorId:req.actor!.userId,requestId:req.requestId},async tx=>{
      const replay=await tx.companyMovementReview.findHistoricalSourceCorrection(body.idempotencyKey)
      if(replay){
        if(replay.branchId!==branchId || replay.fingerprint!==fingerprint) throw new ServiceError(409,'idempotency_key_conflict')
        return {correction:replay,replayed:true}
      }
      const result=await preview(branchId,body,tx)
      const row:CompanyHistoricalSourceCorrection={id:body.idempotencyKey,branchId,sourceReference:body.sourceReference,
        version:result.version+1,before:result.before,values:result.after,reason:body.reason,fingerprint,createdBy:req.actor!.userId,createdAtMs:deps.clock.nowMs()}
      await tx.companyMovementReview.saveHistoricalSourceCorrection(row,result.version)
      if (result.after.excluded) await unlinkDeletedExpensePayments(tx, branchId, [], req.actor!.userId,
        deps.clock.nowMs(), body.reason, [`historical:${body.sourceReference}`])
      else if (result.after.currency !== null && result.after.amount !== null && result.original.paidFrom === 'owner_outside')
        await refreshCorrectedExpensePayments(tx, branchId, '', { amount: result.after.amount, currency: result.after.currency,
          occurredOn: result.after.occurredOn, description: result.after.description, paidFrom: 'owner_outside' },
        req.actor!.userId, deps.clock.nowMs(), body.reason, `historical:${body.sourceReference}`)
      return {correction:row,impact:result.impact,replayed:false}
    })
    return reply.code(outcome.replayed?200:201).send(outcome)
  })
}
