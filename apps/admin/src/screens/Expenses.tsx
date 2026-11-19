import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExpenseCategoryView, ExpenseFilter, ExpensePage, IncomeCategoryView, IncomeView } from '@ash/client'
import { type RangeSelection, type RoleKey, can } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { useToast } from '../feedback.tsx'
import { explainError } from '../errors.ts'
import { Button, Card, Field, FinancePagination, FOCUS_RING, Money, MoneyInput, Pending, Select, Table, TextInput } from '../ui.tsx'
import { pendingExpenseOperation, type PendingExpenseOperation } from '../expense-idempotency.ts'
import { uploadExpenseReceipt } from '../receipt-upload.ts'
import { RecurringExpenses } from './RecurringExpenses.tsx'
import { TimeRangeBar, useRangeMeta } from '../components/TimeRangeBar.tsx'
import { paramsFromSelection, resolveSelection, selectionFromParams } from '../time-range.ts'
import { useHashParams } from '../use-hash-params.ts'
import type { RouteParams } from '../route.ts'
import { EXPENSE_PAGE_SIZE, expenseAmountFilterError, expenseExportCsv, expenseFilterParams, expenseFiltersFromParams } from '../expense-filters.ts'

/**
 * Expenses (SRS G) — «كل ليرة تخرج: مصنَّفة وموثَّقة ومنسوبة لمركز كلفتها». Recording is branch
 * manager + GM (not sysadmin, per D-5); category management is settings.write (sysadmin). Every
 * expense posts to the ledger in the same transaction, so this is money — decimal strings only.
 */

interface VehicleLite {
  id: string
  code: string
}
type Kind = 'vehicle' | 'branch' | 'general'

