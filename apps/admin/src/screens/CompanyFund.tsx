import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { exchangeRate, formatMinor, isCalendarDate, money, minor, monthEndFor, parseMinor, sypToUsdMinor, type Currency, usdToSypMinor } from '@ash/domain'
import type { CompanyHistoricalDraft, HistoricalDraftPayload } from '../company-historical-draft.ts'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { useConfirm, useTextPrompt } from '../feedback.tsx'
import { pendingAfterAttempt, pendingMoneyMove, uncertainMoneyMoveOutcome, type PendingMoneyMove } from '../money-move-idempotency.ts'
import { companyJournalBranch, companyJournalCash, type CompanyJournalDisplayLine } from '../company-journal-display.ts'
import { companyReportCsv, companyReportSummaryCsv, companyReportRows, companyReportTotals, type CompanyReport, type CompanyReportView, type CompanyReportDateBasis } from '../company-report.ts'
import type { RouteParams } from '../route.ts'
import { Button, Card, DateField, Field, FinancePagination, Money, MoneyInput, Pending, Select, Stat, Table, TextInput } from '../ui.tsx'
import { AssetInstallmentPanel, InstallmentPlanFields, installmentPlanPayload, newInstallmentPlanDraft, type InstallmentPlanDraft } from './AssetInstallments.tsx'
import { CompanyOwnerPanel, ExistingAssetsPanel, ExpenseCorrectionDrafts, ExpenseCorrectionPanel, FinanceActionForm, FinanceDialog, RestorationReviewPanel, useResource } from './CompanyFinanceReview.tsx'
import { CompanyBranchTransfer } from './CompanyBranchTransfer.tsx'
import { CompanyHistoricalImportRegister } from './CompanyHistoricalImportRegister.tsx'
import { CompanyHistoricalSourceCorrection } from './CompanyHistoricalSourceCorrection.tsx'
import { newestFinancialRows, visibleCompanyMovement, type ExpenseDeleteTarget } from '../company-expense-list.ts'
import { useExpenseDelete } from './use-expense-delete.ts'
import { CompanyOperationEditor } from './CompanyOperationEditor.tsx'
import { CompanyFinanceOverview } from './CompanyFinanceOverview.tsx'
import { CompanyFinanceFilters, defaultFinanceFilters, downloadFinanceRows, filterFinanceRows, financeRowTotals, type FinanceFilterRow } from './CompanyFinanceFilters.tsx'

type Tab = 'overview' | 'movements' | 'assets' | 'commitments' | 'reports'
type HistoricalMovementKind = 'deposit' | 'withdrawal' | 'expense' | 'income' | 'exchange'
type HistoricalMovementFilterKind = HistoricalMovementKind | 'reversal'

interface CategoryOption {
  id: string
  nameAr: string
  code: string
  active: boolean
}

export interface Overview {
  pockets: Record<Currency, string>
  reserves: Record<Currency, string>
  period: Record<Currency, { income: string; expense: string; deposits: string; withdrawals: string; net: string; companyFundedExpense?: string; ownerOutsideExpense?: string; otherBookExpense?: string }>
  branches: Array<{ branchId: string; nameAr?: string; nameEn?: string; companyBox: string; clearing: string; balanced: boolean; cutOver?: boolean; totalDifference?: string; pendingRestorationDifference?: string; historicalSettlementDifference?: string; unexplainedDifference?: string; pendingReviewCount?: number; unlinkedHistoricalCount?: number; confirmedVarianceCount?: number; pendingToCompany?: string; pendingFromCompany?: string; settlementStatus?: 'not_linked' | 'matched' | 'waiting_review' | 'variance' }>
}

export interface Movement {
  originalCommand?: { id: string; createdAtMs?: number } | null
  corrected?: boolean
  reversed?: boolean
  metadata?: { occurredPrecision: 'day' | 'month'; occurredMonth: string | null; rateBasis: 'documented' | 'estimated' | null; receiptReference: string | null }
  entry: {
    id: number
    businessDate: string
    createdAtMs?: number
    eventType: string
    reason: string | null
    sypMinorPerUsd: string | null
    /** Non-null only for an audited historical company-fund movement. */
    externalReference?: string | null
    lines?: CompanyJournalDisplayLine[]
  }
  /** The company-pocket balance after this entry, supplied by the historical register. */
  pocketAfter?: Partial<Record<Currency, string>>
  command: null | {
    id: string
    kind: string
    occurredOn?: string
    createdAtMs?: number
    businessDate?: string
    currency?: Currency
    amount?: string
    fromCurrency?: Currency
    fromAmount?: string
    toCurrency?: Currency
    toAmount?: string
    sypMinorPerUsd?: string | null
    reason?: string
    description?: string
    categoryId?: string
    targetId?: string
    targetKind?: string
    paidFrom?: 'pocket' | 'reserve' | 'owner_outside' | 'owner_custody'
    occurredPrecision?: 'day' | 'month'
    occurredMonth?: string | null
  }
}

interface HistoricalPreflight {
  pockets: Record<Currency, string>
  /** The server's zero-balance guard for the first historical entry. */
  canStart: boolean
  postingEnabled?: boolean
}

interface Debt {
  id: string
  direction: 'payable' | 'receivable'
  partyName: string
  currency: Currency
  principal: string
  outstanding: string
  openedOn: string
  dueOn: string | null
}

export interface Asset {
  id: string
  kind: 'vehicle' | 'equipment' | 'property' | 'other'
  name: string
  currency: Currency
  price: string
  purchasedOn: string
  bookValue: string
  outstanding: string
  depreciationDue: string
  debtId: string | null
  installmentPlans: AssetInstallmentPlan[]
  activeInstallmentPlan: AssetInstallmentPlan | null
}

type InstallmentPaidFrom = 'pocket' | 'reserve' | 'owner_outside' | 'owner_custody'
type InstallmentScheduleKind = 'weekly' | 'monthly_first' | 'every_n_days'

export interface AssetInstallmentPlan {
  id: string
  assetId: string
  debtId: string
  currency: Currency
  amount: string
  paidFrom: InstallmentPaidFrom
  scheduleKind: InstallmentScheduleKind
  weekday: number | null
  intervalDays: number | null
  startsOn: string
  active: boolean
  deactivatedOn: string | null
  deactivationReason: string | null
}

export interface AssetInstallmentDue extends AssetInstallmentPlan {
  assetName: string
  dueDate: string
  status: 'overdue' | 'today' | 'upcoming' | 'later'
  amountDue: string
}

export interface AssetInstallmentDueFeed {
  today: string
  from: string
  to: string
  olderUnresolved: number
  due: AssetInstallmentDue[]
}

interface DepreciationPlan {
  asOfMonth: string
  currencies: Record<Currency, {
    totalDue: string
    transferAmount: string
    remainingDue: string
    allocations: Array<{ assetId: string; period: number; amount: string }>
  }>
}

interface RecurringTemplate {
  id: string
  title: string
  categoryId: string
  currency: Currency
  paidFrom: 'pocket' | 'reserve' | 'owner_outside'
  amount: string
  scheduleKind: 'weekly' | 'monthly_first' | 'every_n_days'
  weekday: number | null
  intervalDays: number | null
  startsOn: string
  endsOn: string | null
  active: boolean
}

interface RecurringDue extends RecurringTemplate {
  dueDate: string
  status: 'overdue' | 'today' | 'upcoming' | 'later'
}

interface VehicleOption {
  id: string
  code: string
  groundNo?: string | null
}

interface VehicleTypeOption {
  id: string
  nameAr: string
  nameEn: string
  typeNo: number
  active: boolean
}

interface CompanyData {
  movements: Movement[]
  debts: Debt[]
  assets: Asset[]
  depreciation: DepreciationPlan | null
  vehicles: VehicleOption[]
  recurring: RecurringTemplate[]
  recurringDue: RecurringDue[]
  installmentDue: AssetInstallmentDueFeed | null
  categories: CategoryOption[]
  incomeCategories: CategoryOption[]
}

const tabs: readonly Tab[] = ['overview', 'movements', 'assets', 'commitments', 'reports']

type ExchangeField = 'fromAmount' | 'toAmount' | 'rate'

export interface ExchangeFormValues {
  fromCurrency: Currency
  toCurrency: Currency
  fromAmount: string
  toAmount: string
  /** Ordinary SYP per USD, rendered from the stored minor-unit rate. */
  rate: string
}

const exchangeFields: readonly ExchangeField[] = ['fromAmount', 'toAmount', 'rate']

interface ExchangeCalculation {
  sourceA: ExchangeField
  sourceB: ExchangeField
  derived: ExchangeField
}

function positiveExchangeMoney(value: string): ReturnType<typeof parseMinor> | null {
  try {
    const amount = parseMinor(value)
    return amount > 0n ? amount : null
  } catch {
    return null
  }
}

function previewFxDay(rate: bigint) {
  return { businessDate: '2000-01-01', sypMinorPerUsd: rate, provisional: false }
}

/**
 * Derive exactly one of the three exchange values using integer minor units. This is a preview
 * only: the server still freezes the rate it derives from the two actual amounts it posts.
 */
export function deriveExchangeField(values: ExchangeFormValues, derived: ExchangeField): string | null {
  if (values.fromCurrency === values.toCurrency) return null
  const from = positiveExchangeMoney(values.fromAmount)
  const to = positiveExchangeMoney(values.toAmount)
  const rate = positiveExchangeMoney(values.rate)

  try {
    if (derived === 'fromAmount') {
      if (to === null || rate === null) return null
      return formatMinor(values.fromCurrency === 'SYP_NEW'
        ? usdToSypMinor(to, rate)
        : sypToUsdMinor(to, previewFxDay(rate)))
    }
    if (derived === 'toAmount') {
      if (from === null || rate === null) return null
      return formatMinor(values.toCurrency === 'SYP_NEW'
        ? usdToSypMinor(from, rate)
        : sypToUsdMinor(from, previewFxDay(rate)))
    }
    if (from === null || to === null) return null
    return formatMinor(minor(exchangeRate(money(values.fromCurrency, from), money(values.toCurrency, to))))
  } catch {
    return null
  }
}

function thirdExchangeField(first: ExchangeField, second: ExchangeField): ExchangeField | null {
  return exchangeFields.find((field) => field !== first && field !== second) ?? null
}

function nextExchangeCalculation(
  current: ExchangeCalculation | null,
  changed: ExchangeField,
  values: ExchangeFormValues,
): ExchangeCalculation | null {
  if (positiveExchangeMoney(values[changed]) === null) return null
  if (current !== null) {
    if (changed === current.derived && positiveExchangeMoney(values[current.sourceA]) !== null) {
      const derived = thirdExchangeField(current.sourceA, changed)
      if (derived !== null) return { sourceA: current.sourceA, sourceB: changed, derived }
    }
    if (
      (changed === current.sourceA || changed === current.sourceB) &&
      positiveExchangeMoney(values[current.sourceA]) !== null &&
      positiveExchangeMoney(values[current.sourceB]) !== null
    ) return current
  }
  const other = exchangeFields.find((field) => field !== changed && positiveExchangeMoney(values[field]) !== null)
  const derived = other === undefined ? null : thirdExchangeField(other, changed)
  return other === undefined || derived === null ? null : { sourceA: other, sourceB: changed, derived }
}

function normalizedFrozenRate(rate: string | null | undefined): string | null {
  if (rate === null || rate === undefined) return null
  try {
    return /^\d+$/.test(rate) ? formatMinor(minor(BigInt(rate))) : null
  } catch {
    return null
  }
}

