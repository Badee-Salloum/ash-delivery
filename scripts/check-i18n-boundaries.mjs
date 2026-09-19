#!/usr/bin/env node
/**
 * CI guard for copy which reaches a person without going through the central catalogue.
 *
 * This is deliberately a ratchet, not a claim that every historic screen has already been
 * migrated. It blocks new direct text at the feedback and visible-JSX boundaries while a
 * small, exact legacy baseline records the remaining debt. A screen that removes a legacy
 * literal must lower the matching baseline entry; a screen that adds one fails the check.
 *
 * `node scripts/check-i18n-boundaries.mjs --report` prints the current inventory. It is for
 * migration work, not a bypass: additions still need a catalogue key (or an explicitly
 * reviewed, documented exceptional baseline change).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_ROOTS = ['apps/admin/src', 'apps/driver/src'].map((path) => join(ROOT, path))
const REPORT_ONLY = process.argv.includes('--report')

/**
 * This baseline is intentionally keyed by file, boundary, and exact visible value, with an
 * expected count. It is not a directory-wide escape hatch. Exact-count matching means a new
 * literal (including a duplicate) or a completed migration both make CI ask for a conscious
 * review of the baseline.
 *
 * Keep an entry only while the corresponding legacy copy remains. Do not add new product copy
 * here: add it to packages/client/src/i18n/{ar,en}.ts and pass the translated value instead.
 */
function legacy(file, rule, value, count = 1) {
  return [[file, rule, JSON.stringify(value)].join('|'), count]
}

const LEGACY_BASELINE = new Map([
  // Recovery boundaries deliberately have no dependency on an AppProvider which may be what failed.
  legacy('apps/admin/src/ErrorBoundary.tsx', 'jsx:text', 'Something went wrong rendering this screen. Nothing was saved and no data was changed.'),
  legacy('apps/admin/src/ErrorBoundary.tsx', 'jsx:text', 'إعادة التحميل · Reload'),
  legacy('apps/admin/src/ErrorBoundary.tsx', 'jsx:text', 'تعذّر عرض هذه الشاشة. لم يُحفظ أي تغيير ولم تتأثر أي بيانات. أعد تحميل الصفحة، وإذا تكرر الخطأ أرسل النص التالي إلى الدعم.'),
  legacy('apps/admin/src/ErrorBoundary.tsx', 'jsx:text', 'حدث خطأ في العرض'),
  legacy('apps/driver/src/ErrorBoundary.tsx', 'jsx:text', 'إعادة التحميل من جديد'),
  legacy('apps/driver/src/ErrorBoundary.tsx', 'jsx:text', 'تعذّر فتح التطبيق'),
  legacy('apps/driver/src/ErrorBoundary.tsx', 'jsx:text', 'حدث خطأ أثناء العرض. لم تتأثر أي بيانات ولم يُفقد أي شيء رفعته. اضغط الزر بالأسفل لإعادة تحميل نسخة نظيفة، وإذا تكرر الخطأ أرسل النص التالي إلى مدير الفرع.'),

  // Existing technical symbols and units still need catalogue migration in their owning screens.
  legacy('apps/admin/src/screens/Approval.tsx', 'jsx:text', 'OCR', 2),
  legacy('apps/admin/src/screens/Audit.tsx', 'attribute:placeholder', 'users'),
  legacy('apps/admin/src/screens/Fleet.tsx', 'jsx:text', 'Ah', 3),
  legacy('apps/admin/src/screens/Fleet.tsx', 'jsx:text', 'km'),
  legacy('apps/admin/src/screens/fleet/AddBike.tsx', 'jsx:text', 'Ah'),
  legacy('apps/admin/src/screens/fleet/BikeBoard.tsx', 'jsx:text', 'Ah'),
  legacy('apps/admin/src/screens/fleet/BikeCard.tsx', 'jsx:text', 'Ah'),
  legacy('apps/admin/src/screens/GpsLive.tsx', 'jsx:text', 'm'),
  legacy('apps/admin/src/screens/Treasury.tsx', 'jsx:text', '· C'),
  legacy('apps/admin/src/screens/Treasury.tsx', 'jsx:text', 'D'),
  legacy('apps/driver/src/screens/BatterySwap.tsx', 'jsx:text', 'Ah', 2),
  legacy('apps/driver/src/ui.tsx', 'attribute:aria-label', 'ASH Delivery'),
])

const FEEDBACK_METHODS = new Set(['alert', 'confirm', 'prompt'])
const TOAST_METHODS = new Set(['success', 'error', 'info', 'warning'])
const VISIBLE_ATTRIBUTES = new Set([
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'alt',
  'description',
  'emptyMessage',
  'errorMessage',
  'hint',
  'label',
  'placeholder',
  'subtitle',
  'title',
])

