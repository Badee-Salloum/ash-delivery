import { describe, expect, it, vi } from 'vitest'
import { minor } from '@ash/domain'
import type { Pool } from '../src/pool.ts'
import { PgRestorationRepo } from '../src/repos.ts'

describe('PgRestorationRepo evidence versions', () => {
  it('writes and reads a schema-v3 restoration with no invented cash-count id', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          branch_id: 'branch-1',
          business_date: '2026-08-31',
          cash_count_id: null,
          plan: { schemaVersion: 3, source: 'live_ledger' },
          net_to_company_minor: '1234',
          reason: 'ledger restoration',
          performed_by: 'manager-1',
        }],
        rowCount: 1,
      })
    const repo = new PgRestorationRepo({ query } as unknown as Pool)

    await repo.create({
      branchId: 'branch-1',
      businessDate: '2026-08-31',
      cashCountId: null,
      plan: { schemaVersion: 3, source: 'live_ledger' },
      netToCompany: minor(1234n),
      reason: 'ledger restoration',
      performedBy: 'manager-1',
      runNo: 1,
    })
    const restored = await repo.find('branch-1', '2026-08-31')

    expect(query.mock.calls[0]![1][2]).toBeNull()
    expect(restored).toMatchObject({
      cashCountId: null,
      plan: { schemaVersion: 3, source: 'live_ledger' },
      netToCompany: 1234n,
    })
  })

  it('still reads the historical schema-v2 bigint count identity as a string', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        branch_id: 'branch-1',
        business_date: '2026-08-30',
        cash_count_id: 42n,
        plan: { schemaVersion: 2 },
        net_to_company_minor: '0',
        reason: 'count restoration',
        performed_by: 'manager-1',
      }],
      rowCount: 1,
    })
    const repo = new PgRestorationRepo({ query } as unknown as Pool)

    await expect(repo.find('branch-1', '2026-08-30')).resolves.toMatchObject({
      cashCountId: '42',
      plan: { schemaVersion: 2 },
    })
  })
})
