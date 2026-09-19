#!/usr/bin/env node
/**
 * CI guard: Arabic and English catalogs must have exactly the same nested shape.
 *
 * TypeScript catches most mismatches through Catalog, but this parser deliberately checks the
 * source objects too. That makes a missing nested key visible in CI even if a future catalog is
 * temporarily widened, cast, or loaded before type checking.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const dir = fileURLToPath(new URL('../packages/client/src/i18n/', import.meta.url))

function unwrap(expression) {
  let current = expression
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function propertyName(property, source) {
  const name = property.name
  if (!name) throw new Error('Unnamed catalog property in ' + source.fileName)
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) return name.expression.text
  throw new Error('Dynamic catalog key in ' + source.fileName + ': ' + name.getText(source))
}

function shapeOf(expression, source, path = '') {
  const node = unwrap(expression)

  if (ts.isObjectLiteralExpression(node)) {
    const children = new Map()
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        throw new Error('Spread is not allowed in the catalog at ' + (path || '<root>'))
      }
      if (!ts.isPropertyAssignment(property)) {
        throw new Error('Unsupported catalog property at ' + (path || '<root>') + ': ' + property.getText(source))
      }
      const key = propertyName(property, source)
      const childPath = path ? path + '.' + key : key
      if (children.has(key)) throw new Error('Duplicate catalog key: ' + childPath)
      children.set(key, shapeOf(property.initializer, source, childPath))
    }
    return { kind: 'object', children }
  }

  if (ts.isArrayLiteralExpression(node)) {
    return {
      kind: 'array',
      children: node.elements.map((element, index) => {
        if (ts.isSpreadElement(element)) {
          throw new Error('Spread is not allowed in the catalog at ' + path + '[' + index + ']')
        }
        return shapeOf(element, source, path + '[' + index + ']')
      }),
    }
  }

  return { kind: 'leaf' }
}

function readCatalog(fileName, variableName) {
  const source = ts.createSourceFile(fileName, readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === variableName && declaration.initializer) {
        return shapeOf(declaration.initializer, source)
      }
    }
  }
  throw new Error('Could not find exported catalog ' + variableName + ' in ' + fileName)
}

function compare(arShape, enShape, path, errors) {
  if (arShape.kind !== enShape.kind) {
    errors.push(path + ': ar is ' + arShape.kind + ', en is ' + enShape.kind)
    return
  }

  if (arShape.kind === 'leaf') return

  if (arShape.kind === 'array') {
    if (arShape.children.length !== enShape.children.length) {
      errors.push(path + ': ar has ' + arShape.children.length + ' items, en has ' + enShape.children.length)
    }
    const length = Math.min(arShape.children.length, enShape.children.length)
    for (let index = 0; index < length; index++) {
      compare(arShape.children[index], enShape.children[index], path + '[' + index + ']', errors)
    }
    return
  }

  const arKeys = [...arShape.children.keys()]
  const enKeys = [...enShape.children.keys()]
  for (const key of arKeys) {
    const childPath = path ? path + '.' + key : key
    const enChild = enShape.children.get(key)
    if (!enChild) {
      errors.push(childPath + ': missing from en')
      continue
    }
    compare(arShape.children.get(key), enChild, childPath, errors)
  }
  for (const key of enKeys) {
    if (!arShape.children.has(key)) {
      errors.push((path ? path + '.' : '') + key + ': extra in en')
    }
  }
}

function countLeaves(shape) {
  if (shape.kind === 'leaf') return 1
  const children = shape.kind === 'array' ? shape.children : [...shape.children.values()]
  return children.reduce((total, child) => total + countLeaves(child), 0)
}

try {
  const ar = readCatalog(dir + 'ar.ts', 'ar')
  const en = readCatalog(dir + 'en.ts', 'en')
  const errors = []
  compare(ar, en, '', errors)

  if (errors.length) {
    console.error('i18n parity FAILED:')
    for (const error of errors) console.error('  × ' + error)
    process.exit(1)
  }

  console.log('i18n parity passed: ' + countLeaves(ar) + ' localized leaves match recursively.')
} catch (error) {
  console.error('i18n parity FAILED: ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
