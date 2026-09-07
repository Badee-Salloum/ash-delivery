import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Card, Pending, Table } from '../ui.tsx'

/**
 * The §3 permission matrix as editable DATA (SRS A-2) — the point of storing roles and grants in
 * tables rather than in `if` statements. Authorisation reads this on every request, so a change
 * here takes effect immediately, with no deploy.
 *
 * The server refuses the two edits that would be unrecoverable: emptying the matrix (authorisation
 * would silently fall back to the compiled-in defaults) and dropping the last `user.manage` grant
 * (nobody could reopen this screen). Both come back as a plain refusal, and the grid reloads to
 * show the server's truth rather than the optimistic value.
 */
type Scope = 'own' | 'branch' | 'all'
interface Matrix {
  roles: string[]
  permissions: string[]
  grants: Array<{ roleKey: string; permissionKey: string; scope: string }>
}

export function Permissions(): ReactNode {
  const { api, t } = useApp()
  const [m, setM] = useState<Matrix | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    void api
      .permissions()
      .then(setM)
      .catch((e: { error?: string }) => {
        setM(null)
        setLoadError(e.error ?? 'error')
      })
  }, [api])
  useEffect(load, [load])

  const scopeOf = (role: string, perm: string): string =>
    m?.grants.find((g) => g.roleKey === role && g.permissionKey === perm)?.scope ?? ''

  const errorText = (code: string): string =>
    code === 'would_lock_out_admins'
      ? t.permissions.lockoutRefused
      : code === 'matrix_would_be_empty'
        ? t.permissions.emptyRefused
        : code

  async function change(role: string, perm: string, value: string): Promise<void> {
    setErr(null)
    setMsg(null)
    try {
      await api.setGrant(role, perm, value === '' ? null : (value as Scope))
      setMsg(t.permissions.saved)
    } catch (e) {
      setErr(errorText((e as { error?: string }).error ?? 'error'))
    } finally {
      load() // always re-read: on refusal the select must snap back to what the server holds
    }
  }

  if (!m) {
    return (
      <Pending
        error={loadError}
        loadingLabel={t.common.loading}
        errorLabel={explainError(loadError, t)}
        onRetry={load}
        retryLabel={t.common.retry}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-slate-800">{t.permissions.title}</h1>
      <p className="text-sm text-slate-500">{t.permissions.hint}</p>
      {msg ? <p className="text-sm font-medium text-emerald-700">{msg}</p> : null}
      {err ? <p className="text-sm font-medium text-red-600">{explainError(err, t)}</p> : null}

      <Card>
        <Table head={[t.permissions.permission, ...m.roles.map((r) => t.roles[r as keyof typeof t.roles] ?? r)]}>
          {m.permissions.map((perm) => (
            <tr key={perm}>
              <td className="px-3 py-2 text-xs font-medium">{perm}</td>
              {m.roles.map((role) => (
                <td key={role} className="px-3 py-2">
                  <select
                    aria-label={`${perm} — ${t.roles[role as keyof typeof t.roles] ?? role}`}
                    value={scopeOf(role, perm)}
                    onChange={(e) => void change(role, perm, e.target.value)}
                    className="min-h-9 rounded-lg border border-slate-300 bg-surface-card px-2 text-xs outline-none focus:border-brand focus-visible:ring-2 focus-visible:ring-brand/40"
                  >
                    <option value="">—</option>
                    <option value="own">{t.permissions.scopes.own}</option>
                    <option value="branch">{t.permissions.scopes.branch}</option>
                    <option value="all">{t.permissions.scopes.all}</option>
                  </select>
                </td>
              ))}
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  )
}
