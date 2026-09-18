import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { formatDateTime } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Badge, Card, Table } from '../ui.tsx'
import { FOCUS_RING } from '../ui.tsx'

/**
 * «سجلّ الحذف» — every row a branch manager declared was not a delivery.
 *
 * Owner, 2026-09-01: a manager may remove a row, «but this should be reported to the system admin
 * in a clear place and way». This is the clear place. The audit trail already holds the same facts,
 * but you have to know a table name and a record UUID to ask it anything — that is a forensic tool,
 * not something a person checks. This answers the question he actually has: what has been removed
 * lately, from whose shift, for how much, and why.
 *
 * READ-ONLY BY CONSTRUCTION. Nothing here removes or restores anything; the register is append-only
 * in the database and this screen only reads it. The decision lives on the shift where the evidence
 * is, and being able to act from here would put it somewhere the evidence is not.
 */
interface RemovalRow {
  id: string
  kind: 'removed' | 'restored'
  operationKind: 'order' | 'cash_deduction'
  operationRef: string
  shiftId: string
  branchId: string
  businessDate: string
  driverName: string | null
  amount: string
  reason: string
  evidenceSlot: string | null
  evidenceMediaId: string | null
  actedByName: string | null
  actedAt: string
}

export function Removals(): ReactNode {
  const { api, t, lang } = useApp()
  const [rows, setRows] = useState<RemovalRow[]>([])
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setRows((await api.operationRemovals({ limit: 200 })).rows)
      setFailed(false)
    } catch {
      setRows([])
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const copy = lang === 'ar' ? AR : EN

  return (
    <Card title={copy.title}>
      <p className="mb-3 text-xs text-slate-600">{copy.hint}</p>

      {busy ? (
        <p className="text-sm text-slate-500">{t.common.loading}</p>
      ) : failed ? (
        <p className="text-sm font-semibold text-red-700">{t.common.error}</p>
      ) : rows.length === 0 ? (
        /* The ordinary state, and it should stay ordinary. A register with nothing in it is the
           system working, so it says so rather than showing an empty table. */
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
          {copy.empty}
        </p>
      ) : (
        <Table head={[copy.when, copy.what, copy.amount, copy.whose, copy.who, copy.reason, copy.evidence]}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="num px-3 py-2 text-xs">{formatDateTime(row.actedAt, lang)}</td>
              <td className="px-3 py-2">
                <span className="flex min-w-0 flex-col gap-1">
                  <Badge tone={row.kind === 'removed' ? 'red' : 'slate'}>
                    {row.kind === 'removed' ? copy.removed : copy.restored}
                  </Badge>
                  <span className="num truncate text-[11px] text-slate-600" title={row.operationRef}>
                    {row.operationKind === 'order' ? copy.order : copy.deduction} · {row.operationRef.slice(0, 14)}
                  </span>
                </span>
              </td>
              <td dir="ltr" className="num px-3 py-2 font-bold">{row.amount}</td>
              <td className="px-3 py-2 text-xs">
                <span className="flex min-w-0 flex-col">
                  <span>{row.driverName ?? '—'}</span>
                  <span className="num text-[11px] text-slate-500">{row.businessDate}</span>
                </span>
              </td>
              <td className="px-3 py-2 text-xs">{row.actedByName ?? '—'}</td>
              {/* The reason is the whole point of the register, so it is never truncated. */}
              <td className="px-3 py-2 text-xs text-slate-700">{row.reason}</td>
              <td className="px-3 py-2">
                {row.evidenceMediaId === null ? (
                  <span className="text-[11px] text-slate-400">{copy.noEvidence}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setZoom(row.evidenceMediaId)}
                    className={`rounded border border-slate-300 ${FOCUS_RING}`}
                    aria-label={copy.evidence}
                  >
                    <img
                      src={`/api/media/${row.evidenceMediaId}`}
                      alt={copy.evidence}
                      loading="lazy"
                      className="block w-24 rounded"
                    />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {zoom ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/90 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setZoom(null)}
        >
          <img src={`/api/media/${zoom}`} alt={copy.evidence} className="max-h-full max-w-full object-contain" />
        </div>
      ) : null}
    </Card>
  )
}

const AR = {
  title: 'سجلّ الحذف',
  hint: 'صفوف قرّر مديرُ فرعٍ أنّها ليست توصيلات. الصفّ يبقى في سجلّه ولا يُمحى، ويخرج من الحساب.',
  empty: 'لا عمليات حذف. ✔',
  when: 'متى',
  what: 'ماذا',
  amount: 'المبلغ',
  whose: 'نوبة مَن',
  who: 'مَن حذف',
  reason: 'السبب المدقَّق',
  evidence: 'الصفحة',
  noEvidence: 'بلا صورة',
  removed: 'حُذف',
  restored: 'استُرجع',
  order: 'طلبية',
  deduction: 'حسم نقدي',
}

const EN: typeof AR = {
  title: 'Removals',
  hint: 'Rows a branch manager decided were not deliveries. The row stays in its record and is never erased; it leaves the money.',
  empty: 'No removals. ✔',
  when: 'When',
  what: 'What',
  amount: 'Amount',
  whose: 'Whose shift',
  who: 'Removed by',
  reason: 'Audited reason',
  evidence: 'The page',
  noEvidence: 'No image',
  removed: 'Removed',
  restored: 'Restored',
  order: 'Order',
  deduction: 'Cash deduction',
}
