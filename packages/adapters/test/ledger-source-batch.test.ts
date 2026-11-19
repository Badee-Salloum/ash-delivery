import { describe, expect, it } from 'vitest'
import { minor } from '@ash/domain'
import { MemoryLedgerRepo } from '../src/memory/index.ts'

describe('memory exact ledger source batch lookup', () => {
  it('returns distinct existing IDs in ledger order with immutable copied evidence', async () => {
    const repo = new MemoryLedgerRepo(() => 123)
    const entries = await repo.post('branch',[1,2].map(n=>({eventType:'manual' as const,occurrenceKey:`source-${n}`,lines:[
      {fund:{kind:'office_cash' as const},side:'D' as const,amount:minor(BigInt(n))},
      {fund:{kind:'cost_center' as const,costCenterId:'source'},side:'C' as const,amount:minor(BigInt(n))},
    ]})),{shiftId:null,businessDate:'2026-10-04',postingDate:'2026-10-04',weekStartDate:'2026-10-04',fxDayId:1,sypMinorPerUsd:null,createdBy:'manager'})
    const result=await repo.findEntriesByIds([entries[1]!.id,999999,entries[0]!.id,entries[1]!.id])
    expect(result.map(row=>row.id)).toEqual(entries.map(row=>row.id))
    result[0]!.lines[0]!.amount=minor(999n)
    expect((await repo.findEntryById(entries[0]!.id))!.lines[0]!.amount).toBe(1n)
    expect(await repo.findEntriesByIds([])).toEqual([])
    await expect(repo.findEntriesByIds([0])).rejects.toThrow('positive safe integers')
    await expect(repo.findEntriesByIds([Number.MAX_SAFE_INTEGER+1])).rejects.toThrow('positive safe integers')
  })
})
