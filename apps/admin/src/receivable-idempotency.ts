import { formatMinor, parseMinor } from '@ash/domain'

export interface PendingReceivableOperation {
  fingerprint: string
  idempotencyKey: string
  /** Canonical wire payload needed to restore the exact retry after reload or branch switching. */
  payload: ReceivableOperationPayload
}

export type PendingReceivableRecovery =
  | { status: 'none' }
  | { status: 'pending'; operation: PendingReceivableOperation }
  | { status: 'corrupt' }
  | { status: 'unavailable' }

export interface ReceivableOperationPayload {
  driverId: string
  receivableKind: 'ordinary' | 'shift_funding'
  channel: 'cash' | 'wallet'
  direction: 'create' | 'collect'
  amount: string
  reason: string
}

interface ReceivableDriverOption {
  id: string
  active: boolean
}

export interface ReceivableOperationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ReceivableOperationMutex {
  /** `acquired: false` is fail-closed: another tab owns this actor+branch money command. */
  tryRunExclusive<T>(
    name: string,
    task: () => Promise<T> | T,
  ): Promise<{ acquired: true; value: T } | { acquired: false }>
}

export type ReceivableOperationExecution<T> =
  | { status: 'success'; operation: PendingReceivableOperation; value: T }
  | { status: 'success_clear_failed'; operation: PendingReceivableOperation; value: T }
  | { status: 'definitive_rejection'; operation: PendingReceivableOperation; error: unknown }
  | { status: 'definitive_rejection_clear_failed'; operation: PendingReceivableOperation; error: unknown }
  | { status: 'ambiguous_failure'; operation: PendingReceivableOperation; error: unknown }
  | { status: 'pending_conflict'; operation: PendingReceivableOperation }
  | { status: 'busy'; recovery: PendingReceivableRecovery }
  | { status: 'corrupt' }
  | { status: 'unavailable' }

const RECEIVABLE_OUTBOX_PREFIX = 'ash.receivable-outbox.v1'
const RECEIVABLE_OUTBOX_LOCK_PREFIX = 'ash.receivable-outbox-lock.v1'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** The server compares parsed minor units and trimmed reasons, so the client fingerprint must too. */
export function canonicalReceivablePayload(payload: ReceivableOperationPayload): ReceivableOperationPayload {
  return {
    driverId: payload.driverId,
    receivableKind: payload.receivableKind,
    channel: payload.channel,
    direction: payload.direction,
    amount: formatMinor(parseMinor(payload.amount)),
    reason: payload.reason.trim(),
  }
}

export function receivableCommandFingerprint(payload: ReceivableOperationPayload): string {
  return JSON.stringify(canonicalReceivablePayload(payload))
}

export function pendingReceivableOperationMatches(
  current: PendingReceivableOperation | null,
  payload: ReceivableOperationPayload,
): boolean {
  if (!current) return false
  try {
    return current.fingerprint === receivableCommandFingerprint(payload)
  } catch {
    return false
  }
}

/** Actor + branch scoping prevents another login or selected branch from inheriting this command. */
export function receivableOutboxKey(actorId: string, branchId: string): string {
  return `${RECEIVABLE_OUTBOX_PREFIX}:${encodeURIComponent(actorId)}:${encodeURIComponent(branchId)}`
}

export function receivableOutboxLockKey(actorId: string, branchId: string): string {
  return `${RECEIVABLE_OUTBOX_LOCK_PREFIX}:${encodeURIComponent(actorId)}:${encodeURIComponent(branchId)}`
}

/**
 * A receivable command may outlive the tab that issued it, so sessionStorage is not durable enough.
 * Returning null is a hard stop for the caller: an in-memory key must never be used for money.
 */
export function browserReceivableOperationStorage(): ReceivableOperationStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * Web Locks is the only browser primitive here with atomic cross-tab ownership. `localStorage`
 * itself is synchronous but read/set/verify is not a compare-and-swap: two tabs can both read an
 * empty key, save different UUIDs, and POST both. Use `ifAvailable` so the second tab fails closed
 * instead of queuing a second confirmed money command behind the first.
 */
export function browserReceivableOperationMutex(): ReceivableOperationMutex | null {
  try {
    if (typeof window === 'undefined') return null
    const native = (window.navigator as Navigator & {
      locks?: {
        request<T>(
          name: string,
          options: { mode: 'exclusive'; ifAvailable: true },
          callback: (lock: unknown | null) => Promise<T> | T,
        ): Promise<T>
      }
    }).locks
    if (!native || typeof native.request !== 'function') return null
    return {
      tryRunExclusive: async <T>(name: string, task: () => Promise<T> | T) => native.request(
        name,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => lock === null
          ? { acquired: false as const }
          : { acquired: true as const, value: await task() },
      ),
    }
  } catch {
    return null
  }
}

