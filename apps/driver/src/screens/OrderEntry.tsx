import { type ReactNode, useMemo, useState } from 'react'
import {
  type DraftCashDeduction,
  type DraftMovement,
  type DraftOrder,
  allProblems,
  closeOperationsSummary,
  withoutSupersededRemnants,
  clientUuid,
  feeSourceOf,
  frequentFees,
  groupThousands,
  newOrderKey,
  operationDecisionState,
  workedTotalText,
} from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Button, Card, Money, MoneyInput, Sheet } from '../ui.tsx'

/**
 * THE list of financially counted deliveries and cash deductions, followed by optional archival
 * payment-log observations. The archive is deliberately read-only: it never classifies pay mode,
 * changes a fee, or enters BR1/tiers/shares/postings.
 *
 * PAY MODE IS GONE, by the owner's decision (SRS BR3 retired — see CLAUDE.md). The three buttons
 * were most of a card's height and asked the driver to classify every delivery so the app could
 * predict the split between his cash and his wallet. The split was never a control: BR1's scalar is
 * blind to pay mode by construction, and both halves are independently evidenced — the wallet by a
 * photographed Yallago balance, the cash by a count at the branch. What survives is the equation
 * that matters, «cash + wallet == float + topup + 80% of the fees», and the driver is asked for one
 * thing per delivery instead of four. `payMode` is still sent as `cash` so nothing migrates.
 *
 * Inclusion is server-owned. The approved-open and submitted-close window classifies each row;
 * only a manager may override that classification with an audited reason. The driver can inspect
 * the status but cannot make the preview disagree with what the server will account for.
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
  cashDeductions,
  today,
  suspectLocalIds,
  onOrders,
  onCashDeductions,
}: {
  orders: readonly DraftOrder[]
  movements: readonly DraftMovement[]
  cashDeductions: readonly DraftCashDeduction[]
  /** The shift's own business date, «YYYY-MM-DD» — what a row's date is flagged against. */
  today?: string
  /**
   * The rows BR1 says to check first — the ones a machine read, when the shift does not balance.
   * `previewBr1` has always computed this and the screen threw it away, appending a generic
   * sentence instead of pointing at the blocks it means.
   */
  suspectLocalIds?: readonly string[]
  onOrders(next: DraftOrder[]): void
  onCashDeductions(next: DraftCashDeduction[]): void
}): ReactNode {
  const { t } = useApp()
  const [defaultFee, setDefaultFee] = useState('5000')

  /** Which delivery's panel is open. One at a time: this is a phone. */
  const [openId, setOpenId] = useState<string | null>(null)

  const problems = useMemo(() => allProblems(orders), [orders])
  const suspects = useMemo(() => new Set(suspectLocalIds ?? []), [suspectLocalIds])
  /** What he worked — the fees he is claiming, added up. See `workedTotal`. */
  const worked = useMemo(() => workedTotalText(orders), [orders])
  const open = openId === null ? null : (orders.find((o) => o.localId === openId) ?? null)
  const openProblem = open ? problems.get(open.localId) : undefined
  const openSource = open ? feeSourceOf(open) : 'typed'
  // A dropped pin is named, not printed: its coordinates are Arabic-Indic digits Tesseract
  // renders as debris, so the panel says what the card actually shows — a map location.
  const openDropoff = open ? (open.pointBIsPin === true ? t.orders.mapPin : open.pointB) : null
  // The fees already on this shift — what a refused row is most likely to be.
  const chips = useMemo(() => frequentFees(orders), [orders])

  const addRow = (): void => {
    // The key is machinery, generated here and never shown: `provider_order_no` is globally unique,
    // so it cannot be left empty and must not be anything two rows could ever arrive at.
    const localId = clientUuid()
    onOrders([
      ...orders,
      { localId, providerOrderNo: newOrderKey(localId), payMode: 'cash', feeText: defaultFee, included: true },
    ])
  }

  const update = (localId: string, patch: Partial<DraftOrder>): void =>
    onOrders(orders.map((o) => (o.localId === localId ? { ...o, ...patch } : o)))

  /**
   * The provenance mark on a block. Tiny by design — it answers "did the app guess this?" at a
   * glance, and the panel behind the block spells it out in words and shows the pixels.
   */
  const sourceMark: Record<'read' | 'refused' | 'typed', string> = {
    read: '◍',
    refused: '◌',
    typed: '✎',
  }

  /**
   * What the driver is actually shown.
   *
   * A retake rotates the evidence token, and until the merge learned to re-match on the printed
   * time and cost the old rows survived beside the fresh ones — carrying `human_time_edit`, which
   * renders as «بانتظار المدير». Shift d0a5a7ec read «محسوبة 10 من 21»: ten deliveries, each shown
   * twice, and half of them announcing a manager decision with no photo behind it to decide on.
   *
   * A row with no evidence whose printed identity an evidenced row already carries is a remnant,
   * not work. A row with no evidenced twin is NOT hidden — that one is a genuine lost photo and the
   * driver must retake it.
   */
  const visibleOrders = useMemo(() => withoutSupersededRemnants(orders), [orders])
  const visibleDeductions = useMemo(() => withoutSupersededRemnants(cashDeductions), [cashDeductions])
  const summary = useMemo(
    () => closeOperationsSummary(visibleOrders, visibleDeductions),
    [visibleOrders, visibleDeductions],
  )
  const summaryText = t.orders.compactSummary
    .replace('{total}', String(summary.orders.total))
    .replace('{included}', String(summary.orders.included))
    .replace('{pending}', String(summary.orders.pending))
    .replace('{excluded}', String(summary.orders.excluded))
  const deductionSummaryText = t.orders.deductionSummary
    .replace('{total}', String(summary.cashDeductions.total))
    .replace('{included}', String(summary.cashDeductions.included))
    .replace('{pending}', String(summary.cashDeductions.pending))
    .replace('{excluded}', String(summary.cashDeductions.excluded))
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
    return visibleOrders
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
  }, [visibleOrders])

  /** Rows whose own date is not the shift's — the ones a driver most often has to take out. */
  return (
    <>
      {/* Inclusion is shown but never edited here. The server owns the shift window and the manager
          owns any reasoned override, so a cached client cannot change accounting with a checkbox. */}
      <Card className="flex flex-col gap-1 bg-surface-card">
        <p className="text-sm font-semibold text-slate-800">{summaryText}</p>
        {summary.cashDeductions.total > 0 ? (
          <p className="text-sm text-slate-600">{deductionSummaryText}</p>
        ) : null}
        {summary.missingAmountTotal > 0 ? (
          <p className="text-sm font-medium text-red-700">
            {t.orders.missingAmounts.replace('{n}', String(summary.missingAmountTotal))}
          </p>
        ) : null}
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer py-1 font-medium">{t.shift.howReadingWorks}</summary>
          <p className="pt-1">{t.orders.inclusionReadOnly}</p>
        </details>
      </Card>

      {/* Sticky, because it scrolled away the moment he started working — on a list where the
          count and the money it adds up to are the whole point. */}
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-[var(--ash-bg,#eef1f8)] px-4 py-2">
        <span className="text-sm font-semibold">
          {t.orders.countedOf
            .replace('{n}', String(summary.orders.included))
            .replace('{total}', String(visibleOrders.length))}
        </span>
        {/* WHAT HE WORKED. The screen showed him ten rows and a count but never the day's own
            total — the one number he actually wants, and the term BR1 multiplies by 0.80. It sits
            in the bar that is already sticky, so it follows him down the list. */}
        <span className="text-sm text-slate-600">
          {t.orders.workedTotal} <Money value={worked} className="font-bold text-slate-900" />
        </span>
      </div>

      {/* ── THE GRID ────────────────────────────────────────────────────────────────────────
          A delivery was a 226px card, so TWO were visible at once on a 360x820 phone and a
          thirty-order day was seven thousand pixels of scrolling. Nine tenths of that height was
          controls the driver rarely touched. A block is the time and the fee — the two things he
          reads off the screen in his hand — and about two dozen fit where two used to.
          Everything else moved into the panel behind a tap. */}
      <div className="grid grid-cols-3 gap-2">
        {sorted.map((o) => {
          const problem = problems.get(o.localId)
          const decision = operationDecisionState(o)
          const off = decision === 'excluded'
          const pending = decision === 'pending'
          const otherDay = Boolean(today && o.dateText && o.dateText !== today)
          const suspect = suspects.has(o.localId)
          const source = feeSourceOf(o)
          return (
            <button
              key={o.localId}
              type="button"
              onClick={() => setOpenId(o.localId)}
              aria-label={`${o.timeText || t.orders.unknownTime} ${o.feeText}`}
              className={[
                'relative flex min-h-[72px] flex-col items-center justify-center rounded-2xl border-2 px-1 py-2',
                // The border carries the state, exactly as PhotoSlot's tile does — red needs
                // answering, rose was cancelled, amber is another day, emerald is simply fine.
                problem
                  ? 'border-red-400 bg-red-50'
                  : o.cancelled
                    ? 'border-rose-300 bg-rose-50'
                    : pending
                      ? 'border-amber-400 bg-amber-50'
                    : otherDay
                      ? 'border-amber-400 bg-amber-50'
                      : suspect
                        ? 'border-amber-300 bg-surface-card'
                        : 'border-slate-200 bg-surface-card',
                off ? 'opacity-50' : '',
              ].join(' ')}
            >
              {/* Read-only server classification: the mark is status, never a driver control. */}
              <span className="absolute end-1 top-1 text-xs" aria-hidden>
                {off ? '○' : pending ? '!' : '✓'}
              </span>
              <span className="num text-xs font-semibold text-slate-500">
                {o.timeText || t.orders.unknownTime}
              </span>
              <span className={`num text-lg font-bold ${o.feeText.trim() === '' ? 'text-red-600' : ''}`}>
                {o.feeText.trim() === '' ? '؟' : groupThousands(o.feeText)}
              </span>
              {/* WHERE THIS NUMBER CAME FROM — the driver has never been told. A machine-read fee
                  and one he typed himself look identical today, and he is the only person who can
                  still check it against the screen in his hand. */}
              <span className="text-[10px] leading-none text-slate-400">{sourceMark[source]}</span>
              <span
                className={`mt-1 max-w-full truncate rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                  decision === 'included'
                    ? 'bg-emerald-50 text-emerald-700'
                    : decision === 'pending'
                      ? 'bg-amber-100 text-amber-900'
                      : 'bg-slate-100 text-slate-600'
                }`}
              >
                {decision === 'included'
                  ? t.orders.included
                  : decision === 'pending'
                    ? t.orders.awaitingManagerDecision
                    : t.orders.excluded}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── THE PANEL BEHIND A BLOCK ────────────────────────────────────────────────────────
          Everything the tall card used to show inline, on one delivery at a time: where it went,
          what it cost, its read-only inclusion status, and where the number came from. */}
      <Sheet
        title={t.orders.editFee}
        open={open !== null}
        onClose={() => setOpenId(null)}
        closeLabel={t.common.close}
        footer={
          <Button variant="primary" className="w-full" onClick={() => setOpenId(null)}>
            {t.common.confirm}
          </Button>
        }
      >
        {open ? (
          <>
            <p className="num text-sm font-semibold text-slate-600">
              {open.timeText || t.orders.unknownTime}
              {open.cancelled ? (
                <span className="ms-2 rounded-md bg-rose-100 px-1.5 py-0.5 text-xs font-semibold text-rose-700">
                  {t.orders.cancelledCard}
                </span>
              ) : null}
            </p>
            {open.pointA || openDropoff ? (
              <p className="text-sm text-slate-600">
                {open.pointA && openDropoff ? (
                  <>
                    <bdi>{open.pointA}</bdi> ← <bdi>{openDropoff}</bdi>
                  </>
                ) : (
                  <bdi>{open.pointA ?? openDropoff}</bdi>
                )}
              </p>
            ) : null}

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-slate-600">{t.orders.feeWrong}</span>
              <MoneyInput
                value={open.feeText}
                onChange={(e) => update(open.localId, { feeText: e.target.value })}
                className={openProblem?.kind === 'empty_fee' ? 'ring-2 ring-red-400' : undefined}
              />
            </label>
            {chips.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {chips.map((fee) => (
                  <button
                    key={fee}
                    type="button"
                    onClick={() => update(open.localId, { feeText: fee })}
                    className="num min-h-11 rounded-xl bg-slate-100 px-3 text-sm font-semibold text-slate-700"
                  >
                    {fee}
                  </button>
                ))}
              </div>
            ) : null}
            {openProblem ? (
              <p className="text-sm font-medium text-red-600">{t.orders.problems[openProblem.kind]}</p>
            ) : null}

            {/* WHERE THE NUMBER CAME FROM, in words — and, when the app read it, the very pixels it
                read. The strip is cut losslessly from the original screenshot at read time, so this
                is not an approximation of the evidence, it IS the evidence, and it needs no network. */}
            <div className="rounded-2xl bg-slate-50 p-3">
              <p className="text-xs font-medium text-slate-600">
                {openSource === 'read' ? t.orders.sourceRead : openSource === 'refused' ? t.orders.sourceRefused : t.orders.sourceTyped}
              </p>
              {open.feeStrip ? (
                <>
                  <p className="mt-1 text-[10px] text-slate-500">{t.orders.ocrSaw}</p>
                  <img src={open.feeStrip} alt={t.orders.ocrSaw} className="mt-1 max-w-full rounded-lg bg-surface-card" />
                </>
              ) : null}
            </div>

            <div className="flex min-h-11 items-center gap-3" aria-label={t.orders.inclusionReadOnly}>
              <span
                className={`rounded-full px-2 py-1 text-xs font-medium ${
                  operationDecisionState(open) === 'excluded'
                    ? 'bg-slate-100 text-slate-600'
                    : operationDecisionState(open) === 'pending'
                      ? 'bg-amber-50 text-amber-800'
                      : 'bg-emerald-50 text-emerald-700'
                }`}
              >
                {operationDecisionState(open) === 'excluded'
                  ? t.orders.excluded
                  : operationDecisionState(open) === 'pending'
                    ? t.orders.awaitingManagerDecision
                    : t.orders.included}
              </span>
              <span className="text-xs text-slate-500">{t.orders.inclusionReadOnly}</span>
            </div>
          </>
        ) : null}
      </Sheet>

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

      {cashDeductions.length > 0 ? (
        <>
          <p className="mt-2 text-sm font-semibold">{t.orders.cashDeductions}</p>
          <p className="text-sm text-slate-600">{t.orders.cashDeductionHint}</p>
          {cashDeductions.map((deduction) => (
            <Card
              key={deduction.localId}
              className={deduction.included === false && deduction.timeReviewRequired !== true ? 'opacity-60' : ''}
            >
              <div className="flex items-center gap-3">
                {/* Inclusion comes from the shift-time window. Only a manager may override it,
                    with a reason, so the driver sees the status but cannot toggle it here. */}
                <span
                  className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-medium ${
                    deduction.timeReviewRequired === true
                      ? 'bg-amber-50 text-amber-800'
                      : deduction.included === false
                      ? 'bg-slate-100 text-slate-600'
                      : 'bg-emerald-50 text-emerald-700'
                  }`}
                >
                  {deduction.timeReviewRequired === true
                    ? t.orders.awaitingManagerDecision
                    : deduction.included === false
                      ? t.orders.excluded
                      : t.orders.included}
                </span>
                <span className="num w-20 text-xs text-slate-600">
                  {deduction.timeText || t.orders.unknownTime}
                </span>
                <label className="min-w-0 flex-1">
                  <span className="sr-only">{t.orders.cashDeductionAmount}</span>
                  <MoneyInput
                    value={deduction.amountText}
                    onChange={(e) =>
                      onCashDeductions(
                        cashDeductions.map((row) =>
                          row.localId === deduction.localId ? { ...row, amountText: e.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
                <span className="text-[10px] text-slate-400">{deduction.source === 'ocr' ? '◉' : '✎'}</span>
              </div>
              {deduction.pointA || deduction.pointB ? (
                <p className="mt-2 text-xs text-slate-600">
                  <bdi>{deduction.pointA ?? '—'}</bdi> → <bdi>{deduction.pointB ?? '—'}</bdi>
                </p>
              ) : null}
              {deduction.amountOcrText !== null && deduction.amountOcrText !== deduction.amountText ? (
                <p className="mt-1 text-xs text-slate-500">
                  {t.orders.ocrSaw}: <Money value={deduction.amountOcrText} />
                </p>
              ) : null}
            </Card>
          ))}
        </>
      ) : null}

      {/* Archive display only. There is intentionally no include/classify control: such a control
          would suggest these rows can change money when the product policy says they cannot. */}
      {movements.length > 0 ? (
        <>
          <p className="mt-2 text-sm font-semibold">{t.shift.paymentsLog}</p>
          <p className="text-sm text-slate-600">{t.orders.movementsLegend}</p>
          {movements.map((m) => {
            const outward = m.amountText.trim().startsWith('-') || m.amountText.trim().startsWith('−')
            return (
              <Card key={m.localId}>
                <div className="flex min-h-14 items-center gap-3">
                  <span className="num w-14 text-sm text-slate-600">{m.timeText || '—'}</span>
                  {/* Money in and money out looked identical but for a minus sign. */}
                  <Money value={m.amountText} className={`font-semibold ${outward ? 'text-red-700' : 'text-emerald-700'}`} />
                </div>
              </Card>
            )
          })}
        </>
      ) : null}
    </>
  )
}
