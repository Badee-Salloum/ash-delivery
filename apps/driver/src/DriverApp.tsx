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
    state: string
    busy?: boolean
    /** True when the shift holding this bike is the driver's OWN. */
    busyByMe?: boolean
    /** The packs fitted to this bike — the same list the BR5 gate counts. */
    batteries?: Array<{
      id: string
      slotNo: number | null
      capacityAh: number
      serialNo: string | null
      bmsProfile?: string | null
    }>
  }>
}

/**
 * The driver app is intentionally a straight line: log in → confirm today's bike → run the shift.
 * No side menu, no dashboard — a driver on a phone wants the next action, not navigation.
 */
export function DriverApp(): ReactNode {
  const { session, t, lang, setLang, api, setSession } = useApp()
  const [assignment, setAssignment] = useState<Assignment | null>(null)
  const [vehicleId, setVehicleId] = useState<string | null>(null)

  useEffect(() => {
    if (!session?.driverId) return
    void api.get<Assignment>('/me/assignment').then(setAssignment).catch(() => setAssignment(null))
  }, [api, session])

  if (!session) return <Login />

  const bar = (
    <div className="flex items-center justify-between bg-brand-700 px-4 py-2 text-xs text-white/80">
      <button onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'EN' : 'ع'}</button>
      <button
        onClick={async () => {
          try {
            await api.logout()
          } finally {
            // Always clear the session locally, even if the network call fails.
            setVehicleId(null)
            setSession(null)
          }
        }}
      >
        {t.common.logout}
      </button>
    </div>
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
              <p className="text-center text-slate-400">{t.common.loading}</p>
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
                  {t.shift.vehicle} {v.code}
                  {v.busy === true ? ` — ${v.busyByMe === true ? t.shift.yourShiftHere : t.shift.busyVehicle}` : ''}
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
        onDiscarded={() => setVehicleId(null)}
      />
    </div>
  )
}

export { Button }
