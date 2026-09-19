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
const COLOUR_UTILITY =
  '(?:text|bg|border|ring|divide|from|via|to|fill|stroke|outline|placeholder|accent|caret|decoration|shadow)'
const PALETTE =
  '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)'
const VARIANT = '(?:(?:[a-z-]+|\\[[^\\]]+\\]):)*'

const RAW_PALETTE = new RegExp(
  "(?:^|[\\s\\\"'\\x60{(:])" +
    VARIANT +
    '!?' +
    COLOUR_UTILITY +
    '-' +
    PALETTE +
    '-(?:50|\\d{2,3})\\b',
  'g',
)

/*
 * A literal arbitrary colour is just a palette pick written differently. Allow an --ash-* custom
 * property because it is a token; reject literal hex and CSS colour functions everywhere else.
 * The existing bg-[var(--ash-bg,#eef1f8)] alias remains valid until that component is migrated.
 */
const RAW_ARBITRARY_COLOUR = new RegExp(
  "(?:^|[\\s\\\"'\\x60{(:])" +
    VARIANT +
    '!?' +
    COLOUR_UTILITY +
    '-\\[(?!var\\(--ash-)[^\\]]*(?:#[0-9a-fA-F]{3,8}\\b|(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\\()[^\\]]*\\]',
  'g',
)

