#!/usr/bin/env node
/**
 * CI guard: the UI is RTL-first, so only Tailwind LOGICAL properties are allowed.
 *
 * A physical utility (ml-/mr-/pl-/pr-/left-/right-/text-left/text-right) looks fine in the
 * direction it was written and silently breaks the other. Catching it here means RTL correctness
 * cannot rot across the front-ends — the one-afternoon rule the design decision called for.
 *
 * The logical replacements: ms-/me-, ps-/pe-, start-/end-, text-start/text-end.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
//  is in the list because the shared tokens are CSS the two front-ends inherit:
// a physical property introduced there would break RTL in BOTH apps at once, and the guard would
// not have been looking at it.
const APPS = ['apps/driver/src', 'apps/admin/src', 'packages/theme'].map((p) => join(ROOT, p))

// Match physical utilities as whole class tokens, incl. responsive/state prefixes (md:ml-2).
const BANNED =
  /(?:^|[\s"'`{(:])(?:[a-z-]+:)*(?:ml|mr|pl|pr)-|(?:^|[\s"'`{(:])(?:[a-z-]+:)*(?:left|right)-\d|text-(?:left|right)\b/

const failures = []
function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    // A workspace package carries its own node_modules symlinks; vendored CSS is not ours to police
    // and walking it would scan hundreds of irrelevant files for every run.
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(tsx?|css)$/.test(entry)) yield full
  }
}

let scanned = 0
for (const root of APPS) {
  for (const file of walk(root)) {
    scanned += 1
    const rel = relative(ROOT, file).split('\\').join('/')
    // Strip block comments (whole file) and line comments (per line) so prose that mentions a
    // physical utility — e.g. the RTL rule's own docstring — is not a false positive.
    const stripped = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    stripped.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '')
      const m = BANNED.exec(code)
      if (m) failures.push(`${rel}:${i + 1}  ${m[0].trim()}`)
    })
  }
}

if (failures.length) {
  console.error(
    `physical-CSS check FAILED (${failures.length}) — use logical properties (ms-/me-, ps-/pe-, text-start/end):\n` +
      failures.map((f) => `  ✗ ${f}`).join('\n'),
  )
  process.exit(1)
}
console.log(`physical-CSS check passed: ${scanned} files, RTL-safe logical properties only.`)
