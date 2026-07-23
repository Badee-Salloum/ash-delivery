import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { DraftOrder } from '@ash/client'
import { compressImage, uploadEvidencePath } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Button, Card, Field, Money, MoneyInput, Screen, TextInput } from '../ui.tsx'
import { OrderEntry } from './OrderEntry.tsx'
import { BatteryPanel, type FittedBattery } from './BatteryPanel.tsx'

/**
 * The driver's shift flow: start package → order entry → end package.
 *
 * Photo capture uses the device camera (`capture="environment"`), compresses to ~300 KB on the
 * phone before upload, and retries idempotently — the server dedupes by content hash, so a
 * dropped Wi-Fi connection mid-upload is a re-tap, not a lost photo.
 */

type Phase = 'start' | 'awaiting' | 'orders' | 'end' | 'done'

interface ShiftState {
  id: string
  floatText: string
  topupText: string
}

/** Where a shift already in flight puts the driver back. */
const PHASE_FOR: Record<string, Phase> = {
  draft: 'start',
  awaiting_open_approval: 'awaiting',
  open: 'orders',
  // «معلقة» (س29): an incident mid-shift. The data is completed later under the same equation,
  // so the driver carries on exactly where an open shift would.
  suspended: 'orders',
  pending_review: 'done',
}

