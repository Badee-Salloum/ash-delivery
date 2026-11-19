import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Currency } from '@ash/domain'
import { addMonths, monthStartFor } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { formatHash } from '../route.ts'
import { Button, Card, DateField, Field, Money, Pending, Select, Table } from '../ui.tsx'
import type { Mutate } from './CompanyFund.tsx'
import { FinanceActionForm, FinanceDialog, useResource, type FormField } from './CompanyFinanceReview.tsx'
import { MotorPaymentsPanel, MotorPaymentReminders, type MotorPaymentFeed } from './CompanyMotorPayments.tsx'
import { MotorRegistration } from './CompanyMotorRegistration.tsx'

export type WireExistingAsset = {
  id: string; vehicleId: string; name: string; currency: Currency; price: string | null
  purchasedOn: string | null; useStartedOn: string | null; fundingSource: 'company' | 'owner_outside' | 'unknown'
  description: string; status: 'draft' | 'registered' | 'sold'
  accountingStatus: 'pending_review' | 'approved' | 'needs_correction'; version: number
  depreciation: null | { startsOn: string; usefulMonths: number; residualValue: string }
  recognition: null | { journalEntryId: number; cost: string; accumulatedDepreciation: string; asOf: string }
  bookValue: string | null
  calculatedSchedule?: Array<{ period: number; startsOn: string; endsOn: string; amount: string; status: 'scheduled' | 'calculated_not_posted' }>
  pendingEdit: null | { requestId: string; price: string | null; currency: Currency; sourceVersion: number; reason: string }
  sale: null | {
    id: string; kind?: 'financial' | 'documentary'; status: 'draft' | 'confirmed'; buyer: string; price: string; currency: Currency
    occurredOn: string; receivedAmount: string; receiptDestination: 'company' | 'owner_outside'
    receiptEntryId: number | null; debtId: string | null
  }
}
export type ExistingAssetVehicle = {
  id: string; branchId: string; code: string; groundNo: string | null; plateNo: string | null
  assetId: string | null
}
type LegacyAsset = { id: string; vehicleId: string | null; name: string; currency: Currency; price: string }
type Action = 'edit' | 'payments' | 'depreciation' | 'sale' | 'evidence' | 'recognition' | 'saleLinks' | 'confirmSale'
type AssetDetail = {
  evidence: Array<{ id: string; description: string; operationId: string | null; journalEntryId: number | null; mediaId: string | null }>
  events: Array<{ id: string; version: number; reason: string; createdBy: string }>
}

/** Use the existing router's id parameter; vehicle= is a report filter, not the account identity. */
export function existingAssetVehicleAccountHash(vehicleId: string): string {
  return `#${formatHash({ section: 'vehicle', openShift: null, params: { id: vehicleId } })}`
}

export function availableExistingAssetVehicles(vehicles: ExistingAssetVehicle[], editingVehicleId?: string): ExistingAssetVehicle[] {
  return vehicles.filter(vehicle => vehicle.assetId === null || vehicle.id === editingVehicleId)
}

