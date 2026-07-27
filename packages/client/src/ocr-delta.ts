/**
 * The SRS D-3 delta: which confirmed fields disagree with what OCR read.
 *
 * D-3 requires every manual edit to be logged *together with its difference from the OCR reading*
 * (raw material for later anomaly detection). The readings already carry the pre-correction OCR
 * baseline (`ocrRaw`); this is the pure, DOM-free diff the manager's review renders and any future
 * anomaly rule consumes.
 *
 * Generic over the field-key list on purpose: the caller passes the keys, so this never imports the
 * driver app's `BmsReading` (the wrong dependency direction) and serves BMS packs, the odometer,
 * the battery %, the wallet and order fees alike.
 */

export type OcrScalar = number | null

export interface OcrFieldDelta<K extends string = string> {
  key: K
  /** What OCR read (null = OCR left it blank). */
  ocr: OcrScalar
  /** What the driver confirmed. */
  confirmed: OcrScalar
  /** `edited` = OCR read a value the driver changed; `filled` = OCR blank, the driver supplied it. */
  kind: 'edited' | 'filled'
}

/**
 * Fields where the confirmed reading differs from what OCR produced.
 *
 * - `ocrRaw` null/undefined (OCR never ran) → `[]`.
 * - a field equal to OCR → omitted (a confirmation, not an edit).
 * - both null → omitted.
 * - OCR null, confirmed non-null → `kind: 'filled'`.
 * - otherwise (values differ) → `kind: 'edited'`.
 */
export function ocrReadingDelta<K extends string>(
  keys: readonly K[],
  ocrRaw: Partial<Record<K, OcrScalar>> | null | undefined,
  confirmed: Partial<Record<K, OcrScalar>>,
): OcrFieldDelta<K>[] {
  if (ocrRaw == null) return []
  const out: OcrFieldDelta<K>[] = []
  for (const key of keys) {
    const ocr = ocrRaw[key] ?? null
    const conf = confirmed[key] ?? null
    if (ocr === null && conf === null) continue
    if (ocr === conf) continue
    out.push({ key, ocr, confirmed: conf, kind: ocr === null ? 'filled' : 'edited' })
  }
  return out
}
