import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../../app-context.tsx'
import { LatestRequestGuard } from '../../latest-request.ts'

/** One independently abortable dashboard section read. */
export function useDashboardRead<T>(path: string): {
  data: T | null
  error: string | null
  retry(): void
} {
  const { api, branchId } = useApp()
  const requests = useRef(new LatestRequestGuard())
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const load = useCallback(() => {
    const request = requests.current.next()
    setData(null)
    setError(null)
    void api
      .get<T>(path, { cache: 'no-store', signal: request.signal })
      .then((next) => {
        if (!request.isCurrent()) return
        setData(next)
      })
      .catch((cause: { name?: string; error?: string }) => {
        if (!request.isCurrent() || cause.name === 'AbortError') return
        setError(cause.error ?? 'error')
      })
  }, [api, path])

  useEffect(() => {
    load()
    return () => requests.current.cancel()
  }, [load, branchId, attempt])

  return { data, error, retry: () => setAttempt((value) => value + 1) }
}
