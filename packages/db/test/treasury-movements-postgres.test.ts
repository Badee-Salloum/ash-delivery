import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Posting } from '@ash/domain'
import { minor, officeTransfer } from '@ash/domain'
import { migrate } from '../src/migrate.ts'
import { createPool } from '../src/pool.ts'
import { PgLedgerRepo } from '../src/repos.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  describe('PostgreSQL treasury movement query', () => {
    it.skip('skipped: set DATABASE_URL to a positively identified disposable database', () => {})
  })
} else {
  const disposable = assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = createPool(DATABASE_URL)
  const ledger = new PgLedgerRepo(pool)
  const BRANCH = '11111111-1111-4111-8111-111111111111'
  const OTHER_BRANCH = '11111111-1111-4111-8111-111111111112'
  const USER = '22222222-2222-4222-8222-222222222222'
  let fxDayId = 0

  beforeEach(async () => {
    await assertDisposableDatabaseConnection(pool, disposable)
    await migrate(pool)
    await pool.query(`
      TRUNCATE journal_lines, journal_entries, funds, fx_days, audit_log, users, branches, governorates
      RESTART IDENTITY CASCADE
    `)
    await pool.query(
      `INSERT INTO governorates (id, no, name_ar, name_en)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'دمشق', 'Damascus')`,
    )
    await pool.query(
      `INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no)
       VALUES ($1, 'DAM', 'دمشق', 'Damascus', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1),
              ($2, 'ALP', 'حلب', 'Aleppo', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2)`,
      [BRANCH, OTHER_BRANCH],
    )
    await pool.query(
      `INSERT INTO roles (key, name_ar, name_en)
       VALUES ('branch_manager', 'مدير فرع', 'Branch manager')
       ON CONFLICT (key) DO NOTHING`,
    )
    await pool.query(
      `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
       VALUES ($1, $2, 'branch_manager', 'movement-query', 'منفذ الحركة', 'x')`,
      [USER, BRANCH],
    )
    const fx = await pool.query<{ id: bigint }>(
      `INSERT INTO fx_days (business_date, syp_minor_per_usd)
       VALUES (DATE '2026-07-21', 13000)
       RETURNING id`,
    )
    fxDayId = Number(fx.rows[0]!.id)
  })

  afterAll(async () => {
    await pool.end()
  })

  const movement = (direction: 'in' | 'out', occurrenceKey: string): Posting => ({
    eventType: 'manual',
    occurrenceKey,
    lines:
      direction === 'in'
        ? [
            { fund: { kind: 'office_cash' }, side: 'D', amount: minor(10_000n) },
            { fund: { kind: 'cost_center', costCenterId: 'movement-test' }, side: 'C', amount: minor(10_000n) },
          ]
        : [
            { fund: { kind: 'cost_center', costCenterId: 'movement-test' }, side: 'D', amount: minor(3_000n) },
            { fund: { kind: 'office_cash' }, side: 'C', amount: minor(3_000n) },
          ],
  })

  const post = async (branchId: string, posting: Posting, reason: string, businessDate = '2026-07-21') =>
    await ledger.post(branchId, [posting], {
      shiftId: null,
      businessDate,
      postingDate: businessDate,
      weekStartDate: businessDate === '2026-07-21' ? '2026-07-19' : '2026-06-28',
      fxDayId,
      sypMinorPerUsd: null,
      reason,
      createdBy: USER,
    })

  describe('PostgreSQL treasury movement query', () => {
    it('filters in SQL, preserves created_at, isolates branches, and pages without duplicates', async () => {
      const [incoming] = await post(BRANCH, movement('in', 'in'), 'رصيد افتتاحي')
      const [internal] = await post(
        BRANCH,
        officeTransfer('office_cash', 'office_wallet', minor(700n), 'internal'),
        'تحويل داخلي مسائي',
      )
      const [outgoing] = await post(BRANCH, movement('out', 'out'), 'إخراج نقدي للبحث العربي')
      await post(OTHER_BRANCH, movement('in', 'other'), 'حركة فرع آخر')
      await pool.query(`UPDATE journal_entries SET created_at = TIMESTAMPTZ '2026-07-21 22:04:05+00' WHERE id = $1`, [outgoing!.id])

      const base = { from: '2026-07-21' as const, to: '2026-07-21' as const, limit: 50 }
      const all = await ledger.listTreasuryMovements(BRANCH, base)
      expect(all.entries.map((entry) => entry.id)).toEqual([outgoing!.id, internal!.id, incoming!.id])
      expect(all.entries.map((entry) => entry.reason)).not.toContain('حركة فرع آخر')
      expect(all.eventTypes).toEqual(['manual'])
      expect(all.actorIds).toEqual([USER])
      expect(all.entries[0]!.createdAtMs).toBe(Date.parse('2026-07-21T22:04:05.000Z'))

      for (const filter of [
        { eventType: 'manual' as const },
        { actorId: USER },
        { channel: 'cash' as const },
        { flow: 'out' as const },
        { query: 'العربي' },
      ]) {
        const filtered = await ledger.listTreasuryMovements(BRANCH, { ...base, ...filter })
        expect(filtered.entries.map((entry) => entry.id), JSON.stringify(filter)).toContain(outgoing!.id)
      }

      const searched = await ledger.listTreasuryMovements(BRANCH, {
        ...base,
        eventType: 'manual',
        actorId: USER,
        channel: 'cash',
        flow: 'out',
        query: 'العربي',
      })
      expect(searched.entries.map((entry) => entry.id)).toEqual([outgoing!.id])

      const walletInternal = await ledger.listTreasuryMovements(BRANCH, {
        ...base,
        channel: 'wallet',
        flow: 'internal',
      })
      expect(walletInternal.entries.map((entry) => entry.id)).toEqual([internal!.id])

      const first = await ledger.listTreasuryMovements(BRANCH, { ...base, limit: 1 })
      expect(first.entries).toHaveLength(1)
      expect(first.nextBeforeId).toBe(first.entries[0]!.id)
      const second = await ledger.listTreasuryMovements(BRANCH, {
        ...base,
        limit: 1,
        beforeId: first.nextBeforeId!,
      })
      expect(second.entries).toHaveLength(1)
      expect(second.entries[0]!.id).not.toBe(first.entries[0]!.id)
    })
  })
}
