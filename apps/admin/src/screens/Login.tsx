import { type FormEvent, type ReactNode, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { Button, Card, TextInput } from '../ui.tsx'

/**
 * Admin login with the SRS §7 second factor. Admin roles (branch manager, sysadmin, GM) present a
 * TOTP code after the password; an enrolled user is blocked from every permissioned route until
 * they do. A not-yet-enrolled admin is walked through enrolment.
 */
type Step = 'password' | 'code' | 'enroll'

export function Login(): ReactNode {
  const { api, t, refreshSession } = useApp()
  const [step, setStep] = useState<Step>('password')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submitPassword(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.login(username, password)
      if (res.secondFactorRequired) {
        setStep('code')
      } else if (res.enrollmentRequired) {
        setEnroll(await api.enroll2fa())
        setStep('enroll')
      } else {
        await refreshSession()
      }
    } catch (err) {
      const c = (err as { error?: string }).error
      setError(c === 'locked' ? t.auth.locked : t.auth.invalidCredentials)
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.verify2fa(code)
      await refreshSession()
    } catch {
      setError(t.auth.badCode)
    } finally {
      setBusy(false)
    }
  }

  async function submitEnroll(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!enroll) return
    setBusy(true)
    setError(null)
    try {
      await api.confirm2fa(enroll.secret, code)
      await refreshSession()
    } catch {
      setError(t.auth.badCode)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-bold">{t.app.title}</h1>
        <p className="mb-6 text-sm text-slate-500">{t.app.tagline}</p>

        {step === 'password' ? (
          <form onSubmit={submitPassword} className="flex flex-col gap-3">
            <TextInput placeholder={t.auth.username} value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" />
            <TextInput type="password" placeholder={t.auth.password} value={password} onChange={(e) => setPassword(e.target.value)} />
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <Button type="submit" disabled={busy || !username || !password}>
              {busy ? t.common.loading : t.auth.signIn}
            </Button>
          </form>
        ) : step === 'code' ? (
          <form onSubmit={submitCode} className="flex flex-col gap-3">
            <p className="text-sm text-slate-600">{t.auth.twoFactorPrompt}</p>
            <TextInput inputMode="numeric" placeholder={t.auth.twoFactorTitle} value={code} onChange={(e) => setCode(e.target.value)} className="num text-center text-2xl tracking-widest" />
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <Button type="submit" disabled={busy || code.length < 6}>
              {busy ? t.common.loading : t.common.confirm}
            </Button>
          </form>
        ) : (
          <form onSubmit={submitEnroll} className="flex flex-col gap-3">
            <p className="text-sm text-slate-600">{t.auth.enrollPrompt}</p>
            {/* The otpauth URI is shown as text for manual entry; a QR renderer is a Bundle-2 nicety. */}
            <code className="break-all rounded bg-slate-100 p-2 text-xs">{enroll?.secret}</code>
            <TextInput inputMode="numeric" placeholder={t.auth.twoFactorTitle} value={code} onChange={(e) => setCode(e.target.value)} className="num text-center text-2xl tracking-widest" />
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <Button type="submit" disabled={busy || code.length < 6}>
              {busy ? t.common.loading : t.common.confirm}
            </Button>
          </form>
        )}
      </Card>
    </div>
  )
}
