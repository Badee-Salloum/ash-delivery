import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { PgExpenseRepo } from '../src/repos-shift.ts'
import { minor } from '@ash/domain'

describe('PostgreSQL expense-filter read query', () => {
  it('binds every filter and reads page/count/total from one statement', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: '2', total: '9007199254740993', earliest: '2026-06-01', expenses: [{
      id: '00000000-0000-4000-8000-000000000001', branch_id: '00000000-0000-4000-8000-000000000002', category_id: '00000000-0000-4000-8000-000000000003',
      cost_center_kind: 'vehicle', vehicle_id: '00000000-0000-4000-8000-000000000004', channel: 'office_wallet', amount: '9007199254740993', business_date: '2026-07-21', description: 'صيانة', receipt_media_id: 'm-1', journal_entry_id: 1, advance_id: null, created_by: 'u-1',
    }] }] })
    const repo = new PgExpenseRepo({ query } as unknown as Pool)
    const response = await repo.search('branch-1', { from: '2026-06-01', to: '2026-07-21', categoryId: 'category-1', costCenterKind: 'vehicle', vehicleId: 'vehicle-1', channel: 'office_wallet', query: "50%_\\' OR 1=1", receipt: 'with', minAmount: minor(1n), maxAmount: minor(9007199254740993n) }, { limit: 50, offset: 50 })
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0]!
    expect(sql).toContain('ORDER BY business_date DESC, created_at DESC, journal_entry_id DESC NULLS LAST, id DESC LIMIT')
    expect(sql).toContain('jsonb_agg(p ORDER BY p.business_date DESC, p.created_at DESC, p.journal_entry_id DESC NULLS LAST, p.id DESC)')
    expect(sql).toContain('WITH filtered AS'); expect(sql).toContain('COUNT(*)'); expect(sql).toContain('SUM(amount_minor)')
    expect(sql).toContain('e.receipt_media_id IS NOT NULL'); expect(sql).toContain('LIMIT $11 OFFSET $12')
    expect(sql).not.toContain("' OR 1=1")
    expect(values).toEqual(['branch-1', '2026-07-21', '2026-06-01', 'category-1', 'vehicle', 'vehicle-1', 'office_wallet', "%50\\%\\_\\\\' OR 1=1%", '1', '9007199254740993', 50, 50])
    expect(response.count).toBe(2); expect(response.total).toBe(9007199254740993n)
    expect(response.expenses[0]?.amount).toBe(9007199254740993n)
  })
  it('exports all filtered rows without LIMIT/OFFSET and keeps operating distinct from vehicle', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: '0', total: '0', earliest: null, expenses: [] }] })
    const repo = new PgExpenseRepo({ query } as unknown as Pool)
    const response = await repo.search('branch-1', { to: '2026-07-21', costCenterKind: 'operating', receipt: 'without' })
    const [sql, values] = query.mock.calls[0]!
    expect(sql).not.toContain('LIMIT'); expect(sql).not.toContain('OFFSET')
    expect(sql).toContain("e.cost_center_kind IN ('general', 'branch')")
    expect(values).toEqual(['branch-1', '2026-07-21'])
    expect(response).toEqual({ expenses: [], count: 0, total: 0n, earliestBusinessDate: null })
  })
  it('loads inactive category names only when the caller explicitly requests history', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'category-1', code: 'old', name_ar: 'تاريخية', active: false }] })
    const repo = new PgExpenseRepo({ query } as unknown as Pool)
    expect((await repo.listCategories(true))[0]?.active).toBe(false)
    expect(query.mock.calls[0]?.[1]).toEqual([true])
    await repo.listCategories()
    expect(query.mock.calls[1]?.[1]).toEqual([false])
  })
})
