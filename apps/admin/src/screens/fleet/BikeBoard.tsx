import { type ReactNode, useMemo, useState } from 'react'
import { type LiveShiftRow, fleetSummary, occupancyOf, spareBatteries } from '@ash/client'
import { useApp } from '../../app-context.tsx'
import { Button, Card, Stat } from '../../ui.tsx'
import { AddBike } from './AddBike.tsx'
import { BikeCard, type BikePack, type BikeVehicle } from './BikeCard.tsx'

/**
 * The fleet as a board of machines, which is what a branch manager is actually looking at.
 *
 * The question this exists to answer is the one the table could not: «كم آلية عندي، وكم واحدة
 * مشغولة الآن». The counts sit above the grid so it is answered before he reads a single card.
 */
export function BikeBoard({
  vehicles,
  batteries,
  types,
  liveShifts,
  driverName,
  onState,
  onRelease,
  onHistory,
  onChanged,
}: {
  vehicles: readonly BikeVehicle[]
  batteries: readonly BikePack[]
  types: ReadonlyArray<{ id: string; nameAr: string; nameEn: string; typeNo: number; batterySlots: number; active: boolean }>
  liveShifts: readonly LiveShiftRow[]
  driverName(id: string): string
  onState(vehicleId: string, state: string): void
  onRelease(shiftId: string): void
  onHistory(vehicleId: string): void
  onChanged(): void
}): ReactNode {
  const { t, lang } = useApp()
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState<'all' | 'busy' | 'free'>('all')

  const summary = useMemo(() => fleetSummary(vehicles, batteries, liveShifts), [vehicles, batteries, liveShifts])
  const spares = useMemo(() => spareBatteries(batteries), [batteries])

  const typeOf = (id: string): { name: string; slots: number } => {
    const ty = types.find((x) => x.id === id)
    return { name: ty ? (lang === 'ar' ? ty.nameAr : ty.nameEn) : '—', slots: ty?.batterySlots ?? 0 }
  }

  const shown = useMemo(() => {
    const withOcc = vehicles.map((v) => ({ v, occ: occupancyOf(v.id, liveShifts) }))
    const matched =
      filter === 'all' ? withOcc : withOcc.filter(({ occ }) => (filter === 'busy' ? occ.kind !== 'free' : occ.kind === 'free'))
    // Yard order: the marking is what he scans by, and a bike without one goes last rather than
    // sorting as an empty string among the numbered ones.
    return matched.slice().sort((a, b) => {
      const ga = a.v.groundNo
      const gb = b.v.groundNo
      if ((ga === null) !== (gb === null)) return ga === null ? 1 : -1
      return (ga ?? '').localeCompare(gb ?? '', undefined, { numeric: true }) || a.v.code.localeCompare(b.v.code)
    })
  }, [vehicles, liveShifts, filter])

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t.fleet.vehicles} value={String(summary.total)} />
        <Stat label={t.fleet.busyNow} value={String(summary.busy)} />
        <Stat label={t.battery.title} value={String(summary.packs)} />
        <Stat label={t.battery.spare} value={String(summary.spares)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'busy', 'free'] as const).map((f) => (
          <Button key={f} variant={filter === f ? 'primary' : 'ghost'} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? t.common.all : f === 'busy' ? t.fleet.busyNow : t.fleet.availableNow}
          </Button>
        ))}
        <Button className="ms-auto" onClick={() => setAdding((v) => !v)}>
          {t.fleet.addVehicle}
        </Button>
      </div>

      {adding ? (
        <AddBike
          types={types}
          onCancel={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            onChanged()
          }}
        />
      ) : null}

      {shown.length === 0 ? (
        <Card>
          <p className="text-center text-sm text-slate-500">{t.fleet.noneYet}</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map(({ v, occ }) => {
            const ty = typeOf(v.vehicleTypeId)
            return (
              <BikeCard
                key={v.id}
                vehicle={v}
                packs={batteries}
                slots={ty.slots}
                typeName={ty.name}
                occupancy={occ}
                driverName={occ.driverId ? driverName(occ.driverId) : null}
                onState={(state) => onState(v.id, state)}
                onRelease={onRelease}
                onHistory={() => onHistory(v.id)}
              />
            )
          })}
        </div>
      )}

      {/* Spares are the only packs no card shows, and they are exactly what a manager goes looking
          for when a driver needs a swap. */}
      {spares.length > 0 ? (
        <Card title={`${t.battery.spare} — ${spares.length}`}>
          <div className="flex flex-wrap gap-2">
            {spares.map((b) => (
              <span key={b.id} className="num rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-700">
                {b.groundNo ?? b.serialNo ?? b.id.slice(0, 6)} · {b.capacityAh}Ah
              </span>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  )
}
