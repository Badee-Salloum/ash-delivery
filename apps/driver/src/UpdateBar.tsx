import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from './app-context.tsx'

declare const __ASH_DRIVER_BUILD_ID__: string

/** A short, deployment-specific value that a driver can read to support over the phone. */
export const DRIVER_BUILD_ID = __ASH_DRIVER_BUILD_ID__

const END_DRAFT_PREFIX = 'ash:driver:end-draft:'
const EVIDENCE_DB = 'ash-driver-evidence'
const EVIDENCE_STORE = 'pending-evidence'
const EVIDENCE_CHECK_TIMEOUT_MS = 2_000
const UPDATE_RECHECK_MS = 15_000
const WORKER_RECHECK_MS = 5 * 60_000

export type DriverUpdateRecoveryState = 'unchecked' | 'clear' | 'blocked'

/**
 * One gate for both automatic and button-triggered activation.
 *
 * A worker may activate without destroying in-memory React state, but the reload needed to use its
 * bundle does. Treat an unreadable recovery store as blocked: losing a closing draft is worse than
 * asking the driver to finish/synchronise before updating.
 */
export function canActivateDriverUpdate(
  safeBoundary: boolean,
  recovery: DriverUpdateRecoveryState,
): boolean {
  return safeBoundary && recovery === 'clear'
}

export type DriverWorkerRegistrationState = 'current' | 'waiting' | 'refresh'

/**
 * `controllerchange` is not guaranteed for an already-open tab because the generated worker does
 * not claim existing clients. Object identity is therefore significant: when registration.active
 * is newer than this page's controller, only a safe reload can move the tab onto that active code.
 */
export function driverWorkerRegistrationState(
  registration: Pick<ServiceWorkerRegistration, 'waiting' | 'active'> | null,
  controller: ServiceWorker | null,
): DriverWorkerRegistrationState {
  if (registration === null || controller === null) return 'current'
  if (registration.waiting !== null) return 'waiting'
  if (registration.active !== null && registration.active !== controller) return 'refresh'
  return 'current'
}

interface DraftKeyStorage {
  readonly length: number
  key(index: number): string | null
}

/** Any v1/v2 closing draft is recoverable work, so even an old key blocks a reload. */
export function hasPendingEndDraft(storage: DraftKeyStorage | null): boolean {
  if (storage === null) return false
  try {
    for (let index = 0; index < storage.length; index += 1) {
      if (storage.key(index)?.startsWith(END_DRAFT_PREFIX)) return true
    }
    return false
  } catch {
    return true
  }
}

function browserStorage(): DraftKeyStorage | null | 'blocked' {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return 'blocked'
  }
}

/**
 * Read the evidence store without importing the upload module into the app shell.
 *
 * `open()` deliberately omits a version. On a new browser database it creates the same v1 store as
 * pending-evidence-storage; on a future schema it opens the current version instead of throwing a
 * VersionError. A blocked/timed-out database is conservatively treated as containing evidence.
 */
function browserEvidenceFactory(): IDBFactory | null | 'blocked' {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB
  } catch {
    return 'blocked'
  }
}