export function ExistingAssetsPanel({ mutate, busy, initialVehicleId }: { mutate: Mutate; busy: boolean; initialVehicleId?: string | undefined }): ReactNode {
  const { t, branches } = useApp(), r = t.financeReview, a = t.existingAssetReview
  const [revision, setRevision] = useState(0), [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [creationVehicles, setCreationVehicles] = useState<ExistingAssetVehicle[]>([])
  const [openPayments, setOpenPayments] = useState(false)
  const paymentFeed = useResource<MotorPaymentFeed>('/company/existing-assets/payment-summaries', revision)
  const assets = useResource<{ assets: WireExistingAsset[]; legacyAssets: LegacyAsset[] }>('/company/existing-assets', revision)
  const vehicles = useResource<{ vehicles: ExistingAssetVehicle[] }>('/company/existing-assets/vehicles', revision)
  const focused = useRef(false)
  useEffect(() => {
    if (focused.current || !initialVehicleId || !assets.data) return
    const card = assets.data.assets.find(card => card.vehicleId === initialVehicleId)
    if (card) { setSelected(card.id); focused.current = true }
  }, [initialVehicleId, assets.data])
  const refresh = (): void => setRevision(value => value + 1)
  const available = availableExistingAssetVehicles(vehicles.data?.vehicles ?? [])
  const selectedCard = assets.data?.assets.find(card => card.id === selected)
  const fields: FormField[] = [
    { key: 'vehicleId', label: t.companyFinance.vehicle, options: [{ value: '', label: '—' }, ...available.map(vehicle => ({ value: vehicle.id, label: [vehicle.groundNo, vehicle.code, branches.find(branch => branch.id === vehicle.branchId)?.nameAr].filter(Boolean).join(' · ') }))] },
    { key: 'price', label: t.companyFinance.price, type: 'money', optional: true },
    { key: 'currency', label: t.companyFinance.currency, value: 'USD', options: [{ value: 'USD', label: t.currency.USD }, { value: 'SYP_NEW', label: t.currency.SYP_NEW }] },
    { key: 'purchasedOn', label: t.companyFinance.purchasedOn, type: 'date', optional: true },
    { key: 'useStartedOn', label: r.useStartedOn, type: 'date', optional: true },
    { key: 'fundingSource', label: a.previousPayer, value: 'unknown', options: [{ value: 'unknown', label: r.unknown }, { value: 'owner_outside', label: t.companyFinance.ownerOutside }, { value: 'company', label: t.companyFinance.pocket }] },
    { key: 'description', label: t.companyFinance.description, optional: true },
  ]
  return <div className="flex flex-col gap-4">
    {paymentFeed.data ? <MotorPaymentReminders feed={paymentFeed.data} open={assetId=>{setOpenPayments(true);setSelected(assetId)}}/> : <Pending error={paymentFeed.error} loadingLabel={t.common.loading} errorLabel={explainError(paymentFeed.error,t)} onRetry={paymentFeed.load} retryLabel={t.common.retry}/>}
    <Button className="self-start" disabled={busy || !vehicles.data} onClick={() => { setCreationVehicles(available); setCreating(true) }}>{t.financeWorkspace.addMotorCard}</Button>
    {creating ? <FinanceDialog title={t.motorPayments.registrationTitle} onClose={() => setCreating(false)}>
      <MotorRegistration fields={fields} vehicles={creationVehicles} mutate={mutate} busy={busy} refresh={refresh} onClose={() => setCreating(false)} />
    </FinanceDialog> : null}
    <Card title={t.companyFinance.assetsTitle}>
      {!assets.data ? <Pending error={assets.error} loadingLabel={t.common.loading} errorLabel={explainError(assets.error, t)} onRetry={assets.load} retryLabel={t.common.retry} /> : <>
        <Table head={[t.companyFinance.vehicle, t.companyFinance.price, t.motorPayments.paid, t.motorPayments.remaining, t.accounts.status, t.companyFinance.action]} isEmpty={!assets.data.assets.length && !assets.data.legacyAssets.length} empty={r.noExisting}>
          {assets.data.assets.map(card => <tr key={card.id}>
            <td className="px-3 py-2">{card.name}<a className="block text-label text-brand underline" href={existingAssetVehicleAccountHash(card.vehicleId)}>{r.vehicleAccount}</a></td>
            <td className="px-3 py-2">{card.price === null ? '—' : <Money value={card.price} currency={card.currency} />}</td>
            <td className="px-3 py-2">{paymentFeed.data?.summaries.find(row=>row.assetId===card.id)?.totalPaid ? <Money value={paymentFeed.data.summaries.find(row=>row.assetId===card.id)!.totalPaid} currency={card.currency}/> : '—'}</td>
            <td className="px-3 py-2">{paymentFeed.data?.summaries.find(row=>row.assetId===card.id)?.remaining ? <Money value={paymentFeed.data.summaries.find(row=>row.assetId===card.id)!.remaining!} currency={card.currency}/> : '—'}{paymentFeed.data?.summaries.find(row=>row.assetId===card.id)?.status==='not_documented'?<p className="text-label text-ink-muted">{t.motorPayments.undocumented}</p>:null}{paymentFeed.data?.summaries.find(row=>row.assetId===card.id)?.status==='needs_review'?<p className="text-label text-warning-ink">{t.motorPayments.needsReview}</p>:null}</td>
            <td className="px-3 py-2"><p>{r[card.status]}</p><p className="text-label text-ink-muted">{r[card.accountingStatus]}</p><p className="text-label">{card.depreciation ? r.calculationOnly : r.depreciationOff}</p>{card.pendingEdit ? <p className="text-label text-warning-ink">{a.pendingEditTitle}</p> : null}{card.sale?.status === 'draft' ? <p className="text-label text-warning-ink">{a.saleDraftPending}</p> : null}</td>
            <td className="px-3 py-2"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => {setOpenPayments(false);setSelected(card.id)}}>{t.companyFinance.action}</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>{setOpenPayments(true);setSelected(card.id)}}>{t.motorPayments.title}</Button></td>
          </tr>)}
          {assets.data.legacyAssets.map(card => <tr key={`legacy:${card.id}`}><td className="px-3 py-2">{card.name}{card.vehicleId ? <a className="block text-label text-brand underline" href={existingAssetVehicleAccountHash(card.vehicleId)}>{r.vehicleAccount}</a> : null}</td><td className="px-3 py-2"><Money value={card.price} currency={card.currency} /></td><td className="px-3 py-2">—</td><td className="px-3 py-2">—</td><td className="px-3 py-2">{a.alreadyRecorded}</td><td className="px-3 py-2 text-label text-ink-muted">{r.archivePurchase}</td></tr>)}
        </Table>
      </>}
    </Card>
    {selectedCard ? <FinanceDialog title={selectedCard.name} onClose={() => setSelected(null)}><AssetActions key={`${selectedCard.id}:${openPayments}`} card={selectedCard} vehicles={vehicles.data?.vehicles ?? []} baseFields={fields} mutate={mutate} busy={busy} refresh={refresh} revision={revision} initialAction={openPayments?'payments':'edit'} onClose={() => setSelected(null)} /></FinanceDialog> : null}
  </div>
}

