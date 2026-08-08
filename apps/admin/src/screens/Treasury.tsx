import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { formatMinor, minor, parseMinor } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { useConfirm, useToast } from '../feedback.tsx'
import { explainError } from '../errors.ts'
import { Button, Card, Field, Money, MoneyInput, Pending, Select, Table, TextInput } from '../ui.tsx'

/** The branch-level funds a manual entry can move (the driver/cost-centre ones need an id suffix). */
const MANUAL_FUNDS = ['office_cash', 'office_wallet', 'yalago_share', 'company_revenue', 'yalago_income', 'fee_earned'] as const
interface EntryLine {
  fundCode: string
  side: 'D' | 'C'
  amount: string
}

/**
 * Treasury (SRS E-5, E-6): the daily cash count and the Sunday close. Both are branch-manager +
 * GM; the close itself is system-admin-only and its pre-flight blockers are shown before sealing.
 */
export function Treasury(): ReactNode {
  const { api, t, session, branchId } = useApp()
  const toast = useToast()
  const confirm = useConfirm()
  const [sheet, setSheet] = useState<{ businessDate: string; alreadyCounted: boolean; funds: Array<{ fundCode: string; computed: string }> } | null>(null)
  const [counted, setCounted] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ balanced: boolean; lines: Array<{ fundCode: string; variance: string }> } | null>(null)
  const [closeResult, setCloseResult] = useState<{ error?: string; blockers?: Array<{ kind: string }>; weekStart?: string } | null>(null)
  const [balances, setBalances] = useState<{ cash: string; wallet: string } | null>(null)
  const [depositAmt, setDepositAmt] = useState<{ cash: string; wallet: string }>({ cash: '', wallet: '' })
  const [depositMsg, setDepositMsg] = useState<string | null>(null)

  const [sheetError, setSheetError] = useState<string | null>(null)
  const [balanceError, setBalanceError] = useState<string | null>(null)

  // ── Manual entry + reversal (E-3) ────────────────────────────────────────────────────────
  const [reason, setReason] = useState('')
  const [lines, setLines] = useState<EntryLine[]>([
    { fundCode: 'office_cash', side: 'D', amount: '' },
    { fundCode: 'office_wallet', side: 'C', amount: '' },
  ])
  const [manualMsg, setManualMsg] = useState<string | null>(null)
  const [manualError, setManualError] = useState<string | null>(null)
  const [revId, setRevId] = useState('')
  const [revReason, setRevReason] = useState('')
  const [revMsg, setRevMsg] = useState<string | null>(null)

  // Only the branch manager + GM may put money in — `journal.manual.write` in the §3 matrix, and
  // product-owner decision 5. The system admin can SEE the money and not move it; that is
  // deliberate, so the screen says so rather than silently rendering nothing.
  const canDeposit = session?.roleKey === 'branch_manager' || session?.roleKey === 'general_manager'

  const load = useCallback(() => {
    setSheetError(null)
    setBalanceError(null)
    void api
      .get<typeof sheet>('/cash-counts/sheet')
      .then((d) => setSheet(d))
      .catch((e: { error?: string }) => {
        setSheet(null)
        setSheetError(e.error ?? 'error')
      })
    void api
      .treasuryBalances()
      .then(setBalances)
      .catch((e: { error?: string }) => {
        setBalances(null)
        setBalanceError(e.error ?? 'error')
      })
  }, [api])

  // Refetch when an organisation-wide role switches branch — the treasury is per branch, and
  // showing branch A's cash box under branch B's name is the worst kind of wrong.
  useEffect(load, [load, branchId])

  async function deposit(target: 'cash' | 'wallet'): Promise<void> {
    const amount = depositAmt[target]
    if (!amount) return
    setDepositMsg(null)
    try {
      const res = await api.treasuryDeposit(target, amount)
      setBalances((b) => (b ? { ...b, [target]: res.balance } : b))
      setDepositAmt({ ...depositAmt, [target]: '' })
      setDepositMsg(t.treasury.deposited)
    } catch (err) {
      // It used to set the SAME state as success, which renders in emerald — so a rejected
      // deposit printed «forbidden» in green under the cash box and the manager believed the
      // money had gone in.
      setDepositMsg(null)
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  /** Sum one side of the entry in minor units (string math, never Number() on money). */
  const sideTotal = (side: 'D' | 'C'): string => {
    let acc = 0n
    for (const l of lines) {
      if (l.side !== side || l.amount.trim() === '') continue
      try {
        acc += parseMinor(l.amount)
      } catch {
        /* a half-typed amount — skip it in the running total */
      }
    }
    return formatMinor(minor(acc))
  }
  const entryBalanced = sideTotal('D') === sideTotal('C') && lines.some((l) => l.amount.trim() !== '') && reason.trim() !== ''
  const setLine = (i: number, patch: Partial<EntryLine>): void => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const addLine = (): void => setLines((prev) => [...prev, { fundCode: 'office_cash', side: 'D', amount: '' }])
  const removeLine = (i: number): void => setLines((prev) => prev.filter((_, j) => j !== i))

  async function postManual(): Promise<void> {
    setManualMsg(null)
    setManualError(null)
    try {
      await api.manualEntry({ reason, lines: lines.filter((l) => l.amount.trim() !== '') })
      setManualMsg(t.treasury.posted)
      setReason('')
      setLines([
        { fundCode: 'office_cash', side: 'D', amount: '' },
        { fundCode: 'office_wallet', side: 'C', amount: '' },
      ])
      load()
    } catch (err) {
      setManualError((err as { error?: string }).error ?? 'error')
    }
  }
  async function doReverse(): Promise<void> {
    setRevMsg(null)
    try {
      await api.reverseEntry(Number(revId), revReason)
      setRevMsg(t.treasury.reversed)
      setRevId('')
      setRevReason('')
      load()
    } catch (err) {
      setRevMsg(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  async function submitCount(): Promise<void> {
    if (!sheet) return
    const lines = sheet.funds.map((f) => ({ fundCode: f.fundCode, counted: counted[f.fundCode] || '0', resolution: null }))
    // Swallowed before: the manager typed the day's counted cash, pressed «تأكيد», and nothing
    // whatsoever happened — no error, no result — on the seal of the cash box.
    try {
      setResult(await api.post<typeof result>('/cash-counts', { lines }))
    } catch (err) {
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  async function closeWeek(): Promise<void> {
    // The API expects the FOLLOWING Sunday; the server validates it, so send today's next Sunday.
    const closeDate = nextSunday(sheet?.businessDate ?? new Date().toISOString().slice(0, 10))
    // BR7 seals the week: every entry inside it becomes immutable and corrections after this are
    // dated correction entries only. It was a bare red button with no question asked.
    const ok = await confirm({
      title: t.week.confirmCloseTitle,
      body: `${t.week.closeSunday} ${closeDate} — ${t.week.confirmCloseBody}`,
      confirmLabel: t.week.closeSunday,
      danger: true,
    })
    if (!ok) return
    try {
      const res = await api.closeWeek(closeDate)
      setCloseResult(res)
    } catch (err) {
      setCloseResult(err as { error?: string; blockers?: Array<{ kind: string }> })
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title={t.treasury.branchTreasury} className="lg:col-span-2">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(['cash', 'wallet'] as const).map((target) => (
            <div key={target} className="rounded-lg border border-slate-200 p-3">
              <div className="text-xs font-semibold text-slate-500">
                {target === 'cash' ? t.treasury.cashBox : t.treasury.wallet}
              </div>
              <div className="mt-1 text-2xl font-bold">
                {balances ? (
                  <Money value={balances[target]} />
                ) : (
                  <span className="text-base font-medium text-red-600">
                    {balanceError ? explainError(balanceError, t) : '—'}
                  </span>
                )}
              </div>
              {canDeposit ? (
                <div className="mt-3 flex gap-2">
                  <MoneyInput
                    value={depositAmt[target]}
                    onChange={(e) => setDepositAmt({ ...depositAmt, [target]: e.target.value })}
                    className="w-full"
                    placeholder={t.treasury.depositAmount}
                  />
                  <Button onClick={() => deposit(target)} disabled={!depositAmt[target]}>
                    {t.treasury.deposit}
                  </Button>
                </div>
              ) : (
                // Deliberate, not an oversight: `journal.manual.write` is branch manager + GM only.
                // Saying so beats an empty card the system admin reads as a broken screen.
                <p className="mt-3 text-xs text-slate-600">{t.treasury.depositRoleHint}</p>
              )}
            </div>
          ))}
        </div>
        {depositMsg ? <p className="mt-3 text-sm font-medium text-emerald-700">{depositMsg}</p> : null}
      </Card>

      <Card title={t.treasury.cashCount}>
        {!sheet ? (
          <Pending
            error={sheetError}
            loadingLabel={t.common.loading}
            errorLabel={explainError(sheetError, t)}
            onRetry={load}
            retryLabel={t.common.retry}
          />
        ) : sheet.alreadyCounted && !result ? (
          <p className="text-emerald-700">{t.treasury.sealProof} ✓</p>
        ) : (
          <>
            <Table head={[t.treasury.category, t.treasury.computed, t.treasury.counted]}>
              {sheet.funds.map((f) => (
                <tr key={f.fundCode}>
                  <td className="px-3 py-1">
                    {t.treasury.fundCodes[f.fundCode as keyof typeof t.treasury.fundCodes] ?? f.fundCode}
                  </td>
                  <td className="px-3 py-1"><Money value={f.computed} /></td>
                  <td className="px-3 py-1">
                    <MoneyInput
                      value={counted[f.fundCode] ?? ''}
                      onChange={(e) => setCounted({ ...counted, [f.fundCode]: e.target.value })}
                      className="w-32"
                    />
                  </td>
                </tr>
              ))}
            </Table>
            <Button className="mt-3" onClick={submitCount}>
              {t.common.confirm}
            </Button>
            {result ? (
              <p className={`mt-2 text-sm font-medium ${result.balanced ? 'text-emerald-700' : 'text-amber-700'}`}>
                {result.balanced ? t.br1.balanced : t.treasury.variance}
              </p>
            ) : null}
          </>
        )}
      </Card>

      <Card title={t.week.close}>
        {session?.roleKey === 'system_admin' ? (
          <>
            <Button variant="danger" onClick={closeWeek}>
              {t.week.closeSunday}
            </Button>
            {closeResult?.weekStart ? (
              <p className="mt-2 text-sm text-emerald-700">
                {t.week.sealed}: {closeResult.weekStart}
              </p>
            ) : closeResult?.blockers ? (
              <ul className="mt-2 text-sm text-red-600">
                {closeResult.blockers.map((b, i) => (
                  <li key={i}>• {t.treasury.closeBlockers[b.kind as keyof typeof t.treasury.closeBlockers] ?? b.kind}</li>
                ))}
              </ul>
            ) : closeResult?.error ? (
              // A refusal carrying neither a weekStart nor blockers used to fall through to null:
              // the sysadmin pressed «إقفال الأحد», nothing changed on screen, and the reason
              // (branch_required) was never shown. Silence is the worst failure mode for the one
              // action that makes a week immutable.
              <p className="mt-2 text-sm font-medium text-red-600">{explainError(closeResult.error, t)}</p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-slate-600">{t.week.closeSunday} — {t.common.no}</p>
        )}
      </Card>

      {/* E-3: controlled manual entry + the BR7 visible dated reversal (branch manager + GM). */}
      {canDeposit ? (
        <Card title={t.treasury.manualEntry} className="lg:col-span-2">
          <div className="flex flex-col gap-3">
            <Field label={t.treasury.reason}>
              <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Table head={[t.treasury.fund, t.treasury.side, t.treasury.amount, '']}>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="px-2 py-1">
                    <Select value={l.fundCode} onChange={(e) => setLine(i, { fundCode: e.target.value })} aria-label={t.treasury.fund}>
                      {MANUAL_FUNDS.map((f) => (
                        <option key={f} value={f}>
                          {t.treasury.fundCodes[f as keyof typeof t.treasury.fundCodes] ?? f}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1">
                    <Select value={l.side} onChange={(e) => setLine(i, { side: e.target.value as 'D' | 'C' })} aria-label={t.treasury.side}>
                      <option value="D">{t.treasury.debit}</option>
                      <option value="C">{t.treasury.credit}</option>
                    </Select>
                  </td>
                  <td className="px-2 py-1">
                    <MoneyInput value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} className="w-32" aria-label={t.treasury.amount} />
                  </td>
                  <td className="px-2 py-1">
                    {lines.length > 2 ? (
                      <Button variant="ghost" onClick={() => removeLine(i)} aria-label={t.common.remove}>
                        ×
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </Table>
            <div className="flex items-center gap-3">
              <Button variant="ghost" onClick={addLine}>
                + {t.treasury.addLine}
              </Button>
              <span className="num ms-auto text-xs text-slate-500" dir="ltr">
                D <Money value={sideTotal('D')} /> · C <Money value={sideTotal('C')} />
                {entryBalanced ? '' : ` · ${t.treasury.unbalanced}`}
              </span>
            </div>
            {manualError ? <p className="text-sm text-red-600">{explainError(manualError, t)}</p> : null}
            {manualMsg ? <p className="text-sm font-medium text-emerald-700">{manualMsg}</p> : null}
            <Button variant="primary" className="self-start" disabled={!entryBalanced} onClick={postManual}>
              {t.treasury.post}
            </Button>

            <div className="mt-1 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
              <Field label={t.treasury.entryId}>
                <TextInput inputMode="numeric" value={revId} onChange={(e) => setRevId(e.target.value)} className="w-24" />
              </Field>
              <Field label={t.treasury.reason} className="min-w-48 flex-1">
                <TextInput value={revReason} onChange={(e) => setRevReason(e.target.value)} />
              </Field>
              <Button variant="danger" disabled={revId.trim() === '' || revReason.trim() === ''} onClick={doReverse}>
                {t.treasury.reverse}
              </Button>
            </div>
            {revMsg ? <p className="text-sm text-slate-600">{revMsg}</p> : null}
          </div>
        </Card>
      ) : null}
    </div>
  )
}

/** The Sunday on or after `date`, matching the API's "close on the following Sunday". */
function nextSunday(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const ms = Date.UTC(y, m - 1, d)
  const dow = new Date(ms).getUTCDay()
  const add = dow === 0 ? 7 : 7 - dow
  const next = new Date(ms + add * 86_400_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}
