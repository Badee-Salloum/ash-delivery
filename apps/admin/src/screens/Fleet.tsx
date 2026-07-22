import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { Badge, Button, Card, Table, TextInput } from '../ui.tsx'

interface Driver {
  id: string
  code: string
  fullNameAr: string
  active: boolean
  blockedByDocuments: boolean
  documents: Array<{ id: string; kind: string; expiresOn: string | null; status: string }>
}
interface Vehicle {
  id: string
  code: string
  state: 'ready' | 'charging' | 'maintenance' | 'stopped'
  active: boolean
}
interface Assignment {
  id: string
  driverId: string
  vehicleId: string
  businessDate: string
  shiftNo: number
}

const docTone: Record<string, 'green' | 'amber' | 'red' | 'slate'> = {
  valid: 'green',
  expiring_soon: 'amber',
  expires_today: 'amber',
  expired: 'red',
  no_expiry: 'slate',
}
const vehTone: Record<string, 'green' | 'sky' | 'amber' | 'slate'> = {
  ready: 'green',
  charging: 'sky',
  maintenance: 'amber',
  stopped: 'slate',
}

/** Drivers & vehicles (SRS B). Each driver carries his document status; an expired doc blocks him. */
export function Fleet(): ReactNode {
  const { api, t, branchId } = useApp()
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [newDriver, setNewDriver] = useState({ code: '', fullNameAr: '' })
  const [newVehicle, setNewVehicle] = useState({ code: '', vehicleTypeId: 'e_motorbike' })
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [assignDate, setAssignDate] = useState('')
  const [pick, setPick] = useState({ driverId: '', vehicleId: '' })
  const [assignError, setAssignError] = useState<string | null>(null)
  const [dayShifts, setDayShifts] = useState<Array<{ id: string; vehicleId: string; state: string }>>([])

  const load = (): void => {
    void api.get<{ drivers: Driver[] }>('/drivers').then((r) => setDrivers(r.drivers)).catch(() => setDrivers([]))
    void api.get<{ vehicles: Vehicle[] }>('/vehicles').then((r) => setVehicles(r.vehicles)).catch(() => setVehicles([]))
    void api
      .assignments(assignDate || undefined)
      .then((r) => {
        setAssignments(r.assignments)
        // The server decides what "today" is (Asia/Damascus business date) — echo its answer back
        // rather than computing a date in the browser's timezone.
        setAssignDate((d) => d || r.businessDate)
      })
      .catch(() => setAssignments([]))
    void api
      .shiftsOfDay(assignDate || undefined)
      .then((r) => setDayShifts(r.shifts))
      .catch(() => setDayShifts([]))
  }
  useEffect(load, [assignDate, branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const nameOfDriver = (id: string): string => drivers.find((d) => d.id === id)?.fullNameAr ?? id.slice(0, 8)
  const codeOfVehicle = (id: string): string => vehicles.find((v) => v.id === id)?.code ?? id.slice(0, 8)

  /**
   * A shift that never opened still holds its bike, and it never reaches the approval queue. This
   * is the only place it surfaces — so the manager can release the bike instead of the day's
   * second driver finding it permanently "busy".
   */
  const strandedShiftFor = (vehicleId: string): string | null =>
    dayShifts.find((s) => s.vehicleId === vehicleId && (s.state === 'draft' || s.state === 'awaiting_open_approval'))?.id ??
    null

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title={t.fleet.drivers}>
        <div className="mb-3 flex gap-2">
          <TextInput placeholder={t.fleet.code} value={newDriver.code} onChange={(e) => setNewDriver({ ...newDriver, code: e.target.value })} className="w-28" />
          <TextInput placeholder={t.fleet.name} value={newDriver.fullNameAr} onChange={(e) => setNewDriver({ ...newDriver, fullNameAr: e.target.value })} className="flex-1" />
          <Button
            onClick={async () => {
              await api.post('/drivers', { ...newDriver, ...(branchId ? { branchId } : {}) }).catch(() => undefined)
              setNewDriver({ code: '', fullNameAr: '' })
              load()
            }}
            disabled={!newDriver.code || !newDriver.fullNameAr}
          >
            +
          </Button>
        </div>
        <Table head={[t.fleet.code, t.fleet.name, t.fleet.documents]}>
          {drivers.map((d) => (
            <tr key={d.id}>
              <td className="px-3 py-1 num">{d.code}</td>
              <td className="px-3 py-1">
                {d.fullNameAr}
                {d.blockedByDocuments ? <span className="ms-2"><Badge tone="red">{t.fleet.blocked}</Badge></span> : null}
              </td>
              <td className="px-3 py-1">
                <div className="flex flex-wrap gap-1">
                  {d.documents.map((doc) => (
                    <Badge key={doc.id} tone={docTone[doc.status] ?? 'slate'}>
                      {doc.kind}
                    </Badge>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title={t.fleet.vehicles}>
        <div className="mb-3 flex gap-2">
          <TextInput placeholder={t.fleet.code} value={newVehicle.code} onChange={(e) => setNewVehicle({ ...newVehicle, code: e.target.value })} className="flex-1" />
          <Button
            onClick={async () => {
              await api.post('/vehicles', { ...newVehicle, ...(branchId ? { branchId } : {}) }).catch(() => undefined)
              setNewVehicle({ code: '', vehicleTypeId: 'e_motorbike' })
              load()
            }}
            disabled={!newVehicle.code}
          >
            +
          </Button>
        </div>
        <Table head={[t.fleet.code, t.fleet.state, '']}>
          {vehicles.map((v) => (
            <tr key={v.id}>
              <td className="px-3 py-1 num">{v.code}</td>
              <td className="px-3 py-1">
                <Badge tone={vehTone[v.state] ?? 'slate'}>{t.fleet.vehicleStates[v.state]}</Badge>
              </td>
              <td className="px-3 py-1">
                <select
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  value={v.state}
                  onChange={async (e) => {
                    await api.patch(`/vehicles/${v.id}`, { state: e.target.value }).catch(() => undefined)
                    load()
                  }}
                >
                  {(['ready', 'charging', 'maintenance', 'stopped'] as const).map((st) => (
                    <option key={st} value={st}>
                      {t.fleet.vehicleStates[st]}
                    </option>
                  ))}
                </select>
                {strandedShiftFor(v.id) ? (
                  <Button
                    variant="danger"
                    className="ms-2"
                    onClick={async () => {
                      await api.cancelShift(strandedShiftFor(v.id)!).catch(() => undefined)
                      load()
                    }}
                  >
                    {t.fleet.releaseVehicle}
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      {/*
        SRS B-3: the bike is bound to the driver BEFORE the shift. Once a row exists here the
        driver app shows him that bike only, and the API refuses a shift on any other — so this
        screen, not the driver's phone, is where the day's fleet is decided.
      */}
      <Card title={t.fleet.assignments}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="text-xs text-slate-500">{t.fleet.date}</label>
          <TextInput type="date" value={assignDate} onChange={(e) => setAssignDate(e.target.value)} className="w-40" />
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={pick.driverId}
            onChange={(e) => setPick({ ...pick, driverId: e.target.value })}
          >
            <option value="">{t.fleet.driver}</option>
            {drivers
              .filter((d) => d.active)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} — {d.fullNameAr}
                </option>
              ))}
          </select>
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={pick.vehicleId}
            onChange={(e) => setPick({ ...pick, vehicleId: e.target.value })}
          >
            <option value="">{t.fleet.vehicles}</option>
            {vehicles
              .filter((v) => v.active)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.code}
                </option>
              ))}
          </select>
          <Button
            disabled={!pick.driverId || !pick.vehicleId}
            onClick={async () => {
              setAssignError(null)
              try {
                await api.createAssignment({ ...pick, businessDate: assignDate })
                setPick({ driverId: '', vehicleId: '' })
              } catch (err) {
                // A duplicate is the one failure a manager will actually hit — name it, rather
                // than leaving the row silently absent from the table.
                const code = (err as { error?: string }).error
                setAssignError(code === 'already_assigned' ? t.fleet.alreadyAssigned : (code ?? 'error'))
              }
              load()
            }}
          >
            {t.fleet.assign}
          </Button>
        </div>
        {assignError ? <p className="mb-2 text-sm text-rose-600">{assignError}</p> : null}
        {assignments.length === 0 ? (
          <p className="py-2 text-sm text-slate-500">{t.fleet.noAssignments}</p>
        ) : (
          <Table head={[t.fleet.driver, t.fleet.vehicles, '']}>
            {assignments.map((a) => (
              <tr key={a.id}>
                <td className="px-3 py-1">{nameOfDriver(a.driverId)}</td>
                <td className="px-3 py-1 num">{codeOfVehicle(a.vehicleId)}</td>
                <td className="px-3 py-1">
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      await api.deleteAssignment(a.id).catch(() => undefined)
                      load()
                    }}
                  >
                    {t.fleet.unassign}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}
