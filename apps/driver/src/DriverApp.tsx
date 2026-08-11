import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from './app-context.tsx'
import { Button, Card, Screen } from './ui.tsx'
import { Login } from './screens/Login.tsx'
import { ShiftFlow } from './screens/Shift.tsx'

interface Assignment {
  driverId: string
  branchId: string
  /** True when the manager has bound a bike to this driver for today — then `vehicles` is just it. */
  assigned?: boolean
  liveShiftId: string | null
  liveShiftState: string | null
  vehicles: Array<{
    id: string
    code: string
    /** «الرقم التمييزي على الأرض» — what is marked on the machine, null when it carries no number. */
    groundNo?: string | null
    state: string
    busy?: boolean
    /** True when the shift holding this bike is the driver's OWN. */
    busyByMe?: boolean
    /** The packs fitted to this bike — the same list the BR5 gate counts. */
    batteries?: Array<{
      id: string
      slotNo: number | null
      capacityAh: number
      groundNo?: string | null
      serialNo: string | null
      bmsProfile?: string | null
    }>
  }>
  /** Ready spares on the branch shelf, for a mid-shift battery swap (SRS §L seam). */
  spareBatteries?: Array<{
    id: string
    slotNo: number | null
    capacityAh: number
    groundNo?: string | null
    serialNo: string | null
    bmsProfile?: string | null
  }>
}

/**
 * The driver app is intentionally a straight line: log in → confirm today's bike → run the shift.
 * No side menu, no dashboard — a driver on a phone wants the next action, not navigation.
 */
