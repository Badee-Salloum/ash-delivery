import { parseMinor } from '@ash/domain'

const VERSION = 1 as const
const KEY_PREFIX = 'ash.pending-tranche.'

interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface PendingTrancheOperation {
  version: typeof VERSION
  shiftId: string
  occurrenceKey: string
  kind: 'float' | 'topup'
  amount: string
  createdAt: string
}

export type PendingTrancheRecovery =
  | { status: 'none' }
  | { status: 'pending'; operation: PendingTrancheOperation }
  | { status: 'corrupt' }
  | { status: 'unavailable' }

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function storageKey(shiftId: string): string {
  return `${KEY_PREFIX}${shiftId}`
}

export function isStrictlyPositiveTrancheAmount(value: string): boolean {
  try {
    return parseMinor(value.trim()) > 0n
  } catch {
    return false
  }
}

/**
 * A received non-conflict 4xx response proves this request was refused before committing. A 409
 * remains pending even if an intermediary hid its error body: it can mean that this key already
 * names a server-side operation. Network errors and 5xx responses remain pending too.
 */
export function trancheRejectionDefinitelyDidNotCommit(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const error = value as { status?: unknown; error?: unknown }
  return (
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 409
  )
}

function isOperation(value: unknown, shiftId: string): value is PendingTrancheOperation {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<PendingTrancheOperation>
  return (
    row.version === VERSION &&
    row.shiftId === shiftId &&
    typeof row.occurrenceKey === 'string' &&
    row.occurrenceKey.trim() !== '' &&
    row.occurrenceKey.length <= 64 &&
    (row.kind === 'float' || row.kind === 'topup') &&
    typeof row.amount === 'string' &&
    isStrictlyPositiveTrancheAmount(row.amount) &&
    typeof row.createdAt === 'string' &&
    !Number.isNaN(Date.parse(row.createdAt))
  )
}

export function newPendingTranche(
  shiftId: string,
  kind: 'float' | 'topup',
  amount: string,
  occurrenceKey: string,
  createdAt = new Date().toISOString(),
): PendingTrancheOperation {
  return { version: VERSION, shiftId, occurrenceKey, kind, amount: amount.trim(), createdAt }
}

/** Invalid data fails closed: never delete an uncertain money-operation key automatically. */
export function readPendingTranche(
  shiftId: string,
  storage: KeyValueStorage | null = browserStorage(),
): PendingTrancheRecovery {
  if (!storage) return { status: 'unavailable' }
  try {
    const raw = storage.getItem(storageKey(shiftId))
    if (raw === null) return { status: 'none' }
    const parsed: unknown = JSON.parse(raw)
    return isOperation(parsed, shiftId) ? { status: 'pending', operation: parsed } : { status: 'corrupt' }
  } catch {
    return { status: 'corrupt' }
  }
}

/** Persist before issuing the POST. A failed write blocks the disbursement. */
export function writePendingTranche(
  operation: PendingTrancheOperation,
  storage: KeyValueStorage | null = browserStorage(),
): boolean {
  if (!storage || !isOperation(operation, operation.shiftId)) return false
  try {
    storage.setItem(storageKey(operation.shiftId), JSON.stringify(operation))
    return storage.getItem(storageKey(operation.shiftId)) === JSON.stringify(operation)
  } catch {
    return false
  }
}

/** Clear only after a successful or idempotently replayed server response. */
export function clearPendingTranche(
  shiftId: string,
  storage: KeyValueStorage | null = browserStorage(),
): boolean {
  if (!storage) return false
  try {
    storage.removeItem(storageKey(shiftId))
    return storage.getItem(storageKey(shiftId)) === null
  } catch {
    return false
  }
}
