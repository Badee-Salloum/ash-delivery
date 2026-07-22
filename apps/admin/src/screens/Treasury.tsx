import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Button, Card, Money, MoneyInput, Pending, Table } from '../ui.tsx'

/**
 * Treasury (SRS E-5, E-6): the daily cash count and the Sunday close. Both are branch-manager +
 * GM; the close itself is system-admin-only and its pre-flight blockers are shown before sealing.
 */
export function Treasury(): ReactNode {
  const { api, t, session, branchId } = useApp()
  const [sheet, setSheet] = useState<{ businessDate: string; alreadyCounted: boolean; funds: Array<{ fundCode: string; computed: string }> } | null>(null)
  const [counted, setCounted] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ balanced: boolean; lines: Array<{ fundCode: string; variance: string }> } | null>(null)
  const [closeResult, setCloseResult] = useState<{ error?: string; blockers?: Array<{ kind: string }>; weekStart?: string } | null>(null)
  const [balances, setBalances] = useState<{ cash: string; wallet: string } | null>(null)
  const [depositAmt, setDepositAmt] = useState<{ cash: string; wallet: string }>({ cash: '', wallet: '' })
  const [depositMsg, setDepositMsg] = useState<string | null>(null)

  const [sheetError, setSheetError] = useState<string | null>(null)
  const [balanceError, setBalanceError] = useState<string | null>(null)

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
      setDepositMsg((err as { error?: string }).error ?? 'error')
    }
  }

  async function submitCount(): Promise<void> {
    if (!sheet) return
    const lines = sheet.funds.map((f) => ({ fundCode: f.fundCode, counted: counted[f.fundCode] || '0', resolution: null }))
    const res = await api.post<typeof result>('/cash-counts', { lines }).catch(() => null)
    if (res) setResult(res)
  }

  async function closeWeek(): Promise<void> {
    // The API expects the FOLLOWING Sunday; the server validates it, so send today's next Sunday.
    const closeDate = nextSunday(sheet?.businessDate ?? new Date().toISOString().slice(0, 10))
    try {
      const res = await api.post<{ weekStart: string }>('/weeks/close', { closeDate })
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
                <p className="mt-3 text-xs text-slate-400">{t.treasury.depositRoleHint}</p>
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
                  <td className="px-3 py-1">{f.fundCode}</td>
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
                  <li key={i}>• {b.kind}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-slate-400">{t.week.closeSunday} — {t.common.no}</p>
        )}
      </Card>
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
