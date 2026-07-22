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