function AssetEditReview({ card, mutate, refresh }: {card: WireExistingAsset; mutate: Mutate; refresh: () => void}): ReactNode {
  const { t, session } = useApp(), w = t.financeWorkspace, pending = card.pendingEdit!
  const today = session?.businessDate ?? ''
  const [effectiveOn, setEffectiveOn] = useState(card.depreciation && today ? addMonths(monthStartFor(today),1) : today)
  const preview = useResource<{requestId:string;version:number;afterPrice:string;frozenPeriods:number;remainingPeriods:number;futureMonthly:string;requiresJournal:boolean}>(card.status !== 'sold' && effectiveOn ? `/company/existing-assets/${card.id}/edit-preview?effectiveOn=${effectiveOn}` : null,card.version)
  return <div role="status" className="mb-4 rounded-lg border border-warning-line bg-warning-surface p-3">
    <p className="font-semibold">{w.assetReviewPreview}</p><p className="my-3 text-label text-ink-muted">{w.assetEditReviewHint}</p>
    <p>{t.financeReview.before}: <Money value={card.price ?? ''} currency={card.currency}/> · {t.financeReview.after}: <Money value={pending.price ?? ''} currency={pending.currency}/></p><p>{pending.reason}</p>
    <DateField label={w.assetEditEffective} value={effectiveOn} onChange={setEffectiveOn}/>
    {card.status === 'sold' ? <p>{t.financeReview.sold}</p> : !preview.data ? <Pending error={preview.error} loadingLabel={t.common.loading} errorLabel={explainError(preview.error,t)} onRetry={preview.load} retryLabel={t.common.retry}/> : <>
      <p>{w.assetFrozenPeriods}: {preview.data.frozenPeriods} · {w.assetFuturePeriods}: {preview.data.remainingPeriods}</p><p>{w.assetFutureMonthly}: <Money value={preview.data.futureMonthly} currency={card.currency}/></p><p>{t.financeReview.noCashEffect}</p>
      <FinanceActionForm key={`${card.version}:${effectiveOn}`} path={`/company/existing-assets/${card.id}/edit-confirm`} title={w.approveAssetEdit} mutate={mutate} onSaved={refresh}
        fields={[...(preview.data.requiresJournal ? [{key:'journalEntryId',label:w.assetCorrectionEntry,type:'number' as const}] : []),{key:'reason',label:t.companyFinance.reason}]}
        build={values=>({expectedVersion:card.version,requestId:pending.requestId,effectiveOn,journalEntryId:values.journalEntryId ? Number(values.journalEntryId):null,acknowledged:true,reason:values.reason})}
        preview={values=><><p>{w.assetEditReviewHint}</p><Money value={pending.price ?? ''} currency={pending.currency}/><p>{effectiveOn}</p><p>{values.reason}</p></>}/>
    </>}
    <details className="mt-3"><summary className="cursor-pointer text-brand">{w.rejectAssetEdit}</summary><FinanceActionForm path={`/company/existing-assets/${card.id}/edit-reject`} title={w.rejectAssetEdit} mutate={mutate} onSaved={refresh} fields={[{key:'reason',label:t.companyFinance.reason}]} build={values=>({expectedVersion:card.version,requestId:pending.requestId,reason:values.reason})}/></details>
  </div>
}