export function ShiftFlow({
  assignment,
  batteries,
  resume,
  onDiscarded,
}: {
  assignment: { driverId: string; vehicleId: string; shiftNo: number }
  /** The packs fitted to this bike, from `/me/assignment` — the same list the BR5 gate counts. */
  batteries: readonly FittedBattery[]
  /** A shift already in flight. Present ⇒ resume it; absent ⇒ this is a fresh start. */
  resume?: { id: string; state: string }
  onDiscarded?(): void
}): ReactNode {
  const { api, t } = useApp()
  const [phase, setPhase] = useState<Phase>(resume ? (PHASE_FOR[resume.state] ?? 'start') : 'start')
  const [shift, setShift] = useState<ShiftState | null>(null)
  const [recorded, setRecorded] = useState<DraftOrder[]>([])
  const [orderError, setOrderError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(!resume)

  /**
   * Pick the shift back up.
   *
   * The float and top-up come from the MANAGER's approval, so the order screen's live BR1 preview
   * would be wrong without them; the orders already recorded must come back because
   * `provider_order_no` is globally unique and retyping one is a 409 the driver cannot see.
   */
  useEffect(() => {
    if (!resume) return
    void api
      .shiftState(resume.id)
      .then((st) => {
        setShift({ id: st.id, floatText: st.startPackage.floatTotal, topupText: st.startPackage.topupTotal })
        setRecorded(
          st.orders.map((o) => ({
            // `already-<no>` rather than a random id: the list is rebuilt from the server on every
            // resume, and a stable key keeps React from remounting rows the driver is editing.
            localId: `already-${o.providerOrderNo}`,
            providerOrderNo: o.providerOrderNo,
            payMode: o.payMode,
            feeText: o.fee,
          })),
        )
        // Trust the server's state over the one the assignment reported: the manager may have
        // approved between the two calls.
        setPhase(PHASE_FOR[st.state] ?? 'start')
        setLoaded(true)
      })
      .catch(() => setLoaded(true)) // fall back to the state /me/assignment reported
  }, [api, resume])

  const discard = async (): Promise<void> => {
    if (!resume) return
    await api.cancelMyShift(resume.id).catch(() => undefined)
    onDiscarded?.()
  }

  if (!loaded) {
    return (
      <Screen title={t.shift.resumeShift}>
        <Card>
          <p className="text-center text-slate-400">{t.common.loading}</p>
        </Card>
      </Screen>
    )
  }

  if (phase === 'start' || phase === 'awaiting') {
    return (
      <StartPackage
        assignment={assignment}
        batteries={batteries}
        existingShiftId={resume?.id ?? null}
        onDiscard={resume ? discard : undefined}
        awaiting={phase === 'awaiting'}
        onOpened={(id) => {
          setShift({ id, floatText: '0', topupText: '0' })
          setPhase('awaiting')
        }}
        onApproved={(funds) => {
          // The manager entered the float + top-up at approval; carry them into the order screen so
          // the live BR1 preview is right.
          setShift((s) => (s ? { ...s, ...funds } : s))
          setPhase('orders')
        }}
      />
    )
  }
  if (phase === 'orders' && shift) {
    return (
      <>
        {/* A refused order has to be visible. The driver taps «تم» and, before this, nothing at
            all happened — the screen simply did not advance and gave him no reason. */}
        {orderError ? (
          <Card>
            <p className="text-center text-sm font-medium text-red-600">{orderError}</p>
          </Card>
        ) : null}
      <OrderEntry
        shift={shift}
        initialOrders={recorded}
        onDone={async (orders) => {
          // Only what is not already on the server: provider_order_no is globally unique, so a
          // resubmitted order is a 409 — and this used to have no catch at all, so one of them
          // rejected the promise, `setPhase('end')` never ran, and «تم» silently did nothing.
          const already = new Set(recorded.map((o) => o.providerOrderNo.trim()))
          const failed = await submitOrders(api, shift.id, orders.filter((o) => !already.has(o.providerOrderNo.trim())))
          if (failed.length > 0) {
            setOrderError(`${t.shift.ordersFailed}: ${failed.join(', ')}`)
            return
          }
          setOrderError(null)
          setPhase('end')
        }}
      />
      </>
    )
  }
  if (phase === 'end' && shift) {
    return <EndPackage shift={shift} batteries={batteries} onSubmitted={() => setPhase('done')} />
  }
  return (
    <Screen title={t.app.title}>
      <Card>
        <p className="text-center text-lg font-semibold text-emerald-700">{t.shift.states.pending_review} ✓</p>
      </Card>
    </Screen>
  )
}

/**
 * Post the orders, returning the numbers that would not save.
 *
 * It used to `await` each one with no catch: a single rejection — a duplicate order number is a
 * 409, and they are GLOBALLY unique — took the whole promise down, the phase never advanced, and
 * the driver tapped «تم» to no visible effect. Reporting the failures lets the screen say which.
 */
async function submitOrders(
  api: ReturnType<typeof useApp>['api'],
  shiftId: string,
  orders: DraftOrder[],
): Promise<string[]> {
  const failed: string[] = []
  for (const o of orders) {
    try {
      await api.post(`/shifts/${shiftId}/orders`, {
        providerOrderNo: o.providerOrderNo.trim(),
        payMode: o.payMode,
        fee: o.feeText,
        zone: null,
      })
    } catch {
      failed.push(o.providerOrderNo.trim())
    }
  }
  return failed
}

/** A camera-capture tile that compresses and uploads, showing progress and a taken/retake state. */
function PhotoSlot({
  shiftId,
  pkg,
  slot,
  label,
  onUploaded,
  onImage,
  source = 'camera',
}: {
  shiftId: string
  pkg: 'start' | 'end'
  slot: string
  label: string
  onUploaded(): void
  /**
   * The ORIGINAL file, for on-device OCR. Best-effort — never blocks the upload.
   *
   * Deliberately not the compressed bytes. `compressImage` caps the long edge at 1280 px and
   * drops JPEG quality to 0.4, which puts a phone screenshot's body text at roughly 10-13 px of
   * x-height — below what Tesseract's LSTM can read, with JPEG ringing on exactly the thin,
   * high-contrast glyphs a BMS readout is made of. The upload still carries the compressed copy;
   * OCR runs locally, so it costs nothing to give it the real pixels.
   */
  onImage?(file: File): void
  /**
   * `camera` opens the camera (an odometer is photographed). `gallery` does not — a BMS reading
   * is a SCREENSHOT the driver already took, and forcing the camera would make him photograph
   * one phone screen with another.
   */
  source?: 'camera' | 'gallery'
}): ReactNode {
  const { api, t } = useApp()
  const ref = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle')

  const onPick = useCallback(
    async (file: File) => {
      setState('working')
      try {
        const { bytes, mimeType } = await compressImage(file)
        await api.putBytes(uploadEvidencePath(shiftId, pkg, slot), bytes, mimeType, {
          'x-client-taken-at': String(Date.now()),
        })
        setState('done')
        onUploaded()
        onImage?.(file) // fire-and-forget OCR after the upload is safely done
      } catch {
        // The upload is idempotent, so the fix is simply to tap again.
        setState('error')
      }
    },
    [api, shiftId, pkg, slot, onUploaded, onImage],
  )

  return (
    <button
      onClick={() => ref.current?.click()}
      className={`flex min-h-20 items-center justify-between rounded-2xl border-2 border-dashed px-4 ${
        state === 'done' ? 'border-emerald-400 bg-emerald-50' : 'border-slate-300 bg-white'
      }`}
    >
      <span className="font-medium">{label}</span>
      <span className="text-sm text-slate-500">
        {state === 'working' ? t.common.loading : state === 'done' ? '✓' : state === 'error' ? t.common.retake : '📷'}
      </span>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        {...(source === 'camera' ? { capture: 'environment' as const } : {})}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onPick(f)
        }}
      />
    </button>
  )
}

