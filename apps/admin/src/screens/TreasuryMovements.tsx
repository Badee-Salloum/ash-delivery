import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  formatDateTimeSeconds,
  type TreasuryMovementFilter,
  type TreasuryMovementChannel,
  type TreasuryMovementFlow,
  type TreasuryMovementResponse,
} from '@ash/client'
import { type LedgerEvent, type RangeSelection } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { TimeRangeBar, useRangeMeta } from '../components/TimeRangeBar.tsx'
import { explainError } from '../errors.ts'
import { type RouteParams, sanitizeParams } from '../route.ts'
import {
  browserStorage,
  paramsFromSelection,
  parseSelection,
  resolveSelection,
  selectionFromParams,
  serializeSelection,
} from '../time-range.ts'
import { Badge, Button, Card, Field, Money, Pending, Select, Table, TextInput } from '../ui.tsx'
import { useHashParams } from '../use-hash-params.ts'

const PAGE_SIZE = 50
const STORAGE_PREFIX = 'ash.admin.treasury-movements.range.v1:'

interface MovementFilters {
  eventType: '' | LedgerEvent
  channel: '' | TreasuryMovementChannel
  flow: '' | TreasuryMovementFlow
  actorId: string
  q: string
}

const EMPTY_FILTERS: MovementFilters = {
  eventType: '',
  channel: '',
  flow: '',
  actorId: '',
  q: '',
}

function requestFilter(
  range: { from: string; to: string },
  filters: MovementFilters,
  beforeId?: number,
): TreasuryMovementFilter {
  return {
    from: range.from,
    to: range.to,
    limit: PAGE_SIZE,
    ...(filters.eventType === '' ? {} : { eventType: filters.eventType }),
    ...(filters.channel === '' ? {} : { channel: filters.channel }),
    ...(filters.flow === '' ? {} : { flow: filters.flow }),
    ...(filters.actorId === '' ? {} : { actorId: filters.actorId }),
    ...(filters.q === '' ? {} : { q: filters.q }),
    ...(beforeId === undefined ? {} : { beforeId }),
  }
}

function initialRange(params: RouteParams, userId: string | null | undefined): RangeSelection {
  const fromUrl = selectionFromParams(params)
  if (fromUrl) return fromUrl
  const storage = browserStorage()
  if (storage && userId) {
    try {
      const stored = parseSelection(storage.getItem(`${STORAGE_PREFIX}${userId}`))
      if (stored) return stored
    } catch {
      // Disabled/private storage simply means this page starts at its documented default.
    }
  }
  return { preset: 'this_month' }
}

function storeRange(userId: string | null | undefined, selection: RangeSelection): void {
  const storage = browserStorage()
  if (!storage || !userId) return
  try {
    storage.setItem(`${STORAGE_PREFIX}${userId}`, serializeSelection(selection))
  } catch {
    // The URL still keeps the selection when browser storage is unavailable.
  }
}