export function DriverApp(): ReactNode {
  const { session, t, lang, setLang, api, setSession } = useApp()
  /** Whether the phone thinks it has a network. Cheap, and the difference between "the app is
      broken" and "wait until you are back in range". */
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const up = (): void => setOnline(true)
    const down = (): void => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  const [assignment, setAssignment] = useState<Assignment | null>(null)
  const [vehicleId, setVehicleId] = useState<string | null>(null)

  useEffect(() => {
    if (!session?.driverId) return
    void api.get<Assignment>('/me/assignment').then(setAssignment).catch(() => setAssignment(null))
  }, [api, session])

  /**
   * Absorb the Android/browser Back button while a shift is in flight.
   *
   * The app is one URL with no router, so a reflex Back tap — muscle memory on Android — would
   * bounce a working driver clean out of the app mid-shift. His shift is safe on the server (the
   * resume path re-fetches it), but the exit looks broken. So while he has a bike selected or a
   * live shift, we push a sentinel entry and re-push it on every Back, keeping him put. The shift
   * phases are forward-gated — Back never rewinds a phase; «إلغاء النوبة» is the only way back.
   * When idle at the picker with no live shift, Back is left alone so he can still leave.
   */
  const inFlight = vehicleId !== null || (assignment?.liveShiftId ?? null) !== null
  useEffect(() => {
    if (!inFlight) return
    window.history.pushState({ ashGuard: true }, '')
    const onPop = (): void => {
      window.history.pushState({ ashGuard: true }, '')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [inFlight])

  if (!session) return <Login />

  const bar = (
    <>
      {/* OFFLINE, SAID OUT LOUD. The service worker precaches the shell, so with no signal the app
          loads and looks perfectly healthy — buttons enabled, tiles tappable — and then every tap
          ends in «تعذّر تنفيذ العملية». A driver cannot tell a dead network from a broken app or a
          rejected shift, and the three call for completely different things. */}
      {!online ? (
        <div role="status" className="bg-amber-500 px-4 py-2 text-center text-sm font-semibold text-white">
          {t.common.offline}
        </div>
      ) : null}
      <div className="flex items-center justify-between bg-brand-700 px-2 py-1 text-xs text-white/80">
        {/* 44px targets with names. Two unlabelled 12px glyphs at the top of every screen, one of
            which flipped the whole app to English mid-shift and the other of which signed the
            driver out — neither asking, both a mis-tap away. */}
        <button
          onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
          aria-label={lang === 'ar' ? 'English' : 'العربية'}
          className="min-h-11 rounded-lg px-3 font-semibold active:bg-white/20"
        >
          {lang === 'ar' ? 'EN' : 'ع'}
        </button>
        <button
          onClick={async () => {
            if (!window.confirm(t.common.confirmLogout)) return
            try {
              await api.logout()
            } finally {
              // Always clear the session locally, even if the network call fails.
              setVehicleId(null)
              setSession(null)
            }
          }}
          className="min-h-11 rounded-lg px-3 font-semibold active:bg-white/20"
        >
          {t.common.logout}
        </button>
      </div>
    </>
  )

  if (!session.driverId) {
    return (
      <div>
        {bar}
        <Screen title={t.app.title}>
          <Card>
            <p className="text-center text-slate-500">{t.shift.myAssignment}: —</p>
          </Card>
        </Screen>
      </div>
    )
  }

  /**
   * A shift already running is RESUMED, never re-picked.
   *
   * `/me/assignment` has always reported `liveShiftId` and `liveShiftState`; nothing read them.
   * So a driver who closed the app, refreshed, or was thrown out mid-flow came back to a picker
   * whose every option `createShift` refuses with `driver_already_on_shift` — his shift existed,
   * held its bike, and was unreachable by the one person who could finish it.
   */
  if (assignment?.liveShiftId) {
    const bike = assignment.vehicles.find((v) => v.busyByMe) ?? null
    return (
      <div>
        {bar}
        <ShiftFlow
          assignment={{ driverId: session.driverId, vehicleId: bike?.id ?? '', shiftNo: 1 }}
          batteries={bike?.batteries ?? []}
          spares={assignment.spareBatteries ?? []}
          resume={{ id: assignment.liveShiftId, state: assignment.liveShiftState ?? 'draft' }}
          onDiscarded={() => {
            setVehicleId(null)
            void api.get<Assignment>('/me/assignment').then(setAssignment).catch(() => setAssignment(null))
          }}
        />
      </div>
    )
  }

  // Bike not yet chosen. When the manager has pre-assigned one (SRS B-3) the server sends exactly
  // that bike and the driver only confirms it; otherwise he picks from the branch's ready list.
  // Either way the server re-checks the binding on shift create, so no pick can produce an
  // unbacked shift.
  if (!vehicleId) {
    const assigned = assignment?.assigned === true
    return (
      <div>
        {bar}
        <Screen title={t.shift.myAssignment}>
          {assignment === null ? (
            <Card>
              <p className="text-center text-slate-600">{t.common.loading}</p>
            </Card>
          ) : assignment.vehicles.length === 0 ? (
            <Card>
              <p className="text-center text-slate-500">{assigned ? '—' : t.shift.noAssignment}</p>
            </Card>
          ) : assignment.vehicles.every((v) => v.busy === true) ? (
            // Every option disabled and no explanation is the worst version of this screen: the
            // driver taps each one in turn and nothing happens. Say it plainly instead.
            <Card>
              <p className="text-center font-medium text-amber-700">{t.shift.allVehiclesBusy}</p>
            </Card>
          ) : (
            <>
              <Card>
                <p className="text-center text-sm text-slate-500">
                  {assigned ? t.shift.assignedVehicle : t.shift.pickVehicle}
                </p>
              </Card>
              {/* A bike on someone else's live shift cannot be started: show it, but disabled and
                  labelled, rather than letting the driver pick it and hit a refusal. */}
              {assignment.vehicles.map((v) => (
                <Button
                  key={v.id}
                  variant={assigned ? 'primary' : 'ghost'}
                  disabled={v.busy === true}
                  onClick={() => setVehicleId(v.id)}
                >
                  {/* THE NUMBER HE CAN READ ON THE BIKE FIRST, and the fleet code under it. He is
                      standing in front of ten machines: the marking is what tells them apart, and
                      «1-1-1-4» is not written on any of them. When a bike carries no marking the
                      code stands alone rather than leaving a gap where a number should be. */}
                  <span className="flex flex-col items-center leading-tight">
                    <span>
                      {v.groundNo == null || v.groundNo === ''
                        ? `${t.shift.vehicle} ${v.code}`
                        : `${t.shift.vehicle} ${v.groundNo}`}
                      {v.busy === true ? ` — ${v.busyByMe === true ? t.shift.yourShiftHere : t.shift.busyVehicle}` : ''}
                    </span>
                    {v.groundNo == null || v.groundNo === '' ? null : (
                      <span className="num text-xs font-normal opacity-70">{v.code}</span>
                    )}
                  </span>
                </Button>
              ))}
            </>
          )}
        </Screen>
      </div>
    )
  }

  return (
    <div>
      {bar}
      <ShiftFlow
        assignment={{ driverId: session.driverId, vehicleId, shiftNo: 1 }}
        batteries={assignment?.vehicles.find((v) => v.id === vehicleId)?.batteries ?? []}
        spares={assignment?.spareBatteries ?? []}
        onDiscarded={() => setVehicleId(null)}
      />
    </div>
  )
}

export { Button }
