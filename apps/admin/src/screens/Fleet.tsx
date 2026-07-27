import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { BMS_PROFILE_IDS, type VehicleEvent } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Badge, Button, Card, Money, Table, TextInput } from '../ui.tsx'

interface Driver {
  id: string
  code: string
  fullNameAr: string
  fullNameEn: string | null
  phone: string | null
  hiredOn: string | null
  /** Masked tail of the national ID («••••1234»), or null when none is on file. */
  nationalId: string | null
  active: boolean
  blockedByDocuments: boolean
  documents: Array<{ id: string; kind: string; expiresOn: string | null; status: string }>
}
interface Vehicle {
  id: string
  code: string
  vehicleTypeId: string
  machineNo: number
  plateNo: string | null
  state: 'ready' | 'charging' | 'maintenance' | 'stopped'
  active: boolean
}
interface VehicleType {
  id: string
  nameAr: string
  nameEn: string
  typeNo: number
  active: boolean
}
interface Battery {
  id: string
  serialNo: string | null
  capacityAh: number
  vehicleId: string | null
  slotNo: number | null
  state: 'ready' | 'charging' | 'maintenance' | 'retired'
  active: boolean
  bmsProfile: string | null
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
  const { api, t, lang, branchId } = useApp()
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [newDriver, setNewDriver] = useState({ code: '', fullNameAr: '', fullNameEn: '', phone: '', hiredOn: '', nationalId: '' })
  const [types, setTypes] = useState<VehicleType[]>([])
  const [batteries, setBatteries] = useState<Battery[]>([])
  // The type is CHOSEN, never typed. The old form posted the literal string 'e_motorbike' into a
  // uuid foreign key, which failed against Postgres every time and reported success.
  const [newVehicle, setNewVehicle] = useState({ vehicleTypeId: '', plateNo: '' })
  const [preview, setPreview] = useState<string | null>(null)
  const [vehicleError, setVehicleError] = useState<string | null>(null)
  const [newBattery, setNewBattery] = useState({ serialNo: '', capacityAh: '50' })
  const [batteryError, setBatteryError] = useState<string | null>(null)
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
    void api.vehicleTypes().then((r) => setTypes(r.vehicleTypes)).catch(() => setTypes([]))
    void api.batteries().then((r) => setBatteries(r.batteries)).catch(() => setBatteries([]))
  }
  useEffect(load, [assignDate, branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const nameOfDriver = (id: string): string => drivers.find((d) => d.id === id)?.fullNameAr ?? id.slice(0, 8)
  const nameOfType = (id: string): string => {
    const type = types.find((ty) => ty.id === id)
    return type ? (lang === 'ar' ? type.nameAr : type.nameEn) : '—'
  }
  const packsOn = (vehicleId: string): Battery[] =>
    batteries.filter((b) => b.vehicleId === vehicleId && b.active).sort((a, b) => (a.slotNo ?? 0) - (b.slotNo ?? 0))
  const codeOfVehicle = (id: string): string => vehicles.find((v) => v.id === id)?.code ?? id.slice(0, 8)

  useEffect(() => {
    if (!newVehicle.vehicleTypeId) {
      setPreview(null)
      return
    }
    // Asked of the server rather than computed here: a preview that derives the number
    // differently from the write would be worse than showing no preview at all.
    void api
      .nextVehicleNumber(newVehicle.vehicleTypeId)
      .then((r) => setPreview(r.code))
      .catch(() => setPreview(null))
  }, [api, newVehicle.vehicleTypeId, vehicles.length])

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
        <div className="mb-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <TextInput placeholder={t.fleet.code} value={newDriver.code} onChange={(e) => setNewDriver({ ...newDriver, code: e.target.value })} className="w-28" />
            <TextInput placeholder={t.fleet.name} value={newDriver.fullNameAr} onChange={(e) => setNewDriver({ ...newDriver, fullNameAr: e.target.value })} className="flex-1" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TextInput placeholder={t.fleet.nameEn} value={newDriver.fullNameEn} onChange={(e) => setNewDriver({ ...newDriver, fullNameEn: e.target.value })} className="min-w-32 flex-1" />
            <TextInput placeholder={t.fleet.phone} value={newDriver.phone} onChange={(e) => setNewDriver({ ...newDriver, phone: e.target.value })} className="w-36" />
            <TextInput type="date" title={t.fleet.hiredOn} value={newDriver.hiredOn} onChange={(e) => setNewDriver({ ...newDriver, hiredOn: e.target.value })} className="w-40" />
            <TextInput placeholder={t.fleet.nationalId} value={newDriver.nationalId} onChange={(e) => setNewDriver({ ...newDriver, nationalId: e.target.value })} className="w-40" />
            <Button
              onClick={async () => {
                // Send only the fields that were filled — an empty box means "leave blank", not "".
                const payload = {
                  code: newDriver.code,
                  fullNameAr: newDriver.fullNameAr,
                  ...(newDriver.fullNameEn ? { fullNameEn: newDriver.fullNameEn } : {}),
                  ...(newDriver.phone ? { phone: newDriver.phone } : {}),
                  ...(newDriver.hiredOn ? { hiredOn: newDriver.hiredOn } : {}),
                  ...(newDriver.nationalId ? { nationalId: newDriver.nationalId } : {}),
                  ...(branchId ? { branchId } : {}),
                }
                await api.post('/drivers', payload).catch(() => undefined)
                setNewDriver({ code: '', fullNameAr: '', fullNameEn: '', phone: '', hiredOn: '', nationalId: '' })
                load()
              }}
              disabled={!newDriver.code || !newDriver.fullNameAr}
            >
              +
            </Button>
          </div>
        </div>
        <Table head={[t.fleet.code, t.fleet.name, t.fleet.documents]}>
          {drivers.map((d) => (
            <tr key={d.id}>
              <td className="px-3 py-1 num">{d.code}</td>
              <td className="px-3 py-1">
                {d.fullNameAr}
                {d.blockedByDocuments ? <span className="ms-2"><Badge tone="red">{t.fleet.blocked}</Badge></span> : null}
                {[d.fullNameEn, d.phone, d.hiredOn, d.nationalId].some(Boolean) ? (
                  <div className="mt-0.5 text-xs text-slate-400">
                    {[d.fullNameEn, d.phone, d.hiredOn, d.nationalId].filter(Boolean).join(' · ')}
                  </div>
                ) : null}
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
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            value={newVehicle.vehicleTypeId}
            onChange={(e) => setNewVehicle({ ...newVehicle, vehicleTypeId: e.target.value })}
          >
            <option value="">{t.fleet.vehicleType}</option>
            {types
              .filter((ty) => ty.active)
              .map((ty) => (
                <option key={ty.id} value={ty.id}>
                  {ty.typeNo} — {lang === 'ar' ? ty.nameAr : ty.nameEn}
                </option>
              ))}
          </select>
          <TextInput
            placeholder={t.fleet.plateNo}
            value={newVehicle.plateNo}
            onChange={(e) => setNewVehicle({ ...newVehicle, plateNo: e.target.value })}
            className="w-32"
          />
          {/* The number is derived, so the operator sees it before committing to it. */}
          {preview ? (
            <span className="text-sm text-slate-500">
              {t.fleet.numberPreview}: <span className="num font-semibold text-brand">{preview}</span>
            </span>
          ) : null}
          <Button
            onClick={async () => {
              setVehicleError(null)
              try {
                await api.createVehicle({
                  vehicleTypeId: newVehicle.vehicleTypeId,
                  plateNo: newVehicle.plateNo || null,
                })
                setNewVehicle({ vehicleTypeId: '', plateNo: '' })
              } catch (err) {
                const code = (err as { error?: string }).error
                setVehicleError(code === 'vehicle_type_not_found' ? t.fleet.unknownTypeRefused : (code ?? 'error'))
              }
              load()
            }}
            disabled={!newVehicle.vehicleTypeId}
          >
            +
          </Button>
        </div>
        {vehicleError ? <p className="mb-2 text-sm text-rose-600">{vehicleError}</p> : null}
        {types.length === 0 ? <p className="mb-2 text-sm text-amber-700">{t.fleet.unknownTypeRefused}</p> : null}
        <Table head={[t.fleet.vehicleNumber, t.fleet.vehicleType, t.battery.title, t.fleet.state, '']}>
          {vehicles.map((v) => (
            <tr key={v.id}>
              <td className="px-3 py-1 num font-semibold">{v.code}</td>
              <td className="px-3 py-1 text-slate-500">{nameOfType(v.vehicleTypeId)}</td>
              <td className="px-3 py-1">
                {/* How many packs this bike carries — the same COUNT the shift gate reads, so what
                    the manager sees here is exactly what the driver will be asked to photograph. */}
                {packsOn(v.id).length === 0 ? (
                  <span className="text-xs text-amber-700">{t.battery.noneFitted}</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {packsOn(v.id).map((b) => (
                      <Badge key={b.id} tone="sky">
                        {b.slotNo}: {b.capacityAh}Ah
                      </Badge>
                    ))}
                  </div>
                )}
              </td>
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

      <VehicleHistory vehicles={vehicles} />

      <DocumentForm drivers={drivers} vehicles={vehicles} onAdded={load} />

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

      {/*
        Packs are assets, not attributes: they are the expensive consumable, they move between
        bikes, and the BMS shows a serial. Fitting one means BOTH a bike and a slot — the API
        refuses half of that, so this form asks for them together.
      */}
      <Card title={t.battery.title}>
        <div className="mb-3 flex flex-wrap gap-2">
          <TextInput
            placeholder={t.battery.serial}
            value={newBattery.serialNo}
            onChange={(e) => setNewBattery({ ...newBattery, serialNo: e.target.value })}
            className="flex-1"
          />
          <select
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            value={newBattery.capacityAh}
            onChange={(e) => setNewBattery({ ...newBattery, capacityAh: e.target.value })}
          >
            {['30', '50'].map((ah) => (
              <option key={ah} value={ah}>
                {ah} Ah
              </option>
            ))}
          </select>
          <Button
            onClick={async () => {
              setBatteryError(null)
              try {
                await api.createBattery({
                  serialNo: newBattery.serialNo || null,
                  capacityAh: Number(newBattery.capacityAh),
                })
                setNewBattery({ serialNo: '', capacityAh: '50' })
              } catch (err) {
                setBatteryError((err as { error?: string }).error ?? 'error')
              }
              load()
            }}
          >
            {t.battery.add}
          </Button>
        </div>
        {batteryError ? <p className="mb-2 text-sm text-rose-600">{batteryError}</p> : null}

        <p className="mb-2 text-xs text-slate-400">{t.battery.profileHint}</p>
        <Table head={[t.battery.serial, t.battery.capacity, t.battery.profile, t.fleet.vehicles, t.battery.slot, t.fleet.state]}>
          {batteries.map((b) => (
            <tr key={b.id}>
              <td className="px-3 py-1 num text-xs">{b.serialNo ?? '—'}</td>
              <td className="px-3 py-1 num">{b.capacityAh} Ah</td>
              <td className="px-3 py-1">
                {/* Which BMS app this pack ships with. The apps agree on nothing — one is an
                    English table, another an Arabic card grid — so naming it lets the driver's
                    reader use the right labels and layout instead of guessing at all of them. */}
                <select
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  value={b.bmsProfile ?? 'auto'}
                  onChange={async (e) => {
                    setBatteryError(null)
                    try {
                      await api.updateBattery(b.id, { bmsProfile: e.target.value === 'auto' ? null : e.target.value })
                    } catch (err) {
                      setBatteryError((err as { error?: string }).error ?? 'error')
                    }
                    load()
                  }}
                >
                  {BMS_PROFILE_IDS.map((id) => (
                    <option key={id} value={id}>
                      {t.battery.profiles[id]}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-1">
                <select
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  value={b.vehicleId ?? ''}
                  onChange={async (e) => {
                    setBatteryError(null)
                    const vehicleId = e.target.value || null
                    try {
                      // Fitted means both, spare means neither — send them together or the API
                      // refuses with battery_half_fitted.
                      await api.updateBattery(b.id, {
                        vehicleId,
                        slotNo: vehicleId === null ? null : (b.slotNo ?? 1),
                      })
                    } catch (err) {
                      setBatteryError((err as { error?: string }).error ?? 'error')
                    }
                    load()
                  }}
                >
                  <option value="">{t.battery.spare}</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.code}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-1">
                <select
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  value={b.slotNo ?? ''}
                  disabled={b.vehicleId === null}
                  onChange={async (e) => {
                    setBatteryError(null)
                    try {
                      await api.updateBattery(b.id, { slotNo: Number(e.target.value) })
                    } catch (err) {
                      setBatteryError((err as { error?: string }).error ?? 'error')
                    }
                    load()
                  }}
                >
                  <option value="">—</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </td>
              <td className="px-3 py-1">
                <Badge tone={b.state === 'ready' ? 'green' : b.state === 'retired' ? 'slate' : 'amber'}>
                  {t.battery.states[b.state]}
                </Badge>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  )
}

const eventTone: Record<string, 'slate' | 'amber' | 'red' | 'sky' | 'green'> = {
  state_change: 'slate',
  maintenance: 'amber',
  incident: 'red',
  charge: 'sky',
  odometer_reading: 'green',
}

/**
 * A vehicle's life log (SRS B-2 / س66): its history of state changes, maintenance, incidents,
 * charges and linked costs, newest first — and a small form to record one by hand. State changes
 * are logged automatically elsewhere, so they are read here but never offered as something to add.
 */
function VehicleHistory({ vehicles }: { vehicles: Vehicle[] }): ReactNode {
  const { api, t } = useApp()
  const [vehicleId, setVehicleId] = useState('')
  const [events, setEvents] = useState<VehicleEvent[]>([])
  const empty = { kind: 'maintenance', odometerKm: '', cost: '', notes: '' }
  const [form, setForm] = useState(empty)

  const load = useCallback(() => {
    if (!vehicleId) {
      setEvents([])
      return
    }
    void api.vehicleEvents(vehicleId).then((r) => setEvents(r.events)).catch(() => setEvents([]))
  }, [api, vehicleId])
  useEffect(load, [load])

  return (
    <Card title={t.fleet.history}>
      <select
        className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        value={vehicleId}
        onChange={(e) => setVehicleId(e.target.value)}
      >
        <option value="">—</option>
        {vehicles.map((v) => (
          <option key={v.id} value={v.id}>
            {v.code}
          </option>
        ))}
      </select>

      {vehicleId ? (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <select
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              {(['maintenance', 'incident', 'charge', 'odometer_reading'] as const).map((k) => (
                <option key={k} value={k}>
                  {t.fleet.eventKinds[k]}
                </option>
              ))}
            </select>
            <TextInput type="number" placeholder={t.fleet.odometer} value={form.odometerKm} onChange={(e) => setForm({ ...form, odometerKm: e.target.value })} className="w-28" />
            <TextInput placeholder={t.fleet.cost} value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} className="w-28" />
            <TextInput placeholder={t.fleet.notes} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="min-w-40 flex-1" />
            <Button
              onClick={async () => {
                await api
                  .recordVehicleEvent(vehicleId, {
                    kind: form.kind,
                    odometerKm: form.odometerKm ? Number(form.odometerKm) : null,
                    cost: form.cost || null,
                    notes: form.notes || null,
                  })
                  .catch(() => undefined)
                setForm(empty)
                load()
              }}
            >
              {t.fleet.recordEvent}
            </Button>
          </div>

          {events.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">{t.fleet.noEvents}</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-1 text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 border-b border-slate-100 py-1 last:border-0">
                  <span className="flex items-center gap-2">
                    <Badge tone={eventTone[e.kind] ?? 'slate'}>
                      {t.fleet.eventKinds[e.kind as keyof typeof t.fleet.eventKinds] ?? e.kind}
                    </Badge>
                    <span>{e.notes}</span>
                  </span>
                  <span className="flex items-center gap-3 text-slate-500">
                    {e.odometerKm !== null ? <span className="num">{e.odometerKm} km</span> : null}
                    {e.cost !== null ? <Money value={e.cost} /> : null}
                    <span className="num">{e.businessDate}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </Card>
  )
}

const DRIVER_DOC_KINDS = ['driving_licence', 'national_id', 'criminal_record'] as const
const VEHICLE_DOC_KINDS = ['registration', 'insurance'] as const

/**
 * Record a driver or vehicle document with its expiry (SRS B-1/B-2, س37). This is what makes an
 * expiring/expired document exist — and therefore what makes the expiry board light up and the
 * shift gate refuse an expired licence. Driver docs then show as badges on the driver's row.
 */
function DocumentForm({
  drivers,
  vehicles,
  onAdded,
}: {
  drivers: Driver[]
  vehicles: Vehicle[]
  onAdded: () => void
}): ReactNode {
  const { api, t } = useApp()
  const empty = { ownerKind: 'driver' as 'driver' | 'vehicle', ownerId: '', kind: 'driving_licence', issuedOn: '', expiresOn: '' }
  const [form, setForm] = useState(empty)
  const [err, setErr] = useState<string | null>(null)

  const kinds = form.ownerKind === 'driver' ? DRIVER_DOC_KINDS : VEHICLE_DOC_KINDS

  return (
    <Card title={t.fleet.documents}>
      <div className="flex flex-wrap items-end gap-2">
        <select
          className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          value={form.ownerKind}
          onChange={(e) => {
            const ownerKind = e.target.value as 'driver' | 'vehicle'
            // Switching owner resets the picked owner and the kind, since the kind lists differ.
            setForm({ ...empty, ownerKind, kind: ownerKind === 'driver' ? 'driving_licence' : 'registration' })
          }}
        >
          <option value="driver">{t.fleet.ownerKinds.driver}</option>
          <option value="vehicle">{t.fleet.ownerKinds.vehicle}</option>
        </select>

        <select
          className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          value={form.ownerId}
          onChange={(e) => setForm({ ...form, ownerId: e.target.value })}
        >
          <option value="">—</option>
          {form.ownerKind === 'driver'
            ? drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} — {d.fullNameAr}
                </option>
              ))
            : vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.code}
                </option>
              ))}
        </select>

        <select
          className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.target.value })}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {t.fleet.docKinds[k]}
            </option>
          ))}
        </select>

        <TextInput type="date" title={t.fleet.issued} value={form.issuedOn} onChange={(e) => setForm({ ...form, issuedOn: e.target.value })} className="w-40" />
        <TextInput type="date" title={t.fleet.expires} value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} className="w-40" />

        <Button
          disabled={!form.ownerId}
          onClick={async () => {
            setErr(null)
            try {
              await api.createDocument({
                ownerKind: form.ownerKind,
                driverId: form.ownerKind === 'driver' ? form.ownerId : null,
                vehicleId: form.ownerKind === 'vehicle' ? form.ownerId : null,
                kind: form.kind,
                ...(form.issuedOn ? { issuedOn: form.issuedOn } : {}),
                ...(form.expiresOn ? { expiresOn: form.expiresOn } : {}),
              })
              setForm({ ...empty, ownerKind: form.ownerKind, kind: form.kind })
              onAdded()
            } catch (e) {
              setErr((e as { error?: string }).error ?? 'error')
            }
          }}
        >
          {t.fleet.addDocument}
        </Button>
      </div>
      {err ? <p className="mt-2 text-sm text-rose-600">{err}</p> : null}
    </Card>
  )
}
