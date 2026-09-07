#!/usr/bin/env node
/**
 * CI guard: colour is a ROLE, not a palette pick.
 *
 * `apps/admin/src` reached ~700 raw Tailwind colour utilities across 67 distinct values, in which
 * `red-600`, `red-700`, `red-800` and `red-900` all meant "bad" and nothing said which was right.
 * The legacy bridge in `packages/theme/tokens.css` re-points those onto role tokens so they follow
 * the theme, but the bridge is scaffolding: it exists to be deleted, and it cannot be deleted if new
 * raw colours keep arriving.
 *
 * A RATCHET, NOT A WALL. Migrating every screen in one change would be a diff nobody could review
 * against a system that moves real cash daily, so each file carries a budget that may only go DOWN.
 * Add a raw colour to a clean file and the build fails; migrate a file and lower its number. When a
 * budget is beaten the guard says so and insists it be tightened — otherwise a ratchet that is never
 * re-cut is just a comment.
 *
 * The sibling product is the argument for this file existing at all. It built a shared PageHeader
 * and then used it on six of thirty pages; it shipped two different "unified" empty-state components
 * that were never merged. Nothing there was wrong at the moment it was written, and there was no
 * guard, so the drift came back.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ROOTS = ['apps/admin/src', 'apps/driver/src'].map((p) => join(ROOT, p))

/**
 * Whole class tokens only, including variant prefixes (`hover:`, `md:`, `dark:`) and an optional
 * `/opacity` suffix. `bg-white` is deliberately NOT matched: `text-white` is correct forever on a
 * solid brand/danger/success fill, and the surfaces that needed it are already migrated.
 */
const RAW =
  /(?:^|[\s"'`{(:])(?:[a-z-]+:)*(?:text|bg|border|ring|divide|from|via|to|fill|stroke|outline|placeholder|accent|caret|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|\d{2,3})\b/g

/**
 * The debt, per file, as it stood when the token layer landed. These numbers may only DECREASE.
 * A file absent from this map is held at zero.
 */
const BASELINE = {
  'apps/admin/src/AdminApp.tsx': 12,
  'apps/admin/src/ErrorBoundary.tsx': 7,
  'apps/admin/src/feedback.tsx': 2,
  'apps/admin/src/NotificationBell.tsx': 10,
  'apps/admin/src/screens/Accounts.tsx': 14,
  'apps/admin/src/screens/Approval.tsx': 273,
  'apps/admin/src/screens/Audit.tsx': 4,
  'apps/admin/src/screens/CheckIn.tsx': 9,
  'apps/admin/src/screens/Dashboard.tsx': 40,
  'apps/admin/src/screens/Expenses.tsx': 10,
  'apps/admin/src/screens/fleet/AddBike.tsx': 9,
  'apps/admin/src/screens/fleet/BikeBoard.tsx': 3,
  'apps/admin/src/screens/fleet/BikeCard.tsx': 10,
  'apps/admin/src/screens/Fleet.tsx': 27,
  'apps/admin/src/screens/FleetConfig.tsx': 8,
  'apps/admin/src/screens/GpsLive.tsx': 5,
  'apps/admin/src/screens/LiveShifts.tsx': 24,
  'apps/admin/src/screens/Login.tsx': 9,
  'apps/admin/src/screens/Permissions.tsx': 5,
  'apps/admin/src/screens/PreapprovedShifts.tsx': 8,
  'apps/admin/src/screens/Queue.tsx': 3,
  'apps/admin/src/screens/Removals.tsx': 11,
  'apps/admin/src/screens/Settings.tsx': 15,
  'apps/admin/src/screens/Tiers.tsx': 8,
  'apps/admin/src/screens/Treasury.tsx': 119,
  'apps/admin/src/settlement-optional-reason.test.ts': 1,
  'apps/admin/src/ui.tsx': 4,
  'apps/driver/src/DriverApp.tsx': 6,
  'apps/driver/src/ErrorBoundary.tsx': 7,
  'apps/driver/src/screens/BatteryPanel.tsx': 16,
  'apps/driver/src/screens/BatterySwap.tsx': 6,
  'apps/driver/src/screens/CloudReadStatus.tsx': 5,
  'apps/driver/src/screens/Login.tsx': 4,
  'apps/driver/src/screens/OrderEntry.tsx': 62,
  'apps/driver/src/screens/PageGrid.tsx': 3,
  'apps/driver/src/screens/PhotoSlot.tsx': 38,
  'apps/driver/src/screens/ReadingLock.tsx': 6,
  'apps/driver/src/screens/ReadingSource.tsx': 1,
  'apps/driver/src/screens/Shift.tsx': 55,
  'apps/driver/src/ui.tsx': 10,
  'apps/driver/src/UpdateBar.tsx': 2,
}

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.tsx?$/.test(entry)) yield full
  }
}

const over = []
const stale = []

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = relative(ROOT, file).split('\\').join('/')
    // Blank block comments so prose naming a colour — this file's own docstrings, or a note
    // explaining why something was migrated — is not counted as a violation.
    const stripped = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    const code = stripped
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    const count = (code.match(RAW) ?? []).length
    const budget = BASELINE[rel] ?? 0
    if (count > budget) over.push(`${rel}  ${count} raw colours, budget ${budget}`)
    else if (count < budget) stale.push(`${rel}  now ${count}, budget still ${budget}`)
  }
}

if (over.length) {
  console.error(
    `design-token check FAILED (${over.length}) — colour is a role: use surface-/ink-/line-/success-/warning-/danger-/info-* instead of a palette step:\n` +
      over.map((f) => `  ✗ ${f}`).join('\n'),
  )
  process.exit(1)
}
if (stale.length) {
  console.error(
    `design-token check FAILED — these files improved; lower their budget in scripts/check-design-tokens.mjs so the ratchet holds:\n` +
      stale.map((f) => `  ↓ ${f}`).join('\n'),
  )
  process.exit(1)
}
console.log('design-token check passed: no new raw palette colours.')