/** Read-only, branch-scoped register of every cash-box and wallet movement. */
export function TreasuryMovements({ initial = {} }: { initial?: RouteParams }): ReactNode {
  const { api, t, lang, session, branchId } = useApp()
  const replaceParams = useHashParams()
  const { meta, error: metaError, retry: retryMeta } = useRangeMeta()
  const [selection, setSelection] = useState<RangeSelection>(() => initialRange(initial, session?.userId))
  const initialFilters: MovementFilters = {
    eventType: initial.eventType ?? '',
    channel: initial.channel ?? '',
    flow: initial.flow ?? '',
    actorId: initial.actor ?? '',
    q: initial.q ?? '',
  }
  const [draft, setDraft] = useState<MovementFilters>(initialFilters)
  const [filters, setFilters] = useState<MovementFilters>(initialFilters)
  const [page, setPage] = useState<TreasuryMovementResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadVersion = useRef(0)
  const range = meta ? resolveSelection(selection, meta) : null

  useEffect(() => {
    replaceParams(
      sanitizeParams({
        ...paramsFromSelection(selection),
        eventType: filters.eventType,
        channel: filters.channel,
        flow: filters.flow,
        actor: filters.actorId,
        q: filters.q,
      }),
    )
    storeRange(session?.userId, selection)
  }, [replaceParams, selection, filters, session?.userId])

  useEffect(() => {
    if (!range) return
    const version = ++loadVersion.current
    let active = true
    const controller = new AbortController()
    setPage(null)
    setError(null)
    setLoadingMore(false)
    void api
      .treasuryMovements(
        requestFilter(range, filters),
        { cache: 'no-store', signal: controller.signal },
      )
      .then((next) => {
        if (active && version === loadVersion.current) setPage(next)
      })
      .catch((cause: { name?: string; error?: string }) => {
        if (!active || version !== loadVersion.current || cause.name === 'AbortError') return
        setError(cause.error ?? 'error')
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [api, branchId, range?.from, range?.to, filters, retry])

  // An organisation-wide user can switch branches while an actor from the old one is selected.
  // Facets are branch-scoped, so remove that stale value instead of leaving a silently empty page.
  useEffect(() => {
    if (!page) return
    const valid = (actorId: string): boolean =>
      actorId === '' || page.facets.actors.some((actor) => actor.id === actorId)
    if (!valid(filters.actorId)) setFilters((current) => ({ ...current, actorId: '' }))
    if (!valid(draft.actorId)) setDraft((current) => ({ ...current, actorId: '' }))
  }, [page, filters.actorId, draft.actorId])

  const loadMore = useCallback(async (): Promise<void> => {
    if (!range || !page?.nextCursor || loadingMore) return
    const version = loadVersion.current
    setLoadingMore(true)
    setError(null)
    try {
      const next = await api.treasuryMovements(requestFilter(range, filters, page.nextCursor))
      if (version !== loadVersion.current) return
      setPage((current) =>
        current
          ? {
              ...next,
              rows: [...current.rows, ...next.rows],
              facets: current.facets,
            }
          : next,
      )
    } catch (cause) {
      if (version === loadVersion.current) setError((cause as { error?: string }).error ?? 'error')
    } finally {
      if (version === loadVersion.current) setLoadingMore(false)
    }
  }, [api, filters, loadingMore, page, range])

  const applyFilters = (): void => {
    setFilters({ ...draft, q: draft.q.trim() })
  }
  const reset = (): void => {
    setDraft(EMPTY_FILTERS)
    setFilters(EMPTY_FILTERS)
    setSelection({ preset: 'this_month' })
  }
  const eventLabel = (eventType: string): string =>
    (t.treasuryMovements.kinds as Readonly<Record<string, string>>)[eventType] ?? eventType
  const flowLabel = (flow: TreasuryMovementFlow): string => t.treasuryMovements.flows[flow]
  const flowTone = (flow: TreasuryMovementFlow): 'success' | 'danger' | 'info' =>
    flow === 'in' ? 'success' : flow === 'out' ? 'danger' : 'info'

  return (
    <div className="flex flex-col gap-4">
      <Card title={t.treasuryMovements.title} subtitle={t.treasuryMovements.hint}>
        <TimeRangeBar
          selection={selection}
          onChange={setSelection}
          meta={meta}
          metaError={metaError}
          onRetryMeta={retryMeta}
          {...(meta?.maxRangeDays === undefined ? {} : { maxDays: meta.maxRangeDays })}
        />
      </Card>

      <Card title={t.treasuryMovements.filters}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Field label={t.treasuryMovements.kind}>
            <Select
              value={draft.eventType}
              onChange={(event) => setDraft({ ...draft, eventType: event.target.value as '' | LedgerEvent })}
            >
              <option value="">{t.treasuryMovements.allKinds}</option>
              {(page?.facets.eventTypes ?? []).map((eventType) => (
                <option key={eventType} value={eventType}>{eventLabel(eventType)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t.treasuryMovements.channel}>
            <Select
              value={draft.channel}
              onChange={(event) => setDraft({ ...draft, channel: event.target.value as '' | TreasuryMovementChannel })}
            >
              <option value="">{t.treasuryMovements.allChannels}</option>
              <option value="cash">{t.treasuryMovements.channels.cash}</option>
              <option value="wallet">{t.treasuryMovements.channels.wallet}</option>
            </Select>
          </Field>
          <Field label={t.treasuryMovements.flow}>
            <Select
              value={draft.flow}
              onChange={(event) => setDraft({ ...draft, flow: event.target.value as '' | TreasuryMovementFlow })}
            >
              <option value="">{t.treasuryMovements.allFlows}</option>
              <option value="in">{t.treasuryMovements.flows.in}</option>
              <option value="out">{t.treasuryMovements.flows.out}</option>
              <option value="internal">{t.treasuryMovements.flows.internal}</option>
            </Select>
          </Field>
          <Field label={t.treasuryMovements.actor}>
            <Select value={draft.actorId} onChange={(event) => setDraft({ ...draft, actorId: event.target.value })}>
              <option value="">{t.treasuryMovements.allActors}</option>
              {(page?.facets.actors ?? []).map((actor) => (
                <option key={actor.id} value={actor.id}>{actor.name}</option>
              ))}
            </Select>
          </Field>
          <Field label={t.treasuryMovements.search}>
            <TextInput
              value={draft.q}
              maxLength={200}
              placeholder={t.treasuryMovements.searchPlaceholder}
              onChange={(event) => setDraft({ ...draft, q: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyFilters()
              }}
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={applyFilters}>{t.treasuryMovements.apply}</Button>
          <Button variant="ghost" onClick={reset}>{t.treasuryMovements.reset}</Button>
        </div>
      </Card>

      <Card title={t.treasuryMovements.results} subtitle={`${t.glossary.time.recordedAt} · ${t.glossary.time.damascusTime}`}>
        {page === null ? (
          <Pending
            error={error}
            loadingLabel={t.common.loading}
            errorLabel={explainError(error ?? 'error', t)}
            onRetry={() => setRetry((value) => value + 1)}
            retryLabel={t.common.retry}
          />
        ) : (
          <>
            {error ? (
              <div className="mb-3">
                <Pending
                  error={error}
                  loadingLabel={t.common.loading}
                  errorLabel={explainError(error, t)}
                  onRetry={() => void loadMore()}
                  retryLabel={t.common.retry}
                />
              </div>
            ) : null}
            <Table
              head={[
                `${t.glossary.time.recordedAt} (${t.glossary.time.damascusTime})`,
                t.glossary.time.businessDay,
                t.treasuryMovements.kind,
                t.treasuryMovements.cash,
                t.treasuryMovements.wallet,
                t.treasuryMovements.flow,
                t.treasuryMovements.reason,
                t.treasuryMovements.actor,
              ]}
              empty={t.treasuryMovements.empty}
              isEmpty={page.rows.length === 0}
            >
              {page.rows.map((row) => (
                <tr key={row.id}>
                  <td dir="ltr" className="num whitespace-nowrap px-3 py-2 text-xs">{formatDateTimeSeconds(row.createdAt, lang)}</td>
                  <td dir="ltr" className="num whitespace-nowrap px-3 py-2 text-xs">{row.businessDate}</td>
                  <td className="px-3 py-2 text-xs">{eventLabel(row.eventType)}</td>
                  <td dir="ltr" className="num px-3 py-2 text-xs"><Money value={row.cash} /></td>
                  <td dir="ltr" className="num px-3 py-2 text-xs"><Money value={row.wallet} /></td>
                  <td className="px-3 py-2 text-xs"><Badge tone={flowTone(row.flow)}>{flowLabel(row.flow)}</Badge></td>
                  <td className="px-3 py-2 text-xs text-ink-secondary">{row.reason ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{row.actorName ?? '—'}</td>
                </tr>
              ))}
            </Table>
            {page.nextCursor !== null ? (
              <div className="mt-3 flex justify-center">
                <Button variant="ghost" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? t.common.loading : t.treasuryMovements.loadMore}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  )
}
