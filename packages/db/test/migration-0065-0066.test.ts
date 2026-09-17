import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COMPANY_LEDGER_EVENTS } from '@ash/domain'

const migrationDir = new URL('../migrations/', import.meta.url)
const read = (file: string): string => readFileSync(new URL(file, migrationDir), 'utf8')

const ENUMS = '0065_company_ledger_enum_values.sql'
const enums = read(ENUMS)

const COMPANY_FUND_TYPES = [
  'company_cash',
  'depreciation_reserve',
  'company_fx_position',
  'branch_clearing',
  'company_payable',
  'company_receivable',
  'fixed_asset',
  'company_expense',
  'company_income',
  'company_equity',
] as const

/**
 * «صندوق الشركة» becomes its own ledger (finance redesign, phase C1).
 *
 * The static half. The behaviour — per-currency balance, the partition, the USD rate rule and the
 * pocket guard — is proven against a real PostgreSQL in `company-ledger-postgres.test.ts`.
 */
describe('0065 — enum values, and nothing else', () => {
  it('follows 0064', () => {
    // Asserts the ORDER, never the tip, so a later migration does not fail a test about this one.
    const files = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort()
    expect(files.indexOf(ENUMS)).toBe(files.indexOf('0064_company_fund_permission.sql') + 1)
  })

  it('adds the ten company fund types', () => {
    for (const value of COMPANY_FUND_TYPES) {
      expect(enums).toContain(`ALTER TYPE fund_type ADD VALUE IF NOT EXISTS '${value}';`)
    }
  })

  it('adds exactly the company events the domain declares', () => {
    const added = [...enums.matchAll(/ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS '(\w+)';/g)].map((m) => m[1])
    expect(added).toEqual([...COMPANY_LEDGER_EVENTS])
  })

  it('contains no statement other than ALTER TYPE', () => {
    // A Postgres enum value must be committed before a later migration uses it, and the migrator
    // wraps each file in exactly one transaction — the reason 0023, 0036, 0046 and 0055 are alone.
    const statements = enums
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('--'))
    expect(statements.length).toBe(COMPANY_FUND_TYPES.length + COMPANY_LEDGER_EVENTS.length)
    expect(statements.every((line) => line.startsWith('ALTER TYPE '))).toBe(true)
  })

  it('leaves company_box alone', () => {
    expect(enums).not.toMatch(/ADD VALUE IF NOT EXISTS 'company_box'/)
  })
})
