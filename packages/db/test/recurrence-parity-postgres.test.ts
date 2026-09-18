import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type CalendarDate,
  type RecurrenceSchedule,
  addDays,
  recurrenceMatches,
} from '@ash/domain'
import { migrate } from '../src/migrate.ts'
import { createPool } from '../src/pool.ts'
import { assertDisposableDatabaseUrl } from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL
const migrationsDir = new URL('../migrations/', import.meta.url)

describe('migration 0075 recurring expenses', () => {
  it('is ordered after the company-ledger foundation without claiming to be the migration tip', () => {
    const files = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()
    expect(files).toContain('0075_recurring_expenses.sql')
    expect(files.indexOf('0075_recurring_expenses.sql')).toBeGreaterThan(files.indexOf('0066_company_ledger_foundation.sql'))
  })
})

if (!DATABASE_URL) {
  describe('recurring schedule TypeScript/PostgreSQL parity', () => {
    it.skip('skipped: set DATABASE_URL to run against real PostgreSQL', () => {})
  })
} else {
  assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = createPool(DATABASE_URL)

  afterAll(async () => {
    await pool.end()
  })

  describe('recurring schedule TypeScript/PostgreSQL parity', () => {
    it('matches all three schedules on both sides of their start boundary', async () => {
      await migrate(pool)
      const schedules: RecurrenceSchedule[] = [
        { kind: 'weekly', startsOn: '2026-07-03', endsOn: null, weekday: 2, intervalDays: null },
        { kind: 'monthly_first', startsOn: '2026-07-03', endsOn: null, weekday: null, intervalDays: null },
        { kind: 'every_n_days', startsOn: '2026-07-03', endsOn: null, weekday: null, intervalDays: 11 },
      ]

      for (const schedule of schedules) {
        for (let offset = -10; offset <= 80; offset += 1) {
          const date = addDays(schedule.startsOn, offset)
          const { rows } = await pool.query<{ matches: boolean }>(
            `SELECT ash_recurrence_matches(
               $1::text, $2::date, $3::smallint, $4::smallint, $5::date
             ) AS matches`,
            [schedule.kind, schedule.startsOn, schedule.weekday, schedule.intervalDays, date],
          )
          expect(`${schedule.kind}:${date}:${rows[0]!.matches}`).toBe(
            `${schedule.kind}:${date}:${recurrenceMatches(schedule, date as CalendarDate)}`,
          )
        }
      }
    })

    it('guards deactivation, schedule history, occurrence dates, immutability, and audit', async () => {
      await migrate(pool)
      const client = await pool.connect()
      const governorateId = randomUUID()
      const branchId = randomUUID()
      const actorId = randomUUID()
      const categoryId = randomUUID()
      const templateId = randomUUID()
      const occurrenceId = randomUUID()
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)

      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO governorates (id, no, name_ar, name_en) VALUES ($1, 98, 'اختبار', 'Test')`,
          [governorateId],
        )
        await client.query(
          `INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no, kind)
           VALUES ($1, $2, 'فرع اختبار', 'Test branch', $3, 98, 'branch')`,
          [branchId, `R${suffix}`, governorateId],
        )
        await client.query(
          `INSERT INTO roles (key, name_ar, name_en) VALUES ('system_admin', 'مدير النظام', 'System Admin')
           ON CONFLICT (key) DO NOTHING`,
        )
        await client.query(
          `INSERT INTO permissions (key, name_ar, name_en) VALUES ('expense.write', 'كتابة الصرفيات', 'Write expenses')
           ON CONFLICT (key) DO NOTHING`,
        )
        await client.query(
          `INSERT INTO role_permissions (role_key, permission_key, scope)
           VALUES ('system_admin', 'expense.write', 'all')
           ON CONFLICT (role_key, permission_key) DO UPDATE SET scope = EXCLUDED.scope`,
        )
        await client.query(
          `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
           VALUES ($1, $2, 'system_admin', $3, 'مدير اختبار', 'x')`,
          [actorId, branchId, `recurrence-${suffix}`],
        )
        await client.query(
          `INSERT INTO expense_categories (id, code, name_ar, active)
           VALUES ($1, $2, 'إيجار', true)`,
          [categoryId, `rent-${suffix}`],
        )
        await client.query(`SELECT set_config('app.actor_id', $1, true)`, [actorId])
        await client.query(`SELECT set_config('app.request_id', $1, true)`, [`recurrence-${suffix}`])
        await client.query(
          `INSERT INTO recurring_expense_templates
             (id, branch_id, title, category_id, cost_center_kind, channel, amount_minor,
              schedule_kind, starts_on, active, created_by, updated_by)
           VALUES ($1, $2, 'Office rent', $3, 'general', 'office_cash', 30000000,
                   'monthly_first', DATE '2026-07-01', true, $4, $4)`,
          [templateId, branchId, categoryId, actorId],
        )

        await client.query('SAVEPOINT invalid_deactivation')
        await expect(
          client.query('UPDATE recurring_expense_templates SET active = false WHERE id = $1', [templateId]),
        ).rejects.toMatchObject({ code: '23514' })
        await client.query('ROLLBACK TO SAVEPOINT invalid_deactivation')

        await client.query('SAVEPOINT invalid_due')
        await expect(
          client.query(
            `INSERT INTO recurring_expense_occurrences
               (id, template_id, branch_id, due_date, status, reason, acted_by, acted_at)
             VALUES ($1, $2, $3, DATE '2026-07-02', 'skipped', 'not due', $4, now())`,
            [randomUUID(), templateId, branchId, actorId],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'recurring_expense_occurrence_schedule_guard' })
        await client.query('ROLLBACK TO SAVEPOINT invalid_due')

        await client.query(
          `INSERT INTO recurring_expense_occurrences
             (id, template_id, branch_id, due_date, status, reason, acted_by, acted_at)
           VALUES ($1, $2, $3, DATE '2026-08-01', 'skipped', 'Landlord waived it', $4, now())`,
          [occurrenceId, templateId, branchId, actorId],
        )

        await client.query('SAVEPOINT invalid_history')
        await expect(
          client.query(
            `UPDATE recurring_expense_templates
                SET schedule_kind = 'weekly', weekday = 2, updated_by = $2, updated_at = now()
              WHERE id = $1`,
            [templateId, actorId],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'recurring_expense_template_history_guard' })
        await client.query('ROLLBACK TO SAVEPOINT invalid_history')

        const audited = await client.query<{ table_name: string; record_id: string }>(
          `SELECT table_name, record_id FROM audit_log
            WHERE (table_name = 'recurring_expense_templates' AND record_id = $1)
               OR (table_name = 'recurring_expense_occurrences' AND record_id = $2)
            ORDER BY table_name`,
          [templateId, occurrenceId],
        )
        expect(audited.rows).toEqual([
          { table_name: 'recurring_expense_occurrences', record_id: occurrenceId },
          { table_name: 'recurring_expense_templates', record_id: templateId },
        ])

        await client.query('SAVEPOINT immutable_occurrence')
        await client.query('SET LOCAL ROLE app_user')
        await expect(
          client.query(`UPDATE recurring_expense_occurrences SET reason = 'rewritten' WHERE id = $1`, [occurrenceId]),
        ).rejects.toMatchObject({ code: '42501' })
        await client.query('ROLLBACK TO SAVEPOINT immutable_occurrence')
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })
  })
}
