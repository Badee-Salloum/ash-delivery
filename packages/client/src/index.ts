export * from './api.ts'
export * from './order-entry.ts'
export * from './order-match.ts'
export * from './slot-label.ts'
export * from './compress.ts'
export * from './ocr-delta.ts'

/** Pluralization travels with the catalogues, but app code imports it from the root. */
export { plural, pluralCategory, type PluralForms } from './i18n/index.ts'

/**
 * One timestamp format for the whole console.
 *
 * Three screens each rolled their own: the decision log used the BROWSER's locale, so it
 * rendered «8/8/2026, 3:04:11 PM» inside an otherwise Arabic, ISO-dated UI; the audit table
 * sliced the ISO string; the dashboard used a time-only format. Latin digits deliberately —
 * the whole product shows Western numerals (the ar-SY-u-nu-latn policy in styles.css).
 */
export function formatDateTime(iso: string, lang: 'ar' | 'en'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  void lang // the shape is identical in both; the parameter keeps call sites honest
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
