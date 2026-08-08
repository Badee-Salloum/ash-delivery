import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, Pending, Table, TextInput } from '../ui.tsx'

interface Governorate {
  id: string
  no: number
  nameAr: string
  nameEn: string
  active: boolean
}
interface Branch {
  id: string
  code: string
  nameAr: string
  nameEn: string
  governorateId: string
  branchNo: number
}
interface VehicleType {
  id: string
  code: string
  nameAr: string
  nameEn: string
  typeNo: number
  /** Max packs a machine of this type may carry — the configurable ceiling. */
  batterySlots: number
  active: boolean
}

/**
 * Where «رقم الآلية» comes from.
 *
 * The vehicle number is `<governorate>-<branch>-<type>-<machine>`, and the first three segments
 * are configured here. That makes this screen quietly powerful: renumbering a vehicle type
 * restates the printed number of every vehicle of that type, and moving a branch does the same
 * for the whole branch. Each control therefore says what it will do BEFORE it is used, and the
 * server does the restating in one transaction so a half-renumbered fleet cannot exist.
 *
 * `settings.write` — the system admin only. This is configuration, not fleet operations.
 */
export function FleetConfig(): ReactNode {
  const { api, t, lang, session } = useApp()
  const [governorates, setGovernorates] = useState<Governorate[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [types, setTypes] = useState<VehicleType[]>([])
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const canEdit = session?.roleKey === 'system_admin'
  const name = (row: { nameAr: string; nameEn: string }): string => (lang === 'ar' ? row.nameAr : row.nameEn)

  const load = useCallback(() => {
    setError(null)
    void Promise.all([api.governorates(), api.get<{ branches: Branch[] }>('/branches'), api.vehicleTypes()])
      .then(([g, b, v]) => {
        setGovernorates(g.governorates)
        setBranches(b.branches)
        setTypes(v.vehicleTypes)
        setLoaded(true)
      })
      .catch((e: { error?: string }) => setError(e.error ?? 'error'))
  }, [api])
  useEffect(load, [load])

  /** Every write funnels through here so a refusal is always shown, never swallowed. */
  const run = async (action: () => Promise<unknown>, success: string): Promise<void> => {
    setError(null)
    setMsg(null)
    try {
      await action()
      setMsg(success)
    } catch (e) {
      setError((e as { error?: string }).error ?? 'error')
    }
    load()
  }

  if (!loaded && error) {
    return <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={load} retryLabel={t.common.retry} />
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title={t.fleet.numberingTitle}>
        <p className="text-sm text-slate-500">
          {t.fleet.vehicleNumber}: <span className="num font-semibold">{t.fleet.numberingScheme}</span>
          {' — '}
          <span className="num font-semibold text-brand">1-1-1-1</span>
        </p>
        {msg ? <p className="mt-2 text-sm font-medium text-emerald-700">{msg}</p> : null}
        {error ? <p className="mt-2 text-sm font-medium text-red-600">{explainError(error, t)}</p> : null}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GovernorateCard governorates={governorates} canEdit={canEdit} name={name} run={run} />
        <BranchCard branches={branches} governorates={governorates} canEdit={canEdit} name={name} run={run} />
      </div>

      <VehicleTypeCard types={types} canEdit={canEdit} name={name} run={run} />
    </div>
  )
}

type Runner = (action: () => Promise<unknown>, success: string) => Promise<void>
type Namer = (row: { nameAr: string; nameEn: string }) => string

function GovernorateCard({
  governorates,
  canEdit,
  name,
  run,
}: {
  governorates: Governorate[]
  canEdit: boolean
  name: Namer
  run: Runner
}): ReactNode {
  const { api, t } = useApp()
  const [draft, setDraft] = useState({ no: '', nameAr: '', nameEn: '' })

  return (
    <Card title={t.fleet.governorate}>
      {canEdit ? (
        <div className="mb-3 flex flex-wrap gap-2">
          <TextInput
            inputMode="numeric"
            placeholder={t.fleet.governorateNo}
            value={draft.no}
            onChange={(e) => setDraft({ ...draft, no: e.target.value })}
            className="num w-20"
          />
          <TextInput placeholder={t.common.arabic} aria-label={t.common.arabic} value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} className="flex-1" />
          <TextInput placeholder={t.common.english} aria-label={t.common.english} value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })} className="flex-1" />
          <Button
            disabled={!draft.no || !draft.nameAr || !draft.nameEn}
            onClick={async () => {
              await run(
                () => api.createGovernorate({ no: Number(draft.no), nameAr: draft.nameAr, nameEn: draft.nameEn }),
                t.accounts.created,
              )
              setDraft({ no: '', nameAr: '', nameEn: '' })
            }}
          >
            {t.fleet.addGovernorate}
          </Button>
        </div>
      ) : null}

      <Table head={[t.fleet.governorateNo, t.fleet.governorate, '']}>
        {governorates.map((g) => (
          <tr key={g.id}>
            <td className="px-3 py-1 num font-semibold">{g.no}</td>
            <td className="px-3 py-1">{name(g)}</td>
            <td className="px-3 py-1">
              {canEdit ? (
                <NumberEdit
                  value={g.no}
                  onSave={(no) => run(() => api.updateGovernorate(g.id, { no }), t.accounts.updated)}
                  label={t.common.save}
                />
              ) : null}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function BranchCard({
  branches,
  governorates,
  canEdit,
  name,
  run,
}: {
  branches: Branch[]
  governorates: Governorate[]
  canEdit: boolean
  name: Namer
  run: Runner
}): ReactNode {
  const { api, t } = useApp()
  const [draft, setDraft] = useState({ code: '', nameAr: '', nameEn: '', governorateId: '', branchNo: '' })
  const govNo = (id: string): number | string => governorates.find((g) => g.id === id)?.no ?? '?'

  return (
    <Card title={t.accounts.branch}>
      {canEdit ? (
        <div className="mb-3 flex flex-wrap gap-2">
          <TextInput placeholder={t.fleet.code} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} className="w-24" />
          <TextInput placeholder={t.common.arabic} aria-label={t.common.arabic} value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} className="w-28" />
          <TextInput placeholder={t.common.english} aria-label={t.common.english} value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })} className="w-28" />
          <select
            aria-label={t.fleet.governorate}
            className="min-h-10 rounded-lg border border-slate-300 px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            value={draft.governorateId}
            onChange={(e) => setDraft({ ...draft, governorateId: e.target.value })}
          >
            <option value="">{t.fleet.governorate}</option>
            {governorates.map((g) => (
              <option key={g.id} value={g.id}>
                {g.no} — {name(g)}
              </option>
            ))}
          </select>
          <TextInput
            inputMode="numeric"
            placeholder={t.fleet.branchNo}
            value={draft.branchNo}
            onChange={(e) => setDraft({ ...draft, branchNo: e.target.value })}
            className="num w-20"
          />
          <Button
            disabled={!draft.code || !draft.nameAr || !draft.nameEn || !draft.governorateId || !draft.branchNo}
            onClick={async () => {
              await run(
                () =>
                  api.createBranch({
                    code: draft.code,
                    nameAr: draft.nameAr,
                    nameEn: draft.nameEn,
                    governorateId: draft.governorateId,
                    branchNo: Number(draft.branchNo),
                  }),
                t.accounts.created,
              )
              setDraft({ code: '', nameAr: '', nameEn: '', governorateId: '', branchNo: '' })
            }}
          >
            {t.fleet.addBranch}
          </Button>
        </div>
      ) : null}
      <p className="mb-2 text-xs text-slate-600">{t.fleet.branchNoHint}</p>

      <Table head={[t.fleet.vehicleNumber, t.accounts.branch, t.fleet.governorate, '']}>
        {branches.map((b) => (
          <tr key={b.id}>
            {/* The first two segments this branch contributes to every one of its bikes. */}
            <td className="px-3 py-1 num font-semibold">
              {govNo(b.governorateId)}-{b.branchNo}-…
            </td>
            <td className="px-3 py-1">{name(b)}</td>
            <td className="px-3 py-1 text-slate-500">{governorates.find((g) => g.id === b.governorateId)?.nameAr ?? '—'}</td>
            <td className="px-3 py-1">
              {canEdit ? (
                <NumberEdit
                  value={b.branchNo}
                  onSave={(branchNo) => run(() => api.updateBranch(b.id, { branchNo }), t.accounts.updated)}
                  label={t.common.save}
                />
              ) : null}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function VehicleTypeCard({
  types,
  canEdit,
  name,
  run,
}: {
  types: VehicleType[]
  canEdit: boolean
  name: Namer
  run: Runner
}): ReactNode {
  const { api, t } = useApp()
  const [draft, setDraft] = useState({ code: '', nameAr: '', nameEn: '', typeNo: '', batterySlots: '2' })

  return (
    <Card title={t.fleet.vehicleType}>
      {canEdit ? (
        <div className="mb-3 flex flex-wrap gap-2">
          <TextInput placeholder={t.fleet.code} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} className="w-32" />
          <TextInput placeholder={t.common.arabic} aria-label={t.common.arabic} value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} className="flex-1" />
          <TextInput placeholder={t.common.english} aria-label={t.common.english} value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })} className="flex-1" />
          <TextInput
            inputMode="numeric"
            placeholder={t.fleet.typeNo}
            value={draft.typeNo}
            onChange={(e) => setDraft({ ...draft, typeNo: e.target.value })}
            className="num w-20"
          />
          <TextInput
            inputMode="numeric"
            placeholder={t.fleet.batterySlots}
            aria-label={t.fleet.batterySlots}
            value={draft.batterySlots}
            onChange={(e) => setDraft({ ...draft, batterySlots: e.target.value })}
            className="num w-24"
          />
          <Button
            disabled={!draft.code || !draft.nameAr || !draft.nameEn || !draft.typeNo}
            onClick={async () => {
              await run(
                () =>
                  api.createVehicleType({
                    code: draft.code,
                    nameAr: draft.nameAr,
                    nameEn: draft.nameEn,
                    typeNo: Number(draft.typeNo),
                    batterySlots: draft.batterySlots.trim() === '' ? 2 : Number(draft.batterySlots),
                  }),
                t.accounts.created,
              )
              setDraft({ code: '', nameAr: '', nameEn: '', typeNo: '', batterySlots: '2' })
            }}
          >
            {t.fleet.addType}
          </Button>
        </div>
      ) : null}
      {/* Said before the control is used, not after: this edit rewrites printed numbers. */}
      <p className="mb-2 text-xs text-amber-700">{t.fleet.typeNoHint}</p>

      <Table head={[t.fleet.typeNo, t.fleet.vehicleType, t.fleet.code, t.fleet.batterySlots, '']}>
        {types.map((ty) => (
          <tr key={ty.id}>
            <td className="px-3 py-1 num font-semibold">{ty.typeNo}</td>
            <td className="px-3 py-1">
              {name(ty)}
              {ty.active ? null : (
                <span className="ms-2">
                  <Badge tone="slate">{t.accounts.inactive}</Badge>
                </span>
              )}
            </td>
            <td className="px-3 py-1 text-slate-600">{ty.code}</td>
            <td className="px-3 py-1">
              {canEdit ? (
                <NumberEdit
                  value={ty.batterySlots}
                  onSave={(batterySlots) => run(() => api.updateVehicleType(ty.id, { batterySlots }), t.accounts.updated)}
                  label={t.common.save}
                />
              ) : (
                <span className="num">{ty.batterySlots}</span>
              )}
            </td>
            <td className="px-3 py-1">
              {canEdit ? (
                <NumberEdit
                  value={ty.typeNo}
                  onSave={(typeNo) => run(() => api.updateVehicleType(ty.id, { typeNo }), t.accounts.updated)}
                  label={t.common.save}
                />
              ) : null}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

/** A number that is only written when the operator presses save — never on every keystroke. */
function NumberEdit({ value, onSave, label }: { value: number; onSave(next: number): void; label: string }): ReactNode {
  const [text, setText] = useState(String(value))
  const dirty = text !== String(value) && text !== ''

  // Re-sync when the server restates the value (a renumber elsewhere can change this row).
  useEffect(() => setText(String(value)), [value])

  return (
    <span className="flex items-center gap-1">
      <TextInput inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} className="num w-16" />
      <Button variant="ghost" disabled={!dirty} onClick={() => onSave(Number(text))}>
        {label}
      </Button>
    </span>
  )
}
