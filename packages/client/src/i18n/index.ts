import { ar } from './ar.ts'
import { en } from './en.ts'
import type { Catalog } from './ar.ts'

export type Lang = 'ar' | 'en'
export type { Catalog } from './ar.ts'
export { ar } from './ar.ts'
export { en } from './en.ts'

/** ar is the default; the whole UI is RTL-first. */
export const DEFAULT_LANG: Lang = 'ar'
export const catalogs: Record<Lang, Catalog> = { ar, en }
export const dir = (lang: Lang): 'rtl' | 'ltr' => (lang === 'ar' ? 'rtl' : 'ltr')

/** The approved product wording, kept separate from page-specific copy. */
export type Glossary = Catalog['glossary']
export const glossary = (lang: Lang): Glossary => catalogs[lang].glossary

/**
 * Replace the named placeholders used in catalog copy without making a locale-dependent number.
 * Both `{name}` and the older `{{name}}` spelling are supported during the migration.
 */
export function interpolate(template: string, values: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}|\{([A-Za-z0-9_]+)\}/g, (match, doubleKey: string | undefined, singleKey: string | undefined) => {
    const value = values[doubleKey ?? singleKey ?? '']
    return value === undefined ? match : String(value)
  })
}

/**
 * Arabic counts in six categories, and the app was using one.
 *
 * «أُضيفت 1 عملية», «1 صفوف لم تُقرأ», «تمت قراءة 2 حقول» — each of those reads to a native
 * speaker the way "1 rows were added" reads in English: not a rough edge, a sign the software was
 * not written for him. The catalogue even carried `readAddedOne`/`readRefusedOne` keys for the
 * singular; nothing ever called them.
 *
 * The CLDR categories Arabic actually uses:
 *   zero  0
 *   one   1
 *   two   2                       ← the dual, which English has no equivalent for
 *   few   3–10, and n % 100 in 3–10
 *   many  11–99, and n % 100 in 11–99
 *   other everything else (100, 101, 200 …)
 *
 * English collapses to `one` and `other`, so one call site serves both languages.
 */
export interface PluralForms {
  zero?: string
  one?: string
  two?: string
  few?: string
  many?: string
  other: string
}

export function pluralCategory(n: number, lang: Lang): keyof PluralForms {
  if (lang !== 'ar') return n === 1 ? 'one' : 'other'
  if (n === 0) return 'zero'
  if (n === 1) return 'one'
  if (n === 2) return 'two'
  const mod = n % 100
  if (mod >= 3 && mod <= 10) return 'few'
  if (mod >= 11 && mod <= 99) return 'many'
  return 'other'
}

/**
 * Pick the right form and substitute `{n}`.
 *
 * Falls back through the categories rather than throwing: a catalogue that only defines `other` is
 * still correct English, and a missing `two` in Arabic reads as the plural rather than as a crash.
 */
export function plural(n: number, forms: PluralForms, lang: Lang): string {
  const category = pluralCategory(n, lang)
  const text =
    forms[category] ??
    (category === 'zero' || category === 'two' ? forms.few : undefined) ??
    forms.many ??
    forms.other
  return text.replace('{n}', String(n))
}