function isReceivablePayload(value: unknown): value is ReceivableOperationPayload {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<Record<keyof ReceivableOperationPayload, unknown>>
  return typeof row.driverId === 'string' && row.driverId !== '' &&
    (row.receivableKind === 'ordinary' || row.receivableKind === 'shift_funding') &&
    (row.channel === 'cash' || row.channel === 'wallet') &&
    (row.direction === 'create' || row.direction === 'collect') &&
    typeof row.amount === 'string' &&
    typeof row.reason === 'string'
}

/**
 * Read only a complete, internally consistent outbox row. Corruption is distinct from no row:
 * deleting or replacing an unreadable key could abandon a command whose response was lost.
 */
export function loadPendingReceivableOperation(
  storage: ReceivableOperationStorage | null,
  actorId: string,
  branchId: string,
): PendingReceivableRecovery {
  if (!storage) return { status: 'unavailable' }
  let raw: string | null
  try {
    raw = storage.getItem(receivableOutboxKey(actorId, branchId))
  } catch {
    return { status: 'unavailable' }
  }
  if (raw === null) return { status: 'none' }
  try {
    const value = JSON.parse(raw) as Partial<PendingReceivableOperation>
    if (
      typeof value.fingerprint !== 'string' ||
      typeof value.idempotencyKey !== 'string' ||
      !UUID_PATTERN.test(value.idempotencyKey) ||
      !isReceivablePayload(value.payload)
    ) return { status: 'corrupt' }
    const payload = canonicalReceivablePayload(value.payload)
    if (receivableCommandFingerprint(payload) !== value.fingerprint) return { status: 'corrupt' }
    return {
      status: 'pending',
      operation: { fingerprint: value.fingerprint, idempotencyKey: value.idempotencyKey, payload },
    }
  } catch {
    return { status: 'corrupt' }
  }
}

/** Persist before POST and prove the exact row can be read back. Never overwrite another pending command. */
export function savePendingReceivableOperation(
  storage: ReceivableOperationStorage | null,
  actorId: string,
  branchId: string,
  operation: PendingReceivableOperation,
): boolean {
  if (!storage) return false
  try {
    const current = loadPendingReceivableOperation(storage, actorId, branchId)
    if (current.status === 'unavailable' || current.status === 'corrupt') return false
    if (
      current.status === 'pending' &&
      (
        current.operation.idempotencyKey !== operation.idempotencyKey ||
        current.operation.fingerprint !== operation.fingerprint
      )
    ) return false

    const serialized = JSON.stringify(operation)
    storage.setItem(receivableOutboxKey(actorId, branchId), serialized)
    if (storage.getItem(receivableOutboxKey(actorId, branchId)) !== serialized) return false
    const verified = loadPendingReceivableOperation(storage, actorId, branchId)
    return verified.status === 'pending' &&
      verified.operation.idempotencyKey === operation.idempotencyKey &&
      verified.operation.fingerprint === operation.fingerprint
  } catch {
    return false
  }
}

/** A stale response must not erase a newer operation; clear only the confirmed matching key. */
export function clearPendingReceivableOperation(
  storage: ReceivableOperationStorage | null,
  actorId: string,
  branchId: string,
  expectedIdempotencyKey: string,
): boolean {
  if (!storage) return false
  try {
    const current = loadPendingReceivableOperation(storage, actorId, branchId)
    if (current.status === 'unavailable' || current.status === 'corrupt') return false
    if (current.status === 'none') return true
    if (current.operation.idempotencyKey !== expectedIdempotencyKey) return false
    storage.removeItem(receivableOutboxKey(actorId, branchId))
    return storage.getItem(receivableOutboxKey(actorId, branchId)) === null
  } catch {
    return false
  }
}

/**
 * Only a named client response proves a request was rejected before commit. Network failures,
 * server failures and 409 conflicts all retain the exact durable command for reconciliation.
 */
export function receivableRejectionDefinitelyDidNotCommit(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const error = value as { status?: unknown }
  return typeof error.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 409
}

/** Active drivers may receive new advances; an inactive debtor remains visible for collection. */
export function receivableDirectoryDrivers<T extends ReceivableDriverOption>(
  drivers: readonly T[],
  outstandingDriverIds: ReadonlySet<string>,
): T[] {
  return drivers.filter((driver) => driver.active || outstandingDriverIds.has(driver.id))
}

