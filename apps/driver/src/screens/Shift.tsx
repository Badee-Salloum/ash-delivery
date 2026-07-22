import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { DraftOrder } from '@ash/client'
import { compressImage, uploadEvidencePath } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Button, Card, Field, Money, MoneyInput, Screen, TextInput } from '../ui.tsx'
import { OrderEntry } from './OrderEntry.tsx'

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

export function ShiftFlow({ assignment }: { assignment: { driverId: string; vehicleId: string; shiftNo: number } }): ReactNode {
  const { api, t } = useApp()
  const [phase, setPhase] = useState<Phase>('start')
  const [shift, setShift] = useState<ShiftState | null>(null)

  if (phase === 'start' || phase === 'awaiting') {
    return (
      <StartPackage
        assignment={assignment}
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
      <OrderEntry
        shift={shift}
        onDone={async (orders) => {
          await submitOrders(api, shift.id, orders)
          setPhase('end')
        }}
      />
    )
  }
  if (phase === 'end' && shift) {
    return <EndPackage shift={shift} onSubmitted={() => setPhase('done')} />
  }
  return (
    <Screen title={t.app.title}>
      <Card>
        <p className="text-center text-lg font-semibold text-emerald-700">{t.shift.states.pending_review} ✓</p>
      </Card>
    </Screen>
  )
}

async function submitOrders(api: ReturnType<typeof useApp>['api'], shiftId: string, orders: DraftOrder[]): Promise<void> {
  for (const o of orders) {
    await api.post(`/shifts/${shiftId}/orders`, {
      providerOrderNo: o.providerOrderNo.trim(),
      payMode: o.payMode,
      fee: o.feeText,
      zone: null,
    })
  }
}

/** A camera-capture tile that compresses and uploads, showing progress and a taken/retake state. */
function PhotoSlot({
  shiftId,
  pkg,
  slot,
  label,
  onUploaded,
}: {
  shiftId: string
  pkg: 'start' | 'end'
  slot: string
  label: string
  onUploaded(): void
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
      } catch {
        // The upload is idempotent, so the fix is simply to tap again.
        setState('error')
      }
    },
    [api, shiftId, pkg, slot, onUploaded],
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
        capture="environment"
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
  awaiting,
  onOpened,
  onApproved,
}: {
  assignment: { driverId: string; vehicleId: string; shiftNo: number }
  awaiting: boolean
  onOpened(shiftId: string): void
  onApproved(funds: { floatText: string; topupText: string }): void
}): ReactNode {
  const { api, t } = useApp()
  const [shiftId, setShiftId] = useState<string | null>(null)
  const [odo, setOdo] = useState('')
  const [battery, setBattery] = useState('')
  const [odoShot, setOdoShot] = useState(false)
  const [busy, setBusy] = useState(false)

  // Create the draft shift once, so the odometer photo has a shift to attach to.
  useEffect(() => {
    if (shiftId) return
    void api
      .post<{ id: string }>('/shifts', assignment)
      .then((s) => setShiftId(s.id))
      .catch(() => undefined)
  }, [api, assignment, shiftId])

  async function confirm(): Promise<void> {
    if (!shiftId) return
    setBusy(true)
    try {
      // The driver submits only the odometer + battery + photo. The cash float and wallet top-up
      // are the branch's money, entered by the manager at approval.
      await api.put(`/shifts/${shiftId}/start-package`, {
        odometerKm: Number(odo),
        batteryPercent: Number(battery),
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
          .get<{ state: string; startPackage: { floatTotal: string; topupTotal: string } }>(`/shifts/${shiftId}/review`)
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
        <PhotoSlot shiftId={shiftId} pkg="start" slot="odometer" label={t.shift.odometer} onUploaded={() => setOdoShot(true)} />
      ) : (
        <Card>
          <p className="text-center text-slate-400">{t.common.loading}</p>
        </Card>
      )}
      <Card className="flex flex-col gap-3">
        <Field label={t.shift.odometer}>
          <TextInput inputMode="numeric" value={odo} onChange={(e) => setOdo(e.target.value)} />
        </Field>
        <Field label={t.shift.battery}>
          <TextInput inputMode="numeric" value={battery} onChange={(e) => setBattery(e.target.value)} />
        </Field>
      </Card>
    </Screen>
  )
}

function EndPackage({ shift, onSubmitted }: { shift: ShiftState; onSubmitted(): void }): ReactNode {
  const { api, t } = useApp()
  const [cash, setCash] = useState('')
  const [wallet, setWallet] = useState('')
  const [odo, setOdo] = useState('')
  const [battery, setBattery] = useState('')
  const [slots, setSlots] = useState<Set<string>>(new Set())
  const [br1, setBr1] = useState<{ difference: string; balanced: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const required = ['dashboard', 'wallet', 'odometer', 'wallet_zeroed']
  const labels: Record<string, string> = {
    dashboard: t.shift.dashboardShot,
    wallet: t.shift.walletBalance,
    odometer: t.shift.odometer,
    wallet_zeroed: t.shift.walletZeroed,
  }
  const ready = required.every((s) => slots.has(s)) && cash !== '' && wallet !== '' && odo !== ''

  async function submit(): Promise<void> {
    setBusy(true)
    try {
      const res = await api.put<{ br1: { difference: string; balanced: boolean } }>(`/shifts/${shift.id}/end-package`, {
        odometerKm: Number(odo),
        batteryPercent: Number(battery || '0'),
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
    </Screen>
  )
}
