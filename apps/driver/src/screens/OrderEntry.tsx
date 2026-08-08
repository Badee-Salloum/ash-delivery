import { Fragment, type ReactNode, useMemo, useState } from 'react'
import type { PayMode } from '@ash/domain'
import { type DraftMovement, type DraftOrder, allProblems, newOrderKey } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Button, Card, Money, MoneyInput } from '../ui.tsx'

/**
 * THE list. Every operation of the shift — what was delivered, and what the wallet did — with a
 * checkbox on each row.
 *
 * It is one list rather than two because that is how the day happened: an order and the 20% Yallago
 * took for it are one event seen on two screens, and pairing them by minute is what lets the system
 * say how much of a fee actually reached the wallet instead of guessing from a pay mode.
 *
 * The CHECKBOX is the point, and its ergonomics used to be inverted. The safe, reversible action —
 * unchecking a row that is not this shift's — was a 24-pixel box a gloved thumb misses, while the
 * IRREVERSIBLE one, deleting the row, was a 56-pixel button beside the money field with no
 * confirmation and no undo. Now the whole row is the checkbox's label, and nothing here deletes.
 *
 * AN ORDER HAS NO NUMBER. «الطلبات الحديثة» does not display one, so the system stopped inventing
 * one: a row is its value, its route and its clock. The wire still needs a unique key, but that is
 * machinery — generated, never shown, never typed. See `newOrderKey`.
 *
 * EVERY ROW IS TYPEABLE, and that is not a fallback. The reader refuses a glyph it is not sure of
 * rather than guessing, so some rows arrive empty by design.
 *
 * There is no scan button here. A screenshot is picked ONCE, on its own tile above, and reading is
 * something that happens to an image the driver has already handed over — asking him to go back to
 * the gallery for the same picture a second time was the whole complaint.
 */