function AssetActions({ card, vehicles, baseFields, mutate, busy, refresh, revision, initialAction }: {
  card: WireExistingAsset; vehicles: ExistingAssetVehicle[]; baseFields: FormField[]
  mutate: Mutate; busy: boolean; refresh: () => void; onClose: () => void
  revision: number; initialAction: Action
}): ReactNode {
  const { t, session } = useApp(), r = t.financeReview, a = t.existingAssetReview
  const [action, setAction] = useState<Action>(initialAction)
  const [saleCurrency, setSaleCurrency] = useState<Currency>(card.sale?.currency ?? card.currency)
  const detail = useResource<AssetDetail>(`/company/existing-assets/${card.id}`, card.version)
  const receipts = useResource<{ receipts: Array<{ id: number; occurredOn: string; amount: string; currency: Currency; description: string }> }>(`/company/existing-assets/sale-receipts?currency=${saleCurrency}`, card.version)
  const currencyOptions = [{ value: 'SYP_NEW', label: t.currency.SYP_NEW }, { value: 'USD', label: t.currency.USD }]
  const receiptOptions = [{ value: 'company', label: t.companyFinance.pocket }, { value: 'owner_outside', label: t.companyFinance.ownerOutside }]
  const formKey = `${card.id}:${action}:${card.version}`
  const expected = { expectedVersion: card.version }
  const sale = card.sale
  const saleFields: FormField[] = [
    { key: 'buyer', label: r.buyer, value: sale?.buyer ?? '' }, { key: 'price', label: r.salePrice, type: 'money', value: sale?.price ?? '' },
    { key: 'currency', label: t.companyFinance.currency, value: sale?.currency ?? card.currency, options: currencyOptions },
    { key: 'occurredOn', label: t.companyFinance.date, type: 'date', value: sale?.occurredOn ?? session?.businessDate ?? '' },
    { key: 'receivedAmount', label: r.receivedAmount, type: 'money', value: sale?.receivedAmount ?? '0.00' },
    { key: 'receiptDestination', label: r.receiptDestination, value: sale?.receiptDestination ?? 'company', options: receiptOptions },
    ...(action === 'saleLinks' ? [{ key: 'receiptEntryId', label: r.receiptEntry, type: 'number' as const, optional: true, value: sale?.receiptEntryId?.toString() ?? '' }, { key: 'debtId', label: a.buyerDebt, optional: true, value: sale?.debtId ?? '' }] : []),
    { key: 'reason', label: t.companyFinance.reason },
  ]
  return <div><p className="mb-3 text-body text-ink-muted">{r.noCashEffect}</p>
    <details className="mb-4 rounded-lg border border-line p-3"><summary className="cursor-pointer font-semibold">{t.financeWorkspace.motorDepreciationHistory}</summary>
      <p className="my-3 text-label text-ink-muted">{t.financeWorkspace.motorDepreciationHint}</p>
      <a className="text-brand underline" href={existingAssetVehicleAccountHash(card.vehicleId)}>{t.financeWorkspace.openVehicleCard}</a>
      <Table head={[r.startsOn, t.companyFinance.to, t.companyFinance.amount, t.accounts.status]} isEmpty={!card.calculatedSchedule?.length} empty={r.depreciationOff}>{card.calculatedSchedule?.map(period => <tr key={period.period}><td className="px-3 py-2"><bdi>{period.startsOn}</bdi></td><td className="px-3 py-2"><bdi>{period.endsOn}</bdi></td><td className="px-3 py-2"><Money value={period.amount} currency={card.currency} /></td><td className="px-3 py-2">{period.status === 'scheduled' ? t.financeWorkspace.depreciationScheduled : r.calculationOnly}</td></tr>)}</Table>
      {detail.data ? <Table head={[a.version, t.companyFinance.reason]} isEmpty={!detail.data.events.length} empty={a.noEvidence}>{detail.data.events.map(event => <tr key={event.id}><td className="px-3 py-2">{event.version}</td><td className="px-3 py-2">{event.reason}</td></tr>)}</Table> : null}
    </details>
    <div className="mb-4 flex flex-wrap gap-2"><Button variant={action === 'payments' ? 'primary' : 'ghost'} type="button" disabled={busy} onClick={()=>setAction('payments')}>{t.motorPayments.title}</Button><Button variant={action === 'edit' ? 'primary' : 'ghost'} type="button" disabled={busy} onClick={() => setAction('edit')}>{r.edit}</Button><Button variant={action === 'depreciation' ? 'primary' : 'ghost'} type="button" disabled={busy || card.status !== 'registered' || card.depreciation !== null} onClick={() => setAction('depreciation')}>{r.activateDepreciation}</Button><Button variant={action === 'sale' ? 'primary' : 'ghost'} type="button" disabled={busy || card.status === 'sold'} onClick={() => setAction('sale')}>{r.sale}</Button></div>
    {action==='payments'?<MotorPaymentsPanel card={card} mutate={mutate} refresh={refresh} revision={revision} busy={busy}/>:null}
    {card.pendingEdit ? <AssetEditReview card={card} mutate={mutate} refresh={refresh} /> : null}
    {card.sale ? <div className="mb-4 rounded-lg border border-line p-3"><p>{card.sale.kind === 'documentary' ? a.documentarySaleDone : card.sale.status === 'draft' ? a.saleDraftPending : a.confirmedSale}</p><p>{card.sale.buyer} · <Money value={card.sale.price} currency={card.sale.currency} /></p>{card.sale.status === 'draft' ? <p className="text-label text-ink-muted">{r.saleDraftHint}</p> : null}{card.sale.kind === 'documentary' ? <p className="text-label text-ink-muted">{a.documentarySaleHint}</p> : null}</div> : null}
    {action === 'edit' && !card.pendingEdit ? <FinanceActionForm key={formKey} storageScope={formKey} path={`/company/existing-assets/${card.id}/edit`} title={r.edit} fields={[...baseFields.map<FormField>(field => field.key === 'vehicleId' ? { ...field, value: card.vehicleId, options: availableExistingAssetVehicles(vehicles, card.vehicleId).map(vehicle => ({ value: vehicle.id, label: vehicle.groundNo || vehicle.code })) } : { ...field, value: String(card[field.key as keyof WireExistingAsset] ?? '') }), { key: 'reason', label: t.companyFinance.reason }]} mutate={mutate} onSaved={refresh} build={values => ({ ...expected, vehicleId: values.vehicleId, name: vehicles.find(vehicle => vehicle.id === values.vehicleId)?.groundNo || vehicles.find(vehicle => vehicle.id === values.vehicleId)?.code || card.name, currency: values.currency, price: values.price || null, purchasedOn: values.purchasedOn || null, useStartedOn: values.useStartedOn || null, fundingSource: values.fundingSource, description: values.description || '', reason: values.reason })} preview={values => <><p>{card.recognition || card.depreciation || card.status === 'sold' ? a.pendingEditHint : r.noCashEffect}</p>{values.price ? <Money value={values.price} currency={values.currency as Currency} /> : <p>{r.draft}</p>}</>} /> : null}
    {action === 'depreciation' ? <><p className="mb-3 text-body text-ink-muted">{a.depreciationReviewHint}</p><FinanceActionForm key={formKey} storageScope={formKey} path={`/company/existing-assets/${card.id}/depreciation/activate`} title={r.activateDepreciation} fields={[{ key: 'startsOn', label: r.startsOn, type: 'date', value: session?.businessDate ?? '' }, { key: 'usefulMonths', label: r.usefulMonths, type: 'number' }, { key: 'residualValue', label: r.residualValue, type: 'money', value: '0.00' }, { key: 'reason', label: t.companyFinance.reason }]} mutate={mutate} onSaved={refresh} build={values => ({ ...expected, startsOn: values.startsOn, usefulMonths: Number(values.usefulMonths), residualValue: values.residualValue, reason: values.reason })} preview={() => <p>{r.calculationOnly}</p>} /></> : null}
    {action === 'sale' && !card.recognition ? <><p className="mb-3 text-body text-warning-ink">{a.documentarySaleHint}</p><Field label={t.companyFinance.currency}><Select value={saleCurrency} onChange={event => setSaleCurrency(event.target.value as Currency)} aria-label={t.companyFinance.currency}>{currencyOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></Field>{card.status !== 'registered' || card.pendingEdit ? <p className="my-3 text-warning-ink">{a.documentarySaleIncomplete}</p> : !receipts.data ? <Pending error={receipts.error} loadingLabel={t.common.loading} errorLabel={explainError(receipts.error, t)} onRetry={receipts.load} retryLabel={t.common.retry} /> : !receipts.data.receipts.length ? <p className="my-3 text-ink-muted">{a.noSaleReceipts}</p> : <div className="mt-3"><FinanceActionForm key={`${formKey}:${saleCurrency}`} storageScope={`${formKey}:${saleCurrency}`} path={`/company/existing-assets/${card.id}/documentary-sale`} title={a.confirmDocumentarySale} fields={[{ key: 'buyer', label: r.buyer }, { key: 'price', label: r.salePrice, type: 'money' }, { key: 'occurredOn', label: t.companyFinance.date, type: 'date', value: session?.businessDate ?? '' }, { key: 'receiptEntryId', label: a.existingSaleReceipt, options: [{ value: '', label: '—' }, ...receipts.data.receipts.map(row => ({ value: String(row.id), label: `${row.occurredOn} · ${row.amount} ${t.currency[row.currency]} · ${row.description}` }))] }, { key: 'reason', label: t.companyFinance.reason }]} mutate={mutate} onSaved={refresh} build={values => ({ ...expected, buyer: values.buyer, price: values.price, currency: saleCurrency, occurredOn: values.occurredOn, receiptEntryId: Number(values.receiptEntryId), reason: values.reason })} preview={values => <><p>{a.documentarySaleHint}</p><p>{values.buyer} · <Money value={values.price ?? ''} currency={saleCurrency} /></p><p>{values.occurredOn}</p><p>{receipts.data?.receipts.find(row => String(row.id) === values.receiptEntryId)?.description}</p><p>{values.reason}</p></>} /></div>}</> : action === 'sale' || action === 'saleLinks' ? <><p className="mb-3 text-body text-warning-ink">{r.saleDraftHint}</p><FinanceActionForm key={formKey} storageScope={formKey} path={`/company/existing-assets/${card.id}/sales`} title={r.saveDraft} fields={saleFields} mutate={mutate} onSaved={refresh} build={values => ({ ...expected, buyer: values.buyer, currency: values.currency, price: values.price, occurredOn: values.occurredOn, receivedAmount: values.receivedAmount, receiptDestination: values.receiptDestination, receiptEntryId: action === 'saleLinks' ? values.receiptEntryId ? Number(values.receiptEntryId) : null : sale?.receiptEntryId ?? null, debtId: action === 'saleLinks' ? values.debtId || null : sale?.debtId ?? null, reason: values.reason })} preview={() => <p>{r.saleDraftHint}</p>} /></> : null}
    {action === 'evidence' ? <><p className="mb-3 text-body text-ink-muted">{a.evidenceHint}</p><FinanceActionForm key={formKey} storageScope={formKey} path={`/company/existing-assets/${card.id}/evidence`} title={a.attachEvidence} fields={[{ key: 'operationId', label: a.operationId, optional: true }, { key: 'journalEntryId', label: a.evidenceEntry, type: 'number', optional: true }, { key: 'mediaId', label: a.mediaId, optional: true }, { key: 'description', label: t.companyFinance.description }, { key: 'reason', label: t.companyFinance.reason }]} mutate={mutate} onSaved={refresh} build={values => ({ ...expected, operationId: values.operationId || null, journalEntryId: values.journalEntryId ? Number(values.journalEntryId) : null, mediaId: values.mediaId || null, description: values.description, reason: values.reason })} /></> : null}
    {action === 'recognition' ? <><p className="mb-3 text-body text-warning-ink">{a.recognitionHint}</p>{card.recognition ? <p>{r.accumulatedDepreciation}: <Money value={card.recognition.accumulatedDepreciation} currency={card.currency} /></p> : null}<FinanceActionForm key={formKey} storageScope={formKey} path={`/company/existing-assets/${card.id}/recognition`} title={a.linkRecognition} fields={[{ key: 'journalEntryId', label: r.recognitionEntry, type: 'number', value: card.recognition?.journalEntryId.toString() ?? '' }, { key: 'cost', label: a.reviewedCost, type: 'money', value: card.price ?? '' }, { key: 'asOf', label: a.baselineAsOf, type: 'date', value: card.recognition?.asOf ?? session?.businessDate ?? '' }, { key: 'reason', label: t.companyFinance.reason }]} mutate={mutate} onSaved={refresh} build={values => ({ ...expected, journalEntryId: Number(values.journalEntryId), cost: values.cost, accumulatedDepreciation: card.recognition?.accumulatedDepreciation ?? '0.00', asOf: values.asOf, reason: values.reason })} preview={() => <p>{a.recognitionHint}</p>} /></> : null}
    {action === 'confirmSale' && sale?.status === 'draft' ? <><p className="mb-3 text-body text-warning-ink">{a.confirmSaleHint}</p>{card.accountingStatus !== 'approved' ? <p role="status">{r.pendingValuation}</p> : <FinanceActionForm key={formKey} storageScope={formKey} path={`/company/existing-assets/${card.id}/sales/${sale.id}/confirm`} title={r.confirmSale} fields={[{ key: 'disposalEntryId', label: r.disposalEntry, type: 'number' }, { key: 'reason', label: t.companyFinance.reason }]} mutate={mutate} onSaved={refresh} build={values => ({ ...expected, disposalEntryId: Number(values.disposalEntryId), reason: values.reason })} preview={() => <p>{a.confirmSaleHint}</p>} />}</> : null}
    <details className="mt-5 rounded-lg border border-line p-3"><summary className="cursor-pointer font-semibold">{r.accountingReview}</summary><p className="my-3 text-label text-ink-muted">{a.advancedHint}</p><div className="mb-3 flex flex-wrap gap-2"><Button variant="ghost" type="button" disabled={busy} onClick={() => setAction('evidence')}>{a.evidenceTitle}</Button><Button variant="ghost" type="button" disabled={busy || card.status === 'sold'} onClick={() => setAction('recognition')}>{a.linkRecognition}</Button>{sale?.status === 'draft' ? <><Button variant="ghost" type="button" disabled={busy} onClick={() => setAction('saleLinks')}>{a.saleLinks}</Button><Button variant="ghost" type="button" disabled={busy} onClick={() => setAction('confirmSale')}>{r.confirmSale}</Button></> : null}</div>
      {card.bookValue !== null ? <p>{card.status === 'sold' ? t.companyFinance.bookValue : a.baselineValue}: <Money value={card.bookValue} currency={card.currency} /></p> : <p>{r.pendingValuation}</p>}
      <p className="my-3 text-label text-ink-muted">{a.bookValueHint}</p>
      {detail.data ? <><Table head={[a.evidenceTitle, a.evidenceEntry]} isEmpty={!detail.data.evidence.length} empty={a.noEvidence}>{detail.data.evidence.map(evidence => <tr key={evidence.id}><td className="px-3 py-2">{evidence.description}</td><td className="num px-3 py-2">{evidence.journalEntryId ?? '—'}</td></tr>)}</Table><Table head={[a.version, t.companyFinance.reason]} isEmpty={!detail.data.events.length} empty={a.noEvidence}>{detail.data.events.map(event => <tr key={event.id}><td className="num px-3 py-2">{event.version}</td><td className="px-3 py-2">{event.reason}</td></tr>)}</Table></> : <Pending error={detail.error} loadingLabel={t.common.loading} errorLabel={explainError(detail.error, t)} onRetry={detail.load} retryLabel={t.common.retry} />}
    </details>
  </div>
}
