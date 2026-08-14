/** The serialisable, crash-safe part of the closing package. Files and transient reader state stay out. */
export interface PersistedEndDraft {
  version: 1
  savedAt: number
  cash: string
  wallet: string
  walletOcr: string | null
  /** Explicit typing outranks a later AI response, including after a tab reload. */
  walletHumanEdited: boolean
  odo: string
  odoOcr: number | null
  /** True only when the stored machine baseline came from cloud AI. */
  odoAiAuthoritative: boolean
  odoHumanEdited: boolean
  odoConfirmed: boolean
}

export type EndDraftScalars = Omit<PersistedEndDraft, 'version' | 'savedAt'>

interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const PREFIX = 'ash:driver:end-draft:v1:'

export const endDraftStorageKey = (shiftId: string): string => `${PREFIX}${encodeURIComponent(shiftId)}`

const validNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const validOcr = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)

/** Strict decoding means a partial/corrupt write is ignored instead of manufacturing money. */
export function parseEndDraft(raw: string): PersistedEndDraft | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedEndDraft> | null
    if (
      value === null ||
      value.version !== 1 ||
      typeof value.savedAt !== 'number' ||
      !Number.isFinite(value.savedAt) ||
      typeof value.cash !== 'string' ||
      typeof value.wallet !== 'string' ||
      !validNullableString(value.walletOcr) ||
      (value.walletHumanEdited !== undefined && typeof value.walletHumanEdited !== 'boolean') ||
      typeof value.odo !== 'string' ||
      !validOcr(value.odoOcr) ||
      (value.odoAiAuthoritative !== undefined && typeof value.odoAiAuthoritative !== 'boolean') ||
      typeof value.odoHumanEdited !== 'boolean' ||
      typeof value.odoConfirmed !== 'boolean'
    ) {
      return null
    }
    // Drafts written by the immediately-previous PWA lack one or both authority flags. That build
    // could publish a local provisional read before AI settled, with no persisted bit separating
    // it from a cloud value. Clear only untrusted machine fields; every explicit input survives.
    const walletLegacy = value.walletHumanEdited === undefined
    const odometerLegacy = value.odoAiAuthoritative === undefined
    return {
      ...value,
      ...(walletLegacy ? { wallet: '', walletOcr: null, walletHumanEdited: false } : {}),
      ...(odometerLegacy
        ? {
            // Previous builds stored a phone prefill and a cloud-AI value in the same two fields.
            // Keep explicit typing, but never restore an indistinguishable local machine guess.
            odo: value.odoHumanEdited ? value.odo : '',
            odoOcr: null,
            odoAiAuthoritative: false,
          }
        : {}),
    } as PersistedEndDraft
  } catch {
    return null
  }
}

export function readEndDraft(storage: DraftStorage, shiftId: string): PersistedEndDraft | null {
  const key = endDraftStorageKey(shiftId)
  try {
    const raw = storage.getItem(key)
    if (raw === null) return null
    const parsed = parseEndDraft(raw)
    if (parsed === null) {
      // Best effort: a corrupt value should not poison every future mount of this shift.
      try {
        storage.removeItem(key)
      } catch {
        /* storage may be unavailable; reading still fails closed */
      }
    }
    return parsed
  } catch {
    return null
  }
}

/** One JSON setItem is the browser's atomic unit; quota/privacy failures never break the shift UI. */
export function writeEndDraft(
  storage: DraftStorage,
  shiftId: string,
  draft: EndDraftScalars,
  now = Date.now(),
): boolean {
  try {
    storage.setItem(endDraftStorageKey(shiftId), JSON.stringify({ version: 1, savedAt: now, ...draft }))
    return true
  } catch {
    return false
  }
}

export function clearEndDraft(storage: DraftStorage, shiftId: string): void {
  try {
    storage.removeItem(endDraftStorageKey(shiftId))
  } catch {
    /* cleanup must never replace the terminal screen with a storage error */
  }
}

/** Local unsent values are newer than `/state`; restore only this explicitly persisted scalar seam. */
export function restoreEndDraftScalars<T extends EndDraftScalars>(current: T, saved: PersistedEndDraft): T {
  return {
    ...current,
    cash: saved.cash,
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