function walk(directory) {
  const entries = readdirSync(directory)
  return entries.flatMap((entry) => {
    const file = join(directory, entry)
    if (statSync(file).isDirectory()) return walk(file)
    // Fixture prose belongs to tests, not production catalogue enforcement.
    return /\.(?:ts|tsx)$/.test(entry) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry) ? [file] : []
  })
}

function literalValue(node) {
  // A cast does not turn product copy into data. Follow the harmless TypeScript wrappers so
  // `toast.error('…' as string)` cannot evade the feedback boundary.
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function visibleText(value) {
  // JSX whitespace is layout, symbols are data/control affordances, and IDs/format strings are
  // not prose. A letter in any language is a conservative signal that this needs translation.
  return /[\p{L}\p{M}]/u.test(value.trim())
}

function feedbackBoundary(expression) {
  if (ts.isIdentifier(expression)) return FEEDBACK_METHODS.has(expression.text) ? expression.text : null
  if (!ts.isPropertyAccessExpression(expression)) return null

  const owner = expression.expression
  const method = expression.name.text
  if (ts.isIdentifier(owner) && owner.text === 'window' && FEEDBACK_METHODS.has(method)) return 'window.' + method
  if (ts.isIdentifier(owner) && owner.text === 'toast' && TOAST_METHODS.has(method)) return 'toast.' + method
  return null
}

function jsxAttributeLiteral(attribute) {
  if (!VISIBLE_ATTRIBUTES.has(attribute.name.text) || !attribute.initializer) return null
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) return null
  return literalValue(attribute.initializer.expression)
}

function jsxTextLiteral(node) {
  if (ts.isJsxText(node)) return node.getText().replace(/\s+/g, ' ').trim()
  if (!ts.isJsxExpression(node) || !node.expression) return null
  return literalValue(node.expression)
}

function keyFor(violation) {
  return [violation.file, violation.rule, JSON.stringify(violation.value)].join('|')
}

function makeViolation(source, file, node, rule, value) {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source))
  return {
    file: relative(ROOT, file).split('\\').join('/'),
    rule,
    value,
    line: point.line + 1,
    column: point.character + 1,
  }
}

const violations = []
for (const file of SOURCE_ROOTS.flatMap(walk)) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const boundary = feedbackBoundary(node.expression)
      const firstArgument = node.arguments[0]
      const value = firstArgument ? literalValue(firstArgument) : null
      if (boundary && value !== null && visibleText(value)) {
        violations.push(makeViolation(source, file, firstArgument, `feedback:${boundary}`, value))
      }
    }

    if (ts.isJsxAttribute(node)) {
      const value = jsxAttributeLiteral(node)
      if (value !== null && visibleText(value)) {
        violations.push(makeViolation(source, file, node, `attribute:${node.name.text}`, value))
      }
    }

    // An expression used as an attribute value is handled by the attribute rule above; a child
    // expression is visible text and belongs to the JSX-text rule.
    if (ts.isJsxText(node) || (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent))) {
      const value = jsxTextLiteral(node)
      if (value !== null && visibleText(value)) {
        violations.push(makeViolation(source, file, node, 'jsx:text', value))
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
}

const actual = new Map()
for (const violation of violations) {
  const key = keyFor(violation)
  const group = actual.get(key) ?? { ...violation, count: 0 }
  group.count += 1
  actual.set(key, group)
}

if (REPORT_ONLY) {
  if (!actual.size) {
    console.log('No direct visible literals found.')
  } else {
    console.log('Direct visible literal inventory (file | boundary | exact value | count):')
    for (const group of [...actual.values()].sort((a, b) => keyFor(a).localeCompare(keyFor(b)))) {
      console.log(`${group.file} | ${group.rule} | ${JSON.stringify(group.value)} | ${group.count}`)
    }
  }
  process.exit(0)
}

const unexpected = []
const stale = []
for (const [key, group] of actual) {
  const allowed = LEGACY_BASELINE.get(key) ?? 0
  if (group.count > allowed) unexpected.push({ ...group, allowed })
}
for (const [key, allowed] of LEGACY_BASELINE) {
  const count = actual.get(key)?.count ?? 0
  if (count < allowed) stale.push({ key, allowed, count })
}

if (unexpected.length || stale.length) {
  console.error('i18n boundary check FAILED: visible copy must use the central catalogue.')
  for (const group of unexpected) {
    console.error(
      `  NEW  ${group.file}:${group.line}:${group.column} [${group.rule}] ${JSON.stringify(group.value)} ` +
        `(found ${group.count}; legacy allowance ${group.allowed})`,
    )
  }
  for (const group of stale) {
    console.error(`  LOWER ${group.key} (found ${group.count}; legacy allowance ${group.allowed})`)
  }
  console.error('Move new copy to packages/client/src/i18n/{ar,en}.ts. Run with --report when reducing legacy debt.')
  process.exit(1)
}

console.log(
  `i18n boundary check passed: ${SOURCE_ROOTS.length} UI roots have no unreviewed direct visible literals ` +
    '(legacy baseline is an exact-count ratchet).',
)
