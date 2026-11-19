import { describe, expect, it, vi } from 'vitest'
import type { Pool } from '../src/pool.ts'
import { PgLedgerRepo } from '../src/repos.ts'

describe('PostgreSQL exact ledger source batch lookup', () => {
  it('uses one parameterized snapshot and deduplicates source IDs',async () => {
    const query=vi.fn().mockResolvedValue({rows:[]}),repo=new PgLedgerRepo({query} as unknown as Pool)
    expect(await repo.findEntriesByIds([4,2,4])).toEqual([])
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]![0]).toContain('je.id = ANY($1::bigint[])')
    expect(query.mock.calls[0]![0]).toContain('GROUP BY je.id')
    expect(query.mock.calls[0]![0]).toContain('ORDER BY je.id')
    expect(query.mock.calls[0]![1]).toEqual([[4,2]])
    expect(await repo.findEntriesByIds([])).toEqual([])
    await expect(repo.findEntriesByIds([-1])).rejects.toThrow('positive safe integers')
    await expect(repo.findEntriesByIds([1.5])).rejects.toThrow('positive safe integers')
    expect(query).toHaveBeenCalledTimes(1)
  })
})
