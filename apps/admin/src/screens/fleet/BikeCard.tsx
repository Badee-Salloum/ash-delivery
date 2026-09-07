import type { ReactNode } from 'react'
import { type VehicleOccupancy, packsOn } from '@ash/client'
import { useApp } from '../../app-context.tsx'
import { Badge, Button, Select } from '../../ui.tsx'

export interface BikeVehicle {
  id: string
  code: string
  vehicleTypeId: string
  groundNo: string | null
  state: 'ready' | 'charging' | 'maintenance' | 'stopped'
  active: boolean
}
export interface BikePack {
  id: string
  capacityAh: number
  vehicleId: string | null
  slotNo: number | null
  groundNo: string | null
  serialNo: string | null
  active: boolean
}

/**
 * One bike, as the branch sees it.
 *
 * The table this replaces printed «جاهزة» against all ten machines while three were out with
 * drivers — it fetched the shift list and used it for one narrow case. `state` and OCCUPANCY are
 * two different axes and the table only ever showed the first: a bike can be perfectly `ready` and
 * completely unavailable because somebody is riding it.
 *
 * So the badge answers AVAILABILITY first. When a shift holds the bike that is the headline and the
 * maintenance state is demoted to a footnote — and shown only when it is not `ready`, because a
 * green «جاهزة» sitting beside «على نوبة الآن» is exactly the contradiction being fixed.
 */

const stateTone: Record<string, 'green' | 'sky' | 'amber' | 'slate'> = {
  ready: 'green',
  charging: 'sky',
  maintenance: 'amber',
  stopped: 'slate',
}

/** Availability tone. `out` is amber, not red: a bike doing its job is not a fault. */
const occupancyTone: Record<VehicleOccupancy['kind'], 'green' | 'amber' | 'sky' | 'slate'> = {
  free: 'green',
  waiting_to_start: 'slate',
  out: 'amber',
  awaiting_review: 'sky',
}

export function BikeCard({
  vehicle,
  packs,
  slots,
  typeName,
  occupancy,
  driverName,
  onState,
  onRelease,
  onHistory,
}: {
  vehicle: BikeVehicle
  packs: readonly BikePack[]
  /** The ceiling the TYPE declares, so an empty socket is visible rather than merely absent. */
  slots: number
  typeName: string
  occupancy: VehicleOccupancy
  driverName: string | null
  onState(state: string): void
  onRelease(shiftId: string): void
  onHistory(): void
}): ReactNode {
  const { t } = useApp()
  const held = occupancy.kind !== 'free'
  const fitted = packsOn(packs as BikePack[], vehicle.id)

  // What the badge says. Held → the shift's own word («جارية», «بانتظار المراجعة»), because that is
  // the fact that decides whether anyone else can have this bike.
  const label = held
    ? (t.shift.states[occupancy.shiftState as keyof typeof t.shift.states] ?? occupancy.shiftState ?? '')
    : vehicle.active
      ? t.fleet.vehicleStates[vehicle.state]
      : t.fleet.inactive

  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border border-slate-200 bg-surface-card p-4 shadow-sm border-s-4 ${
        held ? 'border-s-amber-400' : vehicle.state === 'ready' && vehicle.active ? 'border-s-emerald-400' : 'border-s-slate-300'
      }`}
    >
      {/* THE MARKING LEADS. It is what a person says out loud and what is painted on the machine;
          «1-1-1-4» is derived from where the bike sits in the fleet and is written on nothing. */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="num text-2xl font-bold leading-none text-slate-900">
            {vehicle.groundNo ?? <span className="text-lg text-slate-400">—</span>}
          </div>
          <div className="mt-1 truncate text-xs text-slate-500">
            <span className="num">{vehicle.code}</span> · {typeName}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge tone={held ? occupancyTone[occupancy.kind] : vehicle.active ? (stateTone[vehicle.state] ?? 'slate') : 'slate'}>
            {label}
          </Badge>
          {/* Who has it. Without the name the badge tells him a bike is gone and not who to ring. */}
          {held && driverName ? <span className="max-w-36 truncate text-xs text-slate-600">{driverName}</span> : null}
        </div>
      </div>

      {/* A CONFLICT, not a decoration: a bike out on a shift that is also in maintenance is worth
          seeing. Hidden while `ready`, so the common case stays quiet. */}
      {held && vehicle.state !== 'ready' ? (
        <p className="text-xs text-amber-700">{t.fleet.vehicleStates[vehicle.state]}</p>
      ) : null}

      {/* One chip per socket the TYPE declares — so a bike short a pack shows a gap instead of
          simply listing fewer chips, which is invisible. */}
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: slots }, (_, i) => i + 1).map((slot) => {
          const pack = fitted.find((p) => p.slotNo === slot)
          return pack ? (
            <span
              key={slot}
              className="num rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-700"
              title={pack.serialNo ?? undefined}
            >
              {slot} · {pack.capacityAh}Ah{pack.groundNo ? ` · ${pack.groundNo}` : ''}
            </span>
          ) : (
            <span key={slot} className="rounded-lg border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-400">
              {slot} · {t.battery.emptySlot}
            </span>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={`${t.fleet.state} — ${vehicle.groundNo ?? vehicle.code}`}
          className="min-w-28 flex-1"
          value={vehicle.state}
          onChange={(e) => onState(e.target.value)}
        >
          {(['ready', 'charging', 'maintenance', 'stopped'] as const).map((st) => (
            <option key={st} value={st}>
              {t.fleet.vehicleStates[st]}
            </option>
          ))}
        </Select>
        <Button variant="ghost" onClick={onHistory}>
          {t.fleet.history}
        </Button>
        {/* Only a shift that never opened can be released — `DELETE /shifts/:id` accepts `draft`
            and `awaiting_open_approval` and nothing else, so offering it on a running shift would
            be a button that always fails. */}
        {occupancy.kind === 'waiting_to_start' && occupancy.shiftId ? (
          <Button variant="danger" onClick={() => onRelease(occupancy.shiftId!)}>
            {t.fleet.releaseVehicle}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
