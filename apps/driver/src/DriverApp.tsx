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
  vehicles: Array<{ id: string; code: string; state: string; busy?: boolean }>
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
                  {v.busy === true ? ` — ${t.shift.busyVehicle}` : ''}
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
      <ShiftFlow assignment={{ driverId: session.driverId, vehicleId, shiftNo: 1 }} />
    </div>
  )
}

export { Button }