export function OperationsList({
  orders,
  movements,
  today,
  onOrders,
  onMovements,
}: {
  orders: readonly DraftOrder[]
  movements: readonly DraftMovement[]
  /** The shift's own business date, «YYYY-MM-DD» — what a row's date is flagged against. */
  today?: string
  onOrders(next: DraftOrder[]): void
  onMovements(next: DraftMovement[]): void
}): ReactNode {
  const { t } = useApp()
  const [defaultFee, setDefaultFee] = useState('5000')

  const problems = useMemo(() => allProblems(orders), [orders])

  const addRow = (): void => {
    // The key is machinery, generated here and never shown: `provider_order_no` is globally unique,
    // so it cannot be left empty and must not be anything two rows could ever arrive at.
    const localId = crypto.randomUUID()
    onOrders([
      ...orders,
      { localId, providerOrderNo: newOrderKey(localId), payMode: 'cash', feeText: defaultFee, included: true },
    ])
  }

  const update = (localId: string, patch: Partial<DraftOrder>): void =>
    onOrders(orders.map((o) => (o.localId === localId ? { ...o, ...patch } : o)))

  const modeLabel: Record<PayMode, string> = {
    cash: t.orders.payModes.cash,
    electronic: t.orders.payModes.electronic,
    free: t.orders.payModes.free,
  }
  /* Amber is the app's WARNING colour — «يوم آخر», a failed read, a suspended shift. Giving it to
     «مجاني» as well taught the driver that a perfectly ordinary promo order was something wrong.
     Pay modes get their own neutral family and amber goes back to meaning "look at this". */
  const modeColor: Record<PayMode, string> = {
    cash: 'bg-emerald-100 text-emerald-800',
    electronic: 'bg-sky-100 text-sky-800',
    free: 'bg-violet-100 text-violet-800',
  }

  const checkedCount = orders.filter((o) => o.included !== false).length
  // «YYYY-MM-DD» → «DD/MM», which is how the date is written on the screen being copied.
  const dayMonth = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

  /**
   * IN THE ORDER THE DAY HAPPENED, newest first — which is how the screen he is copying from reads.
   *
   * The list used to be in SCAN order: page two appended after page one, so a driver who
   * photographed four overlapping screenfuls got thirty rows with yesterday's interleaved among
   * today's and no way to work through them but to hunt. Rows with no clock keep their relative
   * position at the end rather than being scattered.
   */
  const sorted = useMemo(() => {
    const key = (o: DraftOrder): string => `${o.dateText ?? ''} ${o.timeText ?? ''}`
    return orders
      .map((o, i) => ({ o, i }))
      .sort((a, b) => {
        const ka = key(a.o)
        const kb = key(b.o)
        if (ka.trim() === '' && kb.trim() === '') return a.i - b.i
        if (ka.trim() === '') return 1
        if (kb.trim() === '') return -1
        return ka < kb ? 1 : ka > kb ? -1 : a.i - b.i
      })
      .map((x) => x.o)
  }, [orders])

  /** Rows whose own date is not the shift's — the ones a driver most often has to take out. */
  const otherDayRows = today ? orders.filter((o) => o.dateText && o.dateText !== today && o.included !== false) : []
  const excludeOtherDays = (): void =>
    onOrders(orders.map((o) => (o.dateText && today && o.dateText !== today ? { ...o, included: false } : o)))

  return (
    <>
      {/* WHAT THE CHECKBOX MEANS, said once. It is the most consequential control on the screen and
          its meaning existed only as an aria-label — a driver had no way to learn that unchecking a
          row takes it out of his money while keeping it visible to everyone. */}
      <Card className="bg-slate-50">
        <p className="text-sm text-slate-600">{t.orders.checkboxLegend}</p>
      </Card>

      {/* Sticky, because it scrolled away the moment he started working — on a list where the
          count and the money it adds up to are the whole point. */}
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-[var(--ash-bg,#eef1f8)] px-4 py-2">
        <span className="text-sm font-semibold">
          {t.orders.countedOf.replace('{n}', String(checkedCount)).replace('{total}', String(orders.length))}
        </span>
        {otherDayRows.length > 0 ? (
          <Button variant="ghost" className="ms-auto min-h-11 px-3 py-1 text-sm" onClick={excludeOtherDays}>
            {t.orders.excludeOtherDays.replace('{n}', String(otherDayRows.length))}
          </Button>
        ) : null}
      </div>

      {sorted.map((o, i) => {
        const problem = problems.get(o.localId)
        const off = o.included === false
        const otherDay = Boolean(today && o.dateText && o.dateText !== today)
        const prev = sorted[i - 1]
        // A day header wherever the date changes — so «أمس» is a block the driver can see and act
        // on, instead of rows he has to notice one at a time.
        const newDay = o.dateText && o.dateText !== (prev?.dateText ?? null)
        return (
          <Fragment key={o.localId}>
            {newDay ? (
              <p className="num mt-2 text-sm font-semibold text-slate-600">
                {dayMonth(o.dateText!)}
                {otherDay ? <span className="ms-2 text-xs font-medium text-amber-800">{t.orders.otherDay}</span> : null}
              </p>
            ) : null}
            <Card className={problem ? 'ring-2 ring-red-300' : off ? 'opacity-60' : ''}>
              {/* THE WHOLE ROW IS THE CHECKBOX. A 24px target on a phone, outdoors, in gloves, is
                  how a real delivery gets excluded from a driver's pay by accident. */}
              <label className="flex min-h-14 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={!off}
                  onChange={(e) => update(o.localId, { included: e.target.checked })}
                  aria-label={t.orders.included}
                  className="size-7 shrink-0 accent-emerald-600"
                />
                <div className="min-w-0 flex-1">
                  {o.timeText || o.dateText || o.pointA || o.pointB ? (
                    <>
                      <span className="num text-base font-semibold">{o.timeText || dayMonth(o.dateText ?? '')}</span>
                      {/* One arrow only when there are two places. A lone «عمر الخيام ← —» reads as
                          a delivery to nowhere; it means the screen's second line went unread. */}
                      {o.pointA || o.pointB ? (
                        <p className="truncate text-sm text-slate-600">
                          {o.pointA && o.pointB ? `${o.pointA} ← ${o.pointB}` : (o.pointA ?? o.pointB)}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-sm text-slate-500">{t.orders.manualRow}</span>
                  )}
                </div>
              </label>

              {/* THREE OPTIONS, VISIBLE. It used to be one chip that cycled on tap with nothing
                  saying so: the driver read «كاش» as a label and never touched it — which IS
                  `pay_mode_misclassified`, the commonest cause BR1 reports — or tapped once too
                  often and landed on «مجاني», silently zeroing what the order contributes. */}
              <div className="mt-2 flex gap-1" role="group" aria-label={t.orders.payMode}>
                {(['cash', 'electronic', 'free'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => update(o.localId, { payMode: mode })}
                    aria-pressed={o.payMode === mode}
                    className={`min-h-12 flex-1 rounded-xl px-2 text-sm font-semibold ${
                      o.payMode === mode ? modeColor[mode] : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {modeLabel[mode]}
                  </button>
                ))}
              </div>

              {/* LABELLED. Two identical white boxes, told apart only by a placeholder that vanishes
                  the moment the log fills it in, across thirty rows — and they are the two figures
                  that decide whether the driver is short. */}
              <div className="mt-2 flex items-end gap-2">
                <label className="flex flex-1 flex-col gap-0.5">
                  <span className="text-xs font-medium text-slate-600">{t.orders.fee}</span>
                  <MoneyInput value={o.feeText} onChange={(e) => update(o.localId, { feeText: e.target.value })} />
                </label>
                <label className="flex w-32 flex-col gap-0.5">
                  <span className="text-xs font-medium text-slate-600">{t.orders.toWallet}</span>
                  <MoneyInput
                    value={o.walletAmountText ?? ''}
                    onChange={(e) => update(o.localId, { walletAmountText: e.target.value })}
                  />
                </label>
              </div>
              {problem ? <p className="mt-1 text-sm font-medium text-red-600">{t.orders.problems[problem.kind]}</p> : null}
            </Card>
          </Fragment>
        )
      })}

      {orders.length === 0 ? <p className="py-6 text-center text-slate-500">{t.orders.addRow} ↑</p> : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          {/* «الأجرة» alone made this look like the shift total, or like a control over the row
              below it. It sets the fee a row ADDED BY HAND starts with, and nothing else. */}
          <span className="text-xs font-medium text-slate-600">{t.orders.newRowFee}</span>
          <MoneyInput value={defaultFee} onChange={(e) => setDefaultFee(e.target.value)} className="w-28" />
        </label>
        <Button variant="ghost" onClick={addRow}>
          + {t.orders.addRow}
        </Button>
      </div>

      {/* The wallet's own rows: what MOVED, beside what the orders imply. Only the ones no order
          explains are money the equation has to be told about. */}
      {movements.length > 0 ? (
        <>
          <p className="mt-2 text-sm font-semibold">{t.shift.paymentsLog}</p>
          <p className="text-sm text-slate-600">{t.orders.movementsLegend}</p>
          {movements.map((m) => {
            const off = m.included === false
            const explained = (m.role ?? 'unmatched') !== 'unmatched'
            const outward = m.amountText.trim().startsWith('-') || m.amountText.trim().startsWith('−')
            return (
              <Card key={m.localId} className={off ? 'opacity-60' : ''}>
                <label className="flex min-h-14 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={!off}
                    onChange={(e) =>
                      onMovements(movements.map((x) => (x.localId === m.localId ? { ...x, included: e.target.checked } : x)))
                    }
                    aria-label={t.orders.included}
                    className="size-7 shrink-0 accent-emerald-600"
                  />
                  <span className="num w-14 text-sm text-slate-600">{m.timeText || '—'}</span>
                  {/* Money in and money out looked identical but for a minus sign. */}
                  <Money value={m.amountText} className={`font-semibold ${outward ? 'text-red-700' : 'text-emerald-700'}`} />
                  {explained ? (
                    <span className="ms-auto text-xs text-slate-600">{t.orders.explainedByOrder}</span>
                  ) : (
                    /* The flag that actually changes the equation was the lowest-contrast text on
                       the screen. It is the thing on this row that matters. */
                    <span className="ms-auto rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                      {t.orders.unexplained}
                    </span>
                  )}
                </label>
              </Card>
            )
          })}
        </>
      ) : null}
    </>
  )
}