function StartPackage({
  assignment,
  batteries,
  existingShiftId,
  onDiscard,
  awaiting,
  onOpened,
  onApproved,
}: {
  assignment: { driverId: string; vehicleId: string; shiftNo: number }
  batteries: readonly FittedBattery[]
  /** A draft that already exists. Present ⇒ attach to it; absent ⇒ create one. */
  existingShiftId?: string | null
  onDiscard?: (() => Promise<void>) | undefined
  awaiting: boolean
  onOpened(shiftId: string): void
  onApproved(funds: { floatText: string; topupText: string }): void
}): ReactNode {
  const { api, t } = useApp()
  const [shiftId, setShiftId] = useState<string | null>(existingShiftId ?? null)
  const [odo, setOdo] = useState('')
  const [battery, setBattery] = useState('')
  const [odoShot, setOdoShot] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [startSlots, setStartSlots] = useState<Set<string>>(new Set())
  const [batteriesReady, setBatteriesReady] = useState(batteries.length === 0)

  // Assisted OCR: read the odometer + battery off the dashboard photo and PRE-FILL the fields the
  // driver would otherwise type. Only fills a field the driver has not already entered, and any
  // failure is silent — the driver just types, exactly as before.
  const runOcr = useCallback(async (file: File): Promise<void> => {
    setOcrBusy(true)
    try {
      const { readDashboard } = await import('../ocr.ts')
      // The ORIGINAL file, not the compressed upload: 1280 px at q=0.4 puts body text under the
      // LSTM's recognition floor, and no tesseract parameter recovers from that.
      const reading = await readDashboard(file)
      if (reading?.odometer != null) setOdo((cur) => (cur === '' ? String(reading.odometer) : cur))
      if (reading?.battery != null) setBattery((cur) => (cur === '' ? String(reading.battery) : cur))
    } finally {
      setOcrBusy(false)
    }
  }, [])

  // Create the draft shift once, so the odometer photo has a shift to attach to. If this fails the
  // driver must be TOLD: swallowing it left the camera tile stuck on "loading" with no way to know
  // the bike was already on someone else's shift.
  useEffect(() => {
    // A shift the driver is RESUMING already exists. Posting again would be refused with
    // `driver_already_on_shift` — which is exactly the dead end resuming exists to end.
    if (shiftId) return
    void api
      .post<{ id: string }>('/shifts', assignment)
      .then((s) => {
        setShiftId(s.id)
        setCreateError(null)
      })
      .catch((e) => {
        const err = e as { error?: string; detail?: unknown }
        const detail = Array.isArray(err.detail) ? String(err.detail[0]) : undefined
        setCreateError(detail ?? err.error ?? 'error')
      })
  }, [api, assignment, shiftId])

  async function confirm(): Promise<void> {
    if (!shiftId) return
    setBusy(true)
    try {
      // The driver submits only the odometer + battery + photo. The cash float and wallet top-up
      // are the branch's money, entered by the manager at approval.
      await api.put(`/shifts/${shiftId}/start-package`, {
        odometerKm: Number(odo),
        // Blank is NULL, never 0. They used to be the same value on the wire, so "the driver did
        // not answer" was indistinguishable from "the pack is flat".
        batteryPercent: battery.trim() === '' ? null : Number(battery),
      })
      onOpened(shiftId)
    } finally {
      setBusy(false)
    }
  }

  // Poll for the branch manager's approval once submitted. On approval, read the float + top-up the
  // manager recorded so the order screen's live BR1 preview matches the ledger.
  useEffect(() => {
    if (!awaiting || !shiftId) return
    const timer = setInterval(async () => {
      try {
        const s = await api
          // `/state`, not the manager's `/review`: that one is `shift.approve`, so every poll a
          // driver made returned 403, was swallowed, and he waited on an approval that had
          // already happened.
          .shiftState(shiftId)
          .catch(() => null)
        if (s?.state === 'open') {
          onApproved({ floatText: s.startPackage.floatTotal, topupText: s.startPackage.topupTotal })
        }
      } catch {
        /* keep polling */
      }
    }, 4000)
    return () => clearInterval(timer)
  }, [awaiting, shiftId, api, onApproved])

  if (awaiting) {
    return (
      <Screen title={t.shift.startPackage}>
        <Card>
          <p className="text-center text-lg font-semibold text-amber-700">{t.shift.states.awaiting_open_approval}…</p>
        </Card>
        {onDiscard ? <DiscardButton onDiscard={onDiscard} /> : null}
      </Screen>
    )
  }

  const ready = shiftId !== null && odoShot && odo !== '' && battery !== ''

  return (
    <Screen
      title={t.shift.startPackage}
      footer={
        <Button variant="success" disabled={!ready || busy} onClick={confirm}>
          {busy ? t.common.loading : t.shift.confirmStart}
        </Button>
      }
    >
      {shiftId ? (
        <PhotoSlot
          shiftId={shiftId}
          pkg="start"
          slot="odometer"
          label={t.shift.odometer}
          onUploaded={() => {
            setOdoShot(true)
            setStartSlots((cur) => new Set(cur).add('odometer'))
          }}
          onImage={runOcr}
        />
      ) : (
        <Card>
          {createError ? (
            <p className="text-center font-medium text-red-600">
              {t.shift.cannotStart[createError as keyof typeof t.shift.cannotStart] ?? createError}
            </p>
          ) : (
            <p className="text-center text-slate-400">{t.common.loading}</p>
          )}
        </Card>
      )}
      {existingShiftId ? (
        <Card>
          <p className="text-center text-sm text-slate-500">{t.shift.resumeHint}</p>
        </Card>
      ) : null}
      {onDiscard ? <DiscardButton onDiscard={onDiscard} /> : null}
      {ocrBusy ? <p className="text-center text-sm text-slate-400">{t.shift.reading}…</p> : null}
      <Card className="flex flex-col gap-3">
        <Field label={t.shift.odometer}>
          <TextInput inputMode="numeric" value={odo} onChange={(e) => setOdo(e.target.value)} />
        </Field>
        <Field label={t.shift.battery}>
          <TextInput inputMode="numeric" value={battery} onChange={(e) => setBattery(e.target.value)} />
        </Field>
      </Card>
      {/* One screenshot and one set of numbers per pack fitted — the same count the gate reads. */}
      {shiftId ? (
        <BatteryPanel
          shiftId={shiftId}
          pkg="start"
          batteries={batteries}
          slots={startSlots}
          PhotoSlot={(props) => (
            <PhotoSlot
              {...props}
              onUploaded={() => {
                props.onUploaded()
                setStartSlots((cur) => new Set(cur).add(props.slot))
              }}
            />
          )}
          onReadingsChanged={setBatteriesReady}
        />
      ) : null}
    </Screen>
  )
}