/* The same policy for JSX inline styles and SVG attributes. */
const RAW_INLINE_COLOUR =
  /(?:^|[,{]\s*)(?:color|background(?:Color)?|border(?:Color)?|outlineColor|fill(?:Color)?|stroke(?:Color)?|stopColor)\s*:\s*['"\x60]?\s*(?:#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\()/g
const RAW_SVG_COLOUR =
  /(?:fill|stroke|color)\s*=\s*['"](?:#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\()/g

/**
 * The debt, per file, as it stood when the token layer landed. These numbers may only DECREASE.
 * A file absent from this map is held at zero.
 */
const BASELINE = {
  'apps/admin/src/AdminApp.tsx': 12,
  'apps/admin/src/ErrorBoundary.tsx': 7,
  'apps/admin/src/feedback.tsx': 0,
  'apps/admin/src/NotificationBell.tsx': 10,
  'apps/admin/src/screens/Accounts.tsx': 1,
  'apps/admin/src/screens/Approval.tsx': 272,
  'apps/admin/src/screens/Audit.tsx': 1,
  'apps/admin/src/screens/CheckIn.tsx': 9,
  'apps/admin/src/screens/Dashboard.tsx': 0,
  'apps/admin/src/screens/Expenses.tsx': 0,
  'apps/admin/src/screens/fleet/AddBike.tsx': 9,
  'apps/admin/src/screens/fleet/BikeBoard.tsx': 3,
  'apps/admin/src/screens/fleet/BikeCard.tsx': 10,
  'apps/admin/src/screens/Fleet.tsx': 27,
  'apps/admin/src/screens/FleetConfig.tsx': 8,
  'apps/admin/src/screens/GpsLive.tsx': 5,
  'apps/admin/src/screens/LiveShifts.tsx': 24,
  'apps/admin/src/screens/Login.tsx': 9,
  'apps/admin/src/screens/Permissions.tsx': 4,
  'apps/admin/src/screens/PreapprovedShifts.tsx': 8,
  'apps/admin/src/screens/Queue.tsx': 3,
  'apps/admin/src/screens/Removals.tsx': 0,
  'apps/admin/src/screens/Settings.tsx': 15,
  'apps/admin/src/screens/Tiers.tsx': 8,
  'apps/admin/src/screens/Treasury.tsx': 0,
  'apps/admin/src/settlement-optional-reason.test.ts': 1,
  'apps/admin/src/ui.tsx': 0,
  'apps/driver/src/DriverApp.tsx': 5,
  'apps/driver/src/ErrorBoundary.tsx': 6,
  'apps/driver/src/screens/BatteryPanel.tsx': 16,
  'apps/driver/src/screens/BatterySwap.tsx': 2,
  'apps/driver/src/screens/CloudReadStatus.tsx': 5,
  'apps/driver/src/screens/Login.tsx': 0,
  'apps/driver/src/screens/OrderEntry.tsx': 62,
  'apps/driver/src/screens/PageGrid.tsx': 3,
  'apps/driver/src/screens/PhotoSlot.tsx': 38,
  'apps/driver/src/screens/ReadingLock.tsx': 6,
  'apps/driver/src/screens/ReadingSource.tsx': 1,
  'apps/driver/src/screens/Shift.tsx': 55,
  'apps/driver/src/ui.tsx': 0,
  'apps/driver/src/UpdateBar.tsx': 1,
}

const ZERO_LITERAL_DEBT = Object.freeze({ arbitrary: 0, inline: 0, svg: 0 })

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

function countMatches(value, pattern) {
  pattern.lastIndex = 0
  return [...value.matchAll(pattern)].length
}

function colourDebt(code) {
  const palette = countMatches(code, RAW_PALETTE)
  const arbitrary = countMatches(code, RAW_ARBITRARY_COLOUR)
  const inline = countMatches(code, RAW_INLINE_COLOUR)
  const svg = countMatches(code, RAW_SVG_COLOUR)
  return {
    total: palette + arbitrary + inline + svg,
    palette,
    arbitrary,
    inline,
    svg,
  }
}

function debtSummary(debt) {
  return [
    debt.palette ? String(debt.palette) + ' palette' : null,
    debt.arbitrary ? String(debt.arbitrary) + ' arbitrary' : null,
    debt.inline ? String(debt.inline) + ' inline' : null,
    debt.svg ? String(debt.svg) + ' SVG' : null,
  ]
    .filter(Boolean)
    .join(', ')
}

function tokenBlock(source, selector) {
  const start = source.indexOf(selector + ' {')
  if (start < 0) throw new Error('Could not find ' + selector + ' in packages/theme/tokens.css')
  const end = source.indexOf('\n}', start)
  if (end < 0) throw new Error('Could not find the end of ' + selector + ' in packages/theme/tokens.css')

  const tokens = new Map()
  for (const match of source.slice(start, end).matchAll(/^\s*(--ash-[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/gm)) {
    tokens.set(match[1], match[2])
  }
  return tokens
}

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

function contrastFailures() {
  const tokenSource = readFileSync(join(ROOT, 'packages/theme/tokens.css'), 'utf8')
  const themes = [
    ['light', tokenBlock(tokenSource, ':root')],
    ['dark', tokenBlock(tokenSource, ":root[data-theme='dark']")],
  ]
  const pairs = [
    ['on-brand / brand', '--ash-on-brand', '--ash-brand', 4.5],
    ['on-brand / strong brand', '--ash-on-brand', '--ash-brand-strong', 4.5],
    ['on-success / success solid', '--ash-on-success', '--ash-success-solid', 4.5],
    ['on-success / success solid hover', '--ash-on-success', '--ash-success-solid-hover', 4.5],
    ['on-warning / warning solid', '--ash-on-warning', '--ash-warning-solid', 4.5],
    ['on-warning / warning solid hover', '--ash-on-warning', '--ash-warning-solid-hover', 4.5],
    ['on-danger / danger solid', '--ash-on-danger', '--ash-danger-solid', 4.5],
    ['on-danger / danger solid hover', '--ash-on-danger', '--ash-danger-solid-hover', 4.5],
    ['on-info / info solid', '--ash-on-info', '--ash-info-solid', 4.5],
    ['on-info / info solid hover', '--ash-on-info', '--ash-info-solid-hover', 4.5],
    ['on-offline / offline solid', '--ash-on-offline', '--ash-offline-solid', 4.5],
    ['on-offline / offline solid hover', '--ash-on-offline', '--ash-offline-solid-hover', 4.5],
    ['on-solid / brand', '--ash-on-solid', '--ash-brand', 4.5],
    ['on-solid / strong brand', '--ash-on-solid', '--ash-brand-strong', 4.5],
    ['on-solid / success solid', '--ash-on-solid', '--ash-success-solid', 4.5],
    ['on-solid / success solid hover', '--ash-on-solid', '--ash-success-solid-hover', 4.5],
    ['on-solid / warning solid', '--ash-on-solid', '--ash-warning-solid', 4.5],
    ['on-solid / warning solid hover', '--ash-on-solid', '--ash-warning-solid-hover', 4.5],
    ['on-solid / danger solid', '--ash-on-solid', '--ash-danger-solid', 4.5],
    ['on-solid / danger solid hover', '--ash-on-solid', '--ash-danger-solid-hover', 4.5],
    ['on-solid / info solid', '--ash-on-solid', '--ash-info-solid', 4.5],
    ['on-solid / info solid hover', '--ash-on-solid', '--ash-info-solid-hover', 4.5],
    ['on-solid / offline solid', '--ash-on-solid', '--ash-offline-solid', 4.5],
    ['on-solid / offline solid hover', '--ash-on-solid', '--ash-offline-solid-hover', 4.5],
    ['success ink / surface', '--ash-success-ink', '--ash-success-surface', 4.5],
    ['warning ink / surface', '--ash-warning-ink', '--ash-warning-surface', 4.5],
    ['danger ink / surface', '--ash-danger-ink', '--ash-danger-surface', 4.5],
    ['info ink / surface', '--ash-info-ink', '--ash-info-surface', 4.5],
    ['offline ink / surface', '--ash-offline-ink', '--ash-offline-surface', 4.5],
    ['focus / card surface', '--ash-focus', '--ash-surface-card', 3],
    ['focus / page surface', '--ash-focus', '--ash-surface-page', 3],
    ['focus / raised surface', '--ash-focus', '--ash-surface-raised', 3],
  ]

  const failures = []
  for (const [themeName, tokens] of themes) {
    for (const [pairName, foregroundName, backgroundName, minimum] of pairs) {
      const foreground = tokens.get(foregroundName)
      const background = tokens.get(backgroundName)
      if (!foreground || !background) {
        failures.push(
          themeName + ' ' + pairName + ': missing ' + (!foreground ? foregroundName : backgroundName),
        )
        continue
      }
      const ratio = contrastRatio(foreground, background)
      if (ratio < minimum) {
        failures.push(themeName + ' ' + pairName + ': ' + ratio.toFixed(2) + ':1, needs ' + minimum + ':1')
      }
    }
  }
  return failures
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
    const debt = colourDebt(code)
    const paletteBudget = BASELINE[rel] ?? 0
    const literalBudget = ZERO_LITERAL_DEBT
    const hasNewDebt =
      debt.palette > paletteBudget ||
      debt.arbitrary > literalBudget.arbitrary ||
      debt.inline > literalBudget.inline ||
      debt.svg > literalBudget.svg
    const hasReducedDebt =
      debt.palette < paletteBudget ||
      debt.arbitrary < literalBudget.arbitrary ||
      debt.inline < literalBudget.inline ||
      debt.svg < literalBudget.svg

    if (hasNewDebt) {
      over.push(
        rel +
          '  ' +
          debt.total +
          ' raw colours (' +
          debtSummary(debt) +
          '), budgets palette ' +
          paletteBudget +
          ', arbitrary ' +
          literalBudget.arbitrary +
          ', inline ' +
          literalBudget.inline +
          ', SVG ' +
          literalBudget.svg,
      )
    } else if (hasReducedDebt) {
      stale.push(
        rel +
          '  now ' +
          debt.total +
          ' raw colours (' +
          debtSummary(debt) +
          '); lower the matching category budget',
      )
    }
  }
}

const contrast = contrastFailures()
if (contrast.length) {
  console.error(
    'design-token check FAILED — semantic foreground, status, and focus pairs must meet their contrast minimum:\\n' +
      contrast.map((failure) => '  × ' + failure).join('\\n'),
  )
  process.exit(1)
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
