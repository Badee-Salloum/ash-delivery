import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type { CheckInReportView, CheckInWindowView } from '@ash/client'
import { type RoleKey, can } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { useToast } from '../feedback.tsx'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, Field, Pending, Select, Table, TextInput } from '../ui.tsx'

/**
 * «التفقّد» — the branch manager proving he was at the branch when he is expected there.
 *
 * The owner's rule (2026-08-29): several rounds a day — «تسجيل الدخول عالساعة 1 و 5 و 10» — each
 * within a tolerance and each from inside the branch's own patch of ground, «على حساب مدير الفرع
 * و ليس السائقين».
 *
 * NOTHING HERE BLOCKS. A refused GPS permission, a manager genuinely away, a round nobody answered
 * — each produces a row that says exactly that, and the report is for a human to read. A check-in
 * that could stop a manager working would be one GPS outage away from stopping the branch, which
 * is why the button reports its failures instead of gating anything.
 */

/** How the browser reports a fix. Deliberately narrow — nothing else here needs `navigator`. */
interface Fix {
  lat: number
  lng: number
  accuracyM: number | null
}

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const MINUTES = [0, 15, 30, 45]

/** Minutes past branch-local midnight, as the clock face a person reads. */
const clock = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

const toneFor = (status: string): 'green' | 'amber' | 'red' | 'slate' =>
  status === 'on_time' ? 'green' : status === 'missed' ? 'slate' : 'amber'

/** The server's error code, or null — the shape `explainError` reads. */
const codeOf = (e: unknown): string | null => (e as { error?: string }).error ?? null

