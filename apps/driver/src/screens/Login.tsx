import { type FormEvent, type ReactNode, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { Button, Card, Field, Screen, TextInput, ThemeChoiceGroup } from '../ui.tsx'
import { Register } from './Register.tsx'

/**
 * Driver login. Drivers are a `driver` role, so there is no second factor — password only, on a
 * shared or modest Android phone. Admin 2FA lives in the admin console.
 */
export function Login(): ReactNode {
  const { api, t, theme, setTheme, refreshSession, sessionExpired } = useApp()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [registering, setRegistering] = useState(false)

  if (registering) return <Register onBack={() => setRegistering(false)} />

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(username, password)
      await refreshSession()
    } catch (err) {
      const code = (err as { error?: string }).error
      setError(code === 'locked' ? t.auth.locked : t.auth.invalidCredentials)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title={t.app.title}>
      <p className="text-ink-secondary">{t.app.tagline}</p>
      <ThemeChoiceGroup
        value={theme}
        onChange={setTheme}
        label={t.common.theme}
        labels={{
          system: t.common.themeSystem,
          light: t.common.themeLight,
          dark: t.common.themeDark,
        }}
      />
      <Card>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label={t.auth.username}>
            <TextInput
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
            />
          </Field>
          <Field label={t.auth.password}>
            <TextInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {/* WHY this form appeared. A lapsed cookie used to drop a driver mid-shift onto a bare
              sign-in screen with no explanation — indistinguishable from a broken app. */}
          {sessionExpired && !error ? (
            <p role="status" className="rounded-xl border border-warning-line bg-warning-surface px-3 py-2 text-sm font-medium text-warning-ink">{t.auth.sessionExpired}</p>
          ) : null}
          {error ? <p role="alert" className="text-sm font-medium text-danger-ink">{error}</p> : null}
          <Button type="submit" disabled={busy || !username || !password}>
            {busy ? t.common.loading : t.auth.signIn}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setRegistering(true)} disabled={busy}>
            {t.auth.createDriverAccount}
          </Button>
        </form>
      </Card>
    </Screen>
  )
}
