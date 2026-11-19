import { describe, expect, it } from 'vitest'
import type { CompanyHistoricalRestorationSettlement } from '@ash/contracts'
import { minor } from '@ash/domain'
import { MemoryCompanyLedgerRepo } from '../src/memory/company.ts'

const row = (id = '10000000-0000-4000-8000-000000000001'): CompanyHistoricalRestorationSettlement => ({
  id, companyBranchId: 'hq', sourceBranchId: 'branch', version: 1, cutoverWatermarkEntryId: 9,
  evidenceHash: 'a'.repeat(64), requestHash: 'b'.repeat(64), businessDate: '2026-10-04', reason: 'Verified original sources',
  groups: [{ restorationId: 1, businessDate: '2026-09-01', sourceReferences: ['HQ-SRC-1'],
    branchSourceEntries: [{ sourceEntryId: 1, direction: 'to_company', amount: minor(1000n) }],
    branchNet: minor(1000n), companyNet: minor(999n), variance: minor(1n) }],
  legs: [{ restorationId: 1, sourceReference: 'HQ-SRC-1', historicalJournalEntryId: 2,
    direction: 'to_company', amount: minor(999n), journalEntryId: 10 }], createdBy: 'manager', createdAtMs: 123,
})

describe('memory historical restoration settlement repository', () => {
  it('round-trips exact BigInt evidence without exposing mutable stored snapshots', async () => {
    const repo = new MemoryCompanyLedgerRepo(() => 9), input = row()
    input.legs[0]!.amount = minor(90071992547409931n)
    await repo.createHistoricalSettlement(input, 0)
    input.reason = 'caller changed'
    const stored = (await repo.findHistoricalSettlement(input.id.toUpperCase()))!
    expect(stored.reason).toBe('Verified original sources')
    expect(stored.legs[0]!.amount).toBe(90071992547409931n)
    stored.legs[0]!.amount = minor(1n)
    expect((await repo.findHistoricalSettlementBySource(2))!.legs[0]!.amount).toBe(90071992547409931n)
    expect(await repo.listHistoricalSettlements('other')).toEqual([])
    expect(await repo.listHistoricalSettlements('hq', 'other')).toEqual([])
    expect(await repo.listHistoricalSettlements('hq', 'branch')).toHaveLength(1)
  })
  it('rejects duplicate keys, HQ sources, restoration groups and stale branch versions', async () => {
    const repo = new MemoryCompanyLedgerRepo(() => 9), input = row()
    await repo.createHistoricalSettlement(input, 0)
    await expect(repo.createHistoricalSettlement(input, 0)).rejects.toMatchObject({ code: 'DUPLICATE_HISTORICAL_SETTLEMENT' })
    const next = row('10000000-0000-4000-8000-000000000002')
    next.version = 2
    await expect(repo.createHistoricalSettlement(next, 1)).rejects.toMatchObject({ code: 'DUPLICATE_HISTORICAL_SETTLEMENT' })
    next.groups[0]!.restorationId = 2
    next.legs[0] = { ...next.legs[0]!, restorationId: 2, sourceReference: 'HQ-SRC-2', historicalJournalEntryId: 3, journalEntryId: 11 }
    await expect(repo.createHistoricalSettlement(next, 0)).rejects.toMatchObject({ code: 'HISTORICAL_SETTLEMENT_VERSION_CONFLICT' })
    await repo.createHistoricalSettlement(next, 1)
    expect((await repo.listHistoricalSettlements('hq')).map(batch => batch.version)).toEqual([1, 2])
  })
  it('snapshot rollback restores all settlement uniqueness/CAS state', async () => {
    const repo = new MemoryCompanyLedgerRepo(() => 9), snapshot = repo.snapshot(), input = row()
    await repo.createHistoricalSettlement(input, 0)
    repo.restore(snapshot)
    expect(await repo.findHistoricalSettlement(input.id)).toBeNull()
    expect(await repo.findHistoricalSettlementBySource(2)).toBeNull()
    await repo.createHistoricalSettlement(input, 0)
    expect(await repo.listHistoricalSettlements('hq')).toHaveLength(1)
  })
})
