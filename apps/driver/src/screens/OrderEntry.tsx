import { type ReactNode, useMemo, useState } from 'react'
import type { PayMode } from '@ash/domain'
import { type DraftMovement, type DraftOrder, allProblems, nextPayMode } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Button, Card, Money, MoneyInput, TextInput } from '../ui.tsx'

/**
 * THE list. Every operation of the shift — what was delivered, and what the wallet did — with a
 * checkbox on each row.
 *
 * It is one list rather than two because that is how the day happened: an order and the 20% Yallago
 * took for it are one event seen on two screens, and pairing them by minute is what lets the system
 * say how much of a fee actually reached the wallet instead of guessing from a pay mode.
 *
 * The CHECKBOX is the point. The dashboard list scrolls, so it is photographed in several
 * overlapping images, and it scrolls back into previous days — a read list therefore always
 * contains rows that are not this shift's. Unchecking one keeps it stored and visible and takes it
 * out of the money.
 *
 * EVERY ROW IS TYPEABLE, and that is not a fallback. Tesseract cannot read Arabic-Indic digits at
 * all (see scripts/glyph-lab.mjs), so until the glyph reader lands this list is filled in by hand.
 *
 * There is no scan button here. A screenshot is picked ONCE, on its own tile above, and reading is
 * something that happens to an image the driver has already handed over — asking him to go back to
 * the gallery for the same picture a second time was the whole complaint.
 */
export function OperationsList({
  orders,
  movements,
  onOrders,
  onMovements,
}: {
  orders: readonly DraftOrder[]
  movements: readonly DraftMovement[]
  onOrders(next: DraftOrder[]): void
  onMovements(next: DraftMovement[]): void
}): ReactNode {
  const { t } = useApp()
  const [defaultFee, setDefaultFee] = useState('5000')

  const problems = useMemo(() => allProblems(orders), [orders])

  const addRow = (): void =>
    onOrders([
      ...orders,
      { localId: crypto.randomUUID(), providerOrderNo: '', payMode: 'cash', feeText: defaultFee, included: true },
    ])

  const update = (localId: string, patch: Partial<DraftOrder>): void =>
    onOrders(orders.map((o) => (o.localId === localId ? { ...o, ...patch } : o)))

  const remove = (localId: string): void => onOrders(orders.filter((o) => o.localId !== localId))

  const modeLabel: Record<PayMode, string> = {
    cash: t.orders.payModes.cash,
    electronic: t.orders.payModes.electronic,
    free: t.orders.payModes.free,
  }
  const modeColor: Record<PayMode, string> = {
    cash: 'bg-emerald-100 text-emerald-800',
    electronic: 'bg-sky-100 text-sky-800',
    free: 'bg-amber-100 text-amber-800',
  }

  const checkedCount = orders.filter((o) => o.included !== false).length

  return (
    <>
      {/* No scan buttons here. The screenshots are picked ONCE, on their own tiles above, and
          reading is something that happens to an image the driver has already handed over — not a
          second trip to the gallery for the same picture. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">
          {t.orders.title} — {checkedCount}/{orders.length}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">{t.orders.fee}</span>
        <MoneyInput value={defaultFee} onChange={(e) => setDefaultFee(e.target.value)} className="w-28" />
        <Button variant="ghost" className="ms-auto" onClick={addRow}>
          + {t.orders.addRow}
        </Button>
      </div>

      {orders.map((o, i) => {
        const problem = problems.get(o.localId)
        const off = o.included === false
        return (
          <Card key={o.localId} className={problem ? 'ring-2 ring-red-300' : off ? 'opacity-50' : ''}>
            <div className="flex items-center gap-2">
              {/* The checkbox, first and large: on a phone it is the control that decides money. */}
              <input
                type="checkbox"
                checked={!off}
                onChange={(e) => update(o.localId, { included: e.target.checked })}
                aria-label={t.orders.included}
                className="size-6 shrink-0 accent-emerald-600"
              />
              <span className="w-5 text-center text-sm text-slate-400">{i + 1}</span>
              <TextInput
                value={o.providerOrderNo}
                onChange={(e) => update(o.localId, { providerOrderNo: e.target.value })}
                placeholder={t.orders.orderNo}
                inputMode="numeric"
                className="flex-1"
              />
              <button
                onClick={() => update(o.localId, { payMode: nextPayMode(o.payMode) })}
                className={`min-h-14 rounded-2xl px-3 text-sm font-semibold ${modeColor[o.payMode]}`}
              >
                {modeLabel[o.payMode]}
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <MoneyInput
                value={o.feeText}
                onChange={(e) => update(o.localId, { feeText: e.target.value })}
                className="flex-1"
                aria-label={t.orders.fee}
              />
              {/* What the LOG says reached the wallet. Blank means nobody measured it and the pay
                  mode decides — exactly as every shift closed before the log was ever read. */}
              <MoneyInput
                value={o.walletAmountText ?? ''}
                onChange={(e) => update(o.localId, { walletAmountText: e.target.value })}
                placeholder={t.orders.toWallet}
                className="w-28"
                aria-label={t.orders.toWallet}
              />
              <Button variant="ghost" onClick={() => remove(o.localId)} className="px-3" aria-label={t.common.remove}>
                ×
              </Button>
            </div>
            {problem ? (
              <p className="mt-1 text-sm font-medium text-red-600">
                {t.orders.problems[problem.kind]}
                {problem.kind === 'duplicate_order_no' ? ` (#${problem.firstIndex + 1})` : ''}
              </p>
            ) : null}
          </Card>
        )
      })}

      {orders.length === 0 ? <p className="py-6 text-center text-slate-400">{t.orders.addRow} ↑</p> : null}

      {/* The wallet's own rows: what MOVED, beside what the orders imply. Only the ones no order
          explains are money the equation has to be told about. */}
      {movements.length > 0 ? (
        <>
          <p className="mt-2 text-sm font-semibold">{t.shift.paymentsLog}</p>
          {movements.map((m) => {
            const off = m.included === false
            const explained = (m.role ?? 'unmatched') !== 'unmatched'
            return (
              <Card key={m.localId} className={off ? 'opacity-50' : ''}>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!off}
                    onChange={(e) =>
                      onMovements(movements.map((x) => (x.localId === m.localId ? { ...x, included: e.target.checked } : x)))
                    }
                    aria-label={t.orders.included}
                    className="size-6 shrink-0 accent-emerald-600"
                  />
                  <span className="w-12 text-sm text-slate-500">{m.timeText || '—'}</span>
                  <Money value={m.amountText} className="font-semibold" />
                  <span className="ms-auto text-xs text-slate-400">
                    {explained ? t.orders.explainedByOrder : t.orders.unexplained}
                  </span>
                </div>
              </Card>
            )
          })}
        </>
      ) : null}
    </>
  )
}