export function Expenses({ initial = {} }: { initial?: RouteParams }): ReactNode {
  const { api, t, lang, session, branchId } = useApp()
  const toast = useToast()
  const text = (ar: string, en: string): string => lang === 'ar' ? ar : en
  const [result, setResult] = useState<{ key: string; data: ExpensePage } | null>(null)
  const [earliest, setEarliest] = useState<{ scope: string; date: string | null } | null>(null)
  const [readError, setReadError] = useState<{ key: string; code: string } | null>(null)
  const [cats, setCats] = useState<ExpenseCategoryView[]>([])
  const [vehicles, setVehicles] = useState<VehicleLite[]>([])
  const [screenTab, setScreenTab] = useState<'log' | 'due' | 'templates'>(initial.tab === 'due' || initial.tab === 'templates' ? initial.tab : 'log')
  const [selection, setSelection] = useState<RangeSelection>(() => selectionFromParams(initial) ?? { preset: 'today' })
  const [filters, setFilters] = useState<ExpenseFilter>(() => expenseFiltersFromParams(initial))
  const [page, setPage] = useState(Number(initial.page ?? '1'))
  const [advanced, setAdvanced] = useState(Boolean(initial.costCenterKind || initial.vehicle || initial.expenseChannel || initial.receipt || initial.minAmount || initial.maxAmount))
  const [revision, setRevision] = useState(0)
  const [exportBusy, setExportBusy] = useState(false)
  const replaceParams = useHashParams()
  const { meta, error: metaError, retry: retryMeta } = useRangeMeta()
  const scopeKey = JSON.stringify([session?.userId, branchId])
  const range = useMemo(() => meta ? resolveSelection(selection, meta) : null, [selection, meta])
  const amountError = expenseAmountFilterError(filters)
  const { q: rawQuery, ...otherFilters } = filters
  const requestFilter: ExpenseFilter | null = range ? {
    ...otherFilters, ...(rawQuery?.trim() ? { q: rawQuery.trim() } : {}), ...(selection.preset === 'all' ? { all: true, to: range.to } : range),
    limit: EXPENSE_PAGE_SIZE, offset: (page - 1) * EXPENSE_PAGE_SIZE,
  } : null
  const readKey = JSON.stringify([session?.userId, branchId, requestFilter, revision])
  const data = result?.key === readKey ? result.data : null
  const error = readError?.key === readKey ? readError.code : null
  const rows = data?.expenses ?? []
  const load = useCallback(() => setRevision((value) => value + 1), [])
  const changeFilters = (patch: { [K in keyof ExpenseFilter]?: ExpenseFilter[K] | undefined }): void => {
    setFilters((previous) => {
      const next = { ...previous, ...patch }
      if ('costCenterKind' in patch && patch.costCenterKind !== 'vehicle') delete next.vehicleId
      return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== '' && value !== undefined)) as ExpenseFilter
    })
    setPage(1)
  }
  useEffect(() => {
    const params = paramsFromSelection(selection)
    replaceParams({ ...expenseFilterParams(filters, page), range: params.range,
      ...(params.from === undefined ? {} : { from: params.from }), ...(params.to === undefined ? {} : { to: params.to }),
      ...(screenTab === 'log' ? {} : { tab: screenTab }),
    })
  }, [replaceParams, selection, filters, page, screenTab])

  const [categoryId, setCategoryId] = useState('')
  const [kind, setKind] = useState<Kind>('general')
  const [vehicleId, setVehicleId] = useState('')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [receiptMediaId, setReceiptMediaId] = useState<string | null>(null)
  const [receiptBusy, setReceiptBusy] = useState(false)
  const pendingExpense = useRef<PendingExpenseOperation | null>(null)

  const [catCode, setCatCode] = useState('')
  const [catName, setCatName] = useState('')

  /*
   * «الحركات المالية» — one place for the money a branch manager records.
   *
   * `expense` and `income` are the same act in opposite directions, so they share this screen and
   * this date range. Receivables keep their own card in the treasury screen: their client-side
   * outbox (mutex + durable storage, `receivable-idempotency.ts`) is what stops a lost response
   * charging a driver twice, and a second copy of that machinery is not worth the risk.
   */
  const [mode, setMode] = useState<'expense' | 'income' | 'advance'>('expense')
  const [incomeResult, setIncomeResult] = useState<{ key: string; rows: IncomeView[]; total: string } | null>(null)
  const [incomeReadError, setIncomeReadError] = useState<{ key: string; code: string } | null>(null)
  const incomeRows = incomeResult?.key === readKey ? incomeResult.rows : []
  const incomeTotal = incomeResult?.key === readKey ? incomeResult.total : null
  const incomeError = incomeReadError?.key === readKey ? incomeReadError.code : null
  const [incomeCats, setIncomeCats] = useState<IncomeCategoryView[]>([])
  const [incomeCategoryId, setIncomeCategoryId] = useState('')
  const [channel, setChannel] = useState<'office_cash' | 'office_wallet'>('office_cash')
  const pendingIncomeKey = useRef<string | null>(null)

  /*
   * «السلفة» — an expense that must come back (owner decision 17).
   *
   * It lives here because it is RECORDED like a صرفية: same category, same cost centre, same
   * receipt. It is READ from the treasury screen, because while it is outstanding it is still
   * office capital. It reuses `amount` and `description` with the other two directions; what it
   * adds is a party and a channel.
   */
  const [partyName, setPartyName] = useState('')
  const [advanceParties, setAdvanceParties] = useState<Array<{ partyName: string; partyKey: string }>>([])
  const pendingAdvanceKey = useRef<string | null>(null)

  /*
   * ASK THE RULE, do not restate it.
   *
   * This read `roleKey === 'branch_manager' || 'general_manager'`, which owner decision 9 made
   * wrong on 2026-08-12: the system admin holds `expense.write` at scope 'all' and was shown a
   * read-only screen anyway. Exactly the bug already found and fixed in Dashboard.tsx.
   */
  const canWrite =
    session != null &&
    can(
      { userId: session.userId, roleKey: session.roleKey as RoleKey, branchId: session.branchId },
      'expense.write',
      { branchId: branchId ?? session.branchId },
    ).allowed
  const isSysadmin = session?.roleKey === 'system_admin'
  const channelLabel = (value: 'office_cash' | 'office_wallet'): string =>
    value === 'office_cash' ? t.glossary.finance.officeCash : t.glossary.finance.officeWallet

  useEffect(() => {
    if (!requestFilter || amountError || metaError) return
    let active = true
    const controller = new AbortController()
    setResult(null); setReadError(null); setIncomeResult(null); setIncomeReadError(null)
    void api.expenses(requestFilter, undefined, { signal: controller.signal }).then((next) => {
      if (!active) return
      // A malicious/stale response must not be displayed under another branch's heading.
      if (branchId && next.branchId !== branchId) throw { error: 'expense_read_scope_mismatch' }
      setResult({ key: readKey, data: next })
      setEarliest({ scope: scopeKey, date: next.earliestBusinessDate })
      // The shared period is explicit. Category/centre/channel filters belong to expenses only.
      void api.get<{ incomes: IncomeView[]; total: string }>(`/incomes?from=${encodeURIComponent(next.from)}&to=${encodeURIComponent(next.to)}`, { signal: controller.signal })
        .then((income) => { if (active) setIncomeResult({ key: readKey, rows: income.incomes, total: income.total }) })
        .catch((cause: { name?: string; error?: string }) => { if (active && cause.name !== 'AbortError') setIncomeReadError({ key: readKey, code: cause.error ?? 'error' }) })
    }).catch((cause: { name?: string; error?: string }) => {
      if (active && cause.name !== 'AbortError') setReadError({ key: readKey, code: cause.error ?? 'error' })
    })
    return () => { active = false; controller.abort() }
    // readKey includes the complete filter, branch, actor and retry version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, readKey, amountError, metaError])
  useEffect(() => {
    let active = true
    setCats([]); setVehicles([]); setIncomeCats([]); setAdvanceParties([])
    void api.expenseCategories(true).then((next) => { if (active) setCats(next.categories) }).catch(() => undefined)
    void api.get<{ vehicles: VehicleLite[] }>('/vehicles').then((next) => { if (active) setVehicles(next.vehicles) }).catch(() => undefined)
    void api.incomeCategories().then((next) => { if (active) setIncomeCats(next.categories) }).catch(() => undefined)
    void api.advances().then((next) => { if (active) setAdvanceParties(next.parties) }).catch(() => undefined)
    return () => { active = false }
  }, [api, branchId, session?.userId, revision])

  const exportRows = async (): Promise<void> => {
    if (!requestFilter || !data || amountError || exportBusy) return
    const key = readKey
    setExportBusy(true)
    const controller = new AbortController()
    exportRequest.current = controller
    try {
      const exported = await api.exportExpenses(requestFilter, { signal: controller.signal })
      // Changing scope while an export is in flight must never download stale data as current.
      if (exportScope.current !== key) return
      if (branchId && exported.branchId !== branchId) throw { error: 'expense_read_scope_mismatch' }
      const url = URL.createObjectURL(new Blob(['\ufeff', expenseExportCsv(exported)], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a'); link.href = url
      link.download = `branch-expenses-${exported.from}-${exported.to}.csv`
      link.click(); URL.revokeObjectURL(url)
    } catch (cause) {
      if (exportScope.current === key) toast.error(explainError((cause as { error?: string }).error ?? 'error', t))
    } finally { setExportBusy(false) }
  }
  const exportScope = useRef(readKey)
  const exportRequest = useRef<AbortController | null>(null)
  exportScope.current = readKey
  useEffect(() => { exportRequest.current?.abort() }, [readKey])
  useEffect(() => () => { exportScope.current = ''; exportRequest.current?.abort() }, [])
  useEffect(() => {
    if (data && page > Math.max(1, Math.ceil(data.count / EXPENSE_PAGE_SIZE))) setPage(Math.max(1, Math.ceil(data.count / EXPENSE_PAGE_SIZE)))
  }, [data, page])

  const catName_ = (id: string): string => cats.find((c) => c.id === id)?.nameAr ?? id.slice(0, 8)
  const vehicleCode = (id: string | null): string => (id === null ? '—' : (vehicles.find((v) => v.id === id)?.code ?? id.slice(0, 8)))
  const kindLabel = (k: string): string => (k === 'vehicle' ? t.expenses.kindVehicle : k === 'branch' ? t.expenses.kindBranch : t.expenses.kindGeneral)

  const add = async (): Promise<void> => {
    setBusy(true)
    setFormError(null)
    const payload = {
      categoryId,
      costCenterKind: kind,
      vehicleId: kind === 'vehicle' ? vehicleId : null,
      channel,
      amount,
      description,
      receiptMediaId,
    }
    const operation = pendingExpenseOperation(pendingExpense.current, payload)
    pendingExpense.current = operation
    try {
      await api.createExpense({
        ...payload,
        idempotencyKey: operation.idempotencyKey,
      })
      pendingExpense.current = null
      toast.success(t.expenses.added)
      setAmount('')
      setDescription('')
      setReceiptMediaId(null)
      load()
    } catch (e) {
      const code = (e as { error?: string }).error ?? 'error'
      // A key conflict is definitive. Transport failures keep the key so a tap after a lost
      // response asks the server for the same operation instead of spending twice.
      if (code === 'idempotency_key_conflict') pendingExpense.current = null
      setFormError(code)
    } finally {
      setBusy(false)
    }
  }

  const addIncome = async (): Promise<void> => {
    setBusy(true)
    setFormError(null)
    // The key is held across a failed attempt for the same reason as the expense one: a tap after
    // a lost response must ask the server for the SAME operation rather than record a second one.
    const key = pendingIncomeKey.current ?? crypto.randomUUID()
    pendingIncomeKey.current = key
    try {
      await api.createIncome({
        idempotencyKey: key,
        categoryId: incomeCategoryId,
        channel,
        amount,
        description,
      })
      pendingIncomeKey.current = null
      toast.success(t.incomes.added)
      setAmount('')
      setDescription('')
      load()
    } catch (e) {
      const code = (e as { error?: string }).error ?? 'error'
      if (code === 'idempotency_key_conflict') pendingIncomeKey.current = null
      setFormError(code)
    } finally {
      setBusy(false)
    }
  }

  const addAdvance = async (): Promise<void> => {
    setBusy(true)
    setFormError(null)
    // Same key discipline as the other two: held across a failed attempt, so a tap after a lost
    // response asks the server for the SAME advance rather than handing the money over twice.
    const key = pendingAdvanceKey.current ?? crypto.randomUUID()
    pendingAdvanceKey.current = key
    try {
      await api.createAdvance({
        idempotencyKey: key,
        partyName,
        categoryId,
        costCenterKind: kind,
        vehicleId: kind === 'vehicle' ? vehicleId : null,
        channel,
        amount,
        description,
        receiptMediaId,
      })
      pendingAdvanceKey.current = null
      toast.success(t.treasury.advanceAdded)
      setAmount('')
      setDescription('')
      setPartyName('')
      setReceiptMediaId(null)
      load()
    } catch (e) {
      const code = (e as { error?: string }).error ?? 'error'
      if (code === 'idempotency_key_conflict') pendingAdvanceKey.current = null
      setFormError(code)
    } finally {
      setBusy(false)
    }
  }

  const addCategory = async (): Promise<void> => {
    try {
      await api.createExpenseCategory({ code: catCode, nameAr: catName })
      setCatCode('')
      setCatName('')
      load()
    } catch (e) {
      toast.error(explainError((e as { error?: string }).error ?? 'error', t))
    }
  }

  const uploadReceipt = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    if (!file) return
    setReceiptBusy(true)
    setFormError(null)
    try {
      setReceiptMediaId(await uploadExpenseReceipt(api, file))
    } catch (cause) {
      setFormError((cause as { error?: string }).error ?? 'error')
    } finally {
      setReceiptBusy(false)
      event.target.value = ''
    }
  }

  const tabs = (
    <div className="flex gap-2" role="tablist" aria-label={t.expenses.title}>
      {(['log', 'due', 'templates'] as const).map((tab) => (
        <Button
          key={tab}
          role="tab"
          id={`expenses-tab-${tab}`}
          aria-controls={`expenses-panel-${tab}`}
          aria-selected={screenTab === tab}
          variant={screenTab === tab ? 'primary' : 'ghost'}
          onClick={() => setScreenTab(tab)}
        >
          {tab === 'log' ? t.expenses.tabLog : tab === 'due' ? t.expenses.tabDue : t.expenses.tabFixed}
        </Button>
      ))}
    </div>
  )

  if (screenTab !== 'log') {
    return (
      <div className="flex flex-col gap-4">
        {tabs}
        <div id={`expenses-panel-${screenTab}`} role="tabpanel" aria-labelledby={`expenses-tab-${screenTab}`}>
          <RecurringExpenses
            view={screenTab === 'due' ? 'due' : 'templates'}
            categories={cats.filter((category) => category.active)}
            vehicles={vehicles}
            canWrite={canWrite}
          />
        </div>
      </div>
    )
  }

  const ready =
    mode === 'income'
      ? incomeCategoryId !== '' && amount.trim() !== '' && description.trim() !== ''
      : categoryId !== '' &&
        amount.trim() !== '' &&
        description.trim() !== '' &&
        (kind !== 'vehicle' || vehicleId !== '') &&
        (mode !== 'advance' || partyName.trim() !== '')

  return (
    <div className="flex flex-col gap-4">
      {tabs}
      <div id="expenses-panel-log" role="tabpanel" aria-labelledby="expenses-tab-log" className="flex flex-col gap-4">
      {canWrite ? (
        <Card title={t.movements.add}>
          <div className="flex flex-col gap-3">
            {/* One form, two directions. Money out and money in are the same act of recording. */}
            <div className="flex flex-wrap gap-2" role="group" aria-label={t.movements.add}>
              {(['expense', 'income', 'advance'] as const).map((m) => (
                <Button
                  key={m}
                  variant={mode === m ? 'primary' : 'ghost'}
                  onClick={() => {
                    setMode(m)
                    setFormError(null)
                    setReceiptMediaId(null)
                  }}
                >
                  {m === 'expense'
                    ? t.movements.modeExpense
                    : m === 'income'
                      ? t.glossary.finance.revenue
                      : t.treasury.advances}
                </Button>
              ))}
              <a className={`ms-auto self-center text-body font-medium text-brand underline ${FOCUS_RING}`} href="#treasury">
                {t.movements.receivablesElsewhere}
              </a>
            </div>

            {mode === 'income' ? (
              <div className="flex flex-wrap gap-3">
                <Field label={t.expenses.category}>
                  <Select value={incomeCategoryId} onChange={(e) => setIncomeCategoryId(e.target.value)}>
                    <option value="">—</option>
                    {incomeCats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nameAr}
                      </option>
                    ))}
                  </Select>
                </Field>
                {/* WHICH BOX received it — a physical fact, never a ledger fund code. */}
                <Field label={t.movements.channel}>
                  <Select
                    value={channel}
                    onChange={(e) => setChannel(e.target.value as 'office_cash' | 'office_wallet')}
                  >
                    <option value="office_cash">{channelLabel('office_cash')}</option>
                    <option value="office_wallet">{channelLabel('office_wallet')}</option>
                  </Select>
                </Field>
                <Field label={t.expenses.amount}>
                  <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32" />
                </Field>
              </div>
            ) : (
            <div className="flex flex-wrap gap-3">
              {mode === 'advance' ? (
                <>
                  {/*
                    Free text by the owner's own choice. The datalist offers names already used at
                    this branch so «أبو محمد» does not become two rows in the outstanding list —
                    but no money depends on the match: every balance is per advance.
                  */}
                  <Field label={t.treasury.advanceParty}>
                    <TextInput
                      value={partyName}
                      onChange={(e) => setPartyName(e.target.value)}
                      list="advance-parties"
                      className="w-44"
                    />
                    <datalist id="advance-parties">
                      {advanceParties.map((p) => (
                        <option key={p.partyKey} value={p.partyName} />
                      ))}
                    </datalist>
                  </Field>
                  {/* WHICH BOX pays. A repayment must later return to this same box. */}
                  <Field label={t.movements.channel}>
                    <Select
                      value={channel}
                      onChange={(e) => setChannel(e.target.value as 'office_cash' | 'office_wallet')}
                    >
                      <option value="office_cash">{channelLabel('office_cash')}</option>
                      <option value="office_wallet">{channelLabel('office_wallet')}</option>
                    </Select>
                  </Field>
                </>
              ) : null}
              <Field label={t.expenses.category}>
                <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">—</option>
                  {cats.filter((category) => category.active).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nameAr}
                    </option>
                  ))}
                </Select>
              </Field>
              {mode === 'expense' ? (
                <Field label={t.movements.channel}>
                  <Select
                    value={channel}
                    onChange={(e) => setChannel(e.target.value as 'office_cash' | 'office_wallet')}
                  >
                    <option value="office_cash">{channelLabel('office_cash')}</option>
                    <option value="office_wallet">{channelLabel('office_wallet')}</option>
                  </Select>
                </Field>
              ) : null}
              <Field label={t.expenses.costCenter}>
                <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  <option value="general">{t.expenses.kindGeneral}</option>
                  <option value="branch">{t.expenses.kindBranch}</option>
                  <option value="vehicle">{t.expenses.kindVehicle}</option>
                </Select>
              </Field>
              {kind === 'vehicle' ? (
                <Field label={t.expenses.vehicle}>
                  <Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                    <option value="">—</option>
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.code}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <Field label={t.expenses.amount}>
                <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32" />
              </Field>
            </div>
            )}
            <Field label={t.expenses.description}>
              <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            {mode !== 'income' ? (
              <Field label={t.expenses.receipt}>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => void uploadReceipt(event)}
                  className="max-w-72 text-sm"
                />
                <span className="text-xs text-ink-muted">
                  {receiptBusy
                    ? t.expenses.receiptUploading
                    : receiptMediaId
                      ? t.expenses.receiptUploaded
                      : t.expenses.chooseReceipt}
                </span>
              </Field>
            ) : null}
            {formError ? <p role="alert" className="text-body text-danger-ink">{explainError(formError, t)}</p> : null}
            <Button
              variant="primary"
              className="self-start"
              disabled={busy || receiptBusy || !ready}
              onClick={mode === 'expense' ? add : mode === 'income' ? addIncome : addAdvance}
            >
              {mode === 'expense' ? t.expenses.add : mode === 'income' ? t.incomes.add : t.treasury.advanceAdd}
            </Button>
            {mode === 'advance' ? (
              <p className="text-label text-ink-secondary">{t.treasury.advancesHint}</p>
            ) : null}
            {/*
              Entries must be recorded BEFORE the box is counted: the server refuses a restoration
              whose count no longer matches the ledger (`cash_count_stale`), and there is no route
              to count a day twice. Saying so here is cheaper than discovering it at the restoration
              button — the count and restoration live on the treasury screen.
            */}
            <p className="text-label text-ink-muted">{t.movements.beforeCountHint}</p>
          </div>
        </Card>
      ) : null}

      <Card title={t.expenses.title}>
        <TimeRangeBar selection={selection} onChange={(next) => { setSelection(next); setPage(1) }}
          meta={meta ? { ...meta, goLiveBusinessDate: null, firstActivityDate: earliest?.scope === scopeKey ? earliest.date : null, epoch: (earliest?.scope === scopeKey ? earliest.date : null) ?? meta.today } : null}
          metaError={metaError} onRetryMeta={retryMeta} />
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label={text('تصفية حسب الفئة', 'Filter by category')}>
            <Select value={filters.categoryId ?? ''} onChange={(event) => changeFilters({ categoryId: event.target.value })}>
              <option value="">{text('كل الفئات', 'All categories')}</option>
              {cats.map((category) => <option key={category.id} value={category.id}>{category.nameAr}{category.active ? '' : text(' — غير نشطة', ' — inactive')}</option>)}
            </Select>
          </Field>
          <Field label={text('بحث في الوصف أو مرجع الصرفية', 'Search description or expense reference')}>
            <TextInput type="search" value={filters.q ?? ''} maxLength={200} onChange={(event) => changeFilters({ q: event.target.value })} />
          </Field>
          <Button variant="ghost" aria-expanded={advanced} aria-controls="branch-expense-advanced" onClick={() => setAdvanced((value) => !value)}>{text('فلاتر إضافية', 'More filters')}</Button>
          <Button variant="ghost" onClick={() => { setFilters({}); setSelection({ preset: 'today' }); setPage(1) }}>{text('مسح الفلاتر — اليوم', 'Clear filters — today')}</Button>
          <Button variant="ghost" disabled={!data || Boolean(error || amountError || metaError) || exportBusy} onClick={() => void exportRows()}>{exportBusy ? t.common.loading : text('تصدير كل النتائج CSV', 'Export all results CSV')}</Button>
        </div>
        {advanced ? <div id="branch-expense-advanced" className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={text('تصفية حسب مركز الكلفة', 'Filter by cost centre')}>
            <Select value={filters.costCenterKind ?? ''} onChange={(event) => changeFilters({ costCenterKind: event.target.value as ExpenseFilter['costCenterKind'] })}>
              <option value="">{text('كل المراكز', 'All centres')}</option>
              <option value="general">{t.expenses.kindGeneral}</option><option value="branch">{t.expenses.kindBranch}</option><option value="vehicle">{t.expenses.kindVehicle}</option>
              <option value="operating">{text('عام وفرع — دون الآليات', 'General and branch — no vehicles')}</option>
            </Select>
          </Field>
          {filters.costCenterKind === 'vehicle' ? <Field label={text('تصفية حسب الآلية', 'Filter by vehicle')}><Select value={filters.vehicleId ?? ''} onChange={(event) => changeFilters({ vehicleId: event.target.value })}>
            <option value="">{text('كل الآليات', 'All vehicles')}</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.code}</option>)}
          </Select></Field> : null}
          <Field label={text('تصفية حسب قناة الدفع', 'Filter by payment channel')}><Select value={filters.channel ?? ''} onChange={(event) => changeFilters({ channel: event.target.value as ExpenseFilter['channel'] })}>
            <option value="">{text('كل القنوات', 'All channels')}</option><option value="office_cash">{channelLabel('office_cash')}</option><option value="office_wallet">{channelLabel('office_wallet')}</option>
          </Select></Field>
          <Field label={text('وجود مستند', 'Receipt availability')}><Select value={filters.receipt ?? ''} onChange={(event) => changeFilters({ receipt: event.target.value as ExpenseFilter['receipt'] })}>
            <option value="">{text('الكل', 'All')}</option><option value="with">{text('مع مستند', 'With receipt')}</option><option value="without">{text('دون مستند', 'Without receipt')}</option>
          </Select></Field>
          <Field label={text('أقل مبلغ — ليرة جديدة', 'Minimum amount — new SYP')}><MoneyInput value={filters.minAmount ?? ''} onChange={(event) => changeFilters({ minAmount: event.target.value })} /></Field>
          <Field label={text('أكبر مبلغ — ليرة جديدة', 'Maximum amount — new SYP')}><MoneyInput value={filters.maxAmount ?? ''} onChange={(event) => changeFilters({ maxAmount: event.target.value })} /></Field>
        </div> : null}
        {Object.entries(filters).length ? <div className="mb-3 flex flex-wrap gap-2" aria-label={text('الفلاتر النشطة', 'Active filters')}>
          {Object.entries(filters).map(([field, value]) => <Button size="sm" variant="ghost" key={field} onClick={() => changeFilters({ [field]: '' })}>
            {field === 'categoryId' ? `${t.expenses.category}: ${catName_(String(value))}` : field === 'costCenterKind' ? `${t.expenses.costCenter}: ${value === 'operating' ? text('عام وفرع', 'General and branch') : kindLabel(String(value))}` : field === 'vehicleId' ? `${t.expenses.vehicle}: ${vehicleCode(String(value))}` : field === 'channel' ? channelLabel(value as 'office_cash' | 'office_wallet') : field === 'receipt' ? value === 'with' ? text('مع مستند', 'With receipt') : text('دون مستند', 'Without receipt') : field === 'minAmount' ? `${text('من مبلغ', 'Minimum')}: ${value}` : field === 'maxAmount' ? `${text('إلى مبلغ', 'Maximum')}: ${value}` : String(value)} ×
          </Button>)}
        </div> : null}
        <p className="mb-3 text-label text-ink-muted">{text('صرفيات الفرع بالليرة الجديدة. مجموع المبالغ المسجلة قبل العكس اللاحق؛ ليس صافي ربح الفترة ولا مجموع النقد الخارج. تحويل سلفة إلى مصروف لا يخرج نقداً جديداً.', 'Branch expenses in new SYP. Recorded amounts before later reversals; not period profit or total cash outflow. Converting an advance to an expense creates no new cash outflow.')}</p>
        <div className="mb-3 flex flex-wrap items-center gap-3" aria-live="polite">
          <span className="ms-auto text-body text-ink-secondary">
            {text('مجموع كامل النتائج', 'Total of all matching records')}: {data && !amountError && !metaError ? <Money value={data.total} className="font-semibold" /> : '—'}
            {data && !amountError && !metaError ? <span className="ms-3">{text('عدد النتائج', 'Matching records')}: <bdi>{data.count}</bdi></span> : null}
          </span>
        </div>
        {amountError ? <p role="alert" className="text-body text-danger-ink">{amountError === 'amount_order' ? text('أقل مبلغ يجب ألا يتجاوز أكبر مبلغ.', 'Minimum amount must not exceed maximum.') : text('اكتب مبلغاً غير سالب بدقة منزلتين كحد أقصى.', 'Enter a non-negative amount with at most two decimal places.')}</p>
          : !data || error || metaError ? <Pending error={error ?? metaError} loadingLabel={t.common.loading} errorLabel={explainError(error ?? metaError, t)} onRetry={() => { load(); if (metaError) retryMeta() }} retryLabel={t.common.retry} /> : <>
        <Table head={[t.glossary.time.businessDay, t.expenses.category, t.expenses.costCenter, text('قناة الدفع', 'Payment channel'), t.expenses.description, { label: text('المبلغ المسجل', 'Recorded amount'), numeric: true }]} isEmpty={rows.length === 0} empty={t.expenses.none}>
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="num px-3 py-2 text-ink-muted">{e.businessDate}</td>
              <td className="px-3 py-2">{e.categoryNameAr ?? catName_(e.categoryId)}</td>
              <td className="px-3 py-2">
                {kindLabel(e.costCenterKind)}
                {e.costCenterKind === 'vehicle' ? ` · ${e.vehicleCode ?? vehicleCode(e.vehicleId)}` : ''}
              </td>
              <td className="px-3 py-2">{channelLabel(e.channel ?? 'office_cash')}</td>
              <td className="px-3 py-2 text-ink-secondary">{e.description}{e.advanceId ? <span className="block text-label text-ink-muted">{text('تحويل سلفة إلى مصروف — دون نقد جديد', 'Advance converted to expense — no new cash')}</span> : null}</td>
              <td className="px-3 py-2"><Money value={e.amount} /></td>
            </tr>
          ))}
        </Table>
        <FinancePagination page={page - 1} total={data.count} pageSize={EXPENSE_PAGE_SIZE} onChange={value => setPage(value + 1)} />
        </>}
      </Card>

      <Card title={t.glossary.finance.revenue}>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <span className="ms-auto text-body text-ink-secondary">
            {t.expenses.total}: {incomeTotal !== null && !amountError && !metaError ? <Money value={incomeTotal} className="font-semibold" /> : '—'}
          </span>
        </div>
        <p className="mb-3 text-label text-ink-muted">{text('الإيرادات للفترة المعروضة نفسها؛ فلاتر الصرفيات الإضافية لا تُطبّق عليها.', 'Income uses the displayed period; additional expense filters do not apply to income.')}</p>
        {amountError ? null : incomeTotal === null || incomeError || metaError || error ? <Pending error={incomeError ?? error ?? metaError} loadingLabel={t.common.loading} errorLabel={explainError(incomeError ?? error ?? metaError, t)} onRetry={load} retryLabel={t.common.retry} /> : <Table
          head={[t.glossary.time.businessDay, t.expenses.category, t.treasuryMovements.channel, t.expenses.description, t.expenses.amount]}
          isEmpty={incomeRows.length === 0}
          empty={t.incomes.none}
        >
          {incomeRows.map((e) => (
            <tr key={e.id}>
              <td className="num px-3 py-2 text-ink-muted">{e.businessDate}</td>
              <td className="px-3 py-2">{incomeCats.find((c) => c.id === e.categoryId)?.nameAr ?? e.categoryId.slice(0, 8)}</td>
              <td className="px-3 py-2">
                {channelLabel(e.channel)}
              </td>
              <td className="px-3 py-2 text-ink-secondary">{e.description}</td>
              <td className="px-3 py-2"><Money value={e.amount} /></td>
            </tr>
          ))}
        </Table>}
      </Card>

      {isSysadmin ? (
        <Card title={t.expenses.manageCategories}>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t.expenses.categoryCode}>
              <TextInput value={catCode} onChange={(e) => setCatCode(e.target.value)} className="w-28" />
            </Field>
            <Field label={t.expenses.categoryName}>
              <TextInput value={catName} onChange={(e) => setCatName(e.target.value)} />
            </Field>
            <Button variant="ghost" disabled={!catCode || !catName} onClick={addCategory}>
              {t.expenses.addCategory}
            </Button>
          </div>
        </Card>
      ) : null}
      </div>
    </div>
  )
}
