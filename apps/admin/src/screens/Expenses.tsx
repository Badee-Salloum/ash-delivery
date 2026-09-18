import { type ChangeEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { ExpenseCategoryView, ExpenseView, IncomeCategoryView, IncomeView } from '@ash/client'
import { type RoleKey, can } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { useToast } from '../feedback.tsx'
import { explainError } from '../errors.ts'
import { Button, Card, DateField, Field, Money, MoneyInput, Pending, Select, Table, TextInput } from '../ui.tsx'
import { pendingExpenseOperation, type PendingExpenseOperation } from '../expense-idempotency.ts'
import { uploadExpenseReceipt } from '../receipt-upload.ts'
import { RecurringExpenses } from './RecurringExpenses.tsx'

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

export function Expenses(): ReactNode {
  const { api, t, session, branchId } = useApp()
  const toast = useToast()
  const [rows, setRows] = useState<ExpenseView[] | null>(null)
  const [total, setTotal] = useState('0.00')
  const [cats, setCats] = useState<ExpenseCategoryView[]>([])
  const [vehicles, setVehicles] = useState<VehicleLite[]>([])
  const [error, setError] = useState<string | null>(null)
  const [screenTab, setScreenTab] = useState<'log' | 'due' | 'templates'>('log')

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

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
  const [incomeRows, setIncomeRows] = useState<IncomeView[]>([])
  const [incomeTotal, setIncomeTotal] = useState('0.00')
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

  const load = useCallback(() => {
    setError(null)
    void api
      .expenses(from || undefined, to || undefined)
      .then((r) => {
        setRows(r.expenses)
        setTotal(r.total)
      })
      .catch((e: { error?: string }) => {
        setRows([])
        setError(e.error ?? 'error')
      })
    void api.expenseCategories().then((r) => setCats(r.categories)).catch(() => undefined)
    void api.get<{ vehicles: VehicleLite[] }>('/vehicles').then((r) => setVehicles(r.vehicles)).catch(() => undefined)
    void api
      .incomes(from || undefined, to || undefined)
      .then((r) => {
        setIncomeRows(r.incomes)
        setIncomeTotal(r.total)
      })
      .catch(() => setIncomeRows([]))
    void api.incomeCategories().then((r) => setIncomeCats(r.categories)).catch(() => undefined)
    // Names already used at this branch, so the manager picks rather than retypes. Nothing
    // financial rests on the match — every advance balance is keyed by the advance itself.
    void api.advances().then((r) => setAdvanceParties(r.parties)).catch(() => undefined)
  }, [api, from, to])
  useEffect(load, [load, branchId])

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
        <RecurringExpenses
          view={screenTab === 'due' ? 'due' : 'templates'}
          categories={cats}
          vehicles={vehicles}
          canWrite={canWrite}
        />
      </div>
    )
  }

  if (!rows) {
    return <div className="flex flex-col gap-4">{tabs}<Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={load} retryLabel={t.common.retry} /></div>
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
                      ? t.movements.modeIncome
                      : t.treasury.advances}
                </Button>
              ))}
              <a className="ms-auto self-center text-sm text-sky-700 underline" href="#treasury">
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
                    <option value="office_cash">{t.movements.channelCash}</option>
                    <option value="office_wallet">{t.movements.channelWallet}</option>
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
                      <option value="office_cash">{t.movements.channelCash}</option>
                      <option value="office_wallet">{t.movements.channelWallet}</option>
                    </Select>
                  </Field>
                </>
              ) : null}
              <Field label={t.expenses.category}>
                <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">—</option>
                  {cats.map((c) => (
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
                    <option value="office_cash">{t.movements.channelCash}</option>
                    <option value="office_wallet">{t.movements.channelWallet}</option>
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
            {formError ? <p className="text-sm text-red-600">{explainError(formError, t)}</p> : null}
            <Button
              variant="primary"
              className="self-start"
              disabled={busy || receiptBusy || !ready}
              onClick={mode === 'expense' ? add : mode === 'income' ? addIncome : addAdvance}
            >
              {mode === 'expense' ? t.expenses.add : mode === 'income' ? t.incomes.add : t.treasury.advanceAdd}
            </Button>
            {mode === 'advance' ? (
              <p className="text-xs text-slate-600">{t.treasury.advancesHint}</p>
            ) : null}
            {/*
              Entries must be recorded BEFORE the box is counted: the server refuses a restoration
              whose count no longer matches the ledger (`cash_count_stale`), and there is no route
              to count a day twice. Saying so here is cheaper than discovering it at the restoration
              button — the count and restoration live on the treasury screen.
            */}
            <p className="text-xs text-slate-500">{t.movements.beforeCountHint}</p>
          </div>
        </Card>
      ) : null}

      <Card title={t.expenses.title}>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <DateField label={t.expenses.from} value={from} onChange={setFrom} />
          <DateField label={t.expenses.to} value={to} onChange={setTo} />
          <span className="ms-auto text-sm text-slate-600">
            {t.expenses.total}: <Money value={total} className="font-semibold" />
          </span>
        </div>
        <Table head={[t.expenses.date, t.expenses.category, t.expenses.costCenter, t.expenses.description, t.expenses.amount]} isEmpty={rows.length === 0} empty={t.expenses.none}>
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="num px-3 py-1 text-slate-500">{e.businessDate}</td>
              <td className="px-3 py-1">{catName_(e.categoryId)}</td>
              <td className="px-3 py-1">
                {kindLabel(e.costCenterKind)}
                {e.costCenterKind === 'vehicle' ? ` · ${vehicleCode(e.vehicleId)}` : ''}
              </td>
              <td className="px-3 py-1 text-slate-600">{e.description}</td>
              <td className="px-3 py-1"><Money value={e.amount} /></td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title={t.incomes.title}>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <span className="ms-auto text-sm text-slate-600">
            {t.expenses.total}: <Money value={incomeTotal} className="font-semibold" />
          </span>
        </div>
        <Table
          head={[t.expenses.date, t.expenses.category, t.movements.channel, t.expenses.description, t.expenses.amount]}
          isEmpty={incomeRows.length === 0}
          empty={t.incomes.none}
        >
          {incomeRows.map((e) => (
            <tr key={e.id}>
              <td className="num px-3 py-1 text-slate-500">{e.businessDate}</td>
              <td className="px-3 py-1">{incomeCats.find((c) => c.id === e.categoryId)?.nameAr ?? e.categoryId.slice(0, 8)}</td>
              <td className="px-3 py-1">
                {e.channel === 'office_cash' ? t.movements.channelCash : t.movements.channelWallet}
              </td>
              <td className="px-3 py-1 text-slate-600">{e.description}</td>
              <td className="px-3 py-1"><Money value={e.amount} /></td>
            </tr>
          ))}
        </Table>
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
  )
}
