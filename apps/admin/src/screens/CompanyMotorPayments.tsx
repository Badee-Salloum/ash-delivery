import { useState, type ReactNode } from 'react'
import type { Currency } from '@ash/domain'
import { addDays, addMonths, formatMinor, isCalendarDate, minor, parseMinor } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Button, Card, Field, Money, Pending, Select, Table } from '../ui.tsx'
import { FinanceActionForm, useResource, type FormField } from './CompanyFinanceReview.tsx'
import type { WireExistingAsset } from './CompanyExistingAssets.tsx'
import type { Mutate } from './CompanyFund.tsx'

type Payment = { id: string; kind: string; reason: string; needsReview: boolean; data: { amount: string; currency: Currency; occurredOn: string; paidFrom: string; description: string; sourceKey: string; newExpense: boolean } }
export type MotorPaymentSummary = {
  assetId: string; name: string; currency: Currency; version: number; totalPaid: string; remaining: string | null; status: string;
  payments: Payment[]; history: Array<{ id: string; kind: string; reason: string; createdAtMs: number }>;
  plan: { data: { supplier: string } } | null;
  installments: Array<{ dueOn: string; amount: string; paid: string; remaining: string; status: string; remind: boolean }>;
}
export type MotorPaymentFeed = { summaries: MotorPaymentSummary[]; reminders: Array<{ assetId: string; name: string; currency: Currency; dueOn: string; remaining: string; status: string }> }
type Detail = MotorPaymentSummary & { sources: Array<{ key: string; hash: string; available: string; amount: string; currency: Currency; occurredOn: string; description: string; paidFrom: string }> }

export function motorSchedulePreview(remaining: string|null, values: Record<string,string>): {count:number;lastAmount:string;lastDueOn:string}|null {
  try {
    if (remaining===null || !values.firstDueOn || !isCalendarDate(values.firstDueOn)) return null
    const balance=parseMinor(remaining),amount=parseMinor(values.installmentAmount??'')
    if (balance<=0n || amount<=0n) return null
    const count=Number((balance+amount-1n)/amount),interval=Number(values.intervalDays||30)
    if (count>600 || !Number.isInteger(interval) || interval<1 || interval>366) return null
    const lastDueOn=values.recurrence==='monthly'?addMonths(values.firstDueOn,count-1):addDays(values.firstDueOn,(count-1)*(values.recurrence==='weekly'?7:interval))
    return {count,lastAmount:formatMinor(minor(balance-amount*BigInt(count-1))),lastDueOn}
  }catch{return null}
}

export function MotorPaymentReminders({ feed, open }: { feed: MotorPaymentFeed; open: (assetId: string) => void }): ReactNode {
  const { t } = useApp(), p = t.motorPayments
  return <Card title={p.reminders}><p className="mb-3 text-label text-ink-muted">{p.scheduleHint}</p><Table head={[t.companyFinance.vehicle,t.companyFinance.date,p.remaining,t.accounts.status,t.companyFinance.action]} isEmpty={!feed.reminders.length} empty={p.noReminders}>
    {feed.reminders.map(row => <tr key={`${row.assetId}:${row.dueOn}`}><td className="px-3 py-2">{row.name}</td><td className="px-3 py-2"><bdi>{row.dueOn}</bdi></td><td className="px-3 py-2"><Money value={row.remaining} currency={row.currency}/></td><td className="px-3 py-2">{row.status === 'overdue' ? p.overdue : row.status === 'due' ? p.due : p.scheduled}</td><td className="px-3 py-2"><Button variant="ghost" onClick={()=>open(row.assetId)}>{p.add}</Button></td></tr>)}
  </Table></Card>
}

