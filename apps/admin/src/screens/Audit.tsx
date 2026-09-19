import { Fragment, type ReactNode, useCallback, useEffect, useState } from 'react'
import { formatDateTime } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, Field, Pending, Table, TextInput } from '../ui.tsx'

/**
 * The audit trail (SRS A-5 / س79): who changed what, when, and from what to what.
 *
 * Every mutation is already recorded server-side — by the app and, for money and identity tables,
 * by a database trigger that a raw SQL edit cannot bypass. This screen is the window onto it, so a
 * dispute is settled by reading the record rather than by argument.
 */
interface AuditRow {
  id: number
  tableName: string
  recordId: string
  action: string
  actorId: string | null
  actorKind: string
  branchId: string | null
  before: unknown
  after: unknown
  occurredAt: string
}

export function Audit(): ReactNode {
  const { api, t, lang } = useApp()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tableName, setTableName] = useState('')
  const [recordId, setRecordId] = useState('')
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)

  const load = useCallback(
    async (f: { tableName?: string; recordId?: string }) => {
      setBusy(true)
      setLoadError(null)
      try {
        setRows((await api.audit(f)).rows)
      } catch (error) {
        setLoadError((error as { error?: string }).error ?? 'error')
      } finally {
        setBusy(false)
        setLoaded(true)
      }
    },
    [api],
  )
  useEffect(() => {
    void load({})
  }, [load])

  const tone = (action: string): 'green' | 'amber' | 'red' =>
    action === 'INSERT' ? 'green' : action === 'DELETE' ? 'red' : 'amber'

  const currentFilter = (): { tableName?: string; recordId?: string } => {
    const filter: { tableName?: string; recordId?: string } = {}
    if (tableName) filter.tableName = tableName
    if (recordId) filter.recordId = recordId
    return filter
  }

  if (!loaded) {
    return (
      <Pending
        error={loadError}
        loadingLabel={t.common.loading}
        errorLabel={explainError(loadError, t)}
        onRetry={() => void load(currentFilter())}
        retryLabel={t.common.retry}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t.audit.table}>
            <TextInput value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="users" />
          </Field>
          <Field label={t.audit.record}>
            <TextInput value={recordId} onChange={(e) => setRecordId(e.target.value)} className="w-72" />
          </Field>
          <Button
            disabled={busy}
            onClick={() => {
              void load(currentFilter())
            }}
          >
            {busy ? t.common.loading : t.audit.search}
          </Button>
        </div>
      </Card>

      <Card title={`${t.audit.title} — ${rows.length}`}>
        {loadError ? (
          <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-danger-line bg-danger-surface p-3 text-body text-danger-ink">
            <span>{explainError(loadError, t)}</span>
            <Button variant="ghost" size="sm" onClick={() => void load(currentFilter())}>{t.common.retry}</Button>
          </div>
        ) : null}
        <Table
          head={[t.audit.when, t.audit.table, t.audit.record, t.audit.action, t.audit.actor, '']}
          isEmpty={rows.length === 0}
          empty={t.common.empty}
        >
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td className="num px-3 py-2 text-xs">{formatDateTime(r.occurredAt, lang)}</td>
                <td className="px-3 py-2">{r.tableName}</td>
                <td className="num px-3 py-2 text-xs">{r.recordId.slice(0, 12)}</td>
                <td className="px-3 py-2">
                  <Badge tone={tone(r.action)}>{r.action}</Badge>
                </td>
                <td className="px-3 py-2 text-xs">
                  {r.actorKind === 'user' ? (r.actorId?.slice(0, 8) ?? '—') : r.actorKind}
                </td>
                <td className="px-3 py-2">
                  <Button variant="ghost" onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                    {t.audit.details}
                  </Button>
                </td>
              </tr>
              {openId === r.id ? (
                <tr>
                  <td colSpan={6} className="px-3 pb-3">
                    <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs">
                      {JSON.stringify({ before: r.before, after: r.after }, null, 2)}
                    </pre>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </Table>
      </Card>
    </div>
  )
}