export function hasPendingEvidence(
  factoryValue: IDBFactory | null | 'blocked' = browserEvidenceFactory(),
): Promise<boolean> {
  if (factoryValue === 'blocked') return Promise.resolve(true)
  if (factoryValue === null) return Promise.resolve(false)
  return new Promise((resolve) => {
    let database: IDBDatabase | null = null
    let settled = false
    const finish = (present: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      database?.close()
      resolve(present)
    }
    const timeout = setTimeout(() => finish(true), EVIDENCE_CHECK_TIMEOUT_MS)
    try {
      const request = factoryValue.open(EVIDENCE_DB)
      request.onblocked = () => finish(true)
      request.onerror = () => finish(true)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(EVIDENCE_STORE)) {
          db.createObjectStore(EVIDENCE_STORE, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => {
        database = request.result
        // The conservative timeout may have settled while IndexedDB was opening. Close a late
        // handle immediately; otherwise every update recheck leaks one live database connection.
        if (settled) {
          database.close()
          return
        }
        if (!database.objectStoreNames.contains(EVIDENCE_STORE)) {
          finish(false)
          return
        }
        try {
          const transaction = database.transaction(EVIDENCE_STORE, 'readonly')
          const count = transaction.objectStore(EVIDENCE_STORE).count()
          count.onerror = () => finish(true)
          count.onsuccess = () => finish(count.result > 0)
          transaction.onabort = () => finish(true)
          transaction.onerror = () => finish(true)
        } catch {
          finish(true)
        }
      }
    } catch {
      finish(true)
    }
  })
}

async function recoveryDataPresent(): Promise<boolean> {
  const storage = browserStorage()
  if (storage === 'blocked' || hasPendingEndDraft(storage)) return true
  return hasPendingEvidence()
}

interface UpdateBarProps {
  /**
   * True only after DriverApp has proved that there is no live shift and no vehicle/start flow in
   * progress. Local recovery stores are checked separately immediately before every activation.
   */
  safeBoundary: boolean
}

/**
 * Discover a waiting worker, defer it through a live shift, then activate it automatically at the
 * first safe boundary. The old implementation offered an update button at every phase, so one tap
 * could reload a close screen; it also never retried at an idle boundary, leaving stale bundles in
 * service indefinitely when drivers ignored the prompt.
 */
export function UpdateBar({ safeBoundary }: UpdateBarProps): ReactNode {
  const { t, lang } = useApp()
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)
  const [refreshNeeded, setRefreshNeeded] = useState(false)
  const [recovery, setRecovery] = useState<DriverUpdateRecoveryState>('unchecked')
  const [applying, setApplying] = useState(false)
  const safeBoundaryRef = useRef(safeBoundary)
  const activatingRef = useRef(false)
  const reloadOnControlRef = useRef(false)
  safeBoundaryRef.current = safeBoundary

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    let cancelled = false
    let registration: ServiceWorkerRegistration | null = null
    let installing: ServiceWorker | null = null

    const onInstallingState = (): void => {
      if (
        !cancelled &&
        installing?.state === 'installed' &&
        navigator.serviceWorker.controller
      ) {
        setWaiting(registration?.waiting ?? installing)
      }
    }
    const onUpdateFound = (): void => {
      installing?.removeEventListener('statechange', onInstallingState)
      installing = registration?.installing ?? null
      installing?.addEventListener('statechange', onInstallingState)
    }
    const inspect = (): void => {
      if (cancelled) return
      const state = driverWorkerRegistrationState(
        registration,
        navigator.serviceWorker.controller,
      )
      if (state === 'waiting') {
        setWaiting(registration!.waiting)
      } else if (state === 'refresh') {
        setWaiting(null)
        setRefreshNeeded(true)
      } else {
        // Clear a stale object that became redundant or was activated by another tab. Do not clear
        // refreshNeeded here: controllerchange may already have moved the worker while this page is
        // still executing the old JavaScript bundle.
        setWaiting(null)
      }
    }
    const attach = (next: ServiceWorkerRegistration): void => {
      if (cancelled || registration === next) return
      registration?.removeEventListener('updatefound', onUpdateFound)
      installing?.removeEventListener('statechange', onInstallingState)
      registration = next
      inspect()
      next.addEventListener('updatefound', onUpdateFound)
      void next.update().then(inspect).catch(() => undefined)
    }
    const check = (): void => {
      if (document.visibilityState !== 'visible') return
      inspect()
      void registration?.update().then(inspect).catch(() => undefined)
    }
    const onControllerChange = (): void => {
      // Another tab may activate the worker. Keep this tab intact during a shift and remember that
      // it should reload as soon as this tab reaches its own safe boundary.
      setRefreshNeeded(true)
      if (reloadOnControlRef.current && safeBoundaryRef.current) window.location.reload()
    }

    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    const interval = window.setInterval(check, WORKER_RECHECK_MS)

    void navigator.serviceWorker.getRegistration().then((found) => {
      if (found) attach(found)
      else void navigator.serviceWorker.ready.then(attach)
    }).catch(() => undefined)

    return () => {
      cancelled = true
      registration?.removeEventListener('updatefound', onUpdateFound)
      installing?.removeEventListener('statechange', onInstallingState)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      window.clearInterval(interval)
    }
  }, [])

  const activate = useCallback(async (): Promise<void> => {
    if (
      activatingRef.current ||
      !safeBoundaryRef.current ||
      (waiting === null && !refreshNeeded)
    ) return
    activatingRef.current = true
    setRecovery('unchecked')
    const blocked = await recoveryDataPresent()
    const nextRecovery = blocked ? 'blocked' : 'clear'
    setRecovery(nextRecovery)
    if (!canActivateDriverUpdate(safeBoundaryRef.current, nextRecovery)) {
      activatingRef.current = false
      return
    }

    setApplying(true)
    reloadOnControlRef.current = true
    if (refreshNeeded || waiting?.state === 'activated') {
      window.location.reload()
      return
    }

    const recoverWorkerState = (): void => {
      reloadOnControlRef.current = false
      activatingRef.current = false
      setApplying(false)
      void navigator.serviceWorker.getRegistration().then((registration) => {
        const state = driverWorkerRegistrationState(
          registration ?? null,
          navigator.serviceWorker.controller,
        )
        if (state === 'waiting') setWaiting(registration!.waiting)
        else {
          setWaiting(null)
          if (state === 'refresh') setRefreshNeeded(true)
        }
      }).catch(() => undefined)
    }
    if (waiting === null || waiting.state === 'redundant') {
      recoverWorkerState()
      return
    }
    try {
      waiting.postMessage({ type: 'SKIP_WAITING' })
    } catch {
      recoverWorkerState()
      return
    }
    // A broken/foreign worker must not leave an opaque overlay forever. The waiting worker remains
    // visible and the next safe recheck/button tap can try again.
    window.setTimeout(recoverWorkerState, 10_000)
  }, [refreshNeeded, waiting])

  const updateAvailable = waiting !== null || refreshNeeded
  useEffect(() => {
    if (!updateAvailable || !safeBoundary) return
    void activate()
    const interval = window.setInterval(() => void activate(), UPDATE_RECHECK_MS)
    return () => window.clearInterval(interval)
  }, [activate, safeBoundary, updateAvailable])

  const delayed = !safeBoundary || recovery === 'blocked'
  const delayedCopy = lang === 'ar'
    ? 'سيتم التحديث تلقائياً بعد إنهاء النوبة وحفظ كل الصور والبيانات المعلّقة.'
    : 'The app will update automatically after the shift and all pending photos/data are saved.'
  const applyingCopy = lang === 'ar' ? 'جارٍ تثبيت التحديث…' : 'Installing update…'
  const buildCopy = lang === 'ar' ? 'الإصدار' : 'Build'

  return (
    <>
      {updateAvailable ? (
        <div role="status" className="flex items-center justify-between gap-3 bg-warning-solid px-4 py-2 text-sm font-medium text-on-warning">
          <span>{applying ? applyingCopy : delayed ? delayedCopy : t.app.updateAvailable}</span>
          {!applying && !delayed ? (
            <button type="button" onClick={() => void activate()} className="min-h-11 rounded-xl bg-white/20 px-3 py-1 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-on-warning">
              {t.app.updateNow}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="bg-brand px-2 py-0.5 text-center text-[10px] font-medium text-on-brand/70">
        {buildCopy} <span dir="ltr" className="num">{DRIVER_BUILD_ID}</span>
      </div>
      {applying ? <div aria-hidden="true" className="fixed inset-0 z-50 bg-slate-950/20" /> : null}
    </>
  )
}
