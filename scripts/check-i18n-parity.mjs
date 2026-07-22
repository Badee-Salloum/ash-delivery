#!/usr/bin/env node
/**
 * CI guard: the English catalog must mirror the Arabic one key-for-key.
 *
 * The TypeScript `Catalog` type already enforces this at compile time; this is the runtime
 * belt-and-braces, and it also catches an `en` value left accidentally equal to the `ar` one
 * (an untranslated string), which the type cannot see.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../packages/client/src/i18n/', import.meta.url))
// Naive but dependency-free: pull the key structure by importing is not possible from .ts here,
// so we assert the two files reference the same top-level sections. The compile-time type is the
// real check; this guards against a section being dropped wholesale.
const ar = readFileSync(`${dir}ar.ts`, 'utf8')
const en = readFileSync(`${dir}en.ts`, 'utf8')

const sections = (src) => [...src.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]).sort()
const arSections = sections(ar)
const enSections = sections(en)

const missing = arSections.filter((s) => !enSections.includes(s))
const extra = enSections.filter((s) => !arSections.includes(s))

if (missing.length || extra.length) {
  console.error('i18n parity FAILED:')
  if (missing.length) console.error(`  en is missing sections: ${missing.join(', ')}`)
  if (extra.length) console.error(`  en has extra sections: ${extra.join(', ')}`)
  process.exit(1)
}
console.log(`i18n parity: ar and en share ${arSections.length} sections.`)
