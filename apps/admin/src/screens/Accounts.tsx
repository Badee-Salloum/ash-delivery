import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { useConfirm } from '../feedback.tsx'
import { Badge, Button, Card, Table, TextInput } from '../ui.tsx'

/**
 * Accounts (SRS A-2): create and list login accounts. `user.manage` is a sysadmin/GM permission,
 * so the whole screen is only reachable by those roles. A driver-role account gets a linked driver
 * record on the server in the same request, so the new login can actually operate a shift.
 */
interface Account {
  id: string
  username: string
  roleKey: string
  fullNameAr: string
  branchId: string | null
  driverId: string | null
  active: boolean
}
interface Branch {
  id: string
  code: string
  nameAr: string
  nameEn: string
}

const ROLE_KEYS = ['branch_manager', 'driver', 'accountant', 'general_manager', 'system_admin'] as const
const BRANCH_SCOPED = new Set(['driver', 'branch_manager'])

export function Accounts(): ReactNode {
  const { api, t, lang } = useApp()
  const confirm = useConfirm()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [form, setForm] = useState({ username: '', password: '', fullNameAr: '', roleKey: 'branch_manager', branchId: '' })
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Row-level editing: at most one account is being edited or having its password reset.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ fullNameAr: '', roleKey: '', branchId: '' })
  const [pwId, setPwId] = useState<string | null>(null)
  const [pwValue, setPwValue] = useState('')

  function refresh(): void {
    void api.users().then((r) => setAccounts(r.users)).catch(() => setAccounts([]))
  }
  useEffect(() => {
    refresh()
    void api.branches().then((r) => setBranches(r.branches)).catch(() => setBranches([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  const branchScoped = BRANCH_SCOPED.has(form.roleKey)
  const branchName = (id: string | null): string => {
    if (!id) return '—'
    const b = branches.find((x) => x.id === id)
    return b ? (lang === 'ar' ? b.nameAr : b.nameEn) : id.slice(0, 8)
  }

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)
    setOk(null)
    try {
      await api.createUser({
        username: form.username.trim(),
        password: form.password,
        roleKey: form.roleKey,
        fullNameAr: form.fullNameAr.trim(),
        ...(branchScoped && form.branchId ? { branchId: form.branchId } : {}),
      })
      setOk(t.accounts.created)
      setForm({ username: '', password: '', fullNameAr: '', roleKey: form.roleKey, branchId: form.branchId })
      refresh()
    } catch (err) {
      const code = (err as { error?: string }).error
      setError(code === 'duplicate_username' ? t.accounts.duplicate : (code ?? 'error'))
    } finally {
      setBusy(false)
    }
  }

  /** Run a row action, surfacing its error the same way the create form does. */
  async function rowAction(fn: () => Promise<unknown>): Promise<void> {
    setError(null)
    setOk(null)
    try {
      await fn()
      setOk(t.accounts.updated)
      refresh()
    } catch (err) {
      setError((err as { error?: string }).error ?? 'error')
    }
  }

  function startEdit(a: Account): void {
    setPwId(null)
    setEditingId(a.id)
    setEditForm({ fullNameAr: a.fullNameAr, roleKey: a.roleKey, branchId: a.branchId ?? '' })
  }

  async function saveEdit(id: string): Promise<void> {
    const scoped = BRANCH_SCOPED.has(editForm.roleKey)
    await rowAction(() =>
      api.updateUser(id, {
        fullNameAr: editForm.fullNameAr.trim(),
        roleKey: editForm.roleKey,
        branchId: scoped ? editForm.branchId : null,
      }),
    )
    setEditingId(null)
  }

  async function savePassword(id: string): Promise<void> {
    await rowAction(() => api.updateUser(id, { password: pwValue }))
    setPwId(null)
    setPwValue('')
  }

  const canSubmit =
    form.username.length >= 3 &&
    form.password.length >= 8 &&
    form.fullNameAr.length >= 1 &&
    (!branchScoped || form.branchId.length > 0)

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <h1 className="text-xl font-bold text-slate-800">{t.accounts.title}</h1>

      <Card title={t.accounts.add}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-slate-500">{t.accounts.fullName}</span>
            <TextInput value={form.fullNameAr} onChange={(e) => setForm({ ...form, fullNameAr: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-slate-500">{t.accounts.role}</span>
            <select
              value={form.roleKey}
              onChange={(e) => setForm({ ...form, roleKey: e.target.value })}
              className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand"
            >
              {ROLE_KEYS.map((r) => (
                <option key={r} value={r}>
                  {t.roles[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-slate-500">{t.accounts.username}</span>
            <TextInput value={form.username} autoCapitalize="none" onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-slate-500">{t.accounts.password}</span>
            <TextInput
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder={t.accounts.passwordHint}
            />
          </label>
          {branchScoped ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-slate-500">{t.accounts.branch}</span>
              <select
                value={form.branchId}
                onChange={(e) => setForm({ ...form, branchId: e.target.value })}
                className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand"
              >
                <option value="">—</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {lang === 'ar' ? b.nameAr : b.nameEn}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-600">{t.accounts.branchHint}</span>
            </label>
          ) : null}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={submit} disabled={busy || !canSubmit}>
            {busy ? t.common.loading : t.accounts.create}
          </Button>
          {ok ? <span className="text-sm font-medium text-emerald-600">{ok}</span> : null}
          {error ? <span className="text-sm font-medium text-red-600">{explainError(error, t)}</span> : null}
        </div>
      </Card>

      <Card title={t.accounts.title}>
        <Table
          head={[t.accounts.username, t.accounts.fullName, t.accounts.role, t.accounts.branch, t.accounts.status, t.accounts.actions]}
        >
          {accounts.map((a) =>
            editingId === a.id ? (
              <tr key={a.id} className="bg-slate-50">
                <td className="px-3 py-2 font-medium">{a.username}</td>
                <td className="px-3 py-2">
                  <TextInput
                    value={editForm.fullNameAr}
                    onChange={(e) => setEditForm({ ...editForm, fullNameAr: e.target.value })}
                    className="w-full"
                  />
                </td>
                <td className="px-3 py-2">
                  <select
                    aria-label={t.accounts.role}
                    value={editForm.roleKey}
                    onChange={(e) => setEditForm({ ...editForm, roleKey: e.target.value })}
                    className="min-h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand focus-visible:ring-2 focus-visible:ring-brand/40"
                  >
                    {ROLE_KEYS.map((r) => (
                      <option key={r} value={r}>
                        {t.roles[r]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  {BRANCH_SCOPED.has(editForm.roleKey) ? (
                    <select
                      aria-label={t.accounts.branch}
                      value={editForm.branchId}
                      onChange={(e) => setEditForm({ ...editForm, branchId: e.target.value })}
                      className="min-h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand focus-visible:ring-2 focus-visible:ring-brand/40"
                    >
                      <option value="">—</option>
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {lang === 'ar' ? b.nameAr : b.nameEn}
                        </option>
                      ))}
                    </select>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-3 py-2">—</td>
                <td className="px-3 py-2">
                  <div className="flex gap-2">
                    <Button onClick={() => void saveEdit(a.id)}>{t.accounts.save}</Button>
                    <Button variant="ghost" onClick={() => setEditingId(null)}>
                      {t.accounts.cancel}
                    </Button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={a.id}>
                <td className="px-3 py-2 font-medium">{a.username}</td>
                <td className="px-3 py-2">{a.fullNameAr}</td>
                <td className="px-3 py-2">{t.roles[a.roleKey as keyof typeof t.roles] ?? a.roleKey}</td>
                <td className="px-3 py-2">{branchName(a.branchId)}</td>
                <td className="px-3 py-2">
                  <Badge tone={a.active ? 'green' : 'slate'}>{a.active ? t.accounts.active : t.accounts.inactive}</Badge>
                </td>
                <td className="px-3 py-2">
                  {pwId === a.id ? (
                    <div className="flex gap-2">
                      <TextInput
                        value={pwValue}
                        onChange={(e) => setPwValue(e.target.value)}
                        placeholder={t.accounts.newPassword}
                        className="w-40"
                      />
                      <Button disabled={pwValue.length < 8} onClick={() => void savePassword(a.id)}>
                        {t.accounts.save}
                      </Button>
                      <Button variant="ghost" onClick={() => { setPwId(null); setPwValue('') }}>
                        {t.accounts.cancel}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="ghost" onClick={() => startEdit(a)}>
                        {t.accounts.edit}
                      </Button>
                      <Button
                        variant={a.active ? 'danger' : 'success'}
                        onClick={() =>
                          void (async () => {
                            // Deactivating takes away someone's ability to sign in — a driver
                            // mid-shift, or the last admin. One click, no question, until now.
                            if (a.active) {
                              const ok = await confirm({
                                title: t.accounts.confirmDeactivateTitle,
                                body: a.username,
                                confirmLabel: t.accounts.deactivate,
                                danger: true,
                              })
                              if (!ok) return
                            }
                            await rowAction(() => api.updateUser(a.id, { active: !a.active }))
                          })()
                        }
                      >
                        {a.active ? t.accounts.deactivate : t.accounts.activate}
                      </Button>
                      <Button variant="ghost" onClick={() => { setEditingId(null); setPwId(a.id); setPwValue('') }}>
                        {t.accounts.resetPassword}
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ),
          )}
        </Table>
      </Card>
    </div>
  )
}
