import { type FormEvent, type ReactNode, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { Button, Card, TextInput, Wordmark } from '../ui.tsx'

/**
 * Admin login.
 *
 * Two-factor is disabled for the pilot (client's call), so this is a plain password step: a
 * successful login establishes the session and enters the app. The old flow chained a 2FA
 * enrolment call inside the same try/catch, so any hiccup there surfaced as "wrong password"
 * even though the login had already succeeded — that whole branch is gone.
 */
export function Login(): ReactNode {
  const { api, t, refreshSession } = useApp()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(username, password)
      await refreshSession()
    } catch (err) {
      const c = (err as { error?: string }).error
      setError(c === 'locked' ? t.auth.locked : t.auth.invalidCredentials)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-gradient-to-b from-slate-100 to-slate-200 p-6">
      <Card className="w-full max-w-sm border border-slate-200 shadow-lg">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Wordmark size={44} />
          <p className="text-sm text-slate-500">{t.app.tagline}</p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="text-xs font-semibold text-slate-500">{t.auth.username}</label>
          <TextInput
            placeholder={t.auth.username}
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
          />
          <label className="mt-1 text-xs font-semibold text-slate-500">{t.auth.password}</label>
          <TextInput
            type="password"
            placeholder={t.auth.password}
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
          <Button type="submit" className="mt-2" disabled={busy || !username || !password}>
            {busy ? t.common.loading : t.auth.signIn}
          </Button>
        </form>
      </Card>
    </div>
  )
}
