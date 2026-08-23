import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ExpenseRecord } from '@ash/contracts'
import { expense as expensePosting, minor } from '@ash/domain'
import { migrate } from '../src/migrate.ts'
import { createPool } from '../src/pool.ts'
import { PgFinancialUnitOfWork } from '../src/repos-financial.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  describe('PostgreSQL expense atomicity', () => {
    it.skip('skipped: set DATABASE_URL to a positively identified disposable database', () => {})
  })
} else {
  const disposable = assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = createPool(DATABASE_URL)
  const unit = new PgFinancialUnitOfWork(pool)
  const BRANCH = '11111111-1111-4111-8111-111111111111'
  const USER = '22222222-2222-4222-8222-222222222222'
  const CATEGORY = '33333333-3333-4333-8333-333333333333'
  const EXPENSE = '44444444-4444-4444-8444-444444444444'
  let fxDayId = 0

  beforeEach(async () => {
    await assertDisposableDatabaseConnection(pool, disposable)
    await migrate(pool)
    await pool.query(`
      TRUNCATE journal_lines, journal_entries, expenses, expense_categories, funds, fx_days,
               audit_log, users, branches, governorates
      RESTART IDENTITY CASCADE
    `)
    await pool.query(
      `INSERT INTO governorates (id, no, name_ar, name_en)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'دمشق', 'Damascus')`,
    )
    await pool.query(
      `INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no)
       VALUES ($1, 'DAM', 'دمشق', 'Damascus', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1)`,
      [BRANCH],
    )
    await pool.query(
      `INSERT INTO roles (key, name_ar, name_en)
       VALUES ('system_admin', 'مدير النظام', 'System admin')
       ON CONFLICT (key) DO NOTHING`,
    )
    await pool.query(
      `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
       VALUES ($1, $2, 'system_admin', 'expense-atomic', 'اختبار الصرف', 'x')`,
      [USER, BRANCH],
    )
    await pool.query(
      `INSERT INTO expense_categories (id, code, name_ar)
       VALUES ($1, 'POWER', 'كهرباء الشحن')`,
      [CATEGORY],
    )
    const fx = await pool.query<{ id: bigint }>(
      `INSERT INTO fx_days (business_date, syp_minor_per_usd)
       VALUES (DATE '2026-08-23', 13000)
       RETURNING id`,
    )
    fxDayId = Number(fx.rows[0]!.id)
  })

  afterAll(async () => {
    await pool.end()
  })

  const record = (): ExpenseRecord => ({
    id: EXPENSE,
    branchId: BRANCH,
    categoryId: CATEGORY,
    costCenterKind: 'general',
    vehicleId: null,
    amount: minor(25_000n),
    businessDate: '2026-08-23',
    description: 'Charging electricity',
    receiptMediaId: null,
    journalEntryId: null,
    createdBy: USER,
  })

  const writeExpense = async (failAfterRow: boolean): Promise<void> => {
    await unit.run({ lockKey: `expense:${EXPENSE}`, actorId: USER, requestId: 'expense-test' }, async (tx) => {
      const [entry] = await tx.ledger.post(
        BRANCH,
        [expensePosting(`general:${BRANCH}`, minor(25_000n), EXPENSE)],
        {
          shiftId: null,
          businessDate: '2026-08-23',
          postingDate: '2026-08-23',
          weekStartDate: '2026-08-23',
          fxDayId,
          createdBy: USER,
        },
      )
      await tx.expenses.create({ ...record(), journalEntryId: entry!.id })
      if (failAfterRow) throw new Error('rollback after both writes')
    })
  }

  describe('PostgreSQL expense atomicity', () => {
    it('rolls both the expense and journal back when the command fails', async () => {
      await expect(writeExpense(true)).rejects.toThrow('rollback after both writes')

      expect((await pool.query('SELECT id FROM expenses')).rowCount).toBe(0)
      expect((await pool.query("SELECT id FROM journal_entries WHERE event_type = 'expense'")).rowCount).toBe(0)
      expect((await pool.query('SELECT id FROM journal_lines')).rowCount).toBe(0)
    })

    it('commits the expense with its exact journal reference', async () => {
      await writeExpense(false)

      const linked = await pool.query<{ expense_id: string; journal_id: bigint; referenced_id: bigint }>(
        `SELECT e.id::text AS expense_id, je.id AS journal_id, e.journal_entry_id AS referenced_id
           FROM expenses e
           JOIN journal_entries je ON je.id = e.journal_entry_id
          WHERE e.id = $1 AND je.occurrence_key = e.id::text`,
        [EXPENSE],
      )
      expect(linked.rowCount).toBe(1)
      expect(linked.rows[0]!.referenced_id).toBe(linked.rows[0]!.journal_id)
    })
  })
}
