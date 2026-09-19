import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { formatDateTimeSeconds } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, FOCUS_RING, Pending, Table } from '../ui.tsx'

/**
 * Read-only register of operations that a branch manager excluded or restored. The audit row
 * remains in the database: this screen deliberately does not offer a financial action.
 */
interface RemovalRow {
  id: string
  kind: 'removed' | 'restored'
  operationKind: 'order' | 'cash_deduction'
  operationRef: string
  shiftId: string
  branchId: string
  businessDate: string
  driverName: string | null
  amount: string
  reason: string
  evidenceSlot: string | null
  evidenceMediaId: string | null
  actedByName: string | null
  actedAt: string
}

export function Removals(): ReactNode {
  const { api, t, lang } = useApp()
  const [rows, setRows] = useState<RemovalRow[]>([])
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState<string | null>(null)
  const [zoom, setZoom] = useState<string | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const previewOpenerRef = useRef<HTMLElement | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setFailed(null)
    try {
      setRows((await api.operationRemovals({ limit: 200 })).rows)
    } catch (error) {
      setFailed((error as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!zoom) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = (): HTMLElement[] =>
      [...(previewRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])]
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setZoom(null)
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        previewRef.current?.focus()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    const frame = requestAnimationFrame(() => {
      previewRef.current?.querySelector<HTMLElement>('[data-removal-preview-close]')?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      previewOpenerRef.current?.focus()
      previewOpenerRef.current = null
    }
  }, [zoom])

  const openEvidence = (mediaId: string): void => {
    previewOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setZoom(mediaId)
  }

  const copy = t.removals

  return (
    <Card title={copy.title}>
      <p className="mb-3 text-body text-ink-secondary">{copy.hint}</p>

      {busy && rows.length === 0 ? (
        <Pending
          error={null}
          loadingLabel={t.common.loading}
          errorLabel={t.common.actionFailed}
        />
      ) : failed ? (
        <Pending
          error={failed}
          loadingLabel={t.common.loading}
          errorLabel={explainError(failed, t)}
          onRetry={() => void load()}
          retryLabel={t.common.retry}
        />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-success-line bg-success-surface p-3 text-body font-semibold text-success-ink">
          {copy.empty}
        </p>
      ) : (
        <Table head={[copy.when, copy.what, copy.amount, copy.whose, copy.who, copy.reason, copy.evidence]}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="num px-3 py-2 text-label">{formatDateTimeSeconds(row.actedAt, lang)}</td>
              <td className="px-3 py-2">
                <span className="flex min-w-0 flex-col gap-1">
                  <Badge tone={row.kind === 'removed' ? 'danger' : 'neutral'}>
                    {row.kind === 'removed' ? copy.removed : copy.restored}
                  </Badge>
                  <span className="num truncate text-label text-ink-secondary" title={row.operationRef}>
                    {row.operationKind === 'order' ? copy.order : copy.deduction} · {row.operationRef.slice(0, 14)}
                  </span>
                </span>
              </td>
              <td dir="ltr" className="num px-3 py-2 font-bold">{row.amount}</td>
              <td className="px-3 py-2 text-label">
                <span className="flex min-w-0 flex-col">
                  <span>{row.driverName ?? '—'}</span>
                  <span className="num text-label text-ink-muted">{row.businessDate}</span>
                </span>
              </td>
              <td className="px-3 py-2 text-label">{row.actedByName ?? '—'}</td>
              <td className="px-3 py-2 text-label text-ink-secondary">{row.reason}</td>
              <td className="px-3 py-2">
                {row.evidenceMediaId === null ? (
                  <span className="text-label text-ink-muted">{copy.noEvidence}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const mediaId = row.evidenceMediaId
                      if (mediaId !== null) openEvidence(mediaId)
                    }}
                    className={`rounded border border-line-strong ${FOCUS_RING}`}
                    aria-label={copy.evidence}
                  >
                    <img
                      src={`/api/media/${row.evidenceMediaId}`}
                      alt={copy.evidence}
                      loading="lazy"
                      className="block w-24 rounded"
                    />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {zoom ? (
        <div
          ref={previewRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/90 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={copy.evidence}
          onClick={() => setZoom(null)}
          tabIndex={-1}
        >
          <div className="relative max-h-full max-w-full" onClick={(event) => event.stopPropagation()}>
            <Button
              type="button"
              data-removal-preview-close
              variant="ghost"
              size="sm"
              className="absolute end-2 top-2 z-10"
              onClick={() => setZoom(null)}
            >
              {t.common.close}
            </Button>
            <img src={`/api/media/${zoom}`} alt={copy.evidence} className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      ) : null}
    </Card>
  )
}
