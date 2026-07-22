import { type ReactNode, useMemo, useState } from 'react'
import type { PayMode } from '@ash/domain'
import { type DraftOrder, allProblems, isComplete, nextPayMode, previewBr1 } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Button, Card, Money, MoneyInput, Screen, TextInput } from '../ui.tsx'

/**
 * THE screen. With OCR deferred, the driver types every order here — 20 rows, twice a day, on a
 * cheap Android. Everything about it is built for that:
 *
 *   • numeric-keypad-first fee input, remembered default fee
 *   • one-tap pay-mode cycling (cash → electronic → free)
 *   • duplicate order numbers flagged AS YOU TYPE, pointing at the first occurrence
 *   • a LIVE BR1 preview pinned to the bottom, so the driver sees his cash and wallet drift the
 *     instant a pay mode is wrong — and fixes it before the manager ever sees it
 *
 * The logic is all in `@ash/client` (tested without a DOM); this is the shell.
 */
export function OrderEntry({
  shift,
  onDone,
}: {
  shift: { id: string; floatText: string; topupText: string }
  onDone(orders: DraftOrder[]): void
}): ReactNode {
  const { t } = useApp()
  const [orders, setOrders] = useState<DraftOrder[]>([])
  const [defaultFee, setDefaultFee] = useState('5000')

  const problems = useMemo(() => allProblems(orders), [orders])
  const preview = useMemo(
    () => previewBr1({ floatText: shift.floatText, topupText: shift.topupText, orders }),
    [shift, orders],
  )

  const addRow = (): void =>
    setOrders((prev) => [
      ...prev,
      { localId: crypto.randomUUID(), providerOrderNo: '', payMode: 'cash', feeText: defaultFee },
    ])

  const update = (localId: string, patch: Partial<DraftOrder>): void =>
    setOrders((prev) => prev.map((o) => (o.localId === localId ? { ...o, ...patch } : o)))

  const remove = (localId: string): void => setOrders((prev) => prev.filter((o) => o.localId !== localId))

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

  return (
    <Screen
      title={`${t.orders.title} — ${orders.length}`}
      footer={
        <div className="flex flex-col gap-2">
          {preview ? (
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">{t.br1.expectedCash}</span>
              <Money value={preview.expectedCashText} className="font-semibold" />
              <span className="text-slate-500">{t.br1.expectedWallet}</span>
              <Money value={preview.expectedWalletText} className="font-semibold" />
            </div>
          ) : null}
          <Button variant="success" disabled={!isComplete(orders)} onClick={() => onDone(orders)}>
            {t.shift.submitEnd}
          </Button>
        </div>
      }
    >
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-500">{t.orders.fee}</span>
        <MoneyInput value={defaultFee} onChange={(e) => setDefaultFee(e.target.value)} className="w-28" />
        <Button variant="ghost" onClick={addRow} className="ms-auto">
          + {t.orders.addRow}
        </Button>
      </div>

      {orders.map((o, i) => {
        const problem = problems.get(o.localId)
        return (
          <Card key={o.localId} className={problem ? 'ring-2 ring-red-300' : ''}>
            <div className="flex items-center gap-2">
              <span className="w-6 text-center text-sm text-slate-400">{i + 1}</span>
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
              />
              <Button variant="ghost" onClick={() => remove(o.localId)} className="px-4">
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

      {orders.length === 0 ? (
        <p className="py-8 text-center text-slate-400">{t.orders.addRow} ↑</p>
      ) : null}
    </Screen>
  )
}
