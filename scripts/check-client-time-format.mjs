import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SOURCES = [join(ROOT, 'apps', 'admin', 'src'), join(ROOT, 'apps', 'driver', 'src')]
const forbidden = /\b(?:toLocaleDateString|toLocaleTimeString|toLocaleString)\s*\(/g
const files = []

function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) visit(path)
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path)
  }
}

for (const source of SOURCES) visit(source)

const failures = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(forbidden)) {
    const line = text.slice(0, match.index).split('\n').length
    failures.push(`${relative(ROOT, file)}:${line} — use @ash/client Damascus formatters instead of the browser locale/zone`)
  }
}

if (failures.length > 0) {
  console.error(`client-time-format check FAILED (${failures.length}):\n${failures.map((x) => `  ✗ ${x}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`client-time-format check passed: ${files.length} UI source files use the shared Damascus formatter.`)
}
