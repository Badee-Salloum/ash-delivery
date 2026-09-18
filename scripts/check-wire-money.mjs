#!/usr/bin/env node
/**
 * CI guard: money never crosses the HTTP boundary as a JSON number.
 *
 * `JSON.stringify` throws on a bigint, so the tempting fix is `Number(amount)` — and that is the
 * single most likely way a defect ever enters this system. Money goes over the wire as a decimal
 * string and is parsed into `Minor` exactly once, in `@ash/contracts`.
 *
 * Two rules:
 *   1. No `z.number()` on a money-shaped field name in any schema.
 *   2. No `Number(...)` applied to a money-shaped identifier outside the sanctioned parsers.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ROOTS = ['packages/contracts/src', 'packages/adapters/src', 'apps'].map((p) => join(ROOT, p))

/**
 * Field names that mean money. Kept deliberately broad — a false positive costs one rename.
 *
 * The company ledger (C1) adds dollars, frozen exchange rates, debts, instalments, depreciation and
 * book values: every one of them is money or multiplies money, and a float on any of them is the
 * same silent rounding as on an amount.
 */
const MONEY_NAME =
  /(amount|fee|balance|cash|wallet|float|topup|total|share|minor|price|cost|salary|ceiling|usd|syp|rate|principal|outstanding|instal|depreci|reserve|book)/i

/** Where turning money into a Number is legitimate and reviewed. */
const ALLOWED = new Set([
  'packages/contracts/src/wire.ts', // the one sanctioned parse/serialise boundary
])

const failures = []

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) yield full
  }
}

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = relative(ROOT, file).replaceAll('\\', '/')
    if (ALLOWED.has(rel)) continue
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    // Rule 1 — z.number() on a money-shaped field.
    for (const m of code.matchAll(/(\w+)\s*:\s*z\s*\.\s*number\s*\(/g)) {
      if (MONEY_NAME.test(m[1])) {
        failures.push(`${rel}: \`${m[1]}: z.number()\` — money must cross the wire as a decimal string`)
      }
    }

    // Rule 2 — Number() applied to something money-shaped.
    for (const m of code.matchAll(/\bNumber\s*\(\s*([\w.]+)/g)) {
      if (MONEY_NAME.test(m[1])) {
        failures.push(`${rel}: \`Number(${m[1]})\` — converting money to a float loses precision silently`)
      }
    }

    // Rule 3 — parseFloat is never right for money.
    for (const m of code.matchAll(/\bparseFloat\s*\(\s*([\w.]+)/g)) {
      failures.push(`${rel}: \`parseFloat(${m[1]})\` — never use a float parser in this codebase`)
    }
  }
}

if (failures.length > 0) {
  console.error(`wire-money check FAILED (${failures.length}):\n` + failures.map((f) => `  ✗ ${f}`).join('\n'))
  process.exit(1)
}
console.log('wire-money check passed: no money crosses the wire as a JSON number.')
