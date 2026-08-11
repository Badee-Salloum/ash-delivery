import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from '../../app-context.tsx'
import { explainError } from '../../errors.ts'
import { Button, Card, Field, Select, TextInput } from '../../ui.tsx'

/**
 * Add a bike and the packs it carries, in one step.
 *
 * The owner entered ten bikes and twenty packs through the old forms. Each pack was three separate
 * controls after the fact — create it, find it in a table, choose its bike, choose its slot — and
 * every save reloaded six endpoints. The natural unit is a bike WITH its packs: he numbered every
 * pack after the machine it belongs to, which is as clear a statement as he could have made that he
 * thinks of them as one object.
 *
 * ── PARTIAL FAILURE ─────────────────────────────────────────────────────────────────────────
 * This is `POST /vehicles` and then one `POST /batteries` per row. The bike can be created and a
 * pack fail, and the one thing this must never do is leave the operator guessing what exists.
 *
 *   • the bike is created AT MOST ONCE — once it exists the form moves to a second phase and the
 *     button can only retry the packs. Without that, an impatient second press makes two bikes with
 *     consecutive machine numbers that nobody can tell apart, and the second becomes undeletable the
 *     moment a shift touches it.
 *   • each pack row carries its OWN outcome. A saved row goes quiet; a failed row keeps its values,
 *     stays editable, and shows its error beside itself — not in a banner at the top of the card,
 *     which is the defect this screen already had.
 *   • the summary never says «فشل» when the bike exists. It names what was created.
 */

interface PackDraft {
  capacityAh: string
  groundNo: string
  /** Per-row outcome. `null` = not attempted yet or being retried. */
  error: string | null
  saved: boolean
}

const CAPACITIES = ['30', '50']

const emptyPack = (groundNo: string): PackDraft => ({ capacityAh: '50', groundNo, error: null, saved: false })

