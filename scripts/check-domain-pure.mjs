#!/usr/bin/env node
/**
 * CI guard: packages/domain must stay pure.
 *
 * The money core is the one place in this system where a mistake costs real cash, so its
 * isolation is enforced mechanically rather than by convention. This is one of four
 * independent mechanisms (see also: `"types": []`, TypeScript project references, and the
 * ESLint no-restricted-imports/globals rules in that folder).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL.pathname — the latter percent-encodes the spaces in the project path.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOMAIN = join(ROOT, 'packages', 'domain')
const SRC = join(DOMAIN, 'src')

const failures = []

// 1. No runtime dependencies, ever.
const pkg = JSON.parse(readFileSync(join(DOMAIN, 'package.json'), 'utf8'))
const deps = Object.keys(pkg.dependencies ?? {})
if (deps.length > 0) {
  failures.push(`packages/domain has runtime dependencies: ${deps.join(', ')} — it must have none`)
}

// 2. No imports that leave the package, and no ambient impurity.
const BANNED_IMPORT = /^\s*(?:import|export)\b[^'"]*from\s*['"]([^'"]+)['"]/gm
const BANNED_GLOBALS = [
  ['Date', /\bnew\s+Date\b|\bDate\s*\.\s*(now|parse|UTC)\b/],
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['Intl', /\bIntl\s*\./],
  ['process', /\bprocess\s*\./],
  ['fetch', /\bfetch\s*\(/],
]

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (entry.endsWith('.ts')) yield full
  }
}

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  const text = readFileSync(file, 'utf8')
  // Strip block and line comments so prose about `Date` or `Intl` does not trip the guard.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  for (const match of code.matchAll(BANNED_IMPORT)) {
    const spec = match[1]
    if (!spec.startsWith('.')) {
      failures.push(`${rel}: imports "${spec}" — the domain may only import from itself`)
    }
  }
  for (const [name, pattern] of BANNED_GLOBALS) {
    if (pattern.test(code)) {
      failures.push(`${rel}: uses ${name} — the domain is deterministic; inject it as a value instead`)
    }
  }
}

if (failures.length > 0) {
  console.error('domain purity check FAILED:\n' + failures.map((f) => `  ✗ ${f}`).join('\n'))
  process.exit(1)
}
console.log('domain purity check passed: no dependencies, no external imports, no ambient clock or locale.')
