import type { CloseDraftPatch } from '@ash/client'

export const END_DRAFT_TTL_MS = 48 * 60 * 60_000
const ROOT_PREFIX = 'ash:driver:end-draft:'
const PREFIX = `${ROOT_PREFIX}v2:`

export type PersistedCloseDraftOperations = NonNullable<CloseDraftPatch['operations']>

/** Serialisable unsaved human work only. Evidence bytes remain in the dedicated IndexedDB store. */
export interface PersistedEndDraft {
  version: 2
  ownerDriverId: string
  shiftId: string
  savedAt: number
  expiresAt: number
  fingerprint: string
  /** Missing on legacy v2 records. Such records must never replay full-replacement arrays. */
  baseRevision?: number
  baseDraftHash?: string
  persistedCashDeclared: string | null
  persistedWalletDeclared: string | null
  persistedOdometerKm: number | null
  persistedOdometerAnomalyConfirmed: boolean
  cash: string
  wallet: string
  walletOcr: string | null
  walletHumanEdited: boolean
  odo: string
  odoOcr: number | null
  odoAiAuthoritative: boolean
  odoHumanEdited: boolean
  odoConfirmed: boolean
  operations: PersistedCloseDraftOperations
}

export type EndDraftScalars = Pick<
  PersistedEndDraft,
  | 'cash'
  | 'persistedCashDeclared'
  | 'persistedWalletDeclared'
  | 'persistedOdometerKm'
  | 'persistedOdometerAnomalyConfirmed'
  | 'wallet'
  | 'walletOcr'
  | 'walletHumanEdited'
  | 'odo'
  | 'odoOcr'
  | 'odoAiAuthoritative'
  | 'odoHumanEdited'
  | 'odoConfirmed'
>

interface DraftStorage {
  readonly length?: number
  key?(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const endDraftStorageKey = (ownerDriverId: string, shiftId: string): string =>
  `${PREFIX}${encodeURIComponent(ownerDriverId)}:${encodeURIComponent(shiftId)}`

const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const validOcr = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function validManualOrder(value: unknown): boolean {
  if (!object(value)) return false
  return (
    typeof value.clientKey === 'string' &&
    typeof value.providerOrderNo === 'string' &&
    (value.payMode === 'cash' || value.payMode === 'electronic' || value.payMode === 'free') &&
    nullableString(value.fee) &&
    nullableString(value.occurredMinute) &&
    nullableString(value.occurredDate) &&
    nullableString(value.pointA) &&
    nullableString(value.pointB) &&
    value.source === 'manual'
  )
}

function validManualDeduction(value: unknown): boolean {
  if (!object(value)) return false
  return (
    typeof value.clientKey === 'string' &&
    typeof value.operationKey === 'string' &&
    nullableString(value.amount) &&
    nullableString(value.occurredMinute) &&
    nullableString(value.occurredDate) &&
    nullableString(value.pointA) &&
    nullableString(value.pointB) &&
    value.source === 'manual'
  )
}

function validManualMovement(value: unknown): boolean {
  if (!object(value)) return false
  return (
    typeof value.clientKey === 'string' &&
    typeof value.amount === 'string' &&
    nullableString(value.occurredMinute) &&
    (value.role === 'yalago_cut' || value.role === 'order_credit' || value.role === 'unmatched') &&
    nullableString(value.providerOrderNo) &&
    typeof value.ambiguous === 'boolean' &&
    nullableString(value.notes) &&
    value.source === 'manual'
  )
}

function optional(value: Record<string, unknown>, key: string, valid: (field: unknown) => boolean): boolean {
  return !(key in value) || valid(value[key])
}

function validRowEdit(value: unknown): boolean {
  if (!object(value) || typeof value.clientKey !== 'string') return false
  if (value.kind === 'order') {
    return (
      optional(value, 'fee', nullableString) &&
      optional(value, 'occurredMinute', nullableString) &&
      optional(value, 'occurredDate', nullableString)
    )
  }
  if (value.kind === 'cash_deduction') {
    return (
      optional(value, 'amount', nullableString) &&
      optional(value, 'occurredMinute', nullableString) &&
      optional(value, 'occurredDate', nullableString)
    )
  }
  if (value.kind === 'movement') {
    return (
      optional(value, 'amount', (field) => typeof field === 'string') &&
      optional(value, 'occurredMinute', nullableString) &&
      optional(value, 'notes', nullableString) &&
      optional(value, 'ambiguous', (field) => typeof field === 'boolean')
    )
  }
  return false
}

function validOperations(value: unknown): value is PersistedCloseDraftOperations {
  if (!object(value)) return false
  return Array.isArray(value.manualOrders) &&
    value.manualOrders.every(validManualOrder) &&
    Array.isArray(value.manualCashDeductions) &&
    value.manualCashDeductions.every(validManualDeduction) &&
    Array.isArray(value.manualMovements) &&
    value.manualMovements.every(validManualMovement) &&
    Array.isArray(value.rowEdits) &&
    value.rowEdits.every(validRowEdit)
}

/** Strict decoding ignores a torn, stale or cross-account value instead of manufacturing money. */
export function parseEndDraft(
  raw: string,
  expectedOwnerDriverId?: string,
  expectedShiftId?: string,
  now = Date.now(),
): PersistedEndDraft | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedEndDraft> | null
    if (
      value === null ||
      value.version !== 2 ||
      typeof value.ownerDriverId !== 'string' ||
      typeof value.shiftId !== 'string' ||
      (expectedOwnerDriverId !== undefined && value.ownerDriverId !== expectedOwnerDriverId) ||
      (expectedShiftId !== undefined && value.shiftId !== expectedShiftId) ||
      typeof value.savedAt !== 'number' ||
      !Number.isFinite(value.savedAt) ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= now ||
      typeof value.fingerprint !== 'string' ||
      !optional(value as Record<string, unknown>, 'baseRevision', (field) =>
        typeof field === 'number' && Number.isSafeInteger(field) && field >= 0) ||
      !optional(value as Record<string, unknown>, 'baseDraftHash', (field) => typeof field === 'string') ||
      !nullableString(value.persistedCashDeclared) ||
      !nullableString(value.persistedWalletDeclared) ||
      !validOcr(value.persistedOdometerKm) ||
      typeof value.persistedOdometerAnomalyConfirmed !== 'boolean' ||
      typeof value.cash !== 'string' ||
      typeof value.wallet !== 'string' ||
      !nullableString(value.walletOcr) ||
      typeof value.walletHumanEdited !== 'boolean' ||
      typeof value.odo !== 'string' ||
      !validOcr(value.odoOcr) ||
      typeof value.odoAiAuthoritative !== 'boolean' ||
      typeof value.odoHumanEdited !== 'boolean' ||
      typeof value.odoConfirmed !== 'boolean' ||
      !validOperations(value.operations)
    ) return null
    return value as PersistedEndDraft
  } catch {
    return null
  }
}