function EndPackage({
  shift,
  batteries,
  onSubmitted,
}: {
  shift: ShiftState
  batteries: readonly FittedBattery[]
  onSubmitted(): void
}): ReactNode {
  const { api, t } = useApp()
  const [cash, setCash] = useState('')
  const [wallet, setWallet] = useState('')
  const [odo, setOdo] = useState('')
  const [battery, setBattery] = useState('')
  const [slots, setSlots] = useState<Set<string>>(new Set())
  const [br1, setBr1] = useState<{ difference: string; balanced: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const [batteriesReady, setBatteriesReady] = useState(batteries.length === 0)
  const required = ['dashboard', 'wallet', 'odometer', 'wallet_zeroed']
  const labels: Record<string, string> = {
    dashboard: t.shift.dashboardShot,
    wallet: t.shift.walletBalance,
    odometer: t.shift.odometer,
    wallet_zeroed: t.shift.walletZeroed,
  }
  // The end battery is now part of the gate, so the button waits for it too — a shift that
  // cannot be submitted should not offer a button that pretends otherwise.
  const ready =
    required.every((s) => slots.has(s)) && cash !== '' && wallet !== '' && odo !== '' && battery !== '' && batteriesReady

  async function submit(): Promise<void> {
    setBusy(true)
    try {
      const res = await api.put<{ br1: { difference: string; balanced: boolean } }>(`/shifts/${shift.id}/end-package`, {
        odometerKm: Number(odo),
        // Blank is NULL, never 0 — `Number('')` used to make an unanswered field look like a flat
        // pack, and the close gate never checked it at all.
        batteryPercent: battery.trim() === '' ? null : Number(battery),
        cashDeclared: cash,
        walletDeclared: wallet,
      })
      setBr1(res.br1)
      if (res.br1.balanced) onSubmitted()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      title={t.shift.endPackage}
      footer={
        <div className="flex flex-col gap-2">
          {br1 ? (
            <div
              className={`flex items-center justify-between rounded-2xl px-4 py-2 ${
                br1.balanced ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
              }`}
            >
              <span>{br1.balanced ? t.br1.balanced : t.br1.notBalanced}</span>
              <Money value={br1.difference} className="font-bold" />
            </div>
          ) : null}
          <Button variant="success" disabled={!ready || busy} onClick={submit}>
            {busy ? t.common.loading : t.shift.submitEnd}
          </Button>
        </div>
      }
    >
      {required.map((slot) => (
        <PhotoSlot
          key={slot}
          shiftId={shift.id}
          pkg="end"
          slot={slot}
          label={labels[slot]!}
          onUploaded={() => setSlots((prev) => new Set(prev).add(slot))}
        />
      ))}
      <Card className="flex flex-col gap-3">
        <Field label={t.shift.cashHandover}>
          <MoneyInput value={cash} onChange={(e) => setCash(e.target.value)} />
        </Field>
        <Field label={t.shift.walletBalance}>
          <MoneyInput value={wallet} onChange={(e) => setWallet(e.target.value)} />
        </Field>
        <Field label={t.shift.odometer}>
          <TextInput inputMode="numeric" value={odo} onChange={(e) => setOdo(e.target.value)} />
        </Field>
        <Field label={t.shift.battery}>
          <TextInput inputMode="numeric" value={battery} onChange={(e) => setBattery(e.target.value)} />
        </Field>
      </Card>
      {/* The close gate asks for the same per-pack evidence the open gate did. */}
      <BatteryPanel
        shiftId={shift.id}
        pkg="end"
        batteries={batteries}
        slots={slots}
        PhotoSlot={(props) => (
          <PhotoSlot
            {...props}
            onUploaded={() => {
              props.onUploaded()
              setSlots((prev) => new Set(prev).add(props.slot))
            }}
          />
        )}
        onReadingsChanged={setBatteriesReady}
      />
    </Screen>
  )
}

/**
 * Abandon a shift that never opened.
 *
 * Nothing has posted to the ledger in `draft` or `awaiting_open_approval`, so there is nothing to
 * reverse — and without this a driver who backs out of a start screen must wait for someone at
 * the office before he can work at all. The confirm step is there because it releases the bike.
 */
function DiscardButton({ onDiscard }: { onDiscard: () => Promise<void> }): ReactNode {
  const { t } = useApp()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!asking) {
    return (
      <Button variant="ghost" onClick={() => setAsking(true)}>
        {t.shift.discardShift}
      </Button>
    )
  }
  return (
    <Card className="flex flex-col gap-2">
      <p className="text-center text-sm">{t.shift.discardConfirm}</p>
      <div className="flex gap-2">
        <Button
          variant="danger"
          className="flex-1"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onDiscard()
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? t.common.loading : t.shift.discardShift}
        </Button>
        <Button variant="ghost" className="flex-1" onClick={() => setAsking(false)}>
          {t.common.cancel}
        </Button>
      </div>
    </Card>
  )
}