export function MotorPaymentsPanel({ card, mutate, refresh, revision, busy, initialTab = 'payments', initialMode = 'existing', initialAmount = '', initialSchedule = {} }: { card: WireExistingAsset; mutate: Mutate; refresh: () => void; revision: number; busy: boolean; initialTab?: 'payments' | 'schedule'; initialMode?: 'existing' | 'new'; initialAmount?: string; initialSchedule?: Record<string, string> }): ReactNode {
  const { t, session } = useApp(), p = t.motorPayments
  const [mode,setMode] = useState<'existing'|'new'>(initialMode), [tab,setTab] = useState<'payments'|'schedule'>(initialTab), [unlink,setUnlink] = useState<string|null>(null)
  const feed = useResource<Detail>(`/company/existing-assets/${card.id}/payments`, revision)
  const categories = useResource<{categories:Array<{id:string;nameAr:string;nameEn:string;active:boolean}>}>('/expense-categories',0)
  if (!feed.data) return <Pending error={feed.error} loadingLabel={t.common.loading} errorLabel={explainError(feed.error,t)} onRetry={feed.load} retryLabel={t.common.retry}/>
  const data=feed.data, expected={expectedVersion:card.version,expectedPaymentVersion:data.version}
  const writable=card.price!==null && card.status!=='sold' && !card.pendingEdit
  const key=`${card.id}:${card.version}:${data.version}:${mode}:${tab}`
  const sources=[{value:'pocket',label:t.companyFinance.pocket},{value:'owner_custody',label:t.financeWorkspace.ownerCustody},{value:'owner_outside',label:t.companyFinance.ownerOutside},{value:'reserve',label:t.companyFinance.reserve}]
  const label=(value:string):string=>sources.find(row=>row.value===value)?.label??value
  const newFields:FormField[]=[{key:'amount',label:t.companyFinance.amount,type:'money',value:initialAmount},
    {key:'occurredOn',label:t.companyFinance.occurredOn,type:'date',value:session?.businessDate??''},
    {key:'paidFrom',label:t.financeReview.source,value:'pocket',options:sources},
    {key:'categoryId',label:t.expenses.category,options:[{value:'',label:'—'},...(categories.data?.categories.filter(row=>row.active).map(row=>({value:row.id,label:row.nameAr}))??[])]},
    ...(card.currency==='USD'?[{key:'historicalRate',label:t.companyFinance.historicalRate,type:'money' as const}]:[]),
    {key:'description',label:t.companyFinance.description}]
  return <div className="my-4 rounded-lg border border-line p-3">
    <h3 className="font-semibold">{p.title}</h3><p className="my-3 text-label text-ink-muted">{p.hint}</p>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><p>{p.paid}: <Money value={data.totalPaid} currency={card.currency}/></p><p>{p.remaining}: {data.remaining===null?'—':<Money value={data.remaining} currency={card.currency}/>}</p></div>
    {data.status==='not_documented'?<p className="my-3 text-label text-ink-muted">{p.undocumented}</p>:null}
    {data.status==='needs_review'||data.installments.some(row=>row.status==='needs_review')?<p role="alert" className="my-3 text-warning-ink">{p.needsReview}</p>:null}
    {!writable && card.status!=='sold'?<p className="my-3 text-warning-ink">{p.completeCard}</p>:null}
    <div className="my-4 flex flex-wrap gap-2"><Button disabled={busy} variant={tab==='payments'?'primary':'ghost'} onClick={()=>setTab('payments')}>{p.add}</Button><Button disabled={busy} variant={tab==='schedule'?'primary':'ghost'} onClick={()=>setTab('schedule')}>{p.schedule}</Button></div>
    {tab==='payments' && writable ? <><Field label={p.mode}><Select disabled={busy} aria-label={p.mode} value={mode} onChange={event=>setMode(event.target.value as typeof mode)}><option value="existing">{p.existing}</option><option value="new">{p.fresh}</option></Select></Field>
      <p className={`my-3 text-label ${mode==='new'?'text-warning-ink':'text-ink-muted'}`}>{mode==='new'?p.newHint:p.linkHint}</p>
      {mode==='existing'? data.sources.length ? <FinanceActionForm key={key} path={`/company/existing-assets/${card.id}/payments/link`} title={p.link} mutate={mutate} onSaved={refresh}
        fields={[{key:'sourceKey',label:p.source,options:[{value:'',label:'—'},...data.sources.map(row=>({value:row.key,label:`${row.occurredOn} · ${row.available} ${t.currency[row.currency]} · ${row.description}`}))]},
          {key:'amount',label:p.allocated,type:'money',value:initialAmount},{key:'reason',label:t.companyFinance.reason}]}
        build={values=>({...expected,sourceKey:values.sourceKey,sourceHash:data.sources.find(row=>row.key===values.sourceKey)?.hash,amount:values.amount,reason:values.reason})}
        preview={values=><><p>{p.hint}</p><p>{data.sources.find(row=>row.key===values.sourceKey)?.description}</p><Money value={values.amount??''} currency={card.currency}/></>}/>:<p role="status">{p.noSources}</p>:
      !categories.data ? <Pending error={categories.error} loadingLabel={t.common.loading} errorLabel={explainError(categories.error,t)} onRetry={categories.load} retryLabel={t.common.retry}/> : <FinanceActionForm key={key} path="/company/expenses" storageScope={key} title={p.newConfirm} mutate={mutate} onSaved={refresh} fields={newFields}
        build={values=>({amount:values.amount,currency:card.currency,occurredOn:values.occurredOn,paidFrom:values.paidFrom,categoryId:values.categoryId,
          description:values.description,costCenterKind:'vehicle',vehicleId:card.vehicleId,
          ...(card.currency==='USD'?{historicalRate:values.historicalRate}:{}),existingAssetPayment:{...expected,assetId:card.id,acknowledgedNewExpense:true}})}
        preview={values=><><p>{p.newHint}</p><p>{label(values.paidFrom??'')} · <Money value={values.amount??''} currency={card.currency}/></p><p>{values.occurredOn}</p></>}/>}</>:null}
    {tab==='schedule' && writable?<><p className="my-3 text-label text-ink-muted">{p.scheduleHint}</p>{data.plan?<p className="mb-3 text-label">{p.replaceHint}</p>:null}
      <FinanceActionForm key={key} path={`/company/existing-assets/${card.id}/payments/schedule`} title={p.saveSchedule} mutate={mutate} onSaved={refresh}
        fields={[{key:'supplier',label:p.supplier,value:data.plan?.data.supplier??initialSchedule.supplier??''},{key:'installmentAmount',label:p.installment,type:'money',value:initialSchedule.installmentAmount??''},
          {key:'firstDueOn',label:p.firstDue,type:'date',allowFuture:true,value:initialSchedule.firstDueOn??session?.businessDate??''},
          {key:'recurrence',label:p.recurrence,value:initialSchedule.recurrence??'monthly',options:[{value:'monthly',label:p.monthly},{value:'weekly',label:p.weekly},{value:'every_n_days',label:p.everyDays}]},
          {key:'intervalDays',label:p.interval,type:'number',value:'30',visibleWhen:{key:'recurrence',value:'every_n_days'}},
          {key:'reminderDays',label:p.reminderDays,type:'number',value:initialSchedule.reminderDays??'3'},{key:'reason',label:t.companyFinance.reason}]}
        build={values=>({...expected,supplier:values.supplier,installmentAmount:values.installmentAmount,firstDueOn:values.firstDueOn,
          recurrence:values.recurrence,intervalDays:Number(values.intervalDays||30),reminderDays:Number(values.reminderDays),reason:values.reason})}
        preview={values=>{const plan=motorSchedulePreview(data.remaining,values);return <><p>{p.scheduleHint}</p><p>{values.supplier} · {values.firstDueOn}</p>{plan?<><p>{p.count}: {plan.count} · {p.remaining}: <Money value={data.remaining??''} currency={card.currency}/></p><p>{p.lastPayment}: <Money value={plan.lastAmount} currency={card.currency}/> · <bdi>{plan.lastDueOn}</bdi></p></>:<p>{t.errors.asset_payment_invalid_schedule}</p>}</>}}/>
      {data.plan?<details className="mt-3"><summary className="cursor-pointer text-brand">{p.cancelSchedule}</summary><FinanceActionForm path={`/company/existing-assets/${card.id}/payments/cancel_schedule`} title={p.cancelSchedule} fields={[{key:'reason',label:t.companyFinance.reason}]} mutate={mutate} onSaved={refresh} build={values=>({...expected,reason:values.reason})}/></details>:null}</>:null}
    {data.installments.length?<Table head={[p.firstDue,t.companyFinance.amount,p.paid,p.remaining,t.accounts.status]} isEmpty={false} empty={p.noReminders}>{data.installments.map(row=><tr key={row.dueOn}><td className="px-3 py-2"><bdi>{row.dueOn}</bdi></td><td className="px-3 py-2"><Money value={row.amount} currency={card.currency}/></td><td className="px-3 py-2"><Money value={row.paid} currency={card.currency}/></td><td className="px-3 py-2"><Money value={row.remaining} currency={card.currency}/></td><td className="px-3 py-2">{row.status==='paid'?p.settled:row.status==='overdue'?p.overdue:row.status==='due'?p.due:row.status==='needs_review'?p.needsReview:p.scheduled}</td></tr>)}</Table>:null}
    <h4 className="my-3 font-semibold">{p.paymentHistory}</h4><Table head={[t.companyFinance.date,t.companyFinance.amount,t.financeReview.source,t.companyFinance.description,t.companyFinance.action]} isEmpty={!data.payments.length} empty={p.undocumented}>
      {data.payments.map(row=><tr key={row.id}><td className="px-3 py-2"><bdi>{row.data.occurredOn}</bdi></td><td className="px-3 py-2"><Money value={row.data.amount} currency={row.data.currency}/>{row.needsReview?<p className="text-label text-warning-ink">{p.needsReview}</p>:null}</td><td className="px-3 py-2">{label(row.data.paidFrom)}</td><td className="px-3 py-2">{row.data.description}</td><td className="px-3 py-2"><Button variant="ghost" onClick={()=>setUnlink(row.id)}>{p.unlink}</Button></td></tr>)}
    </Table>{unlink?<><p className="my-3 text-label">{p.unlinkHint}</p><FinanceActionForm key={unlink} path={`/company/existing-assets/${card.id}/payments/unlink`} storageScope={unlink} title={p.saveUnlink} fields={[{key:'reason',label:t.companyFinance.reason}]} mutate={mutate} onSaved={()=>{setUnlink(null);refresh()}} build={values=>({...expected,paymentId:unlink,reason:values.reason})}/><Button variant="ghost" onClick={()=>setUnlink(null)}>{t.common.cancel}</Button></>:null}
    <details className="mt-4"><summary className="cursor-pointer text-brand">{p.scheduleHistory}</summary>{data.history.map(row=><p key={row.id} className="my-2 text-label">{row.kind==='link'?p.add:row.kind==='unlink'?p.unlink:row.kind==='schedule'?p.schedule:p.cancelSchedule} · {row.reason}</p>)}</details>
  </div>
}