export function readEndDraft(
  storage: DraftStorage,
  ownerDriverId: string,
  shiftId: string,
  now = Date.now(),
): PersistedEndDraft | null {
  const key = endDraftStorageKey(ownerDriverId, shiftId)
  try {
    const raw = storage.getItem(key)
    if (raw === null) return null
    const parsed = parseEndDraft(raw, ownerDriverId, shiftId, now)
    if (parsed === null) storage.removeItem(key)
    return parsed
  } catch {
    return null
  }
}

/** One JSON `setItem` is atomic; quota/privacy failures never break the closing screen. */
export function writeEndDraft(
  storage: DraftStorage,
  ownerDriverId: string,
  shiftId: string,
  draft: EndDraftScalars,
  operations: PersistedCloseDraftOperations,
  fingerprint: string,
  base: { revision: number; draftHash: string },
  now = Date.now(),
): boolean {
  try {
    const value: PersistedEndDraft = {
      version: 2,
      ownerDriverId,
      shiftId,
      savedAt: now,
      expiresAt: now + END_DRAFT_TTL_MS,
      fingerprint,
      baseRevision: base.revision,
      baseDraftHash: base.draftHash,
      ...draft,
      operations,
    }
    storage.setItem(endDraftStorageKey(ownerDriverId, shiftId), JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function clearEndDraft(storage: DraftStorage, ownerDriverId: string, shiftId: string): void {
  try {
    storage.removeItem(endDraftStorageKey(ownerDriverId, shiftId))
  } catch {
    // Cleanup must never replace the terminal screen with a storage error.
  }
}

function storedDraftKeys(storage: DraftStorage): string[] {
  try {
    const length = storage.length
    if (typeof length !== 'number' || typeof storage.key !== 'function') return []
    const result: string[] = []
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(ROOT_PREFIX)) result.push(key)
    }
    return result
  } catch {
    return []
  }
}

/** Privacy boundary for logout/account change, including unscoped v1 records from cached builds. */
export function clearAllEndDrafts(storage: DraftStorage): void {
  for (const key of storedDraftKeys(storage)) {
    try {
      storage.removeItem(key)
    } catch {
      // Best effort on restricted storage.
    }
  }
}

export function sweepExpiredEndDrafts(storage: DraftStorage, now = Date.now()): void {
  for (const key of storedDraftKeys(storage)) {
    try {
      if (!key.startsWith(PREFIX)) {
        storage.removeItem(key)
        continue
      }
      const raw = storage.getItem(key)
      if (raw === null || parseEndDraft(raw, undefined, undefined, now) === null) storage.removeItem(key)
    } catch {
      // Best effort on restricted storage.
    }
  }
}

export function restoreEndDraftScalars<T extends EndDraftScalars>(current: T, saved: PersistedEndDraft): T {
  return {
    ...current,
    cash: saved.cash,
    persistedCashDeclared: saved.persistedCashDeclared,
    persistedWalletDeclared: saved.persistedWalletDeclared,
    persistedOdometerKm: saved.persistedOdometerKm,
    persistedOdometerAnomalyConfirmed: saved.persistedOdometerAnomalyConfirmed,
    wallet: saved.wallet,
    walletOcr: saved.walletOcr,
    walletHumanEdited: saved.walletHumanEdited,
    odo: saved.odo,
    odoOcr: saved.odoOcr,
    odoAiAuthoritative: saved.odoAiAuthoritative,
    odoHumanEdited: saved.odoHumanEdited,
    odoConfirmed: saved.odoConfirmed,
  }
}
