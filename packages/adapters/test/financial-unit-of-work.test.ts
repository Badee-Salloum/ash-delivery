import { describe, expect, it } from 'vitest'
import type { ExpenseRecord } from '@ash/contracts'
import { expense as expensePosting, minor, postingsForCashCountReconciliation } from '@ash/domain'
import { createMemoryDeps } from '../src/memory/index.ts'

const BRANCH = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const EXPENSE = '33333333-3333-4333-8333-333333333333'

const record = (): ExpenseRecord => ({
  id: EXPENSE,
  branchId: BRANCH,
  categoryId: 'fuel',
  costCenterKind: 'general',
  vehicleId: null,
  amount: minor(25_000n),
  businessDate: '2026-08-23',
  description: 'Charging electricity',
  receiptMediaId: null,
  journalEntryId: null,
  createdBy: USER,
})

const meta = {
  shiftId: null,
  businessDate: '2026-08-23' as const,
  postingDate: '2026-08-23' as const,
  weekStartDate: '2026-08-23' as const,
  fxDayId: 1,
  createdBy: USER,
}

describe('in-memory financial unit of work', () => {
  it('preserves the nullable evidence discriminator and returns an immutable v3 snapshot copy', async () => {
    const deps = createMemoryDeps(Date.UTC(2026, 7, 31))
    const plan = {
      schemaVersion: 3,
      source: 'live_ledger',
      openingBalances: [
        { fundCode: 'office_cash', balance: '50000.00' },
        { fundCode: 'office_wallet', balance: '10000.00' },
      ],
    }
    await deps.restorations.create({
      branchId: BRANCH,
      businessDate: '2026-08-31',
      cashCountId: null,
      plan,
      netToCompany: minor(0n),
      reason: 'ledger-backed restoration',
      performedBy: USER,
    })

    const first = await deps.restorations.find(BRANCH, '2026-08-31')
    expect(first).toMatchObject({ cashCountId: null, plan })
    ;(first!.plan as { source: string }).source = 'mutated-copy'
    await expect(deps.restorations.find(BRANCH, '2026-08-31')).resolves.toMatchObject({ plan })
  })

  it('rolls back a journal when the expense row does not complete', async () => {
    const deps = createMemoryDeps(Date.UTC(2026, 7, 23))
    const failure = new Error('expense insert failed')

    await expect(
      deps.financialUnitOfWork.run({ lockKey: `expense:${EXPENSE}`, actorId: USER }, async (tx) => {
        const [entry] = await tx.ledger.post(
          BRANCH,
          [expensePosting(`general:${BRANCH}`, minor(25_000n), EXPENSE)],
          meta,
        )
        await tx.expenses.create({ ...record(), journalEntryId: entry!.id })
        throw failure
      }),
    ).rejects.toBe(failure)

    expect(deps.ledger.entries).toHaveLength(0)
    expect(deps.expenses.rows.size).toBe(0)
  })

  it('commits the linked row and journal together', async () => {
    const deps = createMemoryDeps(Date.UTC(2026, 7, 23))

    await deps.financialUnitOfWork.run({ lockKey: `expense:${EXPENSE}`, actorId: USER }, async (tx) => {
      const [entry] = await tx.ledger.post(
        BRANCH,
        [expensePosting(`general:${BRANCH}`, minor(25_000n), EXPENSE)],
        meta,
      )
      await tx.expenses.create({ ...record(), journalEntryId: entry!.id })
    })

    expect(deps.ledger.entries).toHaveLength(1)
    expect((await deps.expenses.get(EXPENSE))?.journalEntryId).toBe(deps.ledger.entries[0]!.id)
  })

  it('rolls back a restoration record and its reconciliation journal after a late failure', async () => {
    const deps = createMemoryDeps(Date.UTC(2026, 7, 23))
    const failure = new Error('restoration record failed late')
    const proof = 'a'.repeat(64)

    await expect(
      deps.financialUnitOfWork.run({ lockKey: `receivables:${BRANCH}`, actorId: USER }, async (tx) => {
        const [entry] = await tx.ledger.post(
          BRANCH,
          postingsForCashCountReconciliation({
            branchId: BRANCH,
            cashCountId: '42',
            proofSha256: proof,
            lines: [{ fundCode: 'office_cash', variance: minor(-10_000n), resolution: 'signed shortage' }],
          }),
          { ...meta, reason: 'daily restoration' },
        )
        await tx.restorations.create({
          branchId: BRANCH,
          businessDate: '2026-08-23',
          cashCountId: '42',
          plan: { proof, entryId: entry!.id },
          netToCompany: minor(0n),
          reason: 'daily restoration',
          performedBy: USER,
        })
        throw failure
      }),
    ).rejects.toBe(failure)

    expect(deps.ledger.entries).toHaveLength(0)
    expect(await deps.restorations.find(BRANCH, '2026-08-23')).toBeNull()
  })
})
