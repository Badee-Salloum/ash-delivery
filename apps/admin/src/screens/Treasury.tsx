import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type { RestorationView } from '@ash/client'
import { type RoleKey, can, formatMinor, minor, parseMinor } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { useConfirm, useToast } from '../feedback.tsx'
import { explainError } from '../errors.ts'
import { Button, Card, Field, Money, MoneyInput, Pending, Select, Table, TextInput } from '../ui.tsx'

/** The branch-level funds a manual entry can move (the driver/cost-centre ones need an id suffix). */
const MANUAL_FUNDS = ['office_cash', 'office_wallet', 'yalago_share', 'company_revenue', 'yalago_income', 'fee_earned', 'company_box'] as const
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
  const [withdrawAmt, setWithdrawAmt] = useState<{ cash: string; wallet: string }>({ cash: '', wallet: '' })

  // ── «صندوق الشركة» ────────────────────────────────────────────────────────────────────────
  const [company, setCompany] = useState<{ total: string; branches: Array<{ branchId: string; nameAr: string; balance: string }> } | null>(null)
  const [companyError, setCompanyError] = useState<string | null>(null)
  const [companyAmt, setCompanyAmt] = useState('')
  const [companyReason, setCompanyReason] = useState('')

  // ── «الترميم» ─────────────────────────────────────────────────────────────────────────────
  const [restoration, setRestoration] = useState<RestorationView | null>(null)
  const [restorationError, setRestorationError] = useState<string | null>(null)
  const [restoreDone, setRestoreDone] = useState(false)

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

  /*
   * ASK THE RULE, do not restate it. This was two hard-coded role names and a comment explaining
   * that the system admin may look but not touch — which owner decision 9 reversed on 2026-08-12,
   * leaving the screen confidently wrong and telling him so in Arabic.
   *
   * `can()` is pure and already exported, so the screen now reads the same table the server checks.
   * (UI hiding is not security — the API enforces this regardless. This only decides whether a
   * control is worth showing.)
   */
  const canDeposit =
    session != null &&
    can({ userId: session.userId, roleKey: session.roleKey as RoleKey, branchId: session.branchId }, 'journal.manual.write', {
      branchId: branchId ?? session.branchId,
    }).allowed

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

  const loadRestoration = useCallback(async (): Promise<void> => {
    try {
      setRestoration(await api.restorationPreview())
      setRestorationError(null)
    } catch (err) {
      setRestoration(null)
      setRestorationError((err as { error?: string }).error ?? 'error')
    }
  }, [api])

  // Refetch when an organisation-wide role switches branch — the treasury is per branch, and
  // showing branch A's cash box under branch B's name is the worst kind of wrong.
  useEffect(load, [load, branchId])
  useEffect(() => {
    setRestoreDone(false)
    void loadRestoration()
  }, [loadRestoration, branchId])

  /** «كييش» — take the day's profit out of the branch box and into صندوق الشركة. */
  async function withdraw(target: 'cash' | 'wallet'): Promise<void> {
    const amount = withdrawAmt[target]
    if (!amount) return
    setDepositMsg(null)
    try {
      const res = await api.treasuryWithdraw(target, amount, t.treasury.kaish)
      setBalances((b) => (b ? { ...b, [target]: res.balance } : b))
      setWithdrawAmt({ ...withdrawAmt, [target]: '' })
      setDepositMsg(t.treasury.withdrawn)
      void refreshCompany()
    } catch (err) {
      setDepositMsg(null)
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  const refreshCompany = useCallback(async (): Promise<void> => {
    try {
      setCompany(await api.companyFund())
      setCompanyError(null)
    } catch (err) {
      // `profit.view_total` — the GM and, since decision 9, the system admin. A branch manager
      // gets 403 here, and saying so beats an empty card he reads as broken.
      setCompany(null)
      setCompanyError((err as { error?: string }).error ?? 'error')
    }
  }, [api])

  // صندوق الشركة is company-wide, so it does NOT depend on the selected branch. Declared after
  // `refreshCompany` because a `const` callback is not hoisted — the effect would read it before
  // assignment.
  useEffect(() => {
    void refreshCompany()
  }, [refreshCompany])

  async function moveCompany(direction: 'deposit' | 'withdraw'): Promise<void> {
    if (!companyAmt || !companyReason.trim()) return
    try {
      if (direction === 'deposit') await api.companyFundDeposit(companyAmt, companyReason.trim())
      else await api.companyFundWithdraw(companyAmt, companyReason.trim())
      setCompanyAmt('')
      setCompanyReason('')
      await refreshCompany()
      void load()
    } catch (err) {
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

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
      // الترميم is computed FROM the count (decision j), so sealing one changes the other.
      void loadRestoration()
    } catch (err) {
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  async function doRestore(): Promise<void> {
    if (!restoration) return
    const ok = await confirm({
      title: t.treasury.restoration,
      body: `${t.treasury.netToCompany}: ${formatMinor(parseMinor(restoration.netToCompany))}`,
      confirmLabel: t.treasury.doRestore,
    })
    if (!ok) return
    try {
      const done = await api.restore(t.treasury.restoration)
      setRestoration({ ...done, counted: true })
      setRestoreDone(true)
      void refreshCompany()
      load()
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
                <div className="mt-3 flex flex-col gap-2">
                  <div className="flex gap-2">
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
                  {/* «كييش» by hand. The owner's book moves money out of the box every day; until
                      now the screen could only put money in. الترميم automates the decision later
                      and posts through the very same recipe, so the two are one thing in the ledger. */}
                  <div className="flex gap-2">
                    <MoneyInput
                      value={withdrawAmt[target]}
                      onChange={(e) => setWithdrawAmt({ ...withdrawAmt, [target]: e.target.value })}
                      className="w-full"
                      placeholder={t.treasury.kaish}
                    />
                    <Button
                      variant="ghost"
                      onClick={() => withdraw(target)}
                      disabled={!withdrawAmt[target]}
                    >
                      {t.treasury.withdraw}
                    </Button>
                  </div>
                </div>
              ) : (
                // Saying why beats an empty card somebody reads as a broken screen.
                <p className="mt-3 text-xs text-slate-600">{t.treasury.depositRoleHint}</p>
              )}
            </div>
          ))}
        </div>
        {depositMsg ? <p className="mt-3 text-sm font-medium text-emerald-700">{depositMsg}</p> : null}

        {/* «صندوق الشركة» — where «كييش» lands and where «شحن من الصندوق» comes from. Sits inside
            the treasury card because the two are one flow: money leaves the box and arrives here. */}
        <div className="mt-4 rounded-lg border border-slate-300 bg-slate-50 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-slate-500">{t.treasury.companyFund}</span>
            <span className="text-2xl font-bold">
              {company ? (
                <Money value={company.total} />
              ) : (
                <span className="text-base font-medium text-red-600">
                  {companyError ? explainError(companyError, t) : '—'}
                </span>
              )}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-600">{t.treasury.companyFundHint}</p>
          {company && company.branches.length > 1 ? (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              {company.branches.map((b) => (
                <li key={b.branchId}>
                  {b.nameAr} <Money value={b.balance} />
                </li>
              ))}
            </ul>
          ) : null}
          {company ? (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex gap-2">
                <MoneyInput
                  value={companyAmt}
                  onChange={(e) => setCompanyAmt(e.target.value)}
                  className="w-full"
                  placeholder={t.treasury.depositAmount}
                />
                <TextInput
                  value={companyReason}
                  onChange={(e) => setCompanyReason(e.target.value)}
                  className="w-full"
                  placeholder={t.treasury.reason}
                />
              </div>
              <div className="flex gap-2">
                {/* A reason is mandatory on both: the database enforces it for these events, so a
                    button that submits without one only ever produces a 400 the operator must decode. */}
                <Button onClick={() => moveCompany('deposit')} disabled={!companyAmt || !companyReason.trim()}>
                  {t.treasury.deposit}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => moveCompany('withdraw')}
                  disabled={!companyAmt || !companyReason.trim()}
                >
                  {t.treasury.withdraw}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      {/*
        «الترميم» — the owner's own end-of-day process, in his own words.

        It reads the SEALED COUNT and shows the two boxes side by side: what is physically there,
        what is out on ذمم, and how far that stands from رأس مال المكتب. The button is deliberately
        dead until the count exists — decision (j), and the whole reason the figure is trustworthy.
      */}
      <Card title={t.treasury.restoration} className="lg:col-span-2">
        <p className="text-xs text-slate-600">{t.treasury.restorationHint}</p>
        {!restoration ? (
          <Pending
            error={restorationError}
            loadingLabel={t.common.loading}
            errorLabel={explainError(restorationError, t)}
            onRetry={() => void loadRestoration()}
            retryLabel={t.common.retry}
          />
        ) : (
          <>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {restoration.legs.map((leg) => {
                const delta = parseMinor(leg.delta)
                return (
                  <div key={leg.fundCode} className="rounded-lg border border-slate-200 p-3">
                    <div className="text-xs font-semibold text-slate-500">
                      {leg.fundCode === 'office_cash' ? t.treasury.cashBox : t.treasury.wallet}
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
                      <dt className="text-slate-600">
                        {t.treasury.currentPosition}
                        <span className="text-xs text-slate-400"> ({t.treasury.positionFormula})</span>
                      </dt>
                      <dd className="text-end font-semibold">
                        <Money value={leg.position} />
                      </dd>
                      <dt className="text-slate-600">{t.treasury.capitalTarget}</dt>
                      <dd className="text-end">
                        <Money value={leg.capitalTarget} />
                      </dd>
                    </dl>
                    <div className="mt-2 border-t border-slate-100 pt-2 text-sm font-semibold">
                      {delta === minor(0n) ? (
                        <span className="text-slate-600">{t.treasury.onTarget}</span>
                      ) : delta > minor(0n) ? (
                        <span className="text-emerald-700">
                          {t.treasury.surplus} — {t.treasury.kaish}: <Money value={leg.amount} />
                        </span>
                      ) : (
                        <span className="text-amber-700">
                          {t.treasury.shortage} — {t.treasury.shahn}: <Money value={leg.amount} />
                        </span>
                      )}
                    </div>
                    {leg.refusals.map((code) => (
                      <p key={code} className="mt-2 text-xs text-red-700">
                        {t.treasury.restorationRefusal[code]}
                      </p>
                    ))}
                  </div>
                )
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm">
                {t.treasury.netToCompany}:{' '}
                <span className="font-bold">
                  <Money value={restoration.netToCompany} />
                </span>
              </span>
              {restoreDone ? (
                <span className="text-sm font-semibold text-emerald-700">{t.treasury.restored} ✓</span>
              ) : (
                <Button onClick={doRestore} disabled={restoration.counted === false || !restoration.feasible}>
                  {t.treasury.doRestore}
                </Button>
              )}
            </div>
            {restoration.counted === false ? (
              // Not an error — an order of operations. The count comes first, always.
              <p className="mt-2 text-xs text-amber-700">{t.treasury.countFirst}</p>
            ) : null}
          </>
        )}
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
