import type {
  FinancialTransactionDeps,
  FinancialUnitOfWork,
  FinancialUnitOfWorkInput,
} from '@ash/contracts'
import { bindPoolToTransaction, type Pool, withTransaction } from './pool.ts'
import { PgLedgerRepo, PgOfficeCapitalTargetRepo, PgRestorationRepo } from './repos.ts'
import { PgAdvanceRepo, PgCashCountRepo, PgExpenseRepo, PgIncomeRepo, PgDirectoryRepo } from './repos-shift.ts'
import { PgReceivableEventRepo } from './repos-receivable.ts'
import { PgCompanyLedgerRepo, PgFinancialLocks, PgCompanyLedgerSource } from './repos-company.ts'
import { PgRecurringExpenseRepo } from './repos-recurring.ts'
import { PgCompanyFinanceRepo } from './repos-company-finance.ts'
import { PgExistingAssetRepo } from './repos-existing-assets.ts'
import { PgCompanyRestorationReviewRepo } from './repos-company-restoration-review.ts'
import { PgCompanyMovementReviewRepo } from './repos-company-movement-review.ts'
import { PgCompanyHistoricalDraftRepo } from './repos-company-historical-draft.ts'

const transactionDeps = (pool: Pool): FinancialTransactionDeps => ({
  directory: new PgDirectoryRepo(pool),
  companyLedgerSource: new PgCompanyLedgerSource(pool),
  ledger: new PgLedgerRepo(pool),
  expenses: new PgExpenseRepo(pool),
  recurringExpenses: new PgRecurringExpenseRepo(pool),
  incomes: new PgIncomeRepo(pool),
  advances: new PgAdvanceRepo(pool),
  receivableEvents: new PgReceivableEventRepo(pool),
  cashCounts: new PgCashCountRepo(pool),
  capitalTargets: new PgOfficeCapitalTargetRepo(pool),
  restorations: new PgRestorationRepo(pool),
  companyLedger: new PgCompanyLedgerRepo(pool),
  companyFinance: new PgCompanyFinanceRepo(pool),
  existingAssets: new PgExistingAssetRepo(pool),
  companyRestorationReviews: new PgCompanyRestorationReviewRepo(pool),
  companyMovementReview: new PgCompanyMovementReviewRepo(pool),
  companyHistoricalDrafts: new PgCompanyHistoricalDraftRepo(pool),
  locks: new PgFinancialLocks(pool),
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
    const ctx = { actorId: input.actorId, requestId: input.requestId ?? null, readOnlySnapshot: input.mode === 'read_snapshot' }
    return withTransaction(this.pool, ctx, async (client) => {
      // MVCC gives readers one committed snapshot without queuing behind every other reader
      // or taking a command's exclusive retry lock. Writer serialization is unchanged.
      if (!ctx.readOnlySnapshot) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `ash:financial:${input.lockKey}`,
        ])
      }
      const boundPool = bindPoolToTransaction(this.pool, client, ctx)
      return work(transactionDeps(boundPool))
    })
  }
}
