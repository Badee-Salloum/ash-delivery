import { Fragment, type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { Badge, Button, Card, Table, TextInput } from '../ui.tsx'

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
  const { api, t } = useApp()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [tableName, setTableName] = useState('')
  const [recordId, setRecordId] = useState('')
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)

  const load = useCallback(
    async (f: { tableName?: string; recordId?: string }) => {
      setBusy(true)
      try {
        setRows((await api.audit(f)).rows)
      } catch {
        setRows([])
      } finally {
        setBusy(false)
      }
    },
    [api],
  )
  useEffect(() => {
    void load({})
  }, [load])

  const tone = (action: string): 'green' | 'amber' | 'red' =>
    action === 'INSERT' ? 'green' : action === 'DELETE' ? 'red' : 'amber'

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-slate-800">{t.audit.title}</h1>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-slate-500">{t.audit.table}</span>
            <TextInput value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="users" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-slate-500">{t.audit.record}</span>
            <TextInput value={recordId} onChange={(e) => setRecordId(e.target.value)} className="w-72" />
          </label>
          <Button
            disabled={busy}
            onClick={() => {
              // Built key-by-key: with exactOptionalPropertyTypes an explicit `undefined` is not
              // the same as an absent key.
              const f: { tableName?: string; recordId?: string } = {}
              if (tableName) f.tableName = tableName
              if (recordId) f.recordId = recordId
              void load(f)
            }}
          >
            {busy ? t.common.loading : t.audit.search}
          </Button>
        </div>
      </Card>

      <Card title={`${t.audit.title} — ${rows.length}`}>
        <Table head={[t.audit.when, t.audit.table, t.audit.record, t.audit.action, t.audit.actor, '']}>
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td className="num px-3 py-2 text-xs">{r.occurredAt.replace('T', ' ').slice(0, 19)}</td>
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