export function CompanyFund({ initial = {} }: { initial?: RouteParams }): ReactNode {
  const { api, session, t, branchId } = useApp()
  const today = session?.businessDate ?? ''
  const month = today === '' ? '' : `${today.slice(0, 7)}-01`
  const visibleTabs = tabs
  const [tab, setTab] = useState<Tab>(() => initial.tab === 'historical' || initial.tab === 'review' ? 'movements' : initial.tab === 'debts' || initial.tab === 'recurring' ? 'commitments' : initial.tab === 'depreciation' ? 'assets' : tabs.includes(initial.tab as Tab) ? initial.tab as Tab : 'overview')
  const [operationMode, setOperationMode] = useState<'ledger' | 'entry' | 'review'>(initial.tab === 'review' ? 'review' : 'ledger')
  const [reviewBranch, setReviewBranch] = useState<string | undefined>(undefined)
  const [assetMode, setAssetMode] = useState<'existing' | 'purchase' | 'reserve'>(initial.tab === 'depreciation' ? 'reserve' : 'existing')
  const [commitmentMode, setCommitmentMode] = useState<'debts' | 'recurring'>(initial.tab === 'recurring' ? 'recurring' : 'debts')
  const [correctionTarget, setCorrectionTarget] = useState<string | null>(null)
  const [historicalCorrection, setHistoricalCorrection] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [storedData, setData] = useState<CompanyData | null>(null)
  const dataScope = [branchId, today, tab, operationMode, assetMode, commitmentMode, correctionTarget].join(':')
  const [loadedScope, setLoadedScope] = useState('')
  const data = loadedScope === dataScope ? storedData : null
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const readSequence = useRef(0)

  const load = useCallback(() => {
    const sequence = ++readSequence.current
    if (branchId === null) return
    setError(null)
    const range = `from=2000-01-01&to=${encodeURIComponent(today)}`
    const operations = tab === 'movements', entry = operations && operationMode === 'entry'
    const purchase = tab === 'assets' && assetMode === 'purchase', depreciationRead = tab === 'assets' && assetMode === 'reserve'
    const debtsRead = tab === 'commitments' && commitmentMode === 'debts', recurringRead = tab === 'commitments' && commitmentMode === 'recurring'
    // The archived source register owns its lazy read. Retired historical-entry/preflight reads
    // are not needed here and must never delay or fail the current ledger after a deletion.
    void Promise.all([
      operations ? api.get<{ movements: Movement[]; effectiveMovements?: Movement[] }>(`/company/movements?${range}`) : Promise.resolve({ movements: [] } as { movements: Movement[]; effectiveMovements?: Movement[] }),
      debtsRead ? api.get<{ debts: Debt[] }>('/company/debts') : Promise.resolve({ debts: [] }),
      purchase ? api.get<{ assets: Asset[] }>('/company/assets') : Promise.resolve({ assets: [] }),
      depreciationRead ? api.get<DepreciationPlan>(`/company/depreciation?asOfMonth=${encodeURIComponent(month)}`) : Promise.resolve(null),
      purchase ? api.get<{ vehicles: VehicleOption[] }>('/vehicles') : Promise.resolve({ vehicles: [] }),
      recurringRead ? api.get<{ templates: RecurringTemplate[] }>('/company/recurring-expenses?includeInactive=true') : Promise.resolve({ templates: [] }),
      recurringRead ? api.get<{ due: RecurringDue[] }>('/company/recurring-expenses/due') : Promise.resolve({ due: [] }),
      purchase ? api.get<AssetInstallmentDueFeed>('/company/assets/installment-plans/due') : Promise.resolve(null),
      operations || recurringRead || correctionTarget ? api.expenseCategories() : Promise.resolve({ categories: [] }),
      entry ? api.incomeCategories() : Promise.resolve({ categories: [] }),
    ]).then(([
      movements, debts, assets, depreciation, vehicles, recurring, recurringDue, installmentDue,
      categories, incomeCategories,
    ]) => {
      if (sequence !== readSequence.current) return
      setLoadedScope(dataScope)
      setData({
        movements: movements.effectiveMovements ?? movements.movements, debts: debts.debts, assets: assets.assets,
        depreciation, vehicles: vehicles.vehicles, recurring: recurring.templates,
        recurringDue: recurringDue.due, installmentDue, categories: categories.categories,
        incomeCategories: incomeCategories.categories,
      })
    }).catch((cause: { error?: string }) => {
      if (sequence !== readSequence.current) return
      setData(null)
      setError(cause.error ?? 'error')
    })
  }, [api, branchId, month, today, tab, operationMode, assetMode, commitmentMode, correctionTarget, dataScope])

  useEffect(() => {
    // Company finance is global, but its vehicle picker is branch-scoped. Blank the prior branch
    // while the next read is in flight so an old vehicle can never be submitted under a new branch.
    setData(null)
    setNotice(null)
    load()
    return () => { readSequence.current++ }
  }, [load])

  useEffect(() => {
    if (!visibleTabs.includes(tab)) setTab('overview')
  }, [tab, visibleTabs])

  const mutate = async (
    operation: () => Promise<unknown>,
    success: string,
    onAttempt?: (outcome: MutationOutcome) => void,
  ): Promise<boolean> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await operation()
      onAttempt?.({ ok: true })
      setNotice(success)
      setRevision(value => value + 1)
      load()
      return true
    } catch (cause) {
      const code = (cause as { error?: string }).error
      onAttempt?.({ ok: false, error: code, status: (cause as { status?: number }).status })
      setError(code ?? 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  const deleteExpense = useExpenseDelete(mutate)
  const [editingOperation, setEditingOperation] = useState<Movement | null>(null)
  const operationConfirm = useConfirm()
  const operationDeletes = useRef(new Map<string, { idempotencyKey: string; expectedEntryId: number; action: 'delete'; reason: string }>())
  const deletingOperation = useRef(false)
  const deleteOperation = async (movement: Movement): Promise<void> => {
    if (!movement.command || deletingOperation.current) return
    deletingOperation.current = true
    try {
      const command = movement.command
      if (!await operationConfirm({ title: t.financeReview.deleteOperation, body: `${command.description ?? command.reason ?? ''}\n${t.financeReview.operationDeleteHint}`, confirmLabel: t.financeReview.deleteOperation, danger: true })) return
      const key = `${session?.userId}:${command.id}`
      const request = operationDeletes.current.get(key) ?? { idempotencyKey: crypto.randomUUID(), expectedEntryId: movement.entry.id, action: 'delete' as const, reason: 'Operation deleted after explicit user confirmation' }
      operationDeletes.current.set(key, request)
      await mutate(() => api.post(`/company/operations/${command.id}/actions`, request), t.financeReview.operationDeleted,
        outcome => { if (!uncertainMoneyMoveOutcome(outcome)) operationDeletes.current.delete(key) })
    } finally { deletingOperation.current = false }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-ink-muted">{t.companyFinance.subtitle}</p>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t.companyFinance.title}>
        {visibleTabs.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            onClick={() => { setTab(item); setCorrectionTarget(null); setHistoricalCorrection(null) }}
            className={`min-h-10 rounded-lg border px-3 text-body font-semibold ${
              tab === item ? 'border-brand bg-brand text-on-brand' : 'border-line-strong bg-surface-card text-ink hover:bg-surface-muted'
            }`}
          >
            {item === 'commitments' ? t.financeReview.commitments : item === 'reports' ? t.financeReview.reports : item === 'movements' ? t.financeReview.operations : t.companyFinance.tabs[item]}
          </button>
        ))}
      </div>
      {error ? <p role="alert" className="text-body font-medium text-danger-ink">{explainError(error, t)}</p> : null}
      {notice ? <p role="status" className="text-body font-medium text-success-ink">{notice}</p> : null}
      {tab === 'overview' ? <><Button className="self-start" onClick={() => { setTab('movements'); setOperationMode('entry') }}>{t.financeReview.entry}</Button><CompanyFinanceOverview today={today} revision={revision} mutate={mutate} matching={overview => <OverviewTab data={overview} mutate={mutate} onReview={id => { setReviewBranch(id); setTab('movements'); setOperationMode('review') }} />} /></> : null}
      {data === null && (tab === 'movements' || tab === 'commitments' || tab === 'assets' && assetMode !== 'existing') ? <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={load} retryLabel={t.common.retry} /> : null}
      {tab === 'movements' && data ? <>
        <div className="flex flex-wrap gap-2">
          <Button variant={operationMode === 'ledger' ? 'primary' : 'ghost'} onClick={() => setOperationMode('ledger')}>{t.financeReview.ledger}</Button>
          <Button variant={operationMode === 'entry' ? 'primary' : 'ghost'} onClick={() => setOperationMode('entry')}>{t.financeReview.entry}</Button>
          <Button variant={operationMode === 'review' ? 'primary' : 'ghost'} onClick={() => { setReviewBranch(undefined); setOperationMode('review') }}>{t.financeReview.review}</Button>
        </div>
        {operationMode === 'ledger' ? <><MovementsTab rows={data.movements} categories={data.categories} onCorrect={setCorrectionTarget} onHistoricalCorrect={setHistoricalCorrection} onDelete={deleteExpense} onEditOperation={setEditingOperation} onDeleteOperation={deleteOperation} busy={busy} /><details><summary className="cursor-pointer text-brand">{t.financeReview.importRegisterTitle}</summary><div className="mt-3"><CompanyHistoricalImportRegister today={today} revision={revision} onCorrect={setHistoricalCorrection} onDelete={deleteExpense} busy={busy} /></div></details></> : null}
        {operationMode === 'entry' ? <CompanyEntryTab categories={data.categories} incomeCategories={data.incomeCategories} today={today} mutate={mutate} busy={busy} /> : null}
        {operationMode === 'review' ? <><RestorationReviewPanel mutate={mutate} revision={revision} {...(reviewBranch ? { branchId: reviewBranch } : {})} /><ExpenseCorrectionDrafts revision={revision} onReview={setCorrectionTarget} /><SavedHistoricalDrafts revision={revision} /></> : null}
        {historicalCorrection ? <CompanyHistoricalSourceCorrection sourceReference={historicalCorrection} mutate={mutate} onClose={() => setHistoricalCorrection(null)} /> : null}
      </> : null}
      {tab === 'assets' ? <><div className="flex flex-wrap gap-2"><Button variant={assetMode === 'existing' ? 'primary' : 'ghost'} onClick={() => setAssetMode('existing')}>{t.financeWorkspace.motorCards}</Button><Button variant={assetMode === 'purchase' ? 'primary' : 'ghost'} onClick={() => setAssetMode('purchase')}>{t.financeReview.archivePurchase}</Button><Button variant={assetMode === 'reserve' ? 'primary' : 'ghost'} onClick={() => setAssetMode('reserve')}>{t.companyFinance.depreciationTitle}</Button></div>
        {assetMode === 'existing' ? <ExistingAssetsPanel mutate={mutate} busy={busy} initialVehicleId={initial.vehicle} /> : assetMode === 'purchase' && data?.installmentDue ? <AssetsTab rows={data.assets} due={data.installmentDue} vehicles={data.vehicles} today={today} busy={busy} mutate={mutate} /> : data?.depreciation ? <DepreciationTab plan={data.depreciation} busy={busy} mutate={mutate} /> : null}</> : null}
      {tab === 'commitments' ? <><p className="text-body text-ink-muted">{t.financeWorkspace.dueHint}</p><div className="flex gap-2"><Button variant={commitmentMode === 'debts' ? 'primary' : 'ghost'} onClick={() => setCommitmentMode('debts')}>{t.companyFinance.debtsTitle}</Button><Button variant={commitmentMode === 'recurring' ? 'primary' : 'ghost'} onClick={() => setCommitmentMode('recurring')}>{t.companyFinance.tabs.recurring}</Button></div>{data ? commitmentMode === 'debts' ? <DebtsTab rows={[...data.debts].sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'))} today={today} busy={busy} mutate={mutate} /> : <RecurringTab rows={data.recurring} due={[...data.recurringDue].sort((a, b) => a.dueDate.localeCompare(b.dueDate))} categories={data.categories} today={today} busy={busy} mutate={mutate} /> : null}</> : null}
      {tab === 'reports' ? <CompanyReportsTab today={today} revision={revision} initial={initial} /> : null}
      {correctionTarget ? <FinanceDialog title={t.financeReview.correction} onClose={() => setCorrectionTarget(null)}>{data ? <ExpenseCorrectionPanel key={correctionTarget} targetId={correctionTarget} mutate={mutate} categories={data.categories} onClose={() => setCorrectionTarget(null)} /> : <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={load} retryLabel={t.common.retry} />}</FinanceDialog> : null}
      {editingOperation ? <FinanceDialog title={t.financeReview.edit} onClose={() => setEditingOperation(null)}><CompanyOperationEditor key={editingOperation.command!.id} movement={editingOperation} mutate={mutate} onSaved={() => setEditingOperation(null)} /></FinanceDialog> : null}
    </div>
  )
}

export type MutationOutcome = { ok: true } | { ok: false; error: string | undefined; status?: number | undefined }
export type Mutate = (
  operation: () => Promise<unknown>,
  success: string,
  onAttempt?: (outcome: MutationOutcome) => void,
) => Promise<boolean>

function CompanyReportMoney({ value, currency }: { value: string; currency: Currency }): ReactNode {
  return <bdi dir="ltr"><Money value={value} currency={currency} /></bdi>
}

/** Explicit read-only views; never mix a current event snapshot with immutable period journals. */
function CompanyReportsTab({ today, revision, initial = {} }: { today: string; revision: number; initial?: RouteParams }): ReactNode {
  const Money = CompanyReportMoney
  const { t, branches, lang } = useApp(), r = t.financeReview
  const linkedRange = initial.from && initial.to && isValidHistoricalDate(initial.from, today) && isValidHistoricalDate(initial.to, today) && initial.from <= initial.to
  const initialFrom = linkedRange ? initial.from! : `${today.slice(0, 7)}-01`, initialTo = linkedRange ? initial.to! : today
  const [period, setPeriod] = useState<'month' | 'previous' | 'all' | 'custom'>(linkedRange ? 'custom' : 'month')
  const [from, setFrom] = useState(initialFrom), [to, setTo] = useState(initialTo)
  const [view, setView] = useState<CompanyReportView>(initial.view ?? 'current_corrected'), [dateBasis, setDateBasis] = useState<CompanyReportDateBasis>(initial.dateBasis ?? 'occurrence')
  const w = t.financeWorkspace
  const [category, setCategory] = useState<string>(initial.report ?? 'cash'), [page, setPage] = useState(0)
  const [currencyFilter, setCurrencyFilter] = useState(''), [branchFilter, setBranchFilter] = useState(''), [direction, setDirection] = useState('')
  const [applied, setApplied] = useState({ from: initialFrom, to: initialTo, all: false, view, dateBasis })
  const valid = period === 'all' || isValidHistoricalDate(from, today) && isValidHistoricalDate(to, today) && from <= to
  const query = `${applied.all ? 'all=true' : `from=${encodeURIComponent(applied.from)}&to=${encodeURIComponent(applied.to)}`}&view=${applied.view}&dateBasis=${applied.dateBasis}`
  const resource = useResource<CompanyReport>(`/company/reports?${query}`, revision + Number(today.replaceAll('-', '')))
  const unchanged = valid && applied.view === view && applied.dateBasis === dateBasis && applied.all === (period === 'all') && (applied.all || applied.from === from && applied.to === to)
  const report = unchanged && resource.data?.view === view && resource.data.dateBasis === dateBasis && (applied.all || resource.data.from === applied.from && resource.data.to === applied.to) ? resource.data : null
  const reportDay = useRef(today), linkAccepted = useRef(Boolean(linkedRange))
  useEffect(() => {
    if (linkedRange && !linkAccepted.current) {
      // A Dashboard link can become valid when the authoritative session day refreshes.
      setPeriod('custom'); setFrom(initial.from!); setTo(initial.to!); setApplied({ from: initial.from!, to: initial.to!, all: false, view: initial.view ?? 'current_corrected', dateBasis: initial.dateBasis ?? 'occurrence' }); setPage(0)
    } else if (reportDay.current !== today && (period === 'month' || period === 'previous')) {
      const thisMonth = `${today.slice(0, 7)}-01`, year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7))
      const previousMonth = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
      const nextFrom = period === 'month' ? thisMonth : `${previousMonth}-01`, nextTo = period === 'month' ? today : monthEndFor(`${previousMonth}-01`)
      setFrom(nextFrom); setTo(nextTo); setPage(0)
      if (unchanged) setApplied({ from: nextFrom, to: nextTo, all: false, view, dateBasis })
    }
    reportDay.current = today; linkAccepted.current = Boolean(linkedRange)
  }, [today, linkedRange])
  const choosePeriod = (next: typeof period): void => {
    setPeriod(next); setPage(0)
    if (next === 'month') { setFrom(`${today.slice(0, 7)}-01`); setTo(today) }
    if (next === 'previous') { const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)); const previous = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`; setFrom(`${previous}-01`); setTo(monthEndFor(`${previous}-01`)) }
  }
  const reportRows = report?.view === 'current_corrected' ? report.rows.filter(row => !(row.kind === 'expense' && row.reversed)) : report?.rows ?? []
  const filteredRows = companyReportRows(reportRows, category, currencyFilter, branchFilter, direction)
  const rows = view === 'current_corrected' ? newestFinancialRows(filteredRows, row => row.occurredOn, row => row.originalEntryId ?? 0) : filteredRows
  const totals = companyReportTotals(rows, category === 'custody' ? 'company_custody' : 'company_cash')
  useEffect(() => setPage(0), [query, category, currencyFilter, branchFilter, direction, revision])
  const exportRows = (audit = false): void => {
    if (!report) return
    const filtered = { ...report, rows, detailCategory: category, filters: { currency: currencyFilter, branch: branchFilter, direction } }
    const csv = audit ? companyReportCsv({ ...report, rows, detailCategory: category, filters: filtered.filters }) : companyReportSummaryCsv(filtered, {
      from: t.companyFinance.from, to: t.companyFinance.to, date: t.companyFinance.occurredOn, kind: t.companyFinance.kind, branch: t.accounts.branch,
      description: t.companyFinance.description, source: r.source, currency: t.companyFinance.currency, receipts: r.cashReceipts, payments: r.cashPayments,
      income: t.companyFinance.periodIncome, expense: r.bookExpense, posting: r.reportLatestPosting, reference: t.companyFinance.auditReference,
      currencyFilter: t.companyFinance.currency, branchFilter: t.accounts.branch, directionFilter: t.companyFinance.direction,
    }, row => ({ kind: row.kind === 'company_historical_restoration_reclass' ? t.companyFinance.historicalKinds.historicalRestorationReclass : row.branchId ? row.lines.some(line => line.fundCode.startsWith('company_cash:') && line.side === 'D') ? w.received : w.paid : historicalKindLabel(row.kind, t.companyFinance.historicalKinds), branch: row.branchId ? branchName(row.branchId) : '—',
      source: row.source === 'owner_custody' ? t.financeWorkspace.ownerCustody : row.source === 'owner_outside' ? t.companyFinance.ownerOutside : row.source === 'reserve' ? t.companyFinance.reserve : row.source === 'pocket' ? t.companyFinance.pocket : row.branchId ? w.transfers : r.unknown }), currency => t.currency[currency])
    const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `company-finance-${audit ? 'audit' : 'summary'}-${view}-${dateBasis}-${report.from}-${report.to}-${category}.csv`; link.click(); URL.revokeObjectURL(url)
  }
  const branchName = (id: string): string => { const branch = branches.find(item => item.id === id); return branch ? lang === 'ar' ? branch.nameAr : branch.nameEn : r.unknown }
  return <div className="flex flex-col gap-4"><Card title={r.reports} subtitle={r.reportHint}>
    <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3"><Field label={w.reportType}><Select value={category} aria-label={w.reportType} onChange={event => { setCategory(event.target.value); setDirection(''); setBranchFilter(''); setCurrencyFilter('') }}><option value="cash">{w.cashReport}</option><option value="custody">{w.ownerCustody}</option><option value="branch">{w.transferReport}</option><option value="cost_income">{w.incomeExpenseReport}</option><option value="owner">{w.ownerReport}</option><option value="assets_debts">{r.reportAssetDebtPayments}</option><option value="all">{w.auditReport}</option></Select></Field>{category !== 'owner' ? <><Field label={t.companyFinance.currency}><Select value={currencyFilter} aria-label={t.companyFinance.currency} onChange={event => setCurrencyFilter(event.target.value)}><option value="">{r.allCurrencies}</option><option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option></Select></Field>{category === 'branch' ? <Field label={t.accounts.branch}><Select value={branchFilter} aria-label={t.accounts.branch} onChange={event => setBranchFilter(event.target.value)}><option value="">{w.allBranches}</option>{branches.filter(branch => branch.code !== 'HQ').map(branch => <option key={branch.id} value={branch.id}>{lang === 'ar' ? branch.nameAr : branch.nameEn}</option>)}</Select></Field> : null}</> : null}</div>
    <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label={r.reportPeriod}><Select value={period} onChange={event => choosePeriod(event.target.value as typeof period)} aria-label={r.reportPeriod}><option value="month">{r.thisMonth}</option><option value="previous">{r.previousMonth}</option><option value="all">{r.allPeriod}</option><option value="custom">{r.customPeriod}</option></Select></Field><div className="self-end"><Button disabled={!valid} onClick={() => { setApplied({ from, to, all: period === 'all', view, dateBasis }); setPage(0) }}>{r.showReport}</Button></div></div>
    {period === 'custom' ? <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><DateField label={t.companyFinance.from} value={from} onChange={setFrom} /><DateField label={t.companyFinance.to} value={to} onChange={setTo} /></div> : null}
    <details className="my-3 rounded-lg border border-line p-3"><summary className="cursor-pointer text-brand">{r.auditOptions}</summary><div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label={r.reportView}><Select value={view} onChange={event => setView(event.target.value as CompanyReportView)} aria-label={r.reportView}><option value="current_corrected">{r.currentCorrected}</option><option value="as_booked">{r.asBooked}</option></Select></Field><Field label={r.reportDateBasis}><Select value={dateBasis} onChange={event => setDateBasis(event.target.value as CompanyReportDateBasis)} aria-label={r.reportDateBasis}><option value="occurrence">{r.occurrenceDates}</option><option value="posting">{r.postingDates}</option></Select></Field></div><p className="mt-3 text-body text-ink-muted">{view === 'as_booked' ? dateBasis === 'posting' ? r.reportPostingBasis : r.reportRawOccurrenceBasis : r.currentReportBasis}</p></details>
    {!valid ? <p role="alert" className="text-danger-ink">{t.companyFinance.historicalInvalid}</p> : !unchanged ? <p role="status" className="text-ink-muted">{r.applyReportFilters}</p> : !report ? <Pending error={resource.error} loadingLabel={t.common.loading} errorLabel={explainError(resource.error, t)} onRetry={resource.load} retryLabel={t.common.retry} /> : <>
      {report.view === 'as_booked' ? <p role="status" className="mb-3 rounded-lg border border-warning-line bg-warning-surface p-3 text-warning-ink">{r.auditOnlyHint}</p> : null}
      <p className="mb-3 text-body text-ink-muted"><bdi>{report.from}</bdi> — <bdi>{report.to}</bdi> · {view === 'current_corrected' ? r.currentCorrected : r.asBooked} · {dateBasis === 'occurrence' ? r.occurrenceDates : r.postingDates} · {t.currency.SYP_NEW}</p>
      {category !== 'owner' && category !== 'cost_income' ? <><h3 className="mb-3 font-semibold">{category === 'custody' ? w.ownerCustody : category === 'branch' ? w.transfers : r.companyCashMovements}</h3><p className="mb-3 text-label text-ink-muted">{category === 'custody' ? w.custodyScope : `${w.reportScope} ${r.cashNetHint}`}</p><div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{(['SYP_NEW', 'USD'] as const).filter(currency => !currencyFilter || currencyFilter === currency).map(currency => <div key={currency} className="rounded-lg border border-line p-3" data-report-summary={currency}><p className="mb-3 font-semibold">{t.currency[currency]}</p><dl className="flex flex-col gap-3"><div><dt className="text-label text-ink-muted">{r.cashReceipts}</dt><dd className="text-figure font-bold"><Money value={totals[currency].cashReceipts ?? '0.00'} currency={currency} /></dd><Button variant="ghost" onClick={() => { setDirection('receipts'); setCurrencyFilter(currency) }}>{w.receiptDetails}</Button></div><div><dt className="text-label text-ink-muted">{r.cashPayments}</dt><dd className="text-figure font-bold"><Money value={totals[currency].cashPayments ?? '0.00'} currency={currency} /></dd><Button variant="ghost" onClick={() => { setDirection('payments'); setCurrencyFilter(currency) }}>{w.paymentDetails}</Button></div><div><dt className="text-label text-ink-muted">{category === 'custody' ? w.custodyNet : r.reportCashNet}</dt><dd className="text-figure font-bold"><Money value={totals[currency].cashNet} currency={currency} /></dd></div></dl></div>)}</div>{direction ? <Button variant="ghost" onClick={() => { setDirection(''); setCurrencyFilter('') }}>{w.resetDetails}</Button> : null}
      {(category === 'cash' ? report.cashBalances : category === 'custody' ? report.custodyBalances : null) ? <details className="mt-3"><summary className="cursor-pointer text-brand">{w.cashEquation}</summary><p className="my-3 text-label text-ink-muted">{w.periodBalances} {view === 'current_corrected' ? w.snapshotBalances : ''}</p>{(['SYP_NEW', 'USD'] as const).map(currency => <dl key={currency} className="my-3 flex flex-wrap gap-4"><div><dt>{w.opening}</dt><dd><Money value={(category === 'custody' ? report.custodyBalances! : report.cashBalances!)[currency].opening} currency={currency} /></dd></div><div><dt>{w.closing}</dt><dd><Money value={(category === 'custody' ? report.custodyBalances! : report.cashBalances!)[currency].closing} currency={currency} /></dd></div></dl>)}</details> : null}</> : null}
      {category !== 'owner' ? <details open={category === 'cost_income' || undefined} className="mt-4 rounded-lg border border-line p-3"><summary className="cursor-pointer text-brand">{r.costIncomeDetails}</summary><p className="my-3 text-label text-ink-muted">{r.reportNoReclassification}</p><div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{(['SYP_NEW', 'USD'] as const).filter(currency => !currencyFilter || currencyFilter === currency).map(currency => <dl key={currency} className="flex flex-col gap-2"><div><dt>{t.companyFinance.periodIncome}</dt><dd><Money value={totals[currency].income} currency={currency} /></dd><Button variant="ghost" onClick={() => { setDirection('income'); setCurrencyFilter(currency) }}>{w.incomeDetails}</Button></div><div><dt>{r.companyFundedExpense}</dt><dd><Money value={totals[currency].companyFundedExpense} currency={currency} /></dd><Button variant="ghost" onClick={() => { setDirection('expenses'); setCurrencyFilter(currency) }}>{w.expenseDetails}</Button></div><div><dt>{r.ownerExpenses}</dt><dd><Money value={totals[currency].ownerOutsideExpense} currency={currency} /></dd></div><div><dt>{r.otherBookExpense}</dt><dd><Money value={totals[currency].otherBookExpense} currency={currency} /></dd></div><div><dt>{view === 'as_booked' ? r.bookExpense : r.reportSnapshotExpense}</dt><dd><Money value={totals[currency].expense} currency={currency} /></dd></div></dl>)}</div></details> : null}
      {category === 'cost_income' && direction ? <Button variant="ghost" onClick={() => { setDirection(''); setCurrencyFilter('') }}>{w.resetDetails}</Button> : null}
      {report.occurrenceFallbackCount ? <p className="my-3 text-label text-warning-ink">{r.reportFallback.replace('{count}', String(report.occurrenceFallbackCount))}</p> : null}
      {report.journalOnlyCount ? <p className="my-3 text-label text-ink-muted">{r.reportJournalOnly.replace('{count}', String(report.journalOnlyCount))}</p> : null}
      {(category === 'branch' || category === 'all') && report.pendingRestorationCount ? <p className="my-3 text-label text-warning-ink">{r.pendingRestorations}: <bdi>{report.pendingRestorationCount}</bdi> · {r.pendingNotCash}</p> : null}
    </>}
  </Card>{report && category !== 'owner' ? <Card title={r.reportDetails}><div className="my-3 flex flex-wrap items-center justify-between gap-3"><p className="text-label text-ink-muted">{r.resultCount}: <bdi>{rows.length}</bdi> · {w.reportScope}</p><Button variant="ghost" disabled={!rows.length} onClick={() => exportRows()}>{r.export}</Button></div>
    <Table head={[t.companyFinance.occurredOn, t.companyFinance.kind, t.accounts.branch, { label: t.companyFinance.amount, numeric: true }, t.companyFinance.description, t.audit.details]} isEmpty={!rows.length} empty={r.reportNoRows}>{rows.slice(page * 20, page * 20 + 20).map(row => {
      const cashNet = row.lines.filter(line => line.fundCode.startsWith('company_cash:')).reduce((sum, line) => sum + parseMinor(line.netAmount) * (line.side === 'D' ? 1n : -1n), 0n)
      const kindLabel = row.kind === 'company_historical_restoration_reclass' ? t.companyFinance.historicalKinds.historicalRestorationReclass : row.branchId ? row.kind === 'company_opening_transfer' ? r.openingBranchTransfer : cashNet < 0n || row.source === 'from_company' ? r.fromCompany : r.toCompany : row.kind === 'company_historical_transfer' ? r.unclassifiedMovement : historicalKindLabel(row.kind, t.companyFinance.historicalKinds)
      return <tr key={row.id} data-company-report-row><td className="whitespace-nowrap px-3 py-2"><bdi>{row.occurredPrecision === 'month' ? row.occurredMonth : row.occurredOn}</bdi></td><td className="px-3 py-2">{kindLabel}{row.auditState ? <p className="text-label text-warning-ink">{row.auditState === 'deleted_expense' ? r.auditDeletedExpense : r.auditExpenseDeletion}</p> : null}{row.reversed ? <p className="text-label text-ink-muted">{t.companyFinance.historicalReversedLabel}</p> : null}</td><td className="px-3 py-2">{row.branchId ? branchName(row.branchId) : '—'}</td><td className="px-3 py-2">{row.currency && row.netAmount !== null && (!currencyFilter || row.currency === currencyFilter) ? <Money value={row.netAmount} currency={row.currency} /> : row.lines.filter(line => line.fundCode.startsWith(category === 'custody' ? 'company_custody:' : 'company_cash:')).map((line, index) => <p key={index}><Money value={formatMinor(minor(parseMinor(line.netAmount) * (line.side === 'D' ? 1n : -1n)))} currency={line.currency} /></p>)}</td><td className="px-3 py-2"><p className="line-clamp-2 break-words">{row.description || '—'}</p></td><td className="px-3 py-2">
      <details className="mt-3"><summary className="cursor-pointer text-brand">{t.audit.details}</summary><p className="my-3 break-words text-body">{row.description || '—'}</p><dl className="my-3 grid grid-cols-1 gap-2 sm:grid-cols-2"><div><dt>{r.reportOriginalPosting}</dt><dd><bdi>{row.postingDate}</bdi></dd></div><div><dt>{r.reportLatestPosting}</dt><dd><bdi>{row.latestPostingDate}</bdi></dd></div><div><dt>{t.companyFinance.auditReference}</dt><dd className="break-all"><bdi>{row.externalReference ?? '—'}</bdi></dd></div><div><dt>{t.companyFinance.rate}</dt><dd><bdi>{normalizedFrozenRate(row.sypMinorPerUsd) ?? '—'}</bdi> · {row.rateBasis === 'estimated' ? r.estimated : row.rateBasis === 'documented' ? r.documented : r.unknown}</dd></div><div><dt>{r.source}</dt><dd>{row.source === 'owner_custody' ? t.financeWorkspace.ownerCustody : row.source === 'owner_outside' ? t.companyFinance.ownerOutside : row.source === 'pocket' ? t.companyFinance.pocket : row.source === 'reserve' ? t.companyFinance.reserve : row.branchId ? kindLabel : r.unknown}</dd></div><div><dt>{r.correctionHistory}</dt><dd className="break-all"><bdi>{row.correctionIds.join(' · ') || '—'}</bdi></dd></div><div><dt>{r.reportVersion}</dt><dd>{row.version}</dd></div></dl>{row.occurrenceSource === 'posting_fallback' ? <p className="text-label text-warning-ink">{r.reportOccurrenceFallbackLabel}</p> : null}
      <Table head={[r.reportLineSide, t.companyFinance.currency, r.reportGross, r.reportNet]} isEmpty={!row.lines.length} empty={r.reportNoRows}>{row.lines.map((line, index) => <tr key={index}><td className="px-3 py-2"><span>{line.side === 'D' ? r.reportDebit : r.reportCredit}</span><p className="break-all text-label text-ink-muted"><bdi>{line.fundCode}</bdi></p></td><td className="px-3 py-2">{t.currency[line.currency]}</td><td className="px-3 py-2"><Money value={line.grossAmount} currency={line.currency} /></td><td className="px-3 py-2"><Money value={line.netAmount} currency={line.currency} /></td></tr>)}</Table></details></td></tr>
    })}</Table><FinancePagination page={page} total={rows.length} pageSize={20} onChange={setPage} /><p className="mt-3 text-label text-ink-muted">{w.summaryExportHint}</p><details className="mt-3"><summary className="cursor-pointer text-brand">{r.auditOptions}</summary><Button variant="ghost" disabled={!rows.length} onClick={() => exportRows(true)}>{w.auditExport}</Button><p className="mt-3 text-label text-ink-muted">{r.reportCsvHint}</p></details>
  </Card> : null}{report && category === 'owner' ? <><p className="text-label text-ink-muted">{r.ownerOccurrenceBasis}</p><CompanyOwnerPanel key={`${report.from}:${report.to}`} from={report.from} to={report.to} revision={revision} latest /></> : null}</div>
}
function CompanyEntryTab({ categories, incomeCategories, today, mutate, busy }: { categories: CategoryOption[]; incomeCategories: CategoryOption[]; today: string; mutate: Mutate; busy: boolean }): ReactNode {
  const { t } = useApp()
  const [kind, setKind] = useState<HistoricalMovementKind | 'branch_transfer'>('expense')
  const descriptions = kind === 'expense' || kind === 'income'
  const choices = (kind === 'expense' ? categories : incomeCategories).filter(row => row.active)
  const path = kind === 'expense' ? '/company/expenses' : kind === 'income' ? '/company/incomes' : kind === 'deposit' ? '/company/deposits' : '/company/withdrawals'
  return <div className="flex flex-col gap-4"><Card title={t.financeReview.entry}><Field label={t.companyFinance.kind}><Select value={kind} disabled={busy} onChange={event => setKind(event.target.value as HistoricalMovementKind | 'branch_transfer')} aria-label={t.companyFinance.kind}>{(['expense', 'income', 'deposit', 'withdrawal', 'exchange'] as const).map(value => <option key={value} value={value}>{historicalKindLabel(value, t.companyFinance.historicalKinds)}</option>)}<option value="branch_transfer">{t.financeReview.branchTransfer}</option></Select></Field>
    <p className="my-3 text-body text-ink-muted">{t.financeReview.entrySourceHint}</p>
    {kind === 'withdrawal' ? <p role="note" className="mb-3 rounded-lg border border-line bg-surface-muted p-3 text-body text-ink-secondary">{t.treasury.companyOwnerWithdrawalHint}</p> : null}
    {kind === 'exchange' || kind === 'branch_transfer' ? null : <FinanceActionForm key={kind} path={path} title={t.companyFinance.submit} mutate={mutate} fields={[
      ...(kind === 'expense' ? [{ key: 'paidFrom', label: t.financeReview.source, value: 'pocket', options: [{ value: 'pocket', label: t.companyFinance.pocket }, { value: 'owner_outside', label: t.companyFinance.ownerOutside }, { value: 'owner_custody', label: t.financeWorkspace.ownerCustody }] }] : []),
      { key: 'currency', label: t.companyFinance.currency, value: 'SYP_NEW', options: [{ value: 'SYP_NEW', label: t.currency.SYP_NEW }, { value: 'USD', label: t.currency.USD }] },
      { key: 'amount', label: t.companyFinance.amount, type: 'money' }, { key: 'occurredOn', label: t.companyFinance.occurredOn, type: 'date', value: today },
      { key: 'historicalRate', label: t.companyFinance.historicalRate, type: 'money', optional: true, visibleWhen: { key: 'currency', value: 'USD' } },
      ...(kind === 'expense' ? [{ key: 'rateBasis', label: t.financeReview.rateBasis, value: 'documented', visibleWhen: { key: 'currency', value: 'USD' }, options: [{ value: 'documented', label: t.financeReview.documented }, { value: 'estimated', label: t.financeReview.estimated }] }] : []),
      ...(descriptions ? [{ key: 'categoryId', label: t.expenses.category, options: [{ value: '', label: '—' }, ...choices.map(category => ({ value: category.id, label: category.nameAr }))] }] : []),
      { key: descriptions ? 'description' : 'reason', label: t.companyFinance.description },
    ]} build={values => ({ ...values, historicalRate: values.currency === 'USD' && values.historicalRate ? values.historicalRate : undefined,
      rateBasis: values.currency === 'USD' ? values.rateBasis : undefined,
      ...(kind === 'expense' ? { costCenterKind: 'general', vehicleId: null, assetId: null, receiptMediaId: null } : {}) })} preview={values => <><p>{historicalKindLabel(kind, t.companyFinance.historicalKinds)}</p><p>{values.paidFrom === 'owner_custody' ? t.financeWorkspace.ownerCustody : values.paidFrom === 'owner_outside' ? t.financeReview.ownerHint : t.companyFinance.pocket}</p><Money value={values.amount ?? ''} currency={values.currency as Currency} /><p>{values.occurredOn} · {t.companyFinance.postedOn}: {values.occurredOn}</p>{(values.occurredOn ?? today) < today ? <p className="text-warning-ink">{t.financeWorkspace.priorPeriodHint}</p> : null}<p>{values.description ?? values.reason}</p></>} />}
  </Card>{kind === 'exchange' ? <ExchangeCard busy={busy} mutate={mutate} /> : kind === 'branch_transfer' ? <CompanyBranchTransfer today={today} mutate={mutate} /> : null}</div>
}

function OverviewTab({ data, onReview, mutate }: { data: Overview; onReview: (branchId: string) => void; mutate: Mutate }): ReactNode {
  const { t, branches, lang } = useApp(), r = t.financeReview
  const [linking, setLinking] = useState<string | null>(null)
  const linkBranch = data.branches.find(branch => branch.branchId === linking)
  return <div className="flex flex-col gap-4">
    <Card title={t.companyFinance.branches} subtitle={r.branchMatchingHint}>
      <Table head={[t.accounts.branch, r.companyInBranch, t.companyFinance.clearing, r.unexplainedDifference, t.accounts.status, t.companyFinance.action]} isEmpty={!data.branches.length} empty={t.companyFinance.noBranches}>
        {data.branches.map(branch => {
          const directory = branches.find(item => item.id === branch.branchId)
          const name = lang === 'ar' ? branch.nameAr ?? directory?.nameAr : branch.nameEn ?? directory?.nameEn ?? branch.nameAr
          const total = branch.totalDifference ?? formatMinor(minor(parseMinor(branch.companyBox) + parseMinor(branch.clearing)))
          const difference = branch.unexplainedDifference ?? (branch.pendingRestorationDifference !== undefined ? formatMinor(minor(parseMinor(total) - parseMinor(branch.pendingRestorationDifference))) : null)
          const notLinked = branch.settlementStatus === 'not_linked' || branch.cutOver === false || branch.cutOver === undefined && branch.settlementStatus === undefined
          const pending = branch.pendingReviewCount, variance = branch.confirmedVarianceCount, oldUnlinked = branch.unlinkedHistoricalCount
          return <tr key={branch.branchId}><td className="px-3 py-2 font-semibold">{name ?? r.unknown}</td><td className="px-3 py-2"><bdi><Money value={branch.companyBox} currency="SYP_NEW" /></bdi></td><td className="px-3 py-2"><bdi><Money value={branch.clearing} currency="SYP_NEW" /></bdi></td><td className="px-3 py-2">{difference === null ? r.unavailable : <bdi><Money value={difference} currency="SYP_NEW" /></bdi>}</td><td className="px-3 py-2"><div className="flex flex-col gap-1">
            {notLinked ? <span className="text-warning-ink">{r.branchNotLinked}</span> : difference !== null && parseMinor(difference) !== 0n ? <span className="text-danger-ink">{r.branchDifference}</span> : null}
            {pending !== undefined && pending > 0 ? <span className="text-warning-ink">{r.pending}: <bdi>{pending}</bdi></span> : null}
            {oldUnlinked !== undefined && oldUnlinked > 0 ? <span className="text-warning-ink">{r.unlinkedRestorations}: <bdi>{oldUnlinked}</bdi></span> : null}
            {variance !== undefined && variance > 0 ? <span className="text-warning-ink">{r.approvedVariances}: <bdi>{variance}</bdi></span> : null}
            {!notLinked && difference !== null && parseMinor(difference) === 0n && pending === 0 && variance === 0 && (oldUnlinked ?? 0) === 0 ? <span className="text-success-ink">{t.companyFinance.balanced}</span> : null}
            {pending === undefined ? <span className="text-label text-ink-muted">{r.reviewCountUnavailable}</span> : null}
          </div></td><td className="px-3 py-2"><Button variant="ghost" onClick={() => onReview(branch.branchId)}>{r.reviewAction}</Button><details className="mt-2"><summary className="cursor-pointer text-label text-brand">{t.audit.details}</summary><dl className="my-2 flex flex-col gap-2 text-body"><div><dt>{r.totalBookDifference}</dt><dd><bdi><Money value={total} currency="SYP_NEW" /></bdi></dd></div><div><dt>{r.restorationDifference}</dt><dd>{branch.pendingRestorationDifference !== undefined ? <bdi><Money value={branch.pendingRestorationDifference} currency="SYP_NEW" /></bdi> : r.unavailable}</dd></div>{branch.historicalSettlementDifference !== undefined ? <div><dt>{r.historicalSettlementDifference}</dt><dd><Money value={branch.historicalSettlementDifference} currency="SYP_NEW" /><p className="mt-2 text-label text-ink-muted">{r.historicalSettlementDifferenceHint}</p></dd></div> : null}<div><dt>{r.toCompany}</dt><dd>{branch.pendingToCompany !== undefined ? <bdi><Money value={branch.pendingToCompany} currency="SYP_NEW" /></bdi> : r.unavailable}</dd></div><div><dt>{r.fromCompany}</dt><dd>{branch.pendingFromCompany !== undefined ? <bdi><Money value={branch.pendingFromCompany} currency="SYP_NEW" /></bdi> : r.unavailable}</dd></div><div><dt>{r.pending}</dt><dd>{pending ?? r.unavailable}</dd></div><div><dt>{t.accounts.branch}</dt><dd className="break-all"><bdi>{branch.branchId}</bdi></dd></div></dl>{branch.cutOver === false ? <Button variant="ghost" onClick={() => setLinking(branch.branchId)}>{r.linkBranchOnly}</Button> : null}</details></td></tr>
        })}
      </Table>
    </Card>
    {linkBranch ? <FinanceDialog title={r.linkBranchOnly} onClose={() => setLinking(null)}><p className="mb-3 font-semibold">{linkBranch.nameAr ?? branches.find(branch => branch.id === linkBranch.branchId)?.nameAr ?? r.unknown}</p><p className="mb-3 text-body text-ink-muted">{r.linkBranchOnlyHint}</p><FinanceActionForm path="/company/cutover" storageScope={linkBranch.branchId} title={r.linkBranchOnly} fields={[{ key: 'reason', label: t.companyFinance.reason }]} mutate={mutate} onSaved={() => setLinking(null)} build={values => ({ branchId: linkBranch.branchId, expectedOpening: linkBranch.companyBox, reason: values.reason })} preview={values => <><p>{r.linkBranchOnlyHint}</p><p>{r.companyInBranch}: <Money value={linkBranch.companyBox} currency="SYP_NEW" /></p><p>{r.cashImpact}: <Money value="0.00" currency="SYP_NEW" /></p><p>{r.branchUnchanged}</p><p>{values.reason}</p></>} /></FinanceDialog> : null}
  </div>
}

function SavedHistoricalDrafts({ revision }: { revision: number }): ReactNode {
  const { t } = useApp()
  const feed = useResource<{ drafts: CompanyHistoricalDraft[] }>('/company/historical-drafts', revision)
  return <details><summary className="cursor-pointer text-brand">{t.financeReview.historicalDrafts}</summary><div className="mt-3">{!feed.data ? <Pending error={feed.error} loadingLabel={t.common.loading} errorLabel={explainError(feed.error, t)} onRetry={feed.load} retryLabel={t.common.retry} /> : <Table head={[t.companyFinance.date, t.companyFinance.description, t.accounts.status]} isEmpty={!feed.data.drafts.length} empty={t.financeReview.emptyReviews}>{feed.data.drafts.map(draft => <tr key={draft.id}><td className="whitespace-nowrap px-3 py-2"><bdi>{draft.payload.occurredPrecision === 'month' ? draft.payload.occurredMonth : draft.payload.occurredOn}</bdi></td><td className="px-3 py-2">{draft.payload.description}</td><td className="px-3 py-2">{t.financeReview.notPosted}</td></tr>)}</Table>}</div></details>
}
type ExchangeRequest = {
  idempotencyKey: string; fromCurrency: Currency; fromAmount: string
  toCurrency: Currency; toAmount: string; reason: string; occurredOn?: string
}

function readExchangeRequest(key: string): ExchangeRequest | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const request = value as Record<string, unknown>
    if (typeof request.idempotencyKey !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.idempotencyKey)
      || (request.fromCurrency !== 'SYP_NEW' && request.fromCurrency !== 'USD')
      || (request.toCurrency !== 'SYP_NEW' && request.toCurrency !== 'USD')
      || request.fromCurrency === request.toCurrency || typeof request.reason !== 'string' || !request.reason.trim()
      || typeof request.fromAmount !== 'string' || typeof request.toAmount !== 'string'
      || positiveExchangeMoney(request.fromAmount) === null || positiveExchangeMoney(request.toAmount) === null) return null
    if (request.occurredOn !== undefined && (typeof request.occurredOn !== 'string' || !isCalendarDate(request.occurredOn))) return null
    return { idempotencyKey: request.idempotencyKey, fromCurrency: request.fromCurrency, fromAmount: request.fromAmount, toCurrency: request.toCurrency, toAmount: request.toAmount, reason: request.reason,
      ...(typeof request.occurredOn === 'string' ? { occurredOn: request.occurredOn } : {}) }
  } catch { return null }
}

function ExchangeCard({ busy, mutate }: { busy: boolean; mutate: Mutate }): ReactNode {
  const { api, t, session } = useApp()
  const confirm = useConfirm()
  const pendingStorage = `ash.company-exchange-request:${session?.userId ?? ''}:HQ`
  const [unfinished, setUnfinished] = useState<ExchangeRequest | null>(() => readExchangeRequest(pendingStorage))
  const [fromCurrency, setFromCurrency] = useState<Currency>(unfinished?.fromCurrency ?? 'USD')
  const [toCurrency, setToCurrency] = useState<Currency>(unfinished?.toCurrency ?? 'SYP_NEW')
  const [exchange, setExchange] = useState<ExchangeFormValues>({
    fromCurrency, toCurrency, fromAmount: unfinished?.fromAmount ?? '', toAmount: unfinished?.toAmount ?? '',
    rate: unfinished ? deriveExchangeField({ ...unfinished, rate: '' }, 'rate') ?? '' : '',
  })
  const [calculation, setCalculation] = useState<ExchangeCalculation | null>(null)
  const [reason, setReason] = useState(unfinished?.reason ?? '')
  const [occurredOn, setOccurredOn] = useState(unfinished?.occurredOn ?? session?.businessDate ?? '')
  const [formError, setFormError] = useState<string | null>(null)
  const pendingExchange = useRef<PendingMoneyMove | null>(null)
  const disabled = busy || unfinished !== null

  const rememberRequest = (request: ExchangeRequest | null): void => {
    setUnfinished(request)
    try { if (request) sessionStorage.setItem(pendingStorage, JSON.stringify(request)); else sessionStorage.removeItem(pendingStorage) } catch { /* The exact request remains available in memory. */ }
  }

  const reset = (): void => {
    setExchange({ fromCurrency, toCurrency, fromAmount: '', toAmount: '', rate: '' })
    setCalculation(null)
    setReason('')
    setFormError(null)
  }

  const retryUnfinished = (): void => {
    if (!unfinished || busy) return
    void mutate(() => api.post('/company/exchanges', unfinished), t.companyFinance.exchangeSaved, outcome => {
      if (!uncertainMoneyMoveOutcome(outcome)) rememberRequest(null)
    }).then(saved => { if (saved) { pendingExchange.current = null; reset() } })
  }

  const changeCurrency = (side: 'from' | 'to', currency: Currency): void => {
    const nextFrom = side === 'from' ? currency : fromCurrency
    const nextTo = side === 'to' ? currency : toCurrency
    const normalizedFrom = nextFrom === nextTo && side === 'to'
      ? (nextTo === 'USD' ? 'SYP_NEW' : 'USD')
      : nextFrom
    const normalizedTo = normalizedFrom === nextTo
      ? (normalizedFrom === 'USD' ? 'SYP_NEW' : 'USD')
      : nextTo
    setFromCurrency(normalizedFrom)
    setToCurrency(normalizedTo)
    setExchange({ fromCurrency: normalizedFrom, toCurrency: normalizedTo, fromAmount: '', toAmount: '', rate: '' })
    setCalculation(null)
    setFormError(null)
  }

  const changeValue = (field: ExchangeField, value: string): void => {
    const next = { ...exchange, fromCurrency, toCurrency, [field]: value }
    const nextCalculation = nextExchangeCalculation(calculation, field, next)
    if (nextCalculation !== null) {
      const derived = deriveExchangeField(next, nextCalculation.derived)
      if (derived !== null) next[nextCalculation.derived] = derived
    }
    setExchange(next)
    setCalculation(nextCalculation)
    setFormError(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (disabled) return
    const values = { ...exchange, fromCurrency, toCurrency }
    const from = positiveExchangeMoney(values.fromAmount)
    const to = positiveExchangeMoney(values.toAmount)
    const frozenRate = deriveExchangeField(values, 'rate')
    if (from === null || to === null || frozenRate === null || reason.trim() === '' || !isCalendarDate(occurredOn) || occurredOn < '2000-01-01' || occurredOn > (session?.businessDate ?? '')) {
      setFormError(t.companyFinance.exchangeInvalid)
      return
    }
    const fromText = `${formatMinor(from)} ${t.currency[fromCurrency]}`
    const toText = `${formatMinor(to)} ${t.currency[toCurrency]}`
    const rateText = `${frozenRate} ${t.companyFinance.ratePerUsd}`
    void (async () => {
      const accepted = await confirm({
        title: t.companyFinance.exchangeConfirmTitle,
        body: t.companyFinance.exchangeConfirmBody
          .replace('{from}', fromText)
          .replace('{to}', toText)
          .replace('{rate}', rateText),
        confirmLabel: t.companyFinance.exchangeSubmit,
      })
      if (!accepted) return
      const details = { fromCurrency, fromAmount: formatMinor(from), toCurrency, toAmount: formatMinor(to), reason: reason.trim(), occurredOn }
      const operation = pendingMoneyMove(pendingExchange.current, { command: 'company_exchange', branchId: null, amount: `${details.fromAmount}:${details.toAmount}`, reason: details.reason, details })
      pendingExchange.current = operation
      const requestBody = { idempotencyKey: operation.idempotencyKey, ...details }
      rememberRequest(requestBody)
      const saved = await mutate(
        () => api.post('/company/exchanges', requestBody),
        t.companyFinance.exchangeSaved,
        outcome => { pendingExchange.current = pendingAfterAttempt(operation, outcome); if (!uncertainMoneyMoveOutcome(outcome)) rememberRequest(null) },
      )
      if (saved) reset()
    })()
  }

  return (
    <Card title={t.companyFinance.exchange} subtitle={t.companyFinance.exchangeHint}>
      {unfinished ? <div className="mb-3 rounded-lg border border-warning-line bg-warning-surface p-3 text-body text-warning-ink"><p role="alert">{t.financeReview.unknownAttempt}</p><p className="my-2"><bdi dir="ltr"><Money value={unfinished.fromAmount} currency={unfinished.fromCurrency} /> → <Money value={unfinished.toAmount} currency={unfinished.toCurrency} /></bdi></p><Button variant="ghost" disabled={busy} onClick={retryUnfinished}>{t.common.retry}</Button></div> : null}
      <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submit}>
        <Field label={t.companyFinance.occurredOn}><TextInput type="date" required min="2000-01-01" max={session?.businessDate} value={occurredOn} disabled={disabled} onChange={event => setOccurredOn(event.target.value)} aria-label={t.companyFinance.occurredOn} /></Field>
        <Field label={t.companyFinance.fromCurrency}>
          <Select value={fromCurrency} disabled={disabled} onChange={(event) => changeCurrency('from', event.target.value as Currency)} aria-label={t.companyFinance.fromCurrency}>
            <option value="SYP_NEW" disabled={toCurrency === 'SYP_NEW'}>{t.currency.SYP_NEW}</option>
            <option value="USD" disabled={toCurrency === 'USD'}>{t.currency.USD}</option>
          </Select>
        </Field>
        <Field label={t.companyFinance.toCurrency}>
          <Select value={toCurrency} disabled={disabled} onChange={(event) => changeCurrency('to', event.target.value as Currency)} aria-label={t.companyFinance.toCurrency}>
            <option value="SYP_NEW" disabled={fromCurrency === 'SYP_NEW'}>{t.currency.SYP_NEW}</option>
            <option value="USD" disabled={fromCurrency === 'USD'}>{t.currency.USD}</option>
          </Select>
        </Field>
        <Field label={t.companyFinance.fromAmount}>
          <MoneyInput required value={exchange.fromAmount} disabled={disabled} onChange={(event) => changeValue('fromAmount', event.target.value)} aria-label={t.companyFinance.fromAmount} />
        </Field>
        <Field label={t.companyFinance.toAmount}>
          <MoneyInput required value={exchange.toAmount} disabled={disabled} onChange={(event) => changeValue('toAmount', event.target.value)} aria-label={t.companyFinance.toAmount} />
        </Field>
        <Field label={t.companyFinance.exchangeRate} hint={t.companyFinance.ratePerUsd}>
          <MoneyInput required value={exchange.rate} disabled={disabled} onChange={(event) => changeValue('rate', event.target.value)} aria-label={t.companyFinance.exchangeRate} />
        </Field>
        <Field label={t.companyFinance.reason}>
          <TextInput required value={reason} disabled={disabled} onChange={(event) => { setReason(event.target.value); setFormError(null) }} aria-label={t.companyFinance.reason} />
        </Field>
        {formError ? <p role="alert" className="sm:col-span-2 text-label font-medium text-danger-ink">{formError}</p> : null}
        <Button type="submit" disabled={disabled} className="sm:col-span-2">{t.companyFinance.exchangeSubmit}</Button>
      </form>
    </Card>
  )
}

function MovementsTab({ rows, categories = [], onCorrect, onHistoricalCorrect, onDelete, onEditOperation, onDeleteOperation, busy }: { rows: Movement[]; categories?: CategoryOption[]; onCorrect?: (id: string) => void; onHistoricalCorrect?: (reference: string) => void; onDelete: (target: ExpenseDeleteTarget) => Promise<void>; onEditOperation: (movement: Movement) => void; onDeleteOperation: (movement: Movement) => Promise<void>; busy: boolean }): ReactNode {
  const { t, branches, lang, session } = useApp(), today = session?.businessDate ?? ''
  const [filters, setFilters] = useState(() => defaultFinanceFilters(today)), [page, setPage] = useState(0)
  const ledgerDay = useRef(today)
  useEffect(() => {
    if (ledgerDay.current !== today) {
      setFilters(current => {
        if (current.period === 'custom') return current
        if (current.period === 'all') return { ...current, to: today }
        if (current.period === 'month') return { ...current, from: `${today.slice(0, 7)}-01`, to: today }
        const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)), previous = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
        return { ...current, from: `${previous}-01`, to: monthEndFor(`${previous}-01`) }
      }); setPage(0); ledgerDay.current = today
    }
  }, [today])
  // Use the site's existing table-to-card breakpoint, with only one representation mounted.
  // Hidden duplicate tables/cards repeat amounts and correction buttons for assistive technology.
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(width < 40rem)').matches)
  useEffect(() => {
    const query = window.matchMedia('(width < 40rem)')
    const update = (): void => setMobile(query.matches)
    update(); query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const index = newestFinancialRows(rows.filter(visibleCompanyMovement), row => row.command?.occurredOn ?? row.entry.businessDate, row => row.entry.id,
    row => row.originalCommand?.createdAtMs ?? row.command?.createdAtMs ?? row.entry.createdAtMs).map<FinanceFilterRow & { movement: Movement }>(movement => {
    const command = movement.command, cash = companyJournalCash(movement.entry.lines), branch = companyJournalBranch(movement.entry.lines)
    const kind = command?.kind ?? (movement.entry.eventType === 'company_historical_restoration_reclass' ? movement.entry.eventType : branch ? 'branch_transfer' : movement.entry.eventType === 'company_historical_transfer' ? 'unclassified' : movement.entry.eventType)
    return { id: String(movement.entry.id), date: command?.occurredOn ?? movement.entry.businessDate, kind, source: command?.paidFrom ?? (movement.entry.eventType === 'company_custody_transfer' ? 'owner_custody' : branch ? 'branch' : ['deposit', 'withdrawal', 'income', 'exchange'].includes(kind) ? 'pocket' : 'unknown'), category: command?.categoryId ?? 'unclassified', status: movement.reversed ? 'reversed' : movement.corrected ? 'corrected' : 'active', description: command?.description ?? command?.reason ?? movement.entry.reason ?? '', reference: movement.entry.externalReference ?? movement.metadata?.receiptReference ?? null, amounts: command?.kind === 'exchange' && command.fromCurrency && command.toCurrency ? [{ currency: command.fromCurrency, amount: command.fromAmount ?? '0.00' }, { currency: command.toCurrency, amount: command.toAmount ?? '0.00' }] : command?.amount ? [{ currency: command.currency ?? 'SYP_NEW', amount: command.amount }] : cash, movement }
  })
  const matched = filterFinanceRows(index, filters, today), filtered = matched.slice(page * 20, page * 20 + 20).map(row => row.movement), totals = financeRowTotals(matched.filter(row => row.kind === 'expense'))
  useEffect(() => setPage(0), [rows])
  const displays = filtered.map(row => {
    const command = row.command
    const exchange = command?.kind === 'exchange' &&
      command.fromCurrency !== undefined && command.fromAmount !== undefined &&
      command.toCurrency !== undefined && command.toAmount !== undefined
      ? { fromCurrency: command.fromCurrency, fromAmount: command.fromAmount, toCurrency: command.toCurrency, toAmount: command.toAmount }
      : null
    const amount = command?.amount ?? command?.fromAmount ?? command?.toAmount ?? null
    const cash = command ? [] : companyJournalCash(row.entry.lines)
    const branchId = command ? null : companyJournalBranch(row.entry.lines)
    const frozenRate = normalizedFrozenRate(command?.sypMinorPerUsd ?? row.entry.sypMinorPerUsd)
    const kind = !command && branchId && cash.length === 1
      ? row.entry.eventType === 'company_opening_transfer' ? t.financeReview.openingBranchTransfer : parseMinor(cash[0]!.amount) < 0n ? t.financeReview.fromCompany : t.financeReview.toCompany
      : row.entry.eventType === 'company_historical_transfer' && !command ? t.financeReview.unclassifiedMovement : historicalKindLabel(command?.kind ?? row.entry.eventType, t.companyFinance.historicalKinds)
    return {
      id: row.entry.id,
      occurredOn: row.metadata?.occurredPrecision === 'month' ? row.metadata.occurredMonth : command?.occurredOn ?? row.entry.businessDate,
      postedOn: row.entry.businessDate,
      kind: <>{kind}{!command && row.entry.eventType !== 'company_historical_restoration_reclass' ? <p className="text-label text-ink-muted">{t.financeReview.rawJournalCash}</p> : null}{row.corrected ? <p className="text-label text-ink-muted">{t.financeReview.corrected}</p> : null}{row.reversed ? <p className="text-label text-ink-muted">{t.companyFinance.historicalReversedLabel}</p> : null}</>,
      amount: <bdi dir="ltr">{exchange ? <span className="inline-flex flex-wrap items-center gap-1"><Money value={exchange.fromAmount} currency={exchange.fromCurrency} /><span aria-hidden="true" className="text-ink-muted">→</span><Money value={exchange.toAmount} currency={exchange.toCurrency} /></span>
        : amount === null ? cash.length ? cash.map(value => <span className="block" key={value.currency}><Money value={value.amount} currency={value.currency} /></span>) : '—' : <Money value={amount} currency={command?.currency ?? 'SYP_NEW'} />}</bdi>,
      description: command?.description ?? command?.reason ?? row.entry.reason ?? '—',
      source: row.entry.eventType === 'company_custody_transfer' || command?.paidFrom === 'owner_custody' ? t.financeWorkspace.ownerCustody : command?.paidFrom === 'owner_outside' ? t.companyFinance.ownerOutside : command?.paidFrom === 'reserve' ? t.companyFinance.reserve : command?.paidFrom === 'pocket' || ['deposit', 'withdrawal', 'income', 'exchange'].includes(command?.kind ?? '') ? t.companyFinance.pocket : branchId ? <span>{t.accounts.branch}: {lang === 'ar' ? branches.find(branch => branch.id === branchId)?.nameAr ?? t.financeReview.unknown : branches.find(branch => branch.id === branchId)?.nameEn ?? t.financeReview.unknown}</span> : t.financeReview.unknown,
      rate: frozenRate === null ? '—' : <span className="inline-flex flex-wrap items-center gap-1"><Money value={frozenRate} currency="SYP_NEW" /><span className="text-ink-muted">/ {t.currency.USD}</span></span>,
      action: command?.kind === 'expense' && !row.reversed ? <div className="flex flex-wrap gap-2">{onCorrect ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => onCorrect(row.originalCommand?.id ?? command.id)}>{t.financeReview.edit}</Button> : null}<Button variant="danger" size="sm" disabled={busy} onClick={() => void onDelete({ kind: 'command', id: command.id, description: `${command.description ?? row.entry.reason ?? ''} · ${command.amount ?? ''} ${t.currency[command.currency ?? 'SYP_NEW']} · ${command.occurredOn ?? row.entry.businessDate}` })}>{t.financeReview.deleteExpense}</Button></div> : command && ['deposit', 'withdrawal', 'income', 'exchange'].includes(command.kind) && !row.reversed ? <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => onEditOperation(row)}>{t.financeReview.edit}</Button><Button variant="danger" size="sm" disabled={busy} onClick={() => void onDeleteOperation(row)}>{t.financeReview.deleteOperation}</Button></div> : row.entry.externalReference && /^HQ-SRC-[0-9]+(?:[–-][0-9]+)?$/.test(row.entry.externalReference) && onHistoricalCorrect ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => onHistoricalCorrect(row.entry.externalReference!)}>{t.financeReview.edit}</Button> : <span className="text-label text-ink-muted">{t.financeReview.linkedOperationHint}</span>,
    }
  })
  return (
    <Card title={t.companyFinance.tabs.movements} subtitle={t.financeReview.currentLedgerBasis}>
      <CompanyFinanceFilters filters={filters} onChange={value => { setFilters(value); setPage(0) }} today={today} kinds={[...new Set(index.map(row => row.kind))].map(kind => ({ value: kind, label: kind === 'branch_transfer' ? t.companyFinance.branches : kind === 'unclassified' ? t.financeReview.unclassifiedMovement : historicalKindLabel(kind, t.companyFinance.historicalKinds) }))} categories={[{ value: 'unclassified', label: t.financeReview.unclassifiedMovement }, ...categories.map(category => ({ value: category.id, label: category.nameAr }))]} sources={[{ value: 'pocket', label: t.companyFinance.pocket }, { value: 'owner_outside', label: t.companyFinance.ownerOutside }, { value: 'reserve', label: t.companyFinance.reserve }, { value: 'owner_custody', label: t.financeWorkspace.ownerCustody }, { value: 'branch', label: t.accounts.branch }, { value: 'unknown', label: t.financeReview.unknown }]} statuses={[{ value: 'active', label: t.financeReview.activeStatus }, { value: 'corrected', label: t.financeReview.corrected }, { value: 'reversed', label: t.companyFinance.historicalReversedLabel }]} />
      <div className="my-3 flex flex-wrap items-center justify-between gap-3"><p>{t.financeReview.resultCount}: <bdi>{matched.length}</bdi> · {t.financeReview.newestFirst}</p><Button variant="ghost" disabled={!matched.length} onClick={() => downloadFinanceRows(matched, filters, 'company-ledger')}>{t.financeReview.export}</Button></div><p className="mb-3 text-label text-ink-muted">{t.financeReview.expenseResultsTotal} <Money value={totals.SYP_NEW} currency="SYP_NEW" /> · <Money value={totals.USD} currency="USD" /></p>
      {mobile ? <div className="mt-3 flex flex-col gap-3">
        {displays.length === 0 ? <p className="rounded-lg border border-line p-4 text-body text-ink-muted">{t.companyFinance.emptyMovements}</p> : displays.map(row => <article key={row.id} data-company-movement className="rounded-xl border border-line bg-surface-card p-4">
          <dl className="flex flex-col gap-3">
            <div><dt className="text-label text-ink-muted">{t.companyFinance.kind}</dt><dd className="mt-1 font-semibold">{row.kind}</dd></div>
            <div><dt className="text-label text-ink-muted">{t.companyFinance.amount}</dt><dd className="mt-1 break-words text-figure font-bold">{row.amount}</dd></div>
            <div className="grid grid-cols-2 gap-3"><div><dt className="text-label text-ink-muted">{t.companyFinance.occurredOn}</dt><dd className="num mt-1">{row.occurredOn}</dd></div><div><dt className="text-label text-ink-muted">{t.companyFinance.postedOn}</dt><dd className="num mt-1">{row.postedOn}</dd></div></div>
            <div><dt className="text-label text-ink-muted">{t.companyFinance.description}</dt><dd className="mt-1 break-words"><p className="line-clamp-2">{row.description}</p><details><summary className="cursor-pointer text-label text-brand">{t.audit.details}</summary><p className="mt-2">{row.description}</p></details></dd></div>
            <div><dt className="text-label text-ink-muted">{t.financeReview.source}</dt><dd className="mt-1 break-words">{row.source}</dd></div>
            <div><dt className="text-label text-ink-muted">{t.companyFinance.rate}</dt><dd className="mt-1">{row.rate}</dd></div>
          </dl>
          {row.action ? <div className="mt-3 border-t border-line pt-3">{row.action}</div> : null}
        </article>)}
      </div> : <Table head={[t.companyFinance.occurredOn, t.companyFinance.description, t.companyFinance.amount, t.financeReview.source, t.companyFinance.action]} isEmpty={displays.length === 0} empty={t.companyFinance.emptyMovements}>
        {displays.map(row => <tr key={row.id} data-company-movement><td className="num whitespace-nowrap px-3 py-3">{row.occurredOn}{row.occurredOn !== row.postedOn ? <p className="mt-1 text-label text-ink-muted">{t.companyFinance.postedOn}: {row.postedOn}</p> : null}</td><td className="max-w-md px-3 py-3 break-words"><p className="line-clamp-2 font-medium">{row.description}</p><div className="mt-1 text-label text-ink-muted">{row.kind}</div><details><summary className="cursor-pointer text-label text-brand">{t.audit.details}</summary><p className="mt-2">{row.description}</p><p className="mt-1">{t.companyFinance.rate}: {row.rate}</p></details></td><td className="whitespace-nowrap px-3 py-3 text-end font-semibold">{row.amount}</td><td className="px-3 py-3">{row.source}</td><td className="px-3 py-3">{row.action ?? '—'}</td></tr>)}
      </Table>}
      <FinancePagination page={page} total={matched.length} pageSize={20} onChange={setPage} />
    </Card>
  )
}

export function isValidHistoricalDate(value: string, today: string): boolean {
  return isCalendarDate(value) && value >= '2000-01-01' && value <= today
}

function historicalKindLabel(kind: string, labels: {
  deposit: string
  withdrawal: string
  expense: string
  income: string
  exchange: string
  reversal: string
  historicalRestorationReclass: string; custodyTransfer: string
}): string {
  switch (kind) {
    case 'deposit': return labels.deposit
    case 'withdrawal': return labels.withdrawal
    case 'expense': return labels.expense
    case 'income': return labels.income
    case 'exchange': return labels.exchange
    case 'reversal': return labels.reversal
    case 'company_custody_transfer': return labels.custodyTransfer
    case 'company_historical_restoration_reclass': return labels.historicalRestorationReclass
    default: return kind
  }
}

function HistoricalCategoryCreator({
  kind,
  onCreated,
}: {
  kind: 'expense' | 'income'
  onCreated: (category: CategoryOption) => void
}): ReactNode {
  const { api, session, t } = useApp()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [nameAr, setNameAr] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (session?.roleKey !== 'system_admin') return null

  const create = async (): Promise<void> => {
    if (code.trim() === '' || nameAr.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const category = kind === 'expense'
        ? await api.createExpenseCategory({ code: code.trim(), nameAr: nameAr.trim() })
        : await api.createIncomeCategory({ code: code.trim(), nameAr: nameAr.trim() })
      onCreated(category)
      setCode('')
      setNameAr('')
      setOpen(false)
    } catch (cause) {
      setError((cause as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-line-strong bg-surface-muted p-3">
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setOpen((current) => !current); setError(null) }}>
        {open ? t.common.cancel : t.expenses.addCategory}
      </Button>
      {open ? (
        <div className="mt-3 grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(7rem,1fr)_minmax(12rem,2fr)_auto]">
          <Field label={t.expenses.categoryCode}>
            <TextInput value={code} disabled={busy} onChange={(event) => setCode(event.target.value)} aria-label={t.expenses.categoryCode} />
          </Field>
          <Field label={t.expenses.categoryName}>
            <TextInput value={nameAr} disabled={busy} onChange={(event) => setNameAr(event.target.value)} aria-label={t.expenses.categoryName} />
          </Field>
          <Button type="button" disabled={busy || code.trim() === '' || nameAr.trim() === ''} onClick={() => void create()}>{t.expenses.addCategory}</Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-label font-medium text-danger-ink">{explainError(error, t)}</p> : null}
    </div>
  )
}

function HistoricalMovementsTab({
  rows,
  preflight,
  expenseCategories,
  incomeCategories,
  today,
  busy,
  mutate,
}: {
  rows: Movement[]
  preflight: HistoricalPreflight
  expenseCategories: CategoryOption[]
  incomeCategories: CategoryOption[]
  today: string
  busy: boolean
  mutate: Mutate
}): ReactNode {
  const { api, t, session, branches, lang } = useApp()
  const confirm = useConfirm()
  const pendingStorage = `ash.historical-request:${session?.userId ?? ''}:HQ`
  const [unfinished, setUnfinished] = useState<Record<string, unknown> | null>(() => {
    try { const saved: unknown = JSON.parse(sessionStorage.getItem(pendingStorage) ?? 'null'); return saved && typeof saved === 'object' && !Array.isArray(saved) && typeof (saved as Record<string, unknown>).idempotencyKey === 'string' ? saved as Record<string, unknown> : null } catch { return null }
  })
  const rememberRequest = (request: Record<string, unknown> | null): void => {
    setUnfinished(request)
    try { if (request) sessionStorage.setItem(pendingStorage, JSON.stringify(request)); else sessionStorage.removeItem(pendingStorage) } catch { /* In-memory retry still works in private mode. */ }
  }
  const retryUnfinished = (): void => {
    if (!unfinished) return
    void mutate(() => api.post('/company/historical-movements', unfinished), t.companyFinance.historicalSaved, outcome => {
      if (!uncertainMoneyMoveOutcome(outcome)) rememberRequest(null)
    }).then(saved => { if (saved) { setHasPostedHistorical(true); resetForm() } })
  }
  type DraftRequest = { path: string; method: 'post' | 'patch'; payload: Record<string, unknown> }
  const draftStorage = `${pendingStorage}:administrative`
  const [unfinishedDraft, setUnfinishedDraft] = useState<DraftRequest | null>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftStorage) ?? 'null') as DraftRequest | null
      return saved && /^\/company\/historical-drafts(?:\/[0-9a-f-]{36})?$/.test(saved.path)
        && (saved.method === 'post' || saved.method === 'patch') && typeof saved.payload?.idempotencyKey === 'string' ? saved : null
    } catch { return null }
  })
  const [historicalDrafts, setHistoricalDrafts] = useState<CompanyHistoricalDraft[] | null>(null)
  const [draftLoadError, setDraftLoadError] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<CompanyHistoricalDraft | null>(null)
  const loadDrafts = useCallback(() => {
    void api.get<{ drafts: CompanyHistoricalDraft[] }>('/company/historical-drafts').then(result => {
      setHistoricalDrafts(result.drafts); setDraftLoadError(null)
    }).catch(error => setDraftLoadError((error as { error?: string }).error ?? 'error'))
  }, [api])
  useEffect(loadDrafts, [loadDrafts])
  const rememberDraft = (request: DraftRequest | null): void => {
    setUnfinishedDraft(request)
    try { if (request) sessionStorage.setItem(draftStorage, JSON.stringify(request)); else sessionStorage.removeItem(draftStorage) } catch { /* Exact in-memory retry remains available. */ }
  }
  const saveAdministrativeDraft = (request: DraftRequest): void => {
    rememberDraft(request)
    void mutate(() => request.method === 'patch' ? api.patch(request.path, request.payload) : api.post(request.path, request.payload), t.financeReview.historicalDraftSaved, outcome => {
      if (!uncertainMoneyMoveOutcome(outcome)) rememberDraft(null)
    }).then(saved => {
      if (saved) { pendingKey.current = null; setEditingDraft(null); resetForm(); loadDrafts() }
      else { loadDrafts() }
    })
  }
  const [kind, setKind] = useState<HistoricalDraftPayload['type']>('deposit')
  const [draftBranchId, setDraftBranchId] = useState('')
  const [draftAssetId, setDraftAssetId] = useState<string | null>(null)
  const [draftDepositAccount, setDraftDepositAccount] = useState<'' | 'opening' | 'owner_funding'>('')
  const [occurredOn, setOccurredOn] = useState(today)
  const [occurredPrecision, setOccurredPrecision] = useState<'day' | 'month'>('day')
  const [occurredMonth, setOccurredMonth] = useState(today.slice(0, 7))
  const [paidFrom, setPaidFrom] = useState<'pocket' | 'owner_outside'>('pocket')
  const [rateBasis, setRateBasis] = useState<'documented' | 'estimated'>('documented')
  const [sourceUnit, setSourceUnit] = useState('')
  const [intakeSessionId, setIntakeSessionId] = useState('')
  const [intakeSessions, setIntakeSessions] = useState<Array<{ id: string; from: string; to: string; closedAtMs: number | null }>>([])
  const [intakeAcknowledged, setIntakeAcknowledged] = useState(false)
  const [intakeUnitAcknowledged, setIntakeUnitAcknowledged] = useState(false)
  const [currency, setCurrency] = useState<Currency>('SYP_NEW')
  const [amount, setAmount] = useState('')
  const [historicalRate, setHistoricalRate] = useState('')
  const [externalReference, setExternalReference] = useState('')
  const [reason, setReason] = useState('')
  const [expenseCategoryId, setExpenseCategoryId] = useState('')
  const [incomeCategoryId, setIncomeCategoryId] = useState('')
  const [fromCurrency, setFromCurrency] = useState<Currency>('USD')
  const [toCurrency, setToCurrency] = useState<Currency>('SYP_NEW')
  const [fromAmount, setFromAmount] = useState('')
  const [toAmount, setToAmount] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [createdExpenseCategories, setCreatedExpenseCategories] = useState<CategoryOption[]>([])
  const [createdIncomeCategories, setCreatedIncomeCategories] = useState<CategoryOption[]>([])
  const [from, setFrom] = useState('2000-01-01')
  const [to, setTo] = useState(today)
  const [kindFilter, setKindFilter] = useState<HistoricalMovementFilterKind | 'all'>('all')
  const [referenceFilter, setReferenceFilter] = useState('')
  const [reversing, setReversing] = useState<Movement | null>(null)
  const [reversalReference, setReversalReference] = useState('')
  const [reversalReason, setReversalReason] = useState('')
  const [reversalError, setReversalError] = useState<string | null>(null)
  const [hasPostedHistorical, setHasPostedHistorical] = useState(false)
  const pendingKey = useRef<PendingMoneyMove | null>(null)
  const pendingReversalKey = useRef<PendingMoneyMove | null>(null)
  const loadIntakes = useCallback(() => { void api.get<{ sessions: typeof intakeSessions }>('/company/historical-intake-sessions').then(result => setIntakeSessions(result.sessions.filter(item => item.closedAtMs === null))).catch(() => setIntakeSessions([])) }, [api])
  useEffect(loadIntakes, [loadIntakes])
  const postingBlocked = preflight.postingEnabled === false
  const administrativeKind = kind === 'branch_receipt' || kind === 'branch_payment' || kind === 'asset_payment' || kind === 'refund'
  const reviewOnly = postingBlocked || editingDraft !== null || administrativeKind
  const branchRequired = kind === 'branch_receipt' || kind === 'branch_payment'
  const sourceSelectable = kind === 'expense' || kind === 'branch_payment' || kind === 'asset_payment'
  const draftKindLabel = (value: HistoricalDraftPayload['type']): string => value in t.financeReview.historicalDraftKinds
    ? t.financeReview.historicalDraftKinds[value as keyof typeof t.financeReview.historicalDraftKinds]
    : historicalKindLabel(value, t.companyFinance.historicalKinds)

  const activeExpenseCategories = useMemo(() => {
    const byId = new Map(expenseCategories.filter((category) => category.active).map((category) => [category.id, category]))
    for (const category of createdExpenseCategories) byId.set(category.id, category)
    return [...byId.values()]
  }, [createdExpenseCategories, expenseCategories])
  const activeIncomeCategories = useMemo(() => {
    const byId = new Map(incomeCategories.filter((category) => category.active).map((category) => [category.id, category]))
    for (const category of createdIncomeCategories) byId.set(category.id, category)
    return [...byId.values()]
  }, [createdIncomeCategories, incomeCategories])

  useEffect(() => {
    if (rows.length > 0) setHasPostedHistorical(true)
  }, [rows.length])

  useEffect(() => {
    if (reviewOnly) return
    if (kind === 'expense' && !activeExpenseCategories.some((category) => category.id === expenseCategoryId)) {
      setExpenseCategoryId(activeExpenseCategories[0]?.id ?? '')
    }
    if (kind === 'income' && !activeIncomeCategories.some((category) => category.id === incomeCategoryId)) {
      setIncomeCategoryId(activeIncomeCategories[0]?.id ?? '')
    }
  }, [activeExpenseCategories, activeIncomeCategories, expenseCategoryId, incomeCategoryId, kind, reviewOnly])

  const exchangeRatePreview = deriveExchangeField({
    fromCurrency, toCurrency, fromAmount, toAmount, rate: '',
  }, 'rate')
  // The input is intentionally append-only in real-world order. Reversals are corrective entries
  // dated today, so they do not prevent the operator from finishing an older import afterwards.
  const latestHistoricalOccurrence = useMemo(() => rows.reduce<string | null>((latest, row) => {
    const occurred = row.command?.occurredOn
    if (row.command?.kind === 'reversal' || occurred === undefined) return latest
    return latest === null || occurred > latest ? occurred : latest
  }, null), [rows])
  const earliestAllowedOccurrence = intakeSessionId ? '2000-01-01' : latestHistoricalOccurrence ?? '2000-01-01'
  const openingBlocked = !intakeSessionId && rows.length === 0 && !hasPostedHistorical && !preflight.canStart
  const disabled = busy || (!reviewOnly && openingBlocked) || unfinished !== null || unfinishedDraft !== null
  const reversedTargetIds = useMemo(
    () => new Set(rows.flatMap((row) => row.command?.kind === 'reversal' && row.command.targetId ? [row.command.targetId] : [])),
    [rows],
  )
  const filteredRows = useMemo(() => {
    const referenceNeedle = referenceFilter.trim().toLowerCase()
    return rows.filter((row) => {
      const occurred = row.command?.occurredOn ?? row.entry.businessDate
      const occurrenceEnd = row.metadata?.occurredPrecision === 'month' ? monthEndFor(occurred) : occurred
      const rowKind = row.command?.kind ?? row.entry.eventType
      const reference = `${row.entry.externalReference ?? ''} ${row.metadata?.receiptReference ?? ''}`
      return (from === '' || occurrenceEnd >= from) &&
        (to === '' || occurred <= to) &&
        (kindFilter === 'all' || rowKind === kindFilter) &&
        (referenceNeedle === '' || reference.toLowerCase().includes(referenceNeedle))
    })
  }, [from, kindFilter, referenceFilter, rows, to])

  const resetForm = (): void => {
    setAmount('')
    setHistoricalRate('')
    setExternalReference('')
    setReason('')
    setFromAmount('')
    setToAmount('')
    setFormError(null)
    setDraftBranchId(''); setDraftAssetId(null); setDraftDepositAccount('')
  }
  const editHistoricalDraft = (draft: CompanyHistoricalDraft): void => {
    if (disabled) return
    const value = draft.payload
    setEditingDraft(draft); pendingKey.current = null
    setKind(value.type); setOccurredOn(value.occurredOn); setOccurredPrecision(value.occurredPrecision)
    setOccurredMonth(value.occurredMonth ?? value.occurredOn.slice(0, 7)); setPaidFrom(value.paidFrom)
    setDraftBranchId(value.branchId ?? ''); setDraftAssetId(value.assetId ?? null)
    setDraftDepositAccount(value.account ?? '')
    setCurrency(value.currency ?? 'SYP_NEW'); setAmount(value.amount ?? ''); setHistoricalRate(value.historicalRate ?? '')
    setRateBasis(value.rateBasis ?? 'documented'); setSourceUnit(value.sourceUnit ?? '')
    setExternalReference(value.receiptReference ?? ''); setReason(value.description)
    setExpenseCategoryId(value.type === 'expense' ? value.categoryId ?? '' : '')
    setIncomeCategoryId(value.type === 'income' ? value.categoryId ?? '' : '')
    setFromCurrency(value.fromCurrency ?? 'USD'); setToCurrency(value.toCurrency ?? 'SYP_NEW')
    setFromAmount(value.fromAmount ?? ''); setToAmount(value.toAmount ?? ''); setIntakeSessionId(''); setFormError(null)
  }

  const changeExchangeCurrency = (side: 'from' | 'to', next: Currency): void => {
    const nextFrom = side === 'from' ? next : fromCurrency
    const nextTo = side === 'to' ? next : toCurrency
    if (nextFrom === nextTo) {
      if (side === 'from') setToCurrency(next === 'USD' ? 'SYP_NEW' : 'USD')
      else setFromCurrency(next === 'USD' ? 'SYP_NEW' : 'USD')
    }
    if (side === 'from') setFromCurrency(next)
    else setToCurrency(next)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (disabled) return
    const effectiveOccurrence = occurredPrecision === 'month' ? `${occurredMonth}-01` : occurredOn
    const normalizedAmount = positiveExchangeMoney(amount)
    const normalizedRate = positiveExchangeMoney(historicalRate)
    const normalizedFrom = positiveExchangeMoney(fromAmount)
    const normalizedTo = positiveExchangeMoney(toAmount)
    const selectedCategoryId = kind === 'expense' ? expenseCategoryId : incomeCategoryId
    if (
      !isValidHistoricalDate(effectiveOccurrence, today) || (!reviewOnly && effectiveOccurrence < earliestAllowedOccurrence) ||
      reason.trim() === '' || (branchRequired && draftBranchId === '') ||
      (kind === 'exchange'
        ? fromCurrency === toCurrency || normalizedFrom === null || normalizedTo === null || exchangeRatePreview === null
        : normalizedAmount === null || (currency === 'USD' && normalizedRate === null) ||
          (!reviewOnly && (kind === 'expense' || kind === 'income') && selectedCategoryId === ''))
    ) {
      setFormError(t.companyFinance.historicalInvalid)
      return
    }
    const payload = kind === 'exchange'
      ? {
        type: kind,
        occurredOn: effectiveOccurrence,
        ...(externalReference.trim() ? { receiptReference: externalReference.trim() } : {}),
        description: reason.trim(),
        fromCurrency,
        fromAmount: formatMinor(normalizedFrom!),
        toCurrency,
        toAmount: formatMinor(normalizedTo!),
      }
      : {
        type: kind,
        occurredOn: effectiveOccurrence,
        ...(externalReference.trim() ? { receiptReference: externalReference.trim() } : {}),
        description: reason.trim(),
        currency,
        amount: formatMinor(normalizedAmount!),
        ...(currency === 'USD' ? { historicalRate: formatMinor(normalizedRate!), rateBasis } : {}),
        ...(sourceSelectable ? { paidFrom } : {}),
        ...(branchRequired || (reviewOnly && draftBranchId !== '') ? { branchId: draftBranchId } : {}),
        ...(kind === 'asset_payment' && draftAssetId ? { assetId: draftAssetId } : {}),
        ...(kind === 'deposit' && reviewOnly && draftDepositAccount ? { account: draftDepositAccount } : {}),
        ...((kind === 'expense' || kind === 'income') && selectedCategoryId !== '' ? {
          categoryId: selectedCategoryId,
        } : {}),
      }
    const historicalPayload = { ...payload, occurredPrecision, ...(occurredPrecision === 'month' ? { occurredMonth } : {}), ...(sourceUnit.trim() ? { sourceUnit: sourceUnit.trim() } : {}), ...(intakeSessionId ? { intakeSessionId } : {}) }
    void (async () => {
      const amountText = kind === 'exchange' ? `${formatMinor(normalizedFrom!)} ${t.currency[fromCurrency]} → ${formatMinor(normalizedTo!)} ${t.currency[toCurrency]}` : `${formatMinor(normalizedAmount!)} ${t.currency[currency]}`
      const accepted = await confirm({ title: reviewOnly ? t.financeReview.saveForReview : t.companyFinance.historicalEntry, body: `${draftKindLabel(kind)}: ${amountText}\n${t.companyFinance.occurredOn}: ${occurredPrecision === 'month' ? occurredMonth : effectiveOccurrence}\n${reviewOnly ? t.financeReview.historicalDraftHint : `${t.companyFinance.postedOn}: ${today}`}\n${sourceSelectable && paidFrom === 'owner_outside' ? t.financeReview.ownerHint : t.companyFinance.pocket}\n${currency === 'USD' && kind !== 'exchange' ? `${t.companyFinance.historicalRate}: ${formatMinor(normalizedRate!)} (${rateBasis === 'estimated' ? t.financeReview.estimated : t.financeReview.documented})\n` : ''}${reason.trim()}`, confirmLabel: reviewOnly ? t.financeReview.saveForReview : t.companyFinance.historicalSubmit })
      if (!accepted) return
    // Keep the UUID only for the exact economic fact. This includes every conditional historical
    // field, so a lost response retries safely while an edited row always gets a fresh UUID.
    const operation = pendingMoneyMove(pendingKey.current, {
      command: `${reviewOnly ? 'company_historical_draft' : 'company_historical'}:${kind}`,
      branchId: null,
      amount: kind === 'exchange'
        ? `${formatMinor(normalizedFrom!)}:${formatMinor(normalizedTo!)}`
        : formatMinor(normalizedAmount!),
      reason: reason.trim(),
      details: { ...historicalPayload, ...(editingDraft ? { draftId: editingDraft.id, expectedVersion: editingDraft.version } : {}) },
    })
    pendingKey.current = operation
    const requestBody = { idempotencyKey: operation.idempotencyKey, ...historicalPayload }
    if (reviewOnly) {
      const { intakeSessionId: _intake, ...draftPayload } = requestBody
      saveAdministrativeDraft({ path: editingDraft ? `/company/historical-drafts/${editingDraft.id}` : '/company/historical-drafts',
        method: editingDraft ? 'patch' : 'post', payload: { ...draftPayload, ...(editingDraft ? { expectedVersion: editingDraft.version } : {}) } })
      return
    }
    rememberRequest(requestBody)
    await mutate(
      () => api.post('/company/historical-movements', requestBody),
      t.companyFinance.historicalSaved,
      (outcome) => {
        if (pendingKey.current === operation) pendingKey.current = pendingAfterAttempt(operation, outcome)
        if (!uncertainMoneyMoveOutcome(outcome)) rememberRequest(null)
      },
    ).then((saved) => {
      if (!saved) return
      setHasPostedHistorical(true)
      resetForm()
    })
    })()
  }

  const reverse = (event: FormEvent): void => {
    event.preventDefault()
    const targetId = reversing?.command?.id
    if (!targetId || reversalReason.trim() === '') {
      setReversalError(t.companyFinance.historicalReversalInvalid)
      return
    }
    const payload = {
      type: 'reversal' as const,
      targetId,
      occurredOn: today,
      ...(reversalReference.trim() ? { receiptReference: reversalReference.trim() } : {}),
      reason: reversalReason.trim(),
    }
    const operation = pendingMoneyMove(pendingReversalKey.current, {
      command: 'company_historical:reversal',
      branchId: null,
      amount: targetId,
      reason: reversalReason.trim(),
      details: payload,
    })
    pendingReversalKey.current = operation
    void mutate(
      () => api.post('/company/historical-movements', { idempotencyKey: operation.idempotencyKey, ...payload }),
      t.companyFinance.historicalReversed,
      (outcome) => {
        if (pendingReversalKey.current === operation) pendingReversalKey.current = pendingAfterAttempt(operation, outcome)
      },
    ).then((saved) => {
      if (!saved) return
      setReversing(null)
      setReversalReference('')
      setReversalReason('')
      setReversalError(null)
    })
  }

  const renderAmount = (row: Movement): ReactNode => {
    const command = row.command
    if (
      command?.kind === 'exchange' && command.fromCurrency !== undefined && command.fromAmount !== undefined &&
      command.toCurrency !== undefined && command.toAmount !== undefined
    ) {
      return (
        <span className="inline-flex flex-wrap items-center justify-end gap-1">
          <Money value={command.fromAmount} currency={command.fromCurrency} />
          <span aria-hidden="true" className="text-ink-muted">→</span>
          <Money value={command.toAmount} currency={command.toCurrency} />
        </span>
      )
    }
    const rowAmount = command?.amount
    return rowAmount === undefined ? '—' : <Money value={rowAmount} currency={command?.currency ?? 'SYP_NEW'} />
  }

  const renderBalanceAfter = (row: Movement): ReactNode => {
    const after = row.pocketAfter
    if (!after) return '—'
    const command = row.command
    const currencies: Currency[] = command?.kind === 'exchange'
      ? [command.fromCurrency, command.toCurrency].filter((item): item is Currency => item !== undefined)
      : command?.currency === undefined ? ['SYP_NEW', 'USD'] : [command.currency]
    const figures = [...new Set(currencies)].flatMap((currency) => {
      const value = after[currency]
      return value === undefined ? [] : [{ currency, value }]
    })
    if (figures.length === 0) return '—'
    return (
      <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
        {figures.map((figure) => <Money key={figure.currency} value={figure.value} currency={figure.currency} />)}
      </span>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {unfinished ? <Card title={t.financeReview.retryDraft}><p className="mb-3 text-body">{t.financeReview.unknownAttempt}</p><p>{String(unfinished.description ?? unfinished.reason ?? '')}</p><p className="num">{String(unfinished.occurredMonth ?? unfinished.occurredOn ?? '')} · {String(unfinished.amount ?? `${unfinished.fromAmount ?? ''} → ${unfinished.toAmount ?? ''}`)}</p><Button disabled={busy} onClick={retryUnfinished}>{t.common.retry}</Button></Card> : null}
      {unfinishedDraft ? <Card title={t.financeReview.retryDraft}><p className="mb-3 text-body">{t.financeReview.historicalDraftHint}</p><p>{String(unfinishedDraft.payload.description ?? '')}</p><p className="my-2 text-body text-warning-ink">{t.financeReview.unknownAttempt}</p><Button disabled={busy} onClick={() => saveAdministrativeDraft(unfinishedDraft)}>{t.common.retry}</Button></Card> : null}
      {!postingBlocked ? <details className="rounded-lg border border-line-strong bg-surface-card p-3"><summary className="cursor-pointer font-semibold text-brand">{t.financeReview.intake}</summary><p className="my-3 text-body text-ink-muted">{t.financeReview.intakeHint}</p><label className="flex gap-2 text-body"><input type="checkbox" checked={intakeAcknowledged} onChange={event => setIntakeAcknowledged(event.target.checked)} /><span>{t.financeReview.reviewedEntries}</span></label><label className="my-3 flex gap-2 text-body"><input type="checkbox" checked={intakeUnitAcknowledged} onChange={event => setIntakeUnitAcknowledged(event.target.checked)} /><span>{t.financeReview.reviewedUnits}</span></label>{intakeAcknowledged && intakeUnitAcknowledged ? <FinanceActionForm path="/company/historical-intake-sessions" title={t.financeReview.openIntake} mutate={mutate} onSaved={loadIntakes} fields={[{ key: 'from', label: t.companyFinance.from, value: '2000-01-01', type: 'date' }, { key: 'to', label: t.companyFinance.to, value: today, type: 'date' }, { key: 'reason', label: t.companyFinance.reason }, { key: 'reconciliationNote', label: t.financeReview.reconciliation }]} build={values => ({ ...values, reviewedSourceUnits: true, reviewedExistingEntries: true })} /> : null}</details> : null}
      <Card title={t.companyFinance.historicalEntry} subtitle={reviewOnly ? t.financeReview.historicalDraftHint : t.companyFinance.historicalHint}>
        {postingBlocked ? <p role="status" className="mb-4 rounded-lg border border-warning-line bg-warning-surface p-3 text-body text-warning-ink">{t.financeReview.historicalPostingBlocked}</p> : null}
        {editingDraft ? <div className="mb-3 flex flex-wrap items-center gap-2"><span>{t.financeReview.editHistoricalDraft} · {t.financeReview.draftVersion}: {editingDraft.version}</span><Button variant="ghost" disabled={busy || unfinishedDraft !== null} onClick={() => { setEditingDraft(null); resetForm(); pendingKey.current = null }}>{t.common.cancel}</Button></div> : null}
        <p className="mb-3 text-body text-ink-muted">{t.financeReview.entrySourceHint}</p>
        {!reviewOnly && openingBlocked ? (
          <p role="alert" className="mb-3 rounded-lg border border-warning-line bg-warning-surface p-3 text-body font-medium text-warning-ink">
            {t.companyFinance.historicalOpeningBlocked}
            <span className="mt-2 flex flex-wrap items-center gap-2 text-label">
              <span>{t.companyFinance.historicalOpeningBalances}</span>
              <Money value={preflight.pockets.SYP_NEW} currency="SYP_NEW" />
              <Money value={preflight.pockets.USD} currency="USD" />
            </span>
          </p>
        ) : null}
        <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submit} aria-disabled={disabled}>
          {!reviewOnly ? <Field label={t.financeReview.intake}><Select value={intakeSessionId} disabled={disabled} onChange={event => setIntakeSessionId(event.target.value)} aria-label={t.financeReview.intake}><option value="">{t.financeReview.noIntake}</option>{intakeSessions.map(item => <option key={item.id} value={item.id}>{item.from} — {item.to}</option>)}</Select></Field> : null}
          <Field label={t.companyFinance.kind}>
            <Select value={kind} disabled={disabled} onChange={(event) => { setKind(event.target.value as HistoricalDraftPayload['type']); setDraftAssetId(null); setDraftBranchId(''); setFormError(null) }} aria-label={t.companyFinance.kind}>
              <option value="deposit">{t.companyFinance.historicalKinds.deposit}</option>
              <option value="withdrawal">{t.companyFinance.historicalKinds.withdrawal}</option>
              <option value="expense">{t.companyFinance.historicalKinds.expense}</option>
              <option value="income">{t.companyFinance.historicalKinds.income}</option>
              <option value="exchange">{t.companyFinance.historicalKinds.exchange}</option>
              {reviewOnly ? Object.entries(t.financeReview.historicalDraftKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>) : null}
            </Select>
          </Field>
          <Field label={t.financeReview.precision}><Select value={occurredPrecision} disabled={disabled} onChange={event => setOccurredPrecision(event.target.value as 'day' | 'month')} aria-label={t.financeReview.precision}><option value="day">{t.financeReview.day}</option><option value="month">{t.financeReview.month}</option></Select></Field>
          {occurredPrecision === 'month' ? <Field label={t.financeReview.occurredMonth}><TextInput required type="month" min="2000-01" max={today.slice(0, 7)} value={occurredMonth} disabled={disabled} onChange={event => setOccurredMonth(event.target.value)} aria-label={t.financeReview.occurredMonth} /></Field> : <Field label={t.companyFinance.occurredOn}>
            <TextInput required type="date" min={reviewOnly ? '2000-01-01' : earliestAllowedOccurrence} max={today} dir="ltr" className="num" value={occurredOn} disabled={disabled} onChange={(event) => { setOccurredOn(event.target.value); setFormError(null) }} aria-label={t.companyFinance.occurredOn} />
          </Field>}
          {branchRequired ? <Field label={t.accounts.branch} hint={t.financeReview.draftBranchHint}><Select required value={draftBranchId} disabled={disabled} onChange={event => setDraftBranchId(event.target.value)} aria-label={t.accounts.branch}><option value="">—</option>{branches.filter(branch => branch.code !== 'HQ').map(branch => <option key={branch.id} value={branch.id}>{lang === 'ar' ? branch.nameAr : branch.nameEn}</option>)}</Select></Field> : null}
          {sourceSelectable ? <Field label={t.financeReview.source}><Select value={paidFrom} disabled={disabled} onChange={event => setPaidFrom(event.target.value as 'pocket' | 'owner_outside')} aria-label={t.financeReview.source}><option value="pocket">{t.companyFinance.pocket}</option><option value="owner_outside">{t.companyFinance.ownerOutside}</option></Select></Field> : null}
          {reviewOnly && kind === 'deposit' ? <Field label={t.financeReview.draftDepositAccount}><Select value={draftDepositAccount} disabled={disabled} onChange={event => setDraftDepositAccount(event.target.value as typeof draftDepositAccount)} aria-label={t.financeReview.draftDepositAccount}><option value="">—</option><option value="opening">{t.companyFinance.opening}</option><option value="owner_funding">{t.treasury.ownerFunding}</option></Select></Field> : null}
          {kind === 'exchange' ? (
            <>
              <Field label={t.companyFinance.fromCurrency}>
                <Select value={fromCurrency} disabled={disabled} onChange={(event) => { changeExchangeCurrency('from', event.target.value as Currency); setFormError(null) }} aria-label={t.companyFinance.fromCurrency}>
                  <option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option>
                </Select>
              </Field>
              <Field label={t.companyFinance.toCurrency}>
                <Select value={toCurrency} disabled={disabled} onChange={(event) => { changeExchangeCurrency('to', event.target.value as Currency); setFormError(null) }} aria-label={t.companyFinance.toCurrency}>
                  <option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option>
                </Select>
              </Field>
              <Field label={t.companyFinance.fromAmount}>
                <MoneyInput required value={fromAmount} disabled={disabled} onChange={(event) => { setFromAmount(event.target.value); setFormError(null) }} aria-label={t.companyFinance.fromAmount} />
              </Field>
              <Field label={t.companyFinance.toAmount}>
                <MoneyInput required value={toAmount} disabled={disabled} onChange={(event) => { setToAmount(event.target.value); setFormError(null) }} aria-label={t.companyFinance.toAmount} />
              </Field>
              <Field label={t.companyFinance.rate} hint={t.companyFinance.historicalExchangeRateHint}>
                <MoneyInput readOnly value={exchangeRatePreview ?? ''} aria-label={t.companyFinance.rate} />
              </Field>
            </>
          ) : (
            <>
              <Field label={t.companyFinance.currency}>
                <Select value={currency} disabled={disabled} onChange={(event) => { setCurrency(event.target.value as Currency); setFormError(null) }} aria-label={t.companyFinance.currency}>
                  <option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option>
                </Select>
              </Field>
              <Field label={t.companyFinance.amount}>
                <MoneyInput required value={amount} disabled={disabled} onChange={(event) => { setAmount(event.target.value); setFormError(null) }} aria-label={t.companyFinance.amount} />
              </Field>
              {currency === 'USD' ? (
                <>
                <Field label={t.companyFinance.historicalRate} hint={t.companyFinance.ratePerUsd}>
                  <MoneyInput required value={historicalRate} disabled={disabled} onChange={(event) => { setHistoricalRate(event.target.value); setFormError(null) }} aria-label={t.companyFinance.historicalRate} />
                </Field>
                <Field label={t.financeReview.rateBasis}><Select value={rateBasis} disabled={disabled} onChange={event => setRateBasis(event.target.value as 'documented' | 'estimated')} aria-label={t.financeReview.rateBasis}><option value="documented">{t.financeReview.documented}</option><option value="estimated">{t.financeReview.estimated}</option></Select></Field>
                </>
              ) : null}
              {kind === 'expense' ? (
                <div className="sm:col-span-2 flex flex-col gap-3">
                  <Field label={t.expenses.category}>
                    <Select required={!reviewOnly} value={expenseCategoryId} disabled={disabled || (!reviewOnly && activeExpenseCategories.length === 0)} onChange={(event) => { setExpenseCategoryId(event.target.value); setFormError(null) }} aria-label={t.expenses.category}>
                      <option value="">—</option>
                      {reviewOnly && expenseCategoryId && !activeExpenseCategories.some(category => category.id === expenseCategoryId) ? <option value={expenseCategoryId}>{t.financeReview.draftCategoryReview}</option> : null}
                      {activeExpenseCategories.map((category) => <option key={category.id} value={category.id}>{category.nameAr} · {category.code}</option>)}
                    </Select>
                  </Field>
                  <HistoricalCategoryCreator kind="expense" onCreated={(category) => { setCreatedExpenseCategories((current) => [...current.filter((row) => row.id !== category.id), category]); setExpenseCategoryId(category.id) }} />
                </div>
              ) : null}
              {kind === 'income' ? (
                <div className="sm:col-span-2 flex flex-col gap-3">
                  <Field label={t.expenses.category}>
                    <Select required={!reviewOnly} value={incomeCategoryId} disabled={disabled || (!reviewOnly && activeIncomeCategories.length === 0)} onChange={(event) => { setIncomeCategoryId(event.target.value); setFormError(null) }} aria-label={t.expenses.category}>
                      <option value="">—</option>
                      {reviewOnly && incomeCategoryId && !activeIncomeCategories.some(category => category.id === incomeCategoryId) ? <option value={incomeCategoryId}>{t.financeReview.draftCategoryReview}</option> : null}
                      {activeIncomeCategories.map((category) => <option key={category.id} value={category.id}>{category.nameAr} · {category.code}</option>)}
                    </Select>
                  </Field>
                  <HistoricalCategoryCreator kind="income" onCreated={(category) => { setCreatedIncomeCategories((current) => [...current.filter((row) => row.id !== category.id), category]); setIncomeCategoryId(category.id) }} />
                </div>
              ) : null}
            </>
          )}
          <Field label={t.financeReview.optionalReceipt} hint={t.financeReview.generatedReference} className="sm:col-span-2">
            <TextInput value={externalReference} disabled={disabled} onChange={(event) => { setExternalReference(event.target.value); setFormError(null) }} aria-label={t.financeReview.optionalReceipt} />
          </Field>
          <Field label={t.financeReview.sourceUnit} hint={t.financeReview.sourceUnitHint}><TextInput value={sourceUnit} disabled={disabled} onChange={event => setSourceUnit(event.target.value)} aria-label={t.financeReview.sourceUnit} /></Field>
          <Field label={t.companyFinance.description} className="sm:col-span-2">
            <TextInput required value={reason} disabled={disabled} onChange={(event) => { setReason(event.target.value); setFormError(null) }} aria-label={t.companyFinance.description} />
          </Field>
          {formError ? <p role="alert" className="sm:col-span-2 text-label font-medium text-danger-ink">{formError}</p> : null}
          <Button type="submit" disabled={disabled} className="sm:col-span-2">{reviewOnly ? t.financeReview.saveForReview : t.companyFinance.historicalSubmit}</Button>
        </form>
      </Card>

      <Card title={t.financeReview.historicalDrafts} subtitle={t.financeReview.historicalDraftHint}>
        {draftLoadError ? <Pending error={draftLoadError} loadingLabel={t.common.loading} errorLabel={explainError(draftLoadError, t)} retryLabel={t.common.retry} onRetry={loadDrafts} /> : historicalDrafts === null ? <p>{t.common.loading}</p> : historicalDrafts.length === 0 ? <p className="text-body text-ink-muted">{t.common.empty}</p> : <div className="flex flex-col gap-3">{[...historicalDrafts].sort((a, b) => a.payload.occurredOn.localeCompare(b.payload.occurredOn)).map(draft => <section key={draft.id} className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{draftKindLabel(draft.payload.type)} · <bdi>{draft.payload.occurredPrecision === 'month' ? draft.payload.occurredMonth : draft.payload.occurredOn}</bdi></p><Button variant="ghost" size="sm" disabled={disabled} onClick={() => editHistoricalDraft(draft)}>{t.financeReview.editHistoricalDraft}</Button></div>
          <p className="my-2 break-words text-body">{draft.payload.description}</p><bdi dir="ltr">{draft.payload.type === 'exchange' ? <><Money value={draft.payload.fromAmount ?? ''} currency={draft.payload.fromCurrency ?? 'USD'} /> → <Money value={draft.payload.toAmount ?? ''} currency={draft.payload.toCurrency ?? 'SYP_NEW'} /></> : <Money value={draft.payload.amount ?? ''} currency={draft.payload.currency ?? 'SYP_NEW'} />}</bdi>
          <p className="mt-2 text-label text-ink-muted">{draft.payload.paidFrom === 'owner_outside' ? t.financeReview.ownerHint : t.companyFinance.pocket} · {t.financeReview.draftVersion}: {draft.version} · {t.financeReview.notPosted}</p>
          {draft.payload.receiptReference ? <p className="text-label">{t.financeReview.optionalReceipt}: {draft.payload.receiptReference}</p> : null}
          {draft.payload.branchId ? <p className="text-label">{t.accounts.branch}: {(lang === 'ar' ? branches.find(branch => branch.id === draft.payload.branchId)?.nameAr : branches.find(branch => branch.id === draft.payload.branchId)?.nameEn) ?? draft.payload.branchId}</p> : null}
          {draft.payload.sypMinorPerUsd ? <p className="text-label">{t.companyFinance.historicalRate}: <Money value={formatMinor(minor(BigInt(draft.payload.sypMinorPerUsd)))} currency="SYP_NEW" /> / {t.currency.USD}{draft.payload.rateBasis ? <> · {draft.payload.rateBasis === 'estimated' ? t.financeReview.estimated : t.financeReview.documented}</> : null}</p> : null}
          {draft.payload.sourceUnit ? <p className="text-label">{t.financeReview.sourceUnit}: {draft.payload.sourceUnit}</p> : null}
          <details className="mt-2"><summary className="cursor-pointer text-label text-brand">{t.financeReview.draftHistory}</summary>{draft.revisions.map(revision => <p key={revision.requestId} className="mt-2 break-words text-label text-ink-muted">{t.financeReview.draftVersion}: {revision.version} · {revision.payload.description} · <bdi>{revision.payload.amount ?? `${revision.payload.fromAmount ?? ''} → ${revision.payload.toAmount ?? ''}`}</bdi></p>)}</details>
        </section>)}</div>}
      </Card>

      {reversing ? (
        <Card title={t.companyFinance.historicalReverseTitle}>
          <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={reverse}>
            <Field label={t.financeReview.optionalReceipt}>
              <TextInput value={reversalReference} disabled={busy} onChange={(event) => { setReversalReference(event.target.value); setReversalError(null) }} aria-label={t.financeReview.optionalReceipt} />
            </Field>
            <Field label={t.companyFinance.historicalReversalReason}>
              <TextInput required value={reversalReason} disabled={busy} onChange={(event) => { setReversalReason(event.target.value); setReversalError(null) }} aria-label={t.companyFinance.historicalReversalReason} />
            </Field>
            {reversalError ? <p role="alert" className="sm:col-span-2 text-label font-medium text-danger-ink">{reversalError}</p> : null}
            <div className="sm:col-span-2 flex flex-wrap gap-2">
              <Button type="submit" variant="danger" disabled={busy}>{t.companyFinance.historicalReverse}</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => { setReversing(null); setReversalError(null) }}>{t.common.cancel}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card title={t.companyFinance.historicalList}>
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label={t.companyFinance.from}>
            <TextInput type="date" min="2000-01-01" max={today} dir="ltr" className="num" value={from} onChange={(event) => setFrom(event.target.value)} aria-label={t.companyFinance.from} />
          </Field>
          <Field label={t.companyFinance.to}>
            <TextInput type="date" min="2000-01-01" max={today} dir="ltr" className="num" value={to} onChange={(event) => setTo(event.target.value)} aria-label={t.companyFinance.to} />
          </Field>
          <Field label={t.companyFinance.kind}>
            <Select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as HistoricalMovementFilterKind | 'all')} aria-label={t.companyFinance.kind}>
              <option value="all">{t.companyFinance.allHistoricalKinds}</option>
              <option value="deposit">{t.companyFinance.historicalKinds.deposit}</option>
              <option value="withdrawal">{t.companyFinance.historicalKinds.withdrawal}</option>
              <option value="expense">{t.companyFinance.historicalKinds.expense}</option>
              <option value="income">{t.companyFinance.historicalKinds.income}</option>
              <option value="exchange">{t.companyFinance.historicalKinds.exchange}</option>
              <option value="reversal">{t.companyFinance.historicalKinds.reversal}</option>
            </Select>
          </Field>
          <Field label={t.companyFinance.auditReference}>
            <TextInput value={referenceFilter} onChange={(event) => setReferenceFilter(event.target.value)} aria-label={t.companyFinance.auditReference} />
          </Field>
        </div>
        <Table
          head={[
            t.companyFinance.occurredOn, t.companyFinance.postedOn, t.companyFinance.kind,
            t.companyFinance.amount, t.companyFinance.rate, t.companyFinance.auditReference,
            t.companyFinance.description, t.companyFinance.balanceAfter, t.companyFinance.action,
          ]}
          isEmpty={filteredRows.length === 0}
          empty={t.companyFinance.emptyHistoricalMovements}
        >
          {filteredRows.map((row) => {
            const command = row.command
            const rowKind = command?.kind ?? row.entry.eventType
            const isReversible = command !== null && (
              command.kind === 'deposit' || command.kind === 'withdrawal' || command.kind === 'expense' ||
              command.kind === 'income' || command.kind === 'exchange'
            )
            const wasReversed = command !== null && reversedTargetIds.has(command.id)
            const frozenRate = normalizedFrozenRate(command?.sypMinorPerUsd ?? row.entry.sypMinorPerUsd)
            return (
              <tr key={`${row.entry.id}:${command?.id ?? 'entry'}`}>
                <td className="num px-3 py-2">{row.metadata?.occurredPrecision === 'month' ? row.metadata.occurredMonth : command?.occurredOn ?? row.entry.businessDate}</td>
                <td className="num px-3 py-2">{command?.businessDate ?? row.entry.businessDate}</td>
                <td className="px-3 py-2">{historicalKindLabel(rowKind, t.companyFinance.historicalKinds)}</td>
                <td className="px-3 py-2 text-end">{renderAmount(row)}</td>
                <td className="px-3 py-2 text-end">
                  {frozenRate === null ? '—' : <><span className="inline-flex items-center gap-1"><Money value={frozenRate} currency="SYP_NEW" /><span className="text-ink-muted">/ {t.currency.USD}</span></span>{row.metadata?.rateBasis === 'estimated' ? <p className="text-label text-warning-ink">{t.financeReview.estimated}</p> : null}</>}
                </td>
                <td className="px-3 py-2 num">{row.entry.externalReference ?? '—'}{row.metadata?.receiptReference ? <p className="text-label text-ink-muted">{row.metadata.receiptReference}</p> : null}</td>
                <td className="px-3 py-2">{command?.description ?? command?.reason ?? row.entry.reason ?? '—'}</td>
                <td className="px-3 py-2 text-end">{renderBalanceAfter(row)}</td>
                <td className="px-3 py-2">
                  {isReversible && !wasReversed ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setReversing(row); setReversalReference(''); setReversalReason(''); setReversalError(null) }}>{t.companyFinance.historicalReverse}</Button> : wasReversed ? t.companyFinance.historicalReversedLabel : '—'}
                </td>
              </tr>
            )
          })}
        </Table>
      </Card>
    </div>
  )
}

function DebtsTab({ rows, today, busy, mutate }: { rows: Debt[]; today: string; busy: boolean; mutate: Mutate }): ReactNode {
  const { api, t } = useApp()
  const [paying, setPaying] = useState<Debt | null>(null)
  const [partyName, setPartyName] = useState('')
  const [direction, setDirection] = useState<'payable' | 'receivable'>('payable')
  const [currency, setCurrency] = useState<Currency>('SYP_NEW')
  const [principal, setPrincipal] = useState('')
  const [openedOn, setOpenedOn] = useState(today)
  const [dueOn, setDueOn] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void mutate(() => api.post('/company/debts', {
      idempotencyKey: crypto.randomUUID(), direction, partyName, currency, principal, openedOn,
      dueOn: dueOn === '' ? null : dueOn, note: null, origin: 'opening',
    }), t.companyFinance.saved).then(() => { setPartyName(''); setPrincipal(''); setDueOn('') })
  }
  return (
    <div className="flex flex-col gap-4">

      <Card title={t.companyFinance.debtsTitle}>
        <Table head={[t.companyFinance.party, t.companyFinance.direction, t.companyFinance.principal, t.companyFinance.outstanding, t.companyFinance.dueOn, t.companyFinance.action]} isEmpty={rows.length === 0} empty={t.companyFinance.noDebts}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-3 py-2">{row.partyName}</td>
              <td className="px-3 py-2">{row.direction === 'payable' ? t.companyFinance.payable : t.companyFinance.receivable}</td>
              <td className="px-3 py-2 text-end"><Money value={row.principal} currency={row.currency} /></td>
              <td className="px-3 py-2 text-end"><Money value={row.outstanding} currency={row.currency} /></td>
              <td className="num px-3 py-2">{row.dueOn ?? '—'}</td>
              <td className="px-3 py-2"><Button disabled={busy || parseMinor(row.outstanding) <= 0n} onClick={() => setPaying(row)}>{row.direction === 'payable' ? t.expenses.pay : t.financeWorkspace.receiptDetails}</Button></td>
            </tr>
          ))}
        </Table>
      </Card>
      {paying ? <FinanceDialog title={paying.partyName} onClose={() => setPaying(null)}><FinanceActionForm path={`/company/debts/${paying.id}/payments`} title={t.companyFinance.submit} mutate={mutate} onSaved={() => setPaying(null)}
        fields={[{key:'amount',label:t.companyFinance.amount,type:'money',value:paying.outstanding},
          ...(paying.direction === 'payable' ? [{key:'source',label:t.companyFinance.paidFrom,value:'pocket',options:[{value:'pocket',label:t.companyFinance.pocket},{value:'reserve',label:t.companyFinance.reserve},{value:'owner_outside',label:t.companyFinance.ownerOutside},{value:'owner_custody',label:t.financeWorkspace.ownerCustody}]}] : []),
          {key:'reason',label:t.companyFinance.reason}]}
        build={values=>({amount:values.amount,...(paying.direction === 'payable' ? {source:values.source} : {}),occurredOn:today,reason:values.reason})}
        preview={values=><><p>{paying.partyName} · {today}</p><Money value={values.amount ?? ''} currency={paying.currency}/><p>{t.companyFinance.outstanding}: <Money value={paying.outstanding} currency={paying.currency}/></p><p>{paying.direction === 'receivable' ? t.companyFinance.pocket : values.source === 'owner_custody' ? t.financeWorkspace.ownerCustody : values.source === 'owner_outside' ? t.companyFinance.ownerOutside : values.source === 'reserve' ? t.companyFinance.reserve : t.companyFinance.pocket}</p><p>{t.financeWorkspace.debtPaymentEffect}</p><p>{values.reason}</p></>}/></FinanceDialog> : null}
      <details><summary className="cursor-pointer text-brand">{t.companyFinance.addDebt}</summary><div className="mt-3"><Card title={t.companyFinance.addDebt}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field label={t.companyFinance.party}><TextInput required value={partyName} onChange={(event) => setPartyName(event.target.value)} aria-label={t.companyFinance.party} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.companyFinance.direction}><Select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)} aria-label={t.companyFinance.direction}><option value="payable">{t.companyFinance.payable}</option><option value="receivable">{t.companyFinance.receivable}</option></Select></Field>
            <Field label={t.companyFinance.currency}><Select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} aria-label={t.companyFinance.currency}><option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option></Select></Field>
          </div>
          <Field label={t.companyFinance.principal}><MoneyInput required value={principal} onChange={(event) => setPrincipal(event.target.value)} aria-label={t.companyFinance.principal} /></Field>
          <DateField label={t.companyFinance.openedOn} value={openedOn} onChange={setOpenedOn} />
          <DateField label={t.companyFinance.dueOn} value={dueOn} onChange={setDueOn} />
          <Button type="submit" disabled={busy}>{t.companyFinance.addDebt}</Button>
        </form>
      </Card></div></details>
    </div>
  )
}

function AssetVehicleCreator({ onCreated }: { onCreated(vehicle: VehicleOption): void }): ReactNode {
  const { api, t, lang } = useApp()
  const [types, setTypes] = useState<VehicleTypeOption[] | null>(null)
  const [typeId, setTypeId] = useState('')
  const [groundNo, setGroundNo] = useState('')
  const [plateNo, setPlateNo] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setError(null)
    void api.vehicleTypes()
      .then(({ vehicleTypes }) => {
        if (!current) return
        const active = vehicleTypes.filter((type) => type.active)
        setTypes(active)
        if (active.length === 1) setTypeId(active[0]!.id)
      })
      .catch((cause: { error?: string }) => {
        if (!current) return
        setTypes([])
        setError(cause.error ?? 'error')
      })
    return () => { current = false }
  }, [api])

  useEffect(() => {
    let current = true
    setPreview(null)
    if (typeId !== '') {
      void api.nextVehicleNumber(typeId)
        .then((result) => { if (current) setPreview(result.code) })
        .catch(() => { if (current) setPreview(null) })
    }
    return () => { current = false }
  }, [api, typeId])

  const create = async (): Promise<void> => {
    if (typeId === '') return
    setBusy(true)
    setError(null)
    try {
      const vehicle = await api.createVehicle({
        vehicleTypeId: typeId,
        groundNo: groundNo.trim() === '' ? null : groundNo.trim(),
        plateNo: plateNo.trim() === '' ? null : plateNo.trim(),
      })
      onCreated({ id: vehicle.id, code: vehicle.code, groundNo: vehicle.groundNo })
    } catch (cause) {
      setError((cause as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line-strong bg-surface-muted p-3" role="region" aria-label={t.companyFinance.addNewVehicle}>
      <p className="text-sm text-ink-muted">{t.companyFinance.vehicleOnlyHint}</p>
      <Field label={t.fleet.vehicleType}>
        <Select value={typeId} disabled={busy || types === null} onChange={(event) => setTypeId(event.target.value)} aria-label={t.fleet.vehicleType}>
          <option value="">—</option>
          {(types ?? []).map((type) => (
            <option key={type.id} value={type.id}>{type.typeNo} — {lang === 'ar' ? type.nameAr : type.nameEn}</option>
          ))}
        </Select>
      </Field>
      {types?.length === 0 && error === null ? <p className="text-sm text-warning-ink">{t.companyFinance.noActiveVehicleTypes}</p> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t.fleet.groundNo} hint={t.fleet.groundNoHint}>
          <TextInput value={groundNo} disabled={busy} onChange={(event) => setGroundNo(event.target.value)} aria-label={t.fleet.groundNo} />
        </Field>
        <Field label={t.fleet.plateNo}>
          <TextInput value={plateNo} disabled={busy} onChange={(event) => setPlateNo(event.target.value)} aria-label={t.fleet.plateNo} />
        </Field>
      </div>
      {preview ? <p className="text-sm text-ink-muted">{t.fleet.numberPreview}: <span className="num font-semibold text-brand">{preview}</span></p> : null}
      {error ? <p role="alert" className="text-sm text-danger-ink">{explainError(error, t)}</p> : null}
      <Button type="button" className="self-start" disabled={busy || typeId === '' || types === null} onClick={() => void create()}>
        {busy ? t.common.loading : t.companyFinance.createVehicleOnly}
      </Button>
    </div>
  )
}

function AssetsTab({ rows, due, vehicles, today, busy, mutate }: {
  rows: Asset[]
  due: AssetInstallmentDueFeed
  vehicles: CompanyData['vehicles']
  today: string
  busy: boolean
  mutate: Mutate
}): ReactNode {
  const { api, t, branchId } = useApp()
  const [kind, setKind] = useState<Asset['kind']>('equipment')
  const [vehicleId, setVehicleId] = useState('')
  const [createdVehicles, setCreatedVehicles] = useState<VehicleOption[]>([])
  const [showVehicleCreator, setShowVehicleCreator] = useState(false)
  const [vehicleNotice, setVehicleNotice] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState<Currency>('SYP_NEW')
  const [price, setPrice] = useState('')
  const [purchasedOn, setPurchasedOn] = useState(today)
  const [paidNow, setPaidNow] = useState('')
  const [paidFrom, setPaidFrom] = useState<'pocket' | 'reserve' | 'owner_outside' | 'owner_custody' | 'opening'>('pocket')
  const [financedPartyName, setFinancedPartyName] = useState('')
  const [financedDueOn, setFinancedDueOn] = useState('')
  const [scheduleNewAsset, setScheduleNewAsset] = useState(false)
  const [newPlan, setNewPlan] = useState<InstallmentPlanDraft>(() => newInstallmentPlanDraft(due.today || today))
  const availableVehicles = useMemo(() => {
    const byId = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]))
    for (const vehicle of createdVehicles) byId.set(vehicle.id, vehicle)
    return [...byId.values()]
  }, [createdVehicles, vehicles])
  const selectedVehicle = useMemo(
    () => availableVehicles.find((vehicle) => vehicle.id === vehicleId),
    [availableVehicles, vehicleId],
  )

  useEffect(() => {
    setVehicleId('')
    setCreatedVehicles([])
    setShowVehicleCreator(false)
    setVehicleNotice(null)
  }, [branchId])

  const vehicleCreated = (vehicle: VehicleOption): void => {
    setCreatedVehicles((current) => [...current.filter((row) => row.id !== vehicle.id), vehicle])
    setVehicleId(vehicle.id)
    setShowVehicleCreator(false)
    setVehicleNotice(t.companyFinance.vehicleCreatedAndSelected)
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void mutate(() => api.post('/company/assets', {
      idempotencyKey: crypto.randomUUID(), kind, vehicleId: kind === 'vehicle' ? vehicleId : null,
      name: kind === 'vehicle' && selectedVehicle ? selectedVehicle.groundNo ?? selectedVehicle.code : name,
      currency, price, purchasedOn, paidNow, paidFrom,
      description: name || selectedVehicle?.code || t.companyFinance.assetsTitle,
      financedPartyName: financedPartyName === '' ? null : financedPartyName,
      financedDueOn: financedDueOn === '' ? null : financedDueOn,
      financedNote: null,
      ...(scheduleNewAsset ? { installmentPlan: installmentPlanPayload(newPlan) } : {}),
    }), t.companyFinance.saved).then((saved) => {
      if (!saved) return
      setName(''); setPrice(''); setPaidNow(''); setFinancedPartyName(''); setFinancedDueOn('')
      setScheduleNewAsset(false)
      setNewPlan(newInstallmentPlanDraft(due.today || purchasedOn))
    })
  }
  return (
    <div className="flex flex-col gap-4">
      <AssetInstallmentPanel rows={rows} due={due} today={due.today || today} busy={busy} mutate={mutate} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(20rem,1fr)_2fr]">
      <Card title={t.companyFinance.addAsset}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field label={t.companyFinance.assetKind}>
            <Select
              value={kind}
              onChange={(event) => {
                const next = event.target.value as Asset['kind']
                setKind(next)
                if (next !== 'vehicle') {
                  setShowVehicleCreator(false)
                  setVehicleNotice(null)
                }
              }}
              aria-label={t.companyFinance.assetKind}
            >
              <option value="equipment">{t.companyFinance.equipment}</option><option value="property">{t.companyFinance.property}</option><option value="other">{t.companyFinance.other}</option><option value="vehicle">{t.companyFinance.vehicle}</option>
            </Select>
          </Field>
          {kind === 'vehicle' ? (
            <div className="flex flex-col gap-2">
              <Field label={t.companyFinance.vehicle}>
                <Select required value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} aria-label={t.companyFinance.vehicle}>
                  <option value="">—</option>
                  {availableVehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.groundNo ?? vehicle.code}</option>)}
                </Select>
              </Field>
              <Button
                type="button"
                variant="ghost"
                className="self-start"
                onClick={() => {
                  setShowVehicleCreator((current) => !current)
                  setVehicleNotice(null)
                }}
              >
                {showVehicleCreator ? t.common.cancel : t.companyFinance.addNewVehicle}
              </Button>
              {showVehicleCreator ? <AssetVehicleCreator key={branchId ?? 'no-branch'} onCreated={vehicleCreated} /> : null}
              {vehicleNotice ? <p role="status" className="text-sm font-medium text-success-ink">{vehicleNotice}</p> : null}
            </div>
          ) : <Field label={t.companyFinance.name}><TextInput required value={name} onChange={(event) => setName(event.target.value)} aria-label={t.companyFinance.name} /></Field>}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.companyFinance.currency}><Select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} aria-label={t.companyFinance.currency}><option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option></Select></Field>
            <Field label={t.companyFinance.price}><MoneyInput required value={price} onChange={(event) => setPrice(event.target.value)} aria-label={t.companyFinance.price} /></Field>
          </div>
          <DateField label={t.companyFinance.purchasedOn} value={purchasedOn} onChange={(next) => {
            if (newPlan.startsOn === purchasedOn) setNewPlan((current) => ({ ...current, startsOn: next }))
            setPurchasedOn(next)
          }} />
          <Field label={t.companyFinance.paidNow}><MoneyInput required value={paidNow} onChange={(event) => setPaidNow(event.target.value)} aria-label={t.companyFinance.paidNow} /></Field>
          <Field label={t.companyFinance.paidFrom}><Select value={paidFrom} onChange={(event) => setPaidFrom(event.target.value as typeof paidFrom)} aria-label={t.companyFinance.paidFrom}><option value="pocket">{t.companyFinance.pocket}</option><option value="reserve">{t.companyFinance.reserve}</option><option value="owner_outside">{t.companyFinance.ownerOutside}</option><option value="owner_custody">{t.financeWorkspace.ownerCustody}</option><option value="opening">{t.companyFinance.opening}</option></Select></Field>
          <Field label={t.companyFinance.financedParty}><TextInput required={scheduleNewAsset} value={financedPartyName} onChange={(event) => setFinancedPartyName(event.target.value)} aria-label={t.companyFinance.financedParty} /></Field>
          <DateField label={t.companyFinance.financedDue} value={financedDueOn} onChange={setFinancedDueOn} />
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line-strong bg-surface-muted p-3 text-body text-ink">
            <input type="checkbox" checked={scheduleNewAsset} onChange={(event) => setScheduleNewAsset(event.target.checked)} className="mt-0.5 size-4 accent-brand" />
            <span>{t.companyFinance.scheduleInstallments}</span>
          </label>
          {scheduleNewAsset ? <InstallmentPlanFields value={newPlan} onChange={setNewPlan} disabled={busy} /> : null}
          <Button type="submit" disabled={busy}>{t.companyFinance.addAsset}</Button>
        </form>
      </Card>
      <Card title={t.companyFinance.assetsTitle}>
        <Table head={[t.companyFinance.name, t.companyFinance.kind, t.companyFinance.price, t.companyFinance.bookValue, t.companyFinance.outstanding, t.companyFinance.depreciationDue]} isEmpty={rows.length === 0} empty={t.companyFinance.noAssets}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-3 py-2">{row.name}</td><td className="px-3 py-2">{t.companyFinance[row.kind]}</td>
              <td className="px-3 py-2 text-end"><Money value={row.price} currency={row.currency} /></td>
              <td className="px-3 py-2 text-end"><Money value={row.bookValue} currency={row.currency} /></td>
              <td className="px-3 py-2 text-end"><Money value={row.outstanding} currency={row.currency} /></td>
              <td className="px-3 py-2 text-end"><Money value={row.depreciationDue} currency={row.currency} /></td>
            </tr>
          ))}
        </Table>
      </Card>
      </div>
    </div>
  )
}

function DepreciationTab({ plan, busy, mutate }: { plan: DepreciationPlan; busy: boolean; mutate: Mutate }): ReactNode {
  const { api, t } = useApp()
  const transfer = (currency: Currency): void => {
    const amount = plan.currencies[currency].transferAmount
    void mutate(() => api.post('/company/depreciation/transfers', {
      idempotencyKey: crypto.randomUUID(), currency, asOfMonth: plan.asOfMonth,
      expectedAmount: amount, reason: t.companyFinance.depreciationTitle,
    }), t.companyFinance.transferred)
  }
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {(['SYP_NEW', 'USD'] as const).map((currency) => {
        const row = plan.currencies[currency]
        return (
          <Card key={currency} title={`${t.companyFinance.depreciationTitle} · ${t.currency[currency]}`}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label={t.companyFinance.totalDue} value={<Money value={row.totalDue} currency={currency} />} />
              <Stat lead label={t.companyFinance.transferAmount} value={<Money value={row.transferAmount} currency={currency} />} />
              <Stat label={t.companyFinance.remainingDue} value={<Money value={row.remainingDue} currency={currency} />} />
            </div>
            <Button className="mt-3" type="button" disabled={busy || row.transferAmount === '0.00'} onClick={() => transfer(currency)}>{t.companyFinance.transfer}</Button>
          </Card>
        )
      })}
    </div>
  )
}

function RecurringTab({
  rows,
  due,
  categories,
  today,
  busy,
  mutate,
}: {
  rows: RecurringTemplate[]
  due: RecurringDue[]
  categories: CompanyData['categories']
  today: string
  busy: boolean
  mutate: Mutate
}): ReactNode {
  const { api, t } = useApp()
  const requestText = useTextPrompt()
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '')
  const [currency, setCurrency] = useState<Currency>('SYP_NEW')
  const [paidFrom, setPaidFrom] = useState<'pocket' | 'reserve' | 'owner_outside'>('pocket')
  const [amount, setAmount] = useState('')
  const [scheduleKind, setScheduleKind] = useState<'weekly' | 'monthly_first' | 'every_n_days'>('monthly_first')
  const [weekday, setWeekday] = useState(0)
  const [intervalDays, setIntervalDays] = useState('30')
  const [startsOn, setStartsOn] = useState(today)
  const [endsOn, setEndsOn] = useState('')

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void mutate(() => api.post('/company/recurring-expenses', {
      idempotencyKey: crypto.randomUUID(), title, categoryId, costCenterKind: 'general',
      vehicleId: null, assetId: null, currency, paidFrom, amount, scheduleKind,
      weekday: scheduleKind === 'weekly' ? weekday : null,
      intervalDays: scheduleKind === 'every_n_days' ? Number(intervalDays) : null,
      startsOn, endsOn: endsOn === '' ? null : endsOn,
    }), t.expenses.fixedSaved).then(() => { setTitle(''); setAmount('') })
  }
  const pay = (row: RecurringDue): void => {
    void mutate(() => api.post(`/company/recurring-expenses/${row.id}/occurrences/${row.dueDate}/pay`, {
      idempotencyKey: crypto.randomUUID(), amount: row.amount, receiptMediaId: null, reason: null,
    }), t.expenses.paid)
  }
  const skip = (row: RecurringDue): void => {
    void (async () => {
      const reason = await requestText({
        title: t.expenses.skip,
        label: t.expenses.skipReason,
        confirmLabel: t.expenses.skip,
      })
      if (reason === null) return
      await mutate(
        () => api.post(`/company/recurring-expenses/${row.id}/occurrences/${row.dueDate}/skip`, { reason }),
        t.expenses.skipped,
      )
    })()
  }
  const deactivate = (row: RecurringTemplate): void => {
    void (async () => {
      const reason = await requestText({
        title: t.expenses.deactivate,
        label: t.expenses.deactivationReason,
        confirmLabel: t.expenses.deactivate,
        danger: true,
      })
      if (reason === null) return
      await mutate(
        () => api.post(`/company/recurring-expenses/${row.id}/deactivate`, { reason }),
        t.expenses.deactivated,
      )
    })()
  }

  return (
    <div className="flex flex-col gap-4">

      <div className="flex flex-col gap-4">
        <Card title={t.expenses.tabDue}>
          <Table head={[t.expenses.name, t.companyFinance.date, t.companyFinance.amount, t.expenses.actionLabel]} isEmpty={due.length === 0} empty={t.expenses.nothingDue}>
            {due.map((row) => (
              <tr key={`${row.id}:${row.dueDate}`}>
                <td className="px-3 py-2">{row.title}</td>
                <td className="num px-3 py-2">{row.dueDate}</td>
                <td className="px-3 py-2 text-end"><Money value={row.amount} currency={row.currency} /></td>
                <td className="px-3 py-2"><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || row.dueDate > today} onClick={() => pay(row)}>{t.expenses.pay}</Button><Button size="sm" variant="ghost" disabled={busy || row.dueDate > today} onClick={() => skip(row)}>{t.expenses.skip}</Button></div></td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title={t.expenses.fixedTitle}>
          <Table head={[t.expenses.name, t.expenses.recurrence, t.companyFinance.amount, t.expenses.statusLabel]} isEmpty={rows.length === 0} empty={t.expenses.noneFixed}>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="px-3 py-2">{row.title}</td>
                <td className="px-3 py-2">{row.scheduleKind === 'monthly_first' ? t.expenses.monthlyFirst : row.scheduleKind === 'weekly' ? t.expenses.weekly : t.expenses.everyNDays}</td>
                <td className="px-3 py-2 text-end"><Money value={row.amount} currency={row.currency} /></td>
                <td className="px-3 py-2">{row.active ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => deactivate(row)}>{t.expenses.deactivate}</Button> : t.expenses.inactive}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
      <details><summary className="cursor-pointer text-brand">{t.expenses.saveFixed}</summary><div className="mt-3"><Card title={t.expenses.newFixed}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field label={t.expenses.name}><TextInput required value={title} onChange={(event) => setTitle(event.target.value)} aria-label={t.expenses.name} /></Field>
          <Field label={t.expenses.category}><Select required value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label={t.expenses.category}>{categories.map((category) => <option key={category.id} value={category.id}>{category.nameAr} · {category.code}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.companyFinance.currency}><Select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} aria-label={t.companyFinance.currency}><option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option></Select></Field>
            <Field label={t.companyFinance.paidFrom}><Select value={paidFrom} onChange={(event) => setPaidFrom(event.target.value as typeof paidFrom)} aria-label={t.companyFinance.paidFrom}><option value="pocket">{t.companyFinance.pocket}</option><option value="reserve">{t.companyFinance.reserve}</option><option value="owner_outside">{t.companyFinance.ownerOutside}</option></Select></Field>
          </div>
          <Field label={t.companyFinance.amount}><MoneyInput required value={amount} onChange={(event) => setAmount(event.target.value)} aria-label={t.companyFinance.amount} /></Field>
          <Field label={t.expenses.recurrence}><Select value={scheduleKind} onChange={(event) => setScheduleKind(event.target.value as typeof scheduleKind)} aria-label={t.expenses.recurrence}><option value="monthly_first">{t.expenses.monthlyFirst}</option><option value="weekly">{t.expenses.weekly}</option><option value="every_n_days">{t.expenses.everyNDays}</option></Select></Field>
          {scheduleKind === 'weekly' ? <Field label={t.expenses.weekday}><Select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))} aria-label={t.expenses.weekday}>{t.expenses.weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</Select></Field> : null}
          {scheduleKind === 'every_n_days' ? <Field label={t.expenses.intervalDays}><TextInput type="number" min="1" max="366" value={intervalDays} onChange={(event) => setIntervalDays(event.target.value)} aria-label={t.expenses.intervalDays} /></Field> : null}
          <DateField label={t.expenses.startsOn} value={startsOn} onChange={setStartsOn} />
          <DateField label={t.expenses.endsOn} value={endsOn} onChange={setEndsOn} />
          <Button type="submit" disabled={busy || categoryId === ''}>{t.expenses.saveFixed}</Button>
        </form>
      </Card></div></details>
    </div>
  )
}
