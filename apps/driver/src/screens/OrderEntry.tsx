import { type ReactNode, useMemo, useRef, useState } from 'react'
import type { PayMode } from '@ash/domain'
import { type DraftOrder, allProblems, isComplete, nextPayMode, previewBr1 } from '@ash/client'
import type { OcrOrder } from '../ocr.ts'
import { useApp } from '../app-context.tsx'
import { useToast } from '../feedback.tsx'
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
  initialOrders = [],
  onDone,
  onBack,
}: {
  shift: { id: string; floatText: string; topupText: string }
  /**
   * Orders already recorded on the server, for a resumed shift.
   *
   * They must come back: `provider_order_no` is GLOBALLY unique, so a driver who retypes one gets
   * a 409 he cannot see. Seeding the list also means the live BR1 preview reflects the whole
   * shift rather than only what he has entered since reopening the app.
   */
  initialOrders?: readonly DraftOrder[]
  onDone(orders: DraftOrder[]): void
  /** Back to the running shift. Nothing here has been sent yet, so leaving costs nothing. */
  onBack?(): void
}): ReactNode {
  const { t } = useApp()
  const toast = useToast()
  const [orders, setOrders] = useState<DraftOrder[]>([...initialOrders])
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

  // SRS D-1: read the fee list off a «Recent orders» screenshot and append the rows pre-filled. The
  // screen has no order-id or pay-mode, so the number is auto-keyed from date+time (globally unique,
  // editable) and the pay-mode defaults to cash for the driver to set. He then curates to this shift.
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [scanning, setScanning] = useState(false)
  const scanOrders = async (file: File): Promise<void> => {
    setScanning(true)
    try {
      const { readOrders } = await import('../ocr.ts')
      const r = await readOrders(file)
      if (!r.ok || r.reading.orders.length === 0) {
        toast.error(t.orders.scanNone)
        return
      }
      setOrders((prev) => [
        ...prev,
        ...r.reading.orders.map((s: OcrOrder) => ({
          localId: crypto.randomUUID(),
          providerOrderNo: orderKeyFor(s),
          payMode: 'cash' as PayMode,
          feeText: s.fee,
          feeOcrText: s.fee,
        })),
      ])
      toast.success(t.orders.scanned.replace('{n}', String(r.reading.orders.length)))
    } catch {
      toast.error(t.common.actionFailed)
    } finally {
      setScanning(false)
    }
  }

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
      {...(onBack ? { back: { label: t.common.back, onBack } } : {})}
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
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">{t.orders.fee}</span>
        <MoneyInput value={defaultFee} onChange={(e) => setDefaultFee(e.target.value)} className="w-28" />
        {/* SRS D-1: scan «Recent orders» from the gallery to pre-fill the fee rows. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = '' // let the same file be re-picked
            if (file) void scanOrders(file)
          }}
        />
        <Button variant="ghost" className="ms-auto" disabled={scanning} onClick={() => fileRef.current?.click()}>
          {scanning ? t.common.loading : t.orders.scanOrders}
        </Button>
        <Button variant="ghost" onClick={addRow}>
          + {t.orders.addRow}
        </Button>
      </div>

      {orders.map((o, i) => {
        const problem = problems.get(o.localId)
        // Already on the server. The driver may come back to this list — to add a delivery he
        // forgot — but he cannot un-send one, so the row is read-only rather than an edit that
        // silently does nothing and leaves his BR1 preview disagreeing with the server's.
        const sent = o.recorded === true
        return (
          <Card key={o.localId} className={problem ? 'ring-2 ring-red-300' : sent ? 'opacity-70' : ''}>
            <div className="flex items-center gap-2">
              <span className="w-6 text-center text-sm text-slate-400">{i + 1}</span>
              <TextInput
                value={o.providerOrderNo}
                onChange={(e) => update(o.localId, { providerOrderNo: e.target.value })}
                placeholder={t.orders.orderNo}
                inputMode="numeric"
                className="flex-1"
                disabled={sent}
              />
              <button
                onClick={() => update(o.localId, { payMode: nextPayMode(o.payMode) })}
                disabled={sent}
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
                disabled={sent}
              />
              {sent ? (
                <span className="px-2 text-sm font-medium text-slate-400">{t.orders.sent}</span>
              ) : (
                <Button variant="ghost" onClick={() => remove(o.localId)} className="px-4" aria-label={t.common.remove}>
                  ×
                </Button>
              )}
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

/** A globally-unique, editable order key from the order's day + time, e.g. «YAL-20260727-2346». */
function orderKeyFor(s: OcrOrder): string {
  const day = (s.dateIso ?? '').replace(/-/g, '')
  const time = s.time.replace(':', '')
  return `YAL-${day}-${time}`
}
