/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/repos-shift.ts', import.meta.url), 'utf8')
const start = source.indexOf('async countOpenActorsForBranch')
const end = source.indexOf('async listLiveForDriver', start)
const query = source.slice(start, end).replace(/\s+/g, ' ')

describe('PostgreSQL working-now count query', () => {
  it('counts distinct open actors in one branch without a business-date boundary', () => {
    expect(start).toBeGreaterThan(-1)
    expect(query).toMatch(/COUNT\(DISTINCT driver_id\)::int AS drivers/i)
    expect(query).toMatch(/COUNT\(DISTINCT vehicle_id\)::int AS vehicles/i)
    expect(query).toMatch(/WHERE branch_id = \$1 AND state = 'open'/i)
    expect(query).not.toMatch(/business_date/i)
  })
})