export function AddBike({
  types,
  onDone,
  onCancel,
}: {
  types: ReadonlyArray<{ id: string; nameAr: string; nameEn: string; typeNo: number; batterySlots: number; active: boolean }>
  onDone(): void
  onCancel(): void
}): ReactNode {
  const { api, t, lang } = useApp()
  const active = types.filter((ty) => ty.active)

  // One active type is the whole of production, and making him pick from a list of one is a step
  // that exists only because the code did not look.
  const [typeId, setTypeId] = useState(active.length === 1 ? active[0]!.id : '')
  const [groundNo, setGroundNo] = useState('')
  const [plateNo, setPlateNo] = useState('')
  const [packs, setPacks] = useState<PackDraft[]>([emptyPack(''), emptyPack('')])
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Set once the bike exists. From here the form can only finish its packs. */
  const [created, setCreated] = useState<{ id: string; code: string } | null>(null)

  const slots = active.find((ty) => ty.id === typeId)?.batterySlots ?? 0

  // The number the server will hand out, asked for rather than guessed — the composition reaches
  // across branches and governorates, so a locally-derived preview would sometimes be a lie.
  useEffect(() => {
    if (typeId === '') {
      setPreview(null)
      return
    }
    void api
      .nextVehicleNumber(typeId)
      .then((r) => setPreview(r.code))
      .catch(() => setPreview(null))
  }, [api, typeId])

  const setPack = (i: number, patch: Partial<PackDraft>): void =>
    setPacks((cur) => cur.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  /** Each pack defaults to the bike's marking — the convention the fleet actually uses. */
  const onGroundNo = (next: string): void => {
    setPacks((cur) => cur.map((p) => (p.saved || p.groundNo !== groundNo ? p : { ...p, groundNo: next })))
    setGroundNo(next)
  }

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      let bike = created
      if (!bike) {
        try {
          const made = await api.createVehicle({
            vehicleTypeId: typeId,
            plateNo: plateNo.trim() === '' ? null : plateNo.trim(),
            groundNo: groundNo.trim() === '' ? null : groundNo.trim(),
          })
          bike = { id: made.id, code: made.code }
          setCreated(bike)
        } catch (e) {
          // Nothing exists. Keep every field exactly as typed — retyping it is the punishment for
          // a failure that was not his.
          setError((e as { error?: string }).error ?? 'error')
          return
        }
      }

      // Sequential on purpose: slots are allocated in order, and a parallel burst would make the
      // per-row outcomes arrive in an order that has nothing to do with the rows on screen.
      const results = [...packs]
      for (let i = 0; i < results.length; i++) {
        const p = results[i]!
        if (p.saved) continue
        try {
          await api.createBattery({
            capacityAh: Number(p.capacityAh),
            vehicleId: bike.id,
            slotNo: i + 1,
            groundNo: p.groundNo.trim() === '' ? null : p.groundNo.trim(),
          })
          results[i] = { ...p, saved: true, error: null }
        } catch (e) {
          results[i] = { ...p, saved: false, error: (e as { error?: string }).error ?? 'error' }
        }
      }
      setPacks(results)

      if (results.every((p) => p.saved)) {
        onDone()
        return
      }
      // The bike exists. Say so, and say exactly how much of it does.
      setError(null)
    } finally {
      setBusy(false)
    }
  }

  const savedCount = packs.filter((p) => p.saved).length
  const ready = typeId !== '' && !busy

  return (
    <Card title={t.fleet.addVehicleWithPacks}>
      <div className="flex flex-col gap-3">
        <Field label={t.fleet.vehicleType} htmlFor="add-bike-type">
          <Select id="add-bike-type" value={typeId} disabled={created !== null} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">—</option>
            {active.map((ty) => (
              <option key={ty.id} value={ty.id}>
                {ty.typeNo} — {lang === 'ar' ? ty.nameAr : ty.nameEn}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.fleet.groundNo} htmlFor="add-bike-ground" hint={t.fleet.groundNoHint}>
            <TextInput
              id="add-bike-ground"
              value={groundNo}
              disabled={created !== null}
              onChange={(e) => onGroundNo(e.target.value)}
            />
          </Field>
          <Field label={t.fleet.plateNo} htmlFor="add-bike-plate">
            <TextInput id="add-bike-plate" value={plateNo} disabled={created !== null} onChange={(e) => setPlateNo(e.target.value)} />
          </Field>
        </div>

        {preview ? (
          <p className="text-sm text-slate-600">
            {t.fleet.numberPreview}: <span className="num font-semibold text-brand">{created?.code ?? preview}</span>
          </p>
        ) : null}

        <div className="flex flex-col gap-2 rounded-lg bg-slate-50 p-3">
          <span className="text-sm font-semibold text-slate-700">{t.battery.title}</span>
          {packs.map((p, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <span className="num min-w-6 pb-2 text-sm text-slate-500">{i + 1}</span>
              <Field label={t.battery.capacity} htmlFor={`pack-cap-${i}`} className="w-28">
                <Select
                  id={`pack-cap-${i}`}
                  value={p.capacityAh}
                  disabled={p.saved}
                  onChange={(e) => setPack(i, { capacityAh: e.target.value })}
                >
                  {CAPACITIES.map((c) => (
                    <option key={c} value={c}>
                      {c} Ah
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={t.fleet.groundNo}
                htmlFor={`pack-ground-${i}`}
                className="min-w-32 flex-1"
                {...(p.error ? { error: explainError(p.error, t) } : {})}
              >
                <TextInput
                  id={`pack-ground-${i}`}
                  value={p.groundNo}
                  disabled={p.saved}
                  onChange={(e) => setPack(i, { groundNo: e.target.value, error: null })}
                />
              </Field>
              {p.saved ? (
                <span className="pb-2 text-sm text-emerald-700">✓</span>
              ) : packs.length > 1 ? (
                <Button variant="ghost" className="mb-1" onClick={() => setPacks((c) => c.filter((_, j) => j !== i))}>
                  ×
                </Button>
              ) : null}
            </div>
          ))}
          {packs.length < slots ? (
            <Button variant="ghost" className="self-start" onClick={() => setPacks((c) => [...c, emptyPack(groundNo)])}>
              + {t.battery.title}
            </Button>
          ) : null}
        </div>

        {/* The bike exists and some packs do not. Never «فشل» — name what was created, and leave the
            rest retryable against the bike that is now there. */}
        {created && savedCount < packs.length ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t.fleet.partialCreate
              .replace('{code}', created.code)
              .replace('{n}', String(savedCount))
              .replace('{m}', String(packs.length))}
          </p>
        ) : null}
        {error ? <p className="text-sm text-rose-600">{explainError(error, t)}</p> : null}

        <div className="flex gap-2">
          <Button onClick={() => void submit()} disabled={!ready}>
            {busy ? t.common.loading : created ? t.fleet.retryPacks : t.common.save}
          </Button>
          <Button variant="ghost" onClick={created ? onDone : onCancel}>
            {created ? t.common.done : t.common.cancel}
          </Button>
        </div>
      </div>
    </Card>
  )
}