/** The UI mirrors the API rule: collection survives deactivation, creation does not. */
export function receivableDriverMaySubmit(
  driver: Pick<ReceivableDriverOption, 'active'> | null | undefined,
  direction: ReceivableOperationPayload['direction'],
): boolean {
  return driver !== null && driver !== undefined && (driver.active || direction === 'collect')
}

/** Once a command exists it is immutable until success or a definitive rejection releases it. */
export const pendingReceivableOperation = (
  current: PendingReceivableOperation | null,
  payload: ReceivableOperationPayload,
  generateKey: () => string = () => crypto.randomUUID(),
): PendingReceivableOperation => {
  if (current) return current
  const canonicalPayload = canonicalReceivablePayload(payload)
  const fingerprint = receivableCommandFingerprint(canonicalPayload)
  return { fingerprint, idempotencyKey: generateKey(), payload: canonicalPayload }
}

/** The API is authoritative; this keeps an incomplete or non-positive command from being sent. */
export function receivableOperationReady(payload: ReceivableOperationPayload): boolean {
  if (payload.driverId === '' || payload.reason.trim() === '' || payload.amount.trim() === '') return false
  try {
    return parseMinor(payload.amount) > 0n
  } catch {
    return false
  }
}

/**
 * Own one actor+branch outbox from the final durable re-read through the HTTP result and durable
 * clear. Keeping the Web Lock for the whole interval prevents a second already-confirmed tab from
 * replacing the UUID while the first response is still ambiguous. Exact retries after a later
 * attempt still reuse the persisted operation.
 */
export async function executeReceivableOperation<T>(input: {
  storage: ReceivableOperationStorage | null
  mutex: ReceivableOperationMutex | null
  actorId: string
  branchId: string
  payload: ReceivableOperationPayload
  current: PendingReceivableOperation | null
  execute: (operation: PendingReceivableOperation) => Promise<T>
  generateKey?: () => string
}): Promise<ReceivableOperationExecution<T>> {
  if (!input.storage || !input.mutex) return { status: 'unavailable' }

  let locked:
    | { acquired: true; value: ReceivableOperationExecution<T> }
    | { acquired: false }
  try {
    locked = await input.mutex.tryRunExclusive(
      receivableOutboxLockKey(input.actorId, input.branchId),
      async (): Promise<ReceivableOperationExecution<T>> => {
        const durable = loadPendingReceivableOperation(input.storage, input.actorId, input.branchId)
        if (durable.status === 'unavailable' || durable.status === 'corrupt') return durable

        if (durable.status === 'pending' && !pendingReceivableOperationMatches(durable.operation, input.payload)) {
          return { status: 'pending_conflict', operation: durable.operation }
        }
        if (
          durable.status === 'none' &&
          input.current !== null &&
          !pendingReceivableOperationMatches(input.current, input.payload)
        ) {
          return { status: 'pending_conflict', operation: input.current }
        }

        const operation = durable.status === 'pending'
          ? durable.operation
          : pendingReceivableOperation(input.current, input.payload, input.generateKey)
        if (!savePendingReceivableOperation(input.storage, input.actorId, input.branchId, operation)) {
          const afterFailure = loadPendingReceivableOperation(input.storage, input.actorId, input.branchId)
          if (afterFailure.status === 'pending') {
            return { status: 'pending_conflict', operation: afterFailure.operation }
          }
          return afterFailure.status === 'corrupt' ? { status: 'corrupt' } : { status: 'unavailable' }
        }

        try {
          const value = await input.execute(operation)
          const cleared = clearPendingReceivableOperation(
            input.storage,
            input.actorId,
            input.branchId,
            operation.idempotencyKey,
          )
          return cleared
            ? { status: 'success', operation, value }
            : { status: 'success_clear_failed', operation, value }
        } catch (error) {
          if (!receivableRejectionDefinitelyDidNotCommit(error)) {
            return { status: 'ambiguous_failure', operation, error }
          }
          const cleared = clearPendingReceivableOperation(
            input.storage,
            input.actorId,
            input.branchId,
            operation.idempotencyKey,
          )
          return cleared
            ? { status: 'definitive_rejection', operation, error }
            : { status: 'definitive_rejection_clear_failed', operation, error }
        }
      },
    )
  } catch {
    return { status: 'unavailable' }
  }

  if (!locked.acquired) {
    // The owner tab has already persisted before issuing its request. Return that exact row when it
    // is visible so this tab can display it, but never wait and auto-issue a second confirmed UUID.
    const recovery = loadPendingReceivableOperation(input.storage, input.actorId, input.branchId)
    if (recovery.status === 'corrupt' || recovery.status === 'unavailable') return recovery
    return { status: 'busy', recovery }
  }
  return locked.value
}