export function CheckIn(): ReactNode {
  const { api, t, session, branchId } = useApp()
  const toast = useToast()
  const [report, setReport] = useState<CheckInReportView | null>(null)
  const [windows, setWindows] = useState<CheckInWindowView[]>([])
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The rota and the fence are settings.write — the same gate as the rest of the system's shape,
  // so a branch manager cannot move his own goalposts.
  const canConfigure =
    session != null &&
    can({ userId: session.userId, roleKey: session.roleKey as RoleKey, branchId: session.branchId }, 'settings.write', {
      branchId: branchId ?? session.branchId,
    })

  const [userId, setUserId] = useState('')
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)
  const [tolerance, setTolerance] = useState(30)
  const [label, setLabel] = useState('')

  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [radius, setRadius] = useState('150')

  const load = useCallback(async () => {
    setError(null)
    try {
      const [r, w] = await Promise.all([api.checkinReport(), api.checkinWindows()])
      setReport(r)
      setWindows(w.windows)
      if (r.radiusM !== null) setRadius(String(r.radiusM))
    } catch (e) {
      setError(codeOf(e) ?? 'error')
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const scope = branchId ?? session?.branchId ?? null
  useEffect(() => {
    if (!canConfigure) return
    void api
      .users()
      .then((res) => {
        // Drivers are excluded by design, not by omission — offering one here would only produce
        // a 422 the operator cannot act on.
        const eligible = res.users.filter((u) => u.roleKey !== 'driver' && u.active && u.branchId === scope)
        setPeople(eligible.map((u) => ({ id: u.id, name: u.fullNameAr })))
        setUserId((current) => current || (eligible[0]?.id ?? ''))
      })
      .catch(() => setPeople([]))
  }, [api, canConfigure, scope])

  /** One place that asks the browser where it is, so every caller reports failure the same way. */
  const locate = (): Promise<Fix> =>
    new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('unsupported'))
        return
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            // Evidence, never a gate: refusing a low-confidence fix would punish a manager for
            // standing under a roof.
            accuracyM: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
          }),
        () => reject(new Error('denied')),
        { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
      )
    })

  /** A refused permission is a browser fact, not a server error code — say so in the user's words. */
  const reportFailure = (e: unknown): void => {
    if (e instanceof Error && (e.message === 'denied' || e.message === 'unsupported')) {
      toast.error(t.checkin[e.message])
      return
    }
    toast.error(explainError(codeOf(e), t))
  }

  const checkInNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const fix = await locate()
      const saved = await api.checkin({ ...fix, note: null })
      if (saved.insideArea) toast.success(t.checkin.recorded)
      // Recorded either way. The toast names the verdict rather than pretending nothing happened.
      else toast.error(`${t.checkin.recorded} — ${t.checkin.status[saved.verdict]}`)
      await load()
    } catch (e) {
      reportFailure(e)
    } finally {
      setBusy(false)
    }
  }

  const addRound = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.createCheckinWindow({
        userId,
        atMinute: hour * 60 + minute,
        toleranceMinutes: tolerance,
        label: label.trim() || null,
      })
      setLabel('')
      await load()
    } catch (e) {
      reportFailure(e)
    } finally {
      setBusy(false)
    }
  }

  const retire = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await api.deleteCheckinWindow(id)
      await load()
    } catch (e) {
      reportFailure(e)
    } finally {
      setBusy(false)
    }
  }

  const saveLocation = async (clear: boolean): Promise<void> => {
    setBusy(true)
    try {
      await api.setBranchLocation({
        lat: clear ? null : Number(lat),
        lng: clear ? null : Number(lng),
        checkinRadiusM: Number(radius) || 150,
      })
      if (clear) {
        setLat('')
        setLng('')
      }
      await load()
      toast.success(t.common.saved)
    } catch (e) {
      reportFailure(e)
    } finally {
      setBusy(false)
    }
  }

  const fillFromDevice = async (): Promise<void> => {
    try {
      const fix = await locate()
      setLat(fix.lat.toFixed(6))
      setLng(fix.lng.toFixed(6))
    } catch (e) {
      reportFailure(e)
    }
  }

  if (report === null) {
    return (
      <Pending
        error={error}
        loadingLabel={t.common.loading}
        errorLabel={explainError(error, t)}
        onRetry={load}
        retryLabel={t.common.retry}
      />
    )
  }

  const named = new Map(windows.map((w) => [w.id, w]))
  const offset = (minutes: number): string =>
    minutes === 0
      ? t.checkin.onTime
      : (minutes < 0 ? t.checkin.early : t.checkin.late).replace('{{n}}', String(Math.abs(minutes)))

  return (
    <div className="flex flex-col gap-4">
      <Card title={t.checkin.title}>
        <p className="mb-3 text-sm text-slate-500">{t.checkin.neverBlocks}</p>
        {report.radiusM === null ? (
          // Name whose job it is. A manager who cannot act on a warning, and is not told who can,
          // reads it as the system being broken rather than as a step somebody still owes him.
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {canConfigure ? t.checkin.notSet : t.checkin.notSetAdmin}
          </p>
        ) : null}
        <Button onClick={() => void checkInNow()} disabled={busy}>
          {busy ? t.checkin.locating : t.checkin.now}
        </Button>
      </Card>

      <Card title={`${t.checkin.rounds} — ${report.businessDate}`}>
        {report.people.length === 0 ? (
          <p className="text-sm text-slate-500">{t.checkin.noPeople}</p>
        ) : (
          <div className="flex flex-col gap-5">
            {report.people.map((person) => (
              <div key={person.userId}>
                <div className="mb-2 text-sm font-semibold text-slate-700">{person.name}</div>
                <Table
                  head={[t.checkin.at, t.checkin.label, t.checkin.result, t.checkin.distance]}
                  isEmpty={person.rounds.length === 0}
                  empty={t.checkin.noRounds}
                >
                  {person.rounds.map((round) => (
                    <tr key={round.windowRef}>
                      <td className="px-3 py-2 tabular-nums">{clock(round.atMinute)}</td>
                      <td className="px-3 py-2">{named.get(round.windowRef)?.label ?? '—'}</td>
                      <td className="px-3 py-2">
                        <Badge tone={toneFor(round.status)}>{t.checkin.status[round.status]}</Badge>
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {round.distanceMetres === null
                          ? '—'
                          : `${round.distanceMetres} ${t.checkin.metres}`}
                        {round.minutesFromTarget !== null ? ` · ${offset(round.minutesFromTarget)}` : ''}
                      </td>
                    </tr>
                  ))}
                </Table>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={t.checkin.log}>
        <Table
          head={[t.checkin.time, t.checkin.result, t.checkin.distance, t.checkin.accuracy]}
          isEmpty={report.checkIns.length === 0}
          empty="—"
        >
          {report.checkIns.map((c) => (
            <tr key={c.id}>
              <td className="px-3 py-2 tabular-nums">
                {new Date(c.capturedAt).toLocaleTimeString('en-GB', { hour12: false })}
              </td>
              <td className="px-3 py-2">
                <Badge tone={toneFor(c.verdict)}>{t.checkin.status[c.verdict]}</Badge>
              </td>
              <td className="px-3 py-2 tabular-nums">
                {c.distanceM} {t.checkin.metres}
              </td>
              <td className="px-3 py-2 tabular-nums">
                {c.accuracyM === null ? '—' : `±${c.accuracyM} ${t.checkin.metres}`}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      {canConfigure ? (
        <>
          <Card title={t.checkin.rota}>
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Field label={t.checkin.person}>
                <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t.checkin.at}>
                <div className="flex gap-2">
                  <Select value={String(hour)} onChange={(e) => setHour(Number(e.target.value))}>
                    {HOURS.map((x) => (
                      <option key={x} value={x}>
                        {String(x).padStart(2, '0')}
                      </option>
                    ))}
                  </Select>
                  <Select value={String(minute)} onChange={(e) => setMinute(Number(e.target.value))}>
                    {MINUTES.map((x) => (
                      <option key={x} value={x}>
                        {String(x).padStart(2, '0')}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>
              <Field label={t.checkin.tolerance}>
                <TextInput
                  inputMode="numeric"
                  value={String(tolerance)}
                  onChange={(e) => setTolerance(Number(e.target.value) || 0)}
                />
              </Field>
              <Field label={t.checkin.label}>
                <TextInput value={label} onChange={(e) => setLabel(e.target.value)} />
              </Field>
              <div className="flex items-end">
                <Button onClick={() => void addRound()} disabled={busy || !userId}>
                  {t.checkin.addRound}
                </Button>
              </div>
            </div>
            <Table
              head={[t.checkin.at, t.checkin.tolerance, t.checkin.label, '']}
              isEmpty={windows.length === 0}
              empty={t.checkin.noRounds}
            >
              {windows.map((w) => (
                <tr key={w.id}>
                  <td className="px-3 py-2 tabular-nums">{clock(w.atMinute)}</td>
                  <td className="px-3 py-2 tabular-nums">±{w.toleranceMinutes}</td>
                  <td className="px-3 py-2">{w.label ?? '—'}</td>
                  <td className="px-3 py-2">
                    <Button variant="ghost" onClick={() => void retire(w.id)} disabled={busy}>
                      {t.checkin.retire}
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title={t.checkin.location}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t.checkin.lat}>
                <TextInput inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
              </Field>
              <Field label={t.checkin.lng}>
                <TextInput inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} />
              </Field>
              <Field label={t.checkin.radius}>
                <TextInput inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value)} />
              </Field>
              <div className="flex items-end">
                <Button variant="ghost" onClick={() => void fillFromDevice()} disabled={busy}>
                  {t.checkin.useMyLocation}
                </Button>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button onClick={() => void saveLocation(false)} disabled={busy || !lat || !lng}>
                {t.checkin.saveLocation}
              </Button>
              {/* Clearing is a legitimate act: it switches the rounds off rather than leaving a
                  fence nobody can satisfy. */}
              <Button variant="ghost" onClick={() => void saveLocation(true)} disabled={busy}>
                {t.checkin.clearLocation}
              </Button>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  )
}
