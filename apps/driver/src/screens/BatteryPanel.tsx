import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type { BatteryReadingInput } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Card, Field, TextInput } from '../ui.tsx'

export interface FittedBattery {
  id: string
  slotNo: number | null
  capacityAh: number
  serialNo: string | null
}

/**
 * One BMS screenshot and one set of numbers PER BATTERY PACK.
 *
 * The bikes carry one or two packs, so this is not a single battery field: the shift gate asks for
 * a reading per pack fitted, and a two-pack bike cannot open or close on one screenshot. The pack
 * list comes from the server (`/me/assignment`), which is the same list the gate counts — so this
 * checklist and the gate can never disagree about how many readings are owed.
 *
 * The tile opens the GALLERY, not the camera: a BMS reading is a screenshot the driver already
 * took, and forcing the camera would make him photograph one phone screen with another.
 *
 * OCR pre-fills and the driver corrects. What the OCR read is kept in `ocrRaw` and sent alongside
 * the corrected value, so SRS D-3's "log the manual edit WITH its difference from the OCR reading"
 * is recoverable later rather than only at the moment of typing.
 */
export function BatteryPanel({
  shiftId,
  pkg,
  batteries,
  slots,
  PhotoSlot,
  onReadingsChanged,
}: {
  shiftId: string
  pkg: 'start' | 'end'
  batteries: readonly FittedBattery[]
  /** Which evidence slots have actually uploaded, so a tile can show its taken state. */
  slots: ReadonlySet<string>
  PhotoSlot: (props: {
    shiftId: string
    pkg: 'start' | 'end'
    slot: string
    label: string
    onUploaded(): void
    onImage?(file: File): void
    source?: 'camera' | 'gallery'
  }) => ReactNode
  onReadingsChanged?(complete: boolean): void
}): ReactNode {
  const { api, t } = useApp()
  const [values, setValues] = useState<Record<string, BatteryReadingInput>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const slotOf = (b: FittedBattery, i: number): number => b.slotNo ?? i + 1

  const complete = batteries.every((b, i) => {
    const v = values[b.id]
    return v?.percent != null && slots.has(`bms_${slotOf(b, i)}`)
  })
  useEffect(() => onReadingsChanged?.(complete), [complete, onReadingsChanged])

  /** Push one pack's reading. A retake corrects that pack's row rather than adding a second. */
  const push = useCallback(
    async (batteryId: string, next: BatteryReadingInput): Promise<void> => {
      setValues((cur) => ({ ...cur, [batteryId]: next }))
      if (next.percent == null) return
      // Every failure is swallowed on purpose: the gate re-reads the stored rows at submit time,
      // so a dropped write shows up as an honest "reading missing", never as a false success.
      await api.putBatteryReadings(shiftId, pkg, [next]).catch(() => undefined)
    },
    [api, shiftId, pkg],
  )

  const readBms = useCallback(
    async (battery: FittedBattery, file: File): Promise<void> => {
      setBusy(battery.id)
      try {
        const { readBms: read } = await import('../ocr.ts')
        const reading = await read(file)
        if (!reading) return
        await push(battery.id, {
          batteryId: battery.id,
          percent: reading.percent,
          packMillivolts: reading.packMillivolts,
          cycleCount: reading.cycleCount,
          remainCapacityDah: reading.remainCapacityDah,
          fullCapacityDah: reading.fullCapacityDah,
          mosTempDc: reading.mosTempDc,
          t1Dc: reading.t1Dc,
          t2Dc: reading.t2Dc,
          source: 'ocr',
          ocrRaw: reading,
        })
      } finally {
        setBusy(null)
      }
    },
    [push],
  )

  if (batteries.length === 0) {
    return (
      <Card>
        <p className="text-center text-sm text-amber-700">{t.battery.noneFitted}</p>
      </Card>
    )
  }

  return (
    <>
      {batteries.map((battery, i) => {
        const slotNo = slotOf(battery, i)
        const current = values[battery.id]
        return (
          <div key={battery.id} className="flex flex-col gap-3">
            <PhotoSlot
              shiftId={shiftId}
              pkg={pkg}
              slot={`bms_${slotNo}`}
              label={`${t.battery.bmsShot} ${slotNo} · ${battery.capacityAh}Ah`}
              onUploaded={() => undefined}
              onImage={(file) => void readBms(battery, file)}
              source="gallery"
            />
            {busy === battery.id ? <p className="text-center text-sm text-slate-400">{t.shift.reading}…</p> : null}
            <Card className="flex flex-col gap-3">
              <p className="text-sm text-slate-400">{t.battery.bmsHint}</p>
              <Field label={`${t.battery.percent} — ${t.battery.slot} ${slotNo}`}>
                <TextInput
                  inputMode="numeric"
                  value={current?.percent == null ? '' : String(current.percent)}
                  onChange={(e) => {
                    // A blank field is NULL, not 0. Those used to be the same value on the wire,
                    // so "the driver did not answer" was indistinguishable from "the pack is flat".
                    const text = e.target.value.trim()
                    void push(battery.id, {
                      ...(current ?? { batteryId: battery.id, percent: null }),
                      batteryId: battery.id,
                      percent: text === '' ? null : Math.min(100, Number(text)),
                      source: 'manual',
                      ocrRaw: current?.ocrRaw,
                    })
                  }}
                />
              </Field>
              {current?.cycleCount != null || current?.packMillivolts != null ? (
                // Read-only echo of what the screenshot said, so the driver can spot a misread
                // without being asked to retype figures he has no reason to know by heart.
                <p className="num text-xs text-slate-400">
                  {current.packMillivolts != null ? `${(current.packMillivolts / 1000).toFixed(2)} V · ` : ''}
                  {current.cycleCount != null ? `${t.battery.cycles}: ${current.cycleCount}` : ''}
                </p>
              ) : null}
            </Card>
          </div>
        )
      })}
    </>
  )
}
