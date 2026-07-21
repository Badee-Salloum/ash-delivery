#!/usr/bin/env node
/**
 * CI guard: every .ts file must be runnable by Node's type stripping.
 *
 * Node runs TypeScript in "strip-only" mode — it erases type annotations without transforming
 * code. Syntax that needs a real transform is rejected at load time with
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. The API failed to boot on exactly this: parameter
 * properties (`constructor(private x: number)`), which look harmless and are used everywhere in
 * ordinary TypeScript.
 *
 * Catching it here means the failure is a CI message naming the file, rather than a container
 * that crash-loops on deploy.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ROOTS = ['packages', 'apps'].map((p) => join(ROOT, p))

const failures = []

/** Unsupported in strip-only mode. Each needs a code transform, not just erasure. */
const RULES = [
  {
    // constructor(private readonly x: T) — parameter properties
    re: /constructor\s*\([^)]*?\b(private|public|protected|readonly)\s+\w+\s*[:?]/s,
    msg: 'parameter property in a constructor — declare the field explicitly and assign it in the body',
  },
  {
    re: /^\s*(?!declare\b)(?:export\s+)?enum\s+\w+/m,
    msg: 'a non-declare `enum` — use a union type or an `as const` object',
  },
  {
    re: /^\s*(?:export\s+)?namespace\s+\w+/m,
    msg: 'a `namespace` — use a module',
  },
  {
    re: /^\s*@[\w.]+\s*(\(|\s*$)/m,
    msg: 'a decorator — not supported by strip-only type stripping',
  },
]

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.vite') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) yield full
  }
}

let scanned = 0
for (const root of ROOTS) {
  for (const file of walk(root)) {
    scanned += 1
    const rel = relative(ROOT, file).replaceAll('\\', '/')
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    for (const rule of RULES) {
      if (rule.re.test(code)) failures.push(`${rel}: ${rule.msg}`)
    }
  }
}

if (failures.length > 0) {
  console.error(
    `strippable-TypeScript check FAILED (${failures.length}):\n` + failures.map((f) => `  ✗ ${f}`).join('\n'),
  )
  process.exit(1)
}
console.log(`strippable-TypeScript check passed: ${scanned} files run under Node's type stripping.`)
