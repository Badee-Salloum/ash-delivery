import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../../app-context.tsx'
import { LatestRequestGuard } from '../../latest-request.ts'

/** One independently abortable dashboard section read. */
export function useDashboardRead<T>(path: string): {
  data: T | null
  error: string | null
  retry(): void
} {
  const { api, branchId, session } = useApp()
  const requests = useRef(new LatestRequestGuard())
  const [result, setResult] = useState<{ key: string; data: T | null; error: string | null } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([session?.userId, session?.roleKey, session?.businessDate, branchId, path, attempt])
  const currentKey = useRef(key)
  currentKey.current = key

  const load = useCallback(() => {
    const request = requests.current.next()
    setResult({ key, data: null, error: null })
    void api
      .get<T>(path, { cache: 'no-store', signal: request.signal })
      .then((next) => {
        if (!request.isCurrent() || currentKey.current !== key) return
        setResult({ key, data: next, error: null })
      })
      .catch((cause: { name?: string; error?: string }) => {
        if (!request.isCurrent() || currentKey.current !== key || cause.name === 'AbortError') return
        setResult({ key, data: null, error: cause.error ?? 'error' })
      })
  }, [api, path, key])

  useEffect(() => {
    load()
    return () => requests.current.cancel()
  }, [load, branchId, attempt])

  return { data: result?.key === key ? result.data : null, error: result?.key === key ? result.error : null, retry: () => setAttempt((value) => value + 1) }
}
