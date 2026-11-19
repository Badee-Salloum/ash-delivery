import { useRef, useState, type ReactNode } from 'react'
import { addDays, parseMinor } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { Button, Money } from '../ui.tsx'
import { FinanceActionForm, type FormField } from './CompanyFinanceReview.tsx'
import { MotorPaymentsPanel, motorSchedulePreview } from './CompanyMotorPayments.tsx'
import type { ExistingAssetVehicle, WireExistingAsset } from './CompanyExistingAssets.tsx'
import type { Mutate } from './CompanyFund.tsx'

export type MotorPurchasePaymentState = 'paid' | 'partial' | 'unpaid' | 'unknown'
export function motorRegistrationNextTab(state: MotorPurchasePaymentState): 'payments' | 'schedule' {
  return state === 'unpaid' ? 'schedule' : 'payments'
}

/** A card and payment evidence are different saves. Never fabricate a cash entry from a checkbox. */
export function MotorRegistration({ fields, vehicles, mutate, busy, refresh, onClose }: {
  fields: FormField[]; vehicles: ExistingAssetVehicle[]; mutate: Mutate; busy: boolean; refresh: () => void; onClose: () => void
}): ReactNode {
  const { t, session } = useApp(), p = t.motorPayments
  const response = useRef<WireExistingAsset | null>(null)
  const [saved, setSaved] = useState<{ card: WireExistingAsset; values: Record<string, string> } | null>(null)
  const [revision, setRevision] = useState(0)
  const registrationFields: FormField[] = [
    ...fields.filter(field => field.key !== 'price' && field.key !== 'currency').map(field => field.key === 'vehicleId' ? { ...field, section: p.vehicleDetails, options: [{ value: '', label: '—' }, ...vehicles.map(vehicle => ({ value: vehicle.id, label: vehicle.groundNo || vehicle.code }))] } : { ...field, advanced: field.key !== 'useStartedOn' }),
    ...fields.filter(field => field.key === 'price' || field.key === 'currency').map(field => field.key === 'price' ? { ...field, section: p.priceDetails, label: p.fullPrice, optional: false } : field),
    { key: 'paymentState', section: p.paymentDetails, label: p.purchasePaymentState, options: [
      { value: '', label: '—' }, { value: 'paid', label: p.fullyPaid }, { value: 'partial', label: p.partiallyPaid },
      { value: 'unpaid', label: p.unpaid }, { value: 'unknown', label: p.documentLater },
    ] },
    { key: 'paymentMode', label: p.mode, value: 'existing', visibleWhen: { key: 'paymentState', value: ['paid', 'partial'] },
      options: [{ value: 'existing', label: p.existing }, { value: 'new', label: p.addAsExpense }] },
    { key: 'supplier', section: p.schedule, label: p.supplier, visibleWhen: { key: 'paymentState', value: 'unpaid' } },
    { key: 'installmentAmount', label: p.installment, type: 'money', visibleWhen: { key: 'paymentState', value: 'unpaid' } },
    { key: 'firstDueOn', label: p.firstDue, type: 'date', allowFuture: true,
      value: session?.businessDate ? addDays(session.businessDate, 1) : '', visibleWhen: { key: 'paymentState', value: 'unpaid' } },
    { key: 'recurrence', label: p.recurrence, value: 'monthly', visibleWhen: { key: 'paymentState', value: 'unpaid' },
      options: [{ value: 'monthly', label: p.monthly }, { value: 'weekly', label: p.weekly }] },
    { key: 'reminderDays', label: p.reminderDays, type: 'number', value: '3', visibleWhen: { key: 'paymentState', value: 'unpaid' } },
  ]
  const capture: Mutate = (operation, message, onAttempt) => mutate(async () => {
    const result = await operation() as { asset: WireExistingAsset }
    response.current = result.asset
    return result
  }, message, onAttempt)
  const update = (): void => { setRevision(value => value + 1); refresh() }
  if (saved) return <div data-motor-registration-followup>
    <p className="mb-2 font-semibold">{p.cardSavedNext}</p>
    <p className="mb-3 text-label text-ink-muted">{saved.values.paymentState === 'unpaid' ? p.confirmScheduleNext : saved.values.paymentState === 'paid' ? p.confirmFullPaymentNext : p.confirmPartialPaymentNext}</p>
    <MotorPaymentsPanel card={saved.card} mutate={mutate} refresh={update} revision={revision} busy={busy}
      initialTab={motorRegistrationNextTab(saved.values.paymentState as MotorPurchasePaymentState)}
      initialMode={saved.values.paymentMode === 'new' && saved.values.paymentState !== 'unpaid' ? 'new' : 'existing'}
      initialAmount={saved.values.paymentState === 'paid' ? saved.card.price ?? '' : ''}
      initialSchedule={saved.values.paymentState === 'unpaid' ? saved.values : {}} />
    <Button variant="ghost" className="mt-3" onClick={onClose}>{p.finishRegistration}</Button>
  </div>
  if (!vehicles.length) return <p role="status">{t.existingAssetReview.noAvailable}</p>
  return <div data-motor-registration>
    <p className="mb-2 font-semibold">{p.registrationSteps}</p>
    <p className="mb-3 text-label text-ink-muted">{p.registrationHint}</p>
    <FinanceActionForm path="/company/existing-assets" storageScope="purchase-flow" fields={registrationFields} mutate={capture}
      title={p.saveCardContinue} validate={values => {
        try { if (parseMinor(values.price ?? '') <= 0n) return t.financeReview.invalidAmount } catch { return t.financeReview.invalidAmount }
        if (values.paymentState === 'unpaid' && (!motorSchedulePreview(values.price ?? null, values) || !Number.isInteger(Number(values.reminderDays)) || Number(values.reminderDays) < 0 || Number(values.reminderDays) > 30)) return t.errors.asset_payment_invalid_schedule
        return null
      }} build={values => {
        const vehicle = vehicles.find(row => row.id === values.vehicleId)
        // Payment declarations and schedule inputs are not part of the neutral registration API.
        return { vehicleId: values.vehicleId, name: vehicle?.groundNo || vehicle?.code || '', currency: values.currency,
          price: values.price, purchasedOn: values.purchasedOn || null, useStartedOn: values.useStartedOn || null,
          fundingSource: values.fundingSource, description: values.description || '' }
      }} onSaved={values => {
        refresh()
        if (values.paymentState === 'unknown') { onClose(); return }
        if (response.current) setSaved({ card: response.current, values: { ...values } })
      }} preview={values => <>
        <p>{t.financeReview.noCashEffect}</p><p>{vehicles.find(row => row.id === values.vehicleId)?.code}</p>
        <Money value={values.price ?? ''} currency={values.currency === 'USD' ? 'USD' : 'SYP_NEW'} />
        <p>{values.paymentState === 'unpaid' ? p.confirmScheduleNext : values.paymentState === 'paid' ? p.confirmFullPaymentNext : values.paymentState === 'partial' ? p.confirmPartialPaymentNext : p.documentLater}</p>
        {values.paymentState === 'unpaid' ? <p>{p.count}: {motorSchedulePreview(values.price ?? null, values)?.count} · {p.firstDue}: <bdi>{values.firstDueOn}</bdi></p> : null}
      </>} />
  </div>
}
