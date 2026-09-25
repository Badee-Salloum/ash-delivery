import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import type { RouteParams } from '../route.ts'
import { ShiftPathMap } from '../components/ShiftPathMap.tsx'
import { Card, DateField } from '../ui.tsx'

/**
 * Browse the recorded path of any shift (gps.view): pick a day, pick a shift, see its trail split
 * into a segment per order. The review overlay and the vehicle history show the same map inline;
 * this is the standalone way in when you already know the day.
 */

interface ShiftRow {
  id: string
  driverId: string
  vehicleId: string
  shiftNo: number
  businessDate: string
}
interface DriverLite {
  id: string
  fullNameAr: string
  fullNameEn: string | null
}

export function RecordedPaths({ initial = {} }: { initial?: RouteParams }): ReactNode {
  const { api, t, lang } = useApp()
  const [day, setDay] = useState<string>('')
  const [shifts, setShifts] = useState<ShiftRow[]>([])
  const [names, setNames] = useState<Record<string, DriverLite>>({})
  const [selected, setSelected] = useState<string | null>(initial.id ?? null)
  const [error, setError] = useState<string | null>(null)

  // The day starts as the server's «today», never the browser clock.
  useEffect(() => {
    void api
      .get<{ today: string }>('/dashboard/meta')
      .then((m) => setDay((d) => d || m.today))
      .catch(() => undefined)
    void api
      .get<{ drivers: DriverLite[] }>('/drivers')
      .then((r) => setNames(Object.fromEntries(r.drivers.map((d) => [d.id, d]))))
      .catch(() => undefined)
  }, [api])

  useEffect(() => {
    if (!day) return
    setError(null)
    void api
      .get<{ shifts: ShiftRow[] }>(`/shifts?from=${encodeURIComponent(day)}&to=${encodeURIComponent(day)}`)
      .then((r) => setShifts(r.shifts))
      .catch((e: { error?: string }) => setError(e.error ?? 'error'))
  }, [api, day])

  const driverName = useCallback(
    (id: string): string => {
      const d = names[id]
      if (!d) return id.slice(0, 8)
      return (lang === 'en' ? d.fullNameEn : null) ?? d.fullNameAr
    },
    [names, lang],
  )

  return (
    <div className="flex flex-col gap-4">
      <Card title={t.recordedPaths.title}>
        <DateField label={t.recordedPaths.day} value={day} onChange={setDay} />
        {error ? <p className="mt-2 text-sm text-danger-ink">{error}</p> : null}
        {shifts.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">{t.recordedPaths.noShifts}</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {shifts.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSelected(s.id)}
                  aria-pressed={selected === s.id}
                  className={`rounded-lg border px-3 py-1 text-sm ${
                    selected === s.id ? 'border-brand text-brand' : 'border-line-strong'
                  }`}
                >
                  {driverName(s.driverId)} · #{s.shiftNo}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {selected ? <ShiftPathMap key={selected} shiftId={selected} /> : null}
    </div>
  )
}
