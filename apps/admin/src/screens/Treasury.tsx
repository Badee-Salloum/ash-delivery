import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { Button, Card, Money, MoneyInput, Table } from '../ui.tsx'

/**
 * Treasury (SRS E-5, E-6): the daily cash count and the Sunday close. Both are branch-manager +
 * GM; the close itself is system-admin-only and its pre-flight blockers are shown before sealing.
 */
export function Treasury(): ReactNode {
  const { api, t, session } = useApp()
  const [sheet, setSheet] = useState<{ businessDate: string; alreadyCounted: boolean; funds: Array<{ fundCode: string; computed: string }> } | null>(null)
  const [counted, setCounted] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ balanced: boolean; lines: Array<{ fundCode: string; variance: string }> } | null>(null)
  const [closeResult, setCloseResult] = useState<{ error?: string; blockers?: Array<{ kind: string }>; weekStart?: string } | null>(null)

  useEffect(() => {
    void api.get<typeof sheet>('/cash-counts/sheet').then(setSheet).catch(() => setSheet(null))
  }, [api])

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
      <Card title={t.treasury.cashCount}>
        {!sheet ? (
          t.common.loading
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
