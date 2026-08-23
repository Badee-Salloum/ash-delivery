import type {
  FinancialTransactionDeps,
  FinancialUnitOfWork,
  FinancialUnitOfWorkInput,
} from '@ash/contracts'
import { bindPoolToTransaction, type Pool, withTransaction } from './pool.ts'
import { PgLedgerRepo, PgOfficeCapitalTargetRepo, PgRestorationRepo } from './repos.ts'
import { PgCashCountRepo, PgExpenseRepo } from './repos-shift.ts'
import { PgReceivableEventRepo } from './repos-receivable.ts'

const transactionDeps = (pool: Pool): FinancialTransactionDeps => ({
  ledger: new PgLedgerRepo(pool),
  expenses: new PgExpenseRepo(pool),
  receivableEvents: new PgReceivableEventRepo(pool),
  cashCounts: new PgCashCountRepo(pool),
  capitalTargets: new PgOfficeCapitalTargetRepo(pool),
  restorations: new PgRestorationRepo(pool),
})

/**
 * Generic atomic boundary for commands that write both a business record and the ledger.
 *
 * The advisory lock serializes concurrent lost-response retries before either callback checks its
 * client key. It is transaction-scoped, so a failed callback cannot strand a lock in the pool.
 */
export class PgFinancialUnitOfWork implements FinancialUnitOfWork {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async run<T>(
    input: FinancialUnitOfWorkInput,
    work: (deps: FinancialTransactionDeps) => Promise<T>,
  ): Promise<T> {
    const ctx = { actorId: input.actorId, requestId: input.requestId ?? null }
    return withTransaction(this.pool, ctx, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `ash:financial:${input.lockKey}`,
      ])
      const boundPool = bindPoolToTransaction(this.pool, client, ctx)
      return work(transactionDeps(boundPool))
    })
  }
}
