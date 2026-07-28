import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type { ExpenseCategoryView, ExpenseView } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { useToast } from '../feedback.tsx'
import { explainError } from '../errors.ts'
import { Button, Card, DateField, Field, Money, MoneyInput, Pending, Select, Table, TextInput } from '../ui.tsx'

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

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [categoryId, setCategoryId] = useState('')
  const [kind, setKind] = useState<Kind>('general')
  const [vehicleId, setVehicleId] = useState('')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [catCode, setCatCode] = useState('')
  const [catName, setCatName] = useState('')

  const canWrite = session?.roleKey === 'branch_manager' || session?.roleKey === 'general_manager'
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
  }, [api, from, to])
  useEffect(load, [load, branchId])

  const catName_ = (id: string): string => cats.find((c) => c.id === id)?.nameAr ?? id.slice(0, 8)
  const vehicleCode = (id: string | null): string => (id === null ? '—' : (vehicles.find((v) => v.id === id)?.code ?? id.slice(0, 8)))
  const kindLabel = (k: string): string => (k === 'vehicle' ? t.expenses.kindVehicle : k === 'branch' ? t.expenses.kindBranch : t.expenses.kindGeneral)

  const add = async (): Promise<void> => {
    setBusy(true)
    setFormError(null)
    try {
      await api.createExpense({
        categoryId,
        costCenterKind: kind,
        vehicleId: kind === 'vehicle' ? vehicleId : null,
        amount,
        description,
      })
      toast.success(t.expenses.added)
      setAmount('')
      setDescription('')
      load()
    } catch (e) {
      setFormError((e as { error?: string }).error ?? 'error')
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

  if (!rows) {
    return <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={load} retryLabel={t.common.retry} />
  }

  const ready = categoryId !== '' && amount.trim() !== '' && description.trim() !== '' && (kind !== 'vehicle' || vehicleId !== '')

  return (
    <div className="flex flex-col gap-4">
      {canWrite ? (
        <Card title={t.expenses.add}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
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
            <Field label={t.expenses.description}>
              <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            {formError ? <p className="text-sm text-red-600">{explainError(formError, t)}</p> : null}
            <Button variant="primary" className="self-start" disabled={busy || !ready} onClick={add}>
              {t.expenses.add}
            </Button>
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
