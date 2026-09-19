import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import type { ApiError } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Button, Card, Field, Screen, Select, TextInput, ThemeChoiceGroup } from '../ui.tsx'

interface BranchOption {
  id: string
  code: string
  nameAr: string
  nameEn: string
}

export type RegistrationValidation =
  | 'required'
  | 'invalid_username'
  | 'short_password'
  | 'password_mismatch'
  | null

const normalizedUsername = (value: string): string =>
  value.normalize('NFKC').replace(/[\p{M}\p{Cf}]/gu, '').trim()

export function validateDriverRegistration(input: {
  fullNameAr: string
  branchId: string
  username: string
  password: string
  confirmation: string
}): RegistrationValidation {
  if (!input.fullNameAr.trim() || !input.branchId || !input.username.trim() || !input.password || !input.confirmation) {
    return 'required'
  }
  const username = normalizedUsername(input.username)
  if (username.length < 3 || username.length > 40) return 'invalid_username'
  if (input.password.length < 8 || input.password.length > 200) return 'short_password'
  if (input.password !== input.confirmation) return 'password_mismatch'
  return null
}

export function Register({ onBack }: { onBack(): void }): ReactNode {
  const { api, lang, t, theme, setTheme, refreshSession } = useApp()
  const [branches, setBranches] = useState<BranchOption[]>([])
  const [fullNameAr, setFullNameAr] = useState('')
  const [branchId, setBranchId] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    const up = (): void => setOnline(true)
    const down = (): void => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  useEffect(() => {
    if (!online) {
      setError(t.auth.registrationOnlineOnly)
      return
    }
    let cancelled = false
    setError(null)
    void api.registrationBranches().then((response) => {
      if (!cancelled) setBranches(response.branches)
    }).catch((cause: unknown) => {
      if (cancelled) return
      const code = (cause as ApiError).error
      setError(code === 'registration_disabled' ? t.auth.registrationDisabled : t.auth.branchesLoadFailed)
    })
    return () => { cancelled = true }
  }, [api, online, t])

  const validationMessage = (problem: Exclude<RegistrationValidation, null>): string => {
    if (problem === 'required') return t.auth.requiredFields
    if (problem === 'invalid_username') return t.auth.invalidUsername
    if (problem === 'short_password') return t.auth.passwordHint
    return t.auth.passwordMismatch
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    setSuccess(null)
    if (!online) {
      setError(t.auth.registrationOnlineOnly)
      return
    }
    const problem = validateDriverRegistration({ fullNameAr, branchId, username, password, confirmation })
    if (problem) {
      setError(validationMessage(problem))
      return
    }
    setBusy(true)
    try {
      await api.registerDriver({ fullNameAr: fullNameAr.trim(), branchId, username, password })
      setSuccess(t.auth.registrationSuccess)
      // Let the success status paint and be announced before the authenticated flow replaces it.
      await new Promise((resolve) => window.setTimeout(resolve, 400))
      await refreshSession()
    } catch (cause) {
      const code = (cause as ApiError | undefined)?.error
      const messages: Record<string, string> = {
        duplicate_username: t.auth.duplicateUsername,
        duplicate_driver_code: t.auth.duplicateUsername,
        unknown_branch: t.auth.unknownBranch,
        registration_disabled: t.auth.registrationDisabled,
        registration_rate_limited: t.auth.registrationRateLimited,
        already_authenticated: t.auth.registrationSuccess,
        invalid_request: t.auth.requiredFields,
      }
      setError(code ? (messages[code] ?? t.auth.registrationNetworkFailure) : t.auth.registrationNetworkFailure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title={t.auth.registrationTitle}>
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
          <Field label={t.auth.fullNameAr}>
            <TextInput value={fullNameAr} onChange={(event) => setFullNameAr(event.target.value)} autoComplete="name" />
          </Field>
          <Field label={t.auth.branch}>
            <Select
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              disabled={busy || branches.length === 0}
            >
              <option value="">{t.auth.selectBranch}</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {lang === 'ar' ? branch.nameAr : branch.nameEn}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.auth.username}>
            <TextInput
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
            />
          </Field>
          <Field label={t.auth.password} hint={t.auth.passwordHint}>
            <TextInput
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label={t.auth.confirmPassword}>
            <TextInput
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          {error ? <p role="alert" className="text-sm font-medium text-danger-ink">{error}</p> : null}
          {success ? <p role="status" className="text-sm font-medium text-success-ink">{success}</p> : null}
          <Button type="submit" disabled={busy || !online}>
            {busy ? t.common.loading : t.auth.createDriverAccount}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
            {t.auth.backToLogin}
          </Button>
        </form>
      </Card>
    </Screen>
  )
}
