import type {
  RecurringExpenseOccurrenceRecord,
  RecurringExpenseRepo,
  RecurringExpenseTemplateRecord,
} from '@ash/contracts'
import { type CalendarDate, minor } from '@ash/domain'
import type { Pool } from './pool.ts'
import { PG, isPgError } from './pool.ts'

const isoDate = (value: unknown): CalendarDate => {
  if (!(value instanceof Date)) return String(value) as CalendarDate
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` as CalendarDate
}

const atMs = (value: unknown): number => (value instanceof Date ? value.getTime() : new Date(String(value)).getTime())

const templateRecord = (row: Record<string, unknown>): RecurringExpenseTemplateRecord => ({
  id: String(row.id),
  branchId: String(row.branch_id),
  templateKind: (row.template_kind as 'branch' | 'company' | undefined) ?? 'branch',
  currency: (row.currency as 'SYP_NEW' | 'USD' | undefined) ?? 'SYP_NEW',
  title: String(row.title),
  categoryId: String(row.category_id),
  costCenterKind: row.cost_center_kind as RecurringExpenseTemplateRecord['costCenterKind'],
  vehicleId: (row.vehicle_id as string | null) ?? null,
  assetId: (row.asset_id as string | null) ?? null,
  channel: (row.channel as RecurringExpenseTemplateRecord['channel']) ?? null,
  paidFrom: (row.paid_from as RecurringExpenseTemplateRecord['paidFrom']) ?? null,
  amount: minor(BigInt(String(row.amount_minor))),
  scheduleKind: row.schedule_kind as RecurringExpenseTemplateRecord['scheduleKind'],
  weekday: row.weekday === null ? null : Number(row.weekday),
  intervalDays: row.interval_days === null ? null : Number(row.interval_days),
  startsOn: isoDate(row.starts_on),
  endsOn: row.ends_on === null ? null : isoDate(row.ends_on),
  active: Boolean(row.active),
  deactivatedOn: row.deactivated_on === null ? null : isoDate(row.deactivated_on),
  deactivatedAtMs: row.deactivated_at === null ? null : atMs(row.deactivated_at),
  deactivatedBy: (row.deactivated_by as string | null) ?? null,
  deactivationReason: (row.deactivation_reason as string | null) ?? null,
  createdBy: String(row.created_by),
  createdAtMs: atMs(row.created_at),
  updatedBy: String(row.updated_by),
  updatedAtMs: atMs(row.updated_at),
})

const occurrenceRecord = (row: Record<string, unknown>): RecurringExpenseOccurrenceRecord => ({
  id: String(row.id),
  templateId: String(row.template_id),
  branchId: String(row.branch_id),
  dueDate: isoDate(row.due_date),
  status: row.status as RecurringExpenseOccurrenceRecord['status'],
  expenseId: (row.expense_id as string | null) ?? null,
  companyExpenseId: (row.company_expense_id as string | null) ?? null,
  reason: (row.reason as string | null) ?? null,
  actedBy: String(row.acted_by),
  actedAtMs: atMs(row.acted_at),
})

export class PgRecurringExpenseRepo implements RecurringExpenseRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async getTemplate(id: string): Promise<RecurringExpenseTemplateRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM recurring_expense_templates WHERE id = $1',
      [id],
    )
    return rows[0] ? templateRecord(rows[0]) : null
  }

  async listTemplates(branchId: string, includeInactive = false): Promise<RecurringExpenseTemplateRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM recurring_expense_templates
        WHERE branch_id = $1 AND ($2::boolean OR active)
        ORDER BY title, id`,
      [branchId, includeInactive],
    )
    return rows.map(templateRecord)
  }

  async createTemplate(template: RecurringExpenseTemplateRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO recurring_expense_templates
           (id, branch_id, template_kind, currency, title, category_id, cost_center_kind, vehicle_id,
            asset_id, channel, paid_from, amount_minor,
            schedule_kind, weekday, interval_days, starts_on, ends_on, active,
            deactivated_on, deactivated_at, deactivated_by, deactivation_reason,
            created_by, created_at, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                 CASE WHEN $20::bigint IS NULL THEN NULL ELSE to_timestamp($20::double precision / 1000) END,
                 $21,$22,$23,to_timestamp($24::double precision / 1000),$25,
                 to_timestamp($26::double precision / 1000))`,
        [
          template.id, template.branchId, template.templateKind ?? 'branch', template.currency ?? 'SYP_NEW',
          template.title, template.categoryId, template.costCenterKind, template.vehicleId,
          template.assetId ?? null, template.channel, template.paidFrom ?? null, template.amount.toString(),
          template.scheduleKind, template.weekday, template.intervalDays, template.startsOn, template.endsOn,
          template.active, template.deactivatedOn, template.deactivatedAtMs, template.deactivatedBy,
          template.deactivationReason, template.createdBy, template.createdAtMs, template.updatedBy,
          template.updatedAtMs,
        ],
      )
    } catch (error) {
      if (isPgError(error, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error(`duplicate recurring template ${template.id}`), { code: 'DUPLICATE_TEMPLATE' })
      }
      throw error
    }
  }

  async updateTemplate(template: RecurringExpenseTemplateRecord): Promise<void> {
    const result = await this.pool.query(
      `UPDATE recurring_expense_templates
          SET title = $2, category_id = $3, cost_center_kind = $4, vehicle_id = $5,
              asset_id = $6, channel = $7, paid_from = $8, currency = $9,
              amount_minor = $10, schedule_kind = $11, weekday = $12,
              interval_days = $13, starts_on = $14, ends_on = $15, active = $16,
              deactivated_on = $17,
              deactivated_at = CASE WHEN $18::bigint IS NULL THEN NULL ELSE to_timestamp($18::double precision / 1000) END,
              deactivated_by = $19, deactivation_reason = $20,
              updated_by = $21, updated_at = to_timestamp($22::double precision / 1000)
        WHERE id = $1`,
      [
        template.id, template.title, template.categoryId, template.costCenterKind, template.vehicleId,
        template.assetId ?? null, template.channel, template.paidFrom ?? null, template.currency ?? 'SYP_NEW',
        template.amount.toString(), template.scheduleKind, template.weekday,
        template.intervalDays, template.startsOn, template.endsOn, template.active,
        template.deactivatedOn, template.deactivatedAtMs, template.deactivatedBy,
        template.deactivationReason, template.updatedBy, template.updatedAtMs,
      ],
    )
    if (result.rowCount !== 1) {
      throw Object.assign(new Error(`unknown recurring template ${template.id}`), { code: 'TEMPLATE_NOT_FOUND' })
    }
  }

  async getOccurrence(
    templateId: string,
    dueDate: CalendarDate,
  ): Promise<RecurringExpenseOccurrenceRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM recurring_expense_occurrences WHERE template_id = $1 AND due_date = $2',
      [templateId, dueDate],
    )
    return rows[0] ? occurrenceRecord(rows[0]) : null
  }

  async listOccurrences(
    branchId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<RecurringExpenseOccurrenceRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM recurring_expense_occurrences
        WHERE branch_id = $1 AND due_date BETWEEN $2 AND $3
        ORDER BY due_date, template_id`,
      [branchId, from, to],
    )
    return rows.map(occurrenceRecord)
  }

  async countOccurrencesBefore(templateId: string, before: CalendarDate): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM recurring_expense_occurrences WHERE template_id = $1 AND due_date < $2',
      [templateId, before],
    )
    return Number(rows[0]?.count ?? '0')
  }

  async createOccurrence(occurrence: RecurringExpenseOccurrenceRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO recurring_expense_occurrences
           (id, template_id, branch_id, due_date, status, expense_id, company_expense_id, reason, acted_by, acted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10::double precision / 1000))`,
        [
          occurrence.id, occurrence.templateId, occurrence.branchId, occurrence.dueDate,
          occurrence.status, occurrence.expenseId, occurrence.companyExpenseId ?? null,
          occurrence.reason, occurrence.actedBy,
          occurrence.actedAtMs,
        ],
      )
    } catch (error) {
      if (isPgError(error, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error('recurring occurrence already resolved'), { code: 'DUPLICATE_OCCURRENCE' })
      }
      throw error
    }
  }
}
