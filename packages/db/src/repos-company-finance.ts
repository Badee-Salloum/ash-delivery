import type {
  AssetDepreciationPeriodRecord,
  AssetInstallmentOccurrenceRecord,
  AssetInstallmentPlanRecord,
  CompanyDebtEventRecord,
  CompanyDebtRecord,
  CompanyFinanceRepo,
  DepreciationAllocationRecord,
  DepreciationReleaseRecord,
  DepreciationTransferRecord,
  FixedAssetRecord,
} from '@ash/contracts'
import { minor, type CalendarDate, type Currency } from '@ash/domain'
import type { Pool } from './pool.ts'
import { isoDate } from './repos.ts'

// PostgreSQL `date` is a civil date. Converting its Date object through UTC can move Damascus
// midnight to the preceding day, which would fund an extra depreciation month.
const date = (value: unknown): CalendarDate => isoDate(value)
const ms = (value: unknown): number => value instanceof Date ? value.getTime() : new Date(String(value)).getTime()
const amount = (value: unknown) => minor(BigInt(String(value)))
const rate = (value: unknown): bigint | null => value === null || value === undefined ? null : BigInt(String(value))

const debt = (r: Record<string, unknown>): CompanyDebtRecord => ({
  id: String(r.id), branchId: String(r.branch_id), direction: String(r.direction) as CompanyDebtRecord['direction'],
  partyName: String(r.party_name), partyKey: String(r.party_key), currency: String(r.currency) as Currency,
  principal: amount(r.principal_minor), sypMinorPerUsd: rate(r.syp_minor_per_usd), openedOn: date(r.opened_on),
  businessDate: date(r.business_date), dueOn: r.due_on === null ? null : date(r.due_on),
  note: r.note === null ? null : String(r.note), origin: String(r.origin) as CompanyDebtRecord['origin'],
  expenseCategoryId: r.expense_category_id === null ? null : String(r.expense_category_id),
  incomeCategoryId: r.income_category_id === null ? null : String(r.income_category_id),
  costCenterKind: r.cost_center_kind === null ? null : String(r.cost_center_kind) as CompanyDebtRecord['costCenterKind'],
  vehicleId: r.vehicle_id === null ? null : String(r.vehicle_id), assetId: r.asset_id === null ? null : String(r.asset_id),
  journalEntryId: Number(r.journal_entry_id), createdBy: String(r.created_by), createdAtMs: ms(r.created_at),
})

const debtEvent = (r: Record<string, unknown>): CompanyDebtEventRecord => ({
  id: String(r.id), debtId: String(r.debt_id), branchId: String(r.branch_id),
  kind: String(r.kind) as CompanyDebtEventRecord['kind'], amount: amount(r.amount_minor),
  source: r.source === null ? null : String(r.source) as CompanyDebtEventRecord['source'],
  sypMinorPerUsd: rate(r.syp_minor_per_usd), occurredOn: date(r.occurred_on), businessDate: date(r.business_date),
  reason: String(r.reason), journalEntryId: Number(r.journal_entry_id), createdBy: String(r.created_by),
  createdAtMs: ms(r.created_at),
})

const asset = (r: Record<string, unknown>): FixedAssetRecord => ({
  id: String(r.id), branchId: String(r.branch_id), kind: String(r.kind) as FixedAssetRecord['kind'],
  vehicleId: r.vehicle_id === null ? null : String(r.vehicle_id), name: String(r.name),
  currency: String(r.currency) as Currency, price: amount(r.price_minor), sypMinorPerUsd: rate(r.syp_minor_per_usd),
  purchasedOn: date(r.purchased_on), businessDate: date(r.business_date), usefulMonths: 36,
  paidNow: amount(r.paid_now_minor), paidFrom: String(r.paid_from) as FixedAssetRecord['paidFrom'],
  debtId: r.debt_id === null ? null : String(r.debt_id), description: String(r.description),
  journalEntryId: Number(r.journal_entry_id), createdBy: String(r.created_by), createdAtMs: ms(r.created_at),
})

const installmentPlan = (r: Record<string, unknown>): AssetInstallmentPlanRecord => ({
  id: String(r.id), assetId: String(r.asset_id), debtId: String(r.debt_id), branchId: String(r.branch_id),
  currency: String(r.currency) as Currency, amount: amount(r.amount_minor),
  paidFrom: String(r.paid_from) as AssetInstallmentPlanRecord['paidFrom'],
  scheduleKind: String(r.schedule_kind) as AssetInstallmentPlanRecord['scheduleKind'],
  weekday: r.weekday === null ? null : Number(r.weekday),
  intervalDays: r.interval_days === null ? null : Number(r.interval_days),
  startsOn: date(r.starts_on), active: Boolean(r.active),
  deactivatedOn: r.deactivated_on === null ? null : date(r.deactivated_on),
  deactivatedAtMs: r.deactivated_at === null ? null : ms(r.deactivated_at),
  deactivatedBy: r.deactivated_by === null ? null : String(r.deactivated_by),
  deactivationReason: r.deactivation_reason === null ? null : String(r.deactivation_reason),
  createdBy: String(r.created_by), createdAtMs: ms(r.created_at),
})

const installmentOccurrence = (r: Record<string, unknown>): AssetInstallmentOccurrenceRecord => ({
  id: String(r.id), planId: String(r.plan_id), branchId: String(r.branch_id), dueDate: date(r.due_date),
  status: String(r.status) as AssetInstallmentOccurrenceRecord['status'],
  debtEventId: r.debt_event_id === null ? null : String(r.debt_event_id),
  reason: r.reason === null ? null : String(r.reason), actedBy: String(r.acted_by), actedAtMs: ms(r.acted_at),
})

const transfer = (r: Record<string, unknown>): DepreciationTransferRecord => ({
  id: String(r.id), branchId: String(r.branch_id), currency: String(r.currency) as Currency,
  amount: amount(r.amount_minor), expectedAmount: amount(r.expected_amount_minor),
  sypMinorPerUsd: rate(r.syp_minor_per_usd), asOfMonth: date(r.as_of_month), businessDate: date(r.business_date),
  reason: String(r.reason), journalEntryId: Number(r.journal_entry_id), createdBy: String(r.created_by),
  createdAtMs: ms(r.created_at),
})

const release = (r: Record<string, unknown>): DepreciationReleaseRecord => ({
  id: String(r.id), branchId: String(r.branch_id), currency: String(r.currency) as Currency,
  amount: amount(r.amount_minor), sypMinorPerUsd: rate(r.syp_minor_per_usd), occurredOn: date(r.occurred_on),
  businessDate: date(r.business_date), reason: String(r.reason), journalEntryId: Number(r.journal_entry_id),
  createdBy: String(r.created_by), createdAtMs: ms(r.created_at),
})

export class PgCompanyFinanceRepo implements CompanyFinanceRepo {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async getDebt(id: string): Promise<CompanyDebtRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM company_debts WHERE id = $1', [id])
    return rows[0] ? debt(rows[0]) : null
  }
  async listDebts(companyBranchId: string): Promise<CompanyDebtRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM company_debts WHERE branch_id = $1 ORDER BY created_at, id', [companyBranchId],
    )
    return rows.map(debt)
  }
  async createDebt(row: CompanyDebtRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO company_debts
         (id,branch_id,direction,party_name,party_key,currency,principal_minor,syp_minor_per_usd,
          opened_on,business_date,due_on,note,origin,expense_category_id,income_category_id,
          cost_center_kind,vehicle_id,asset_id,journal_entry_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [row.id,row.branchId,row.direction,row.partyName,row.partyKey,row.currency,row.principal.toString(),
       row.sypMinorPerUsd?.toString() ?? null,row.openedOn,row.businessDate,row.dueOn,row.note,row.origin,
       row.expenseCategoryId,row.incomeCategoryId,row.costCenterKind,row.vehicleId,row.assetId,row.journalEntryId,row.createdBy],
    )
  }
  async getDebtEvent(id: string): Promise<CompanyDebtEventRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM company_debt_events WHERE id = $1', [id],
    )
    return rows[0] ? debtEvent(rows[0]) : null
  }
  async listDebtEvents(debtId: string): Promise<CompanyDebtEventRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM company_debt_events WHERE debt_id = $1 ORDER BY created_at, id', [debtId],
    )
    return rows.map(debtEvent)
  }
  async createDebtEvent(row: CompanyDebtEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO company_debt_events
         (id,debt_id,branch_id,kind,amount_minor,source,syp_minor_per_usd,occurred_on,business_date,
          reason,journal_entry_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.id,row.debtId,row.branchId,row.kind,row.amount.toString(),row.source,row.sypMinorPerUsd?.toString() ?? null,
       row.occurredOn,row.businessDate,row.reason,row.journalEntryId,row.createdBy],
    )
  }

  async getAsset(id: string): Promise<FixedAssetRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM fixed_assets WHERE id = $1', [id])
    return rows[0] ? asset(rows[0]) : null
  }
  async getAssetByVehicle(vehicleId: string): Promise<FixedAssetRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM fixed_assets WHERE vehicle_id = $1', [vehicleId])
    return rows[0] ? asset(rows[0]) : null
  }
  async listAssets(companyBranchId: string): Promise<FixedAssetRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM fixed_assets WHERE branch_id = $1 ORDER BY purchased_on, created_at, id', [companyBranchId],
    )
    return rows.map(asset)
  }
  async createAsset(row: FixedAssetRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO fixed_assets
         (id,branch_id,kind,vehicle_id,name,currency,price_minor,syp_minor_per_usd,purchased_on,
          business_date,useful_months,paid_now_minor,paid_from,debt_id,description,journal_entry_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [row.id,row.branchId,row.kind,row.vehicleId,row.name,row.currency,row.price.toString(),
       row.sypMinorPerUsd?.toString() ?? null,row.purchasedOn,row.businessDate,row.usefulMonths,
       row.paidNow.toString(),row.paidFrom,row.debtId,row.description,row.journalEntryId,row.createdBy],
    )
  }
  async listAssetSchedule(assetId?: string): Promise<AssetDepreciationPeriodRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM asset_depreciation_schedule WHERE ($1::uuid IS NULL OR asset_id = $1)
       ORDER BY period_month, asset_id, period`, [assetId ?? null],
    )
    return rows.map((r) => ({ assetId: String(r.asset_id), period: Number(r.period), periodMonth: date(r.period_month), amount: amount(r.amount_minor) }))
  }
  async createAssetSchedule(rows: readonly AssetDepreciationPeriodRecord[]): Promise<void> {
    for (const row of rows) {
      await this.pool.query(
        `INSERT INTO asset_depreciation_schedule (asset_id,period,period_month,amount_minor) VALUES ($1,$2,$3,$4)`,
        [row.assetId,row.period,row.periodMonth,row.amount.toString()],
      )
    }
  }

  async getAssetInstallmentPlan(id: string): Promise<AssetInstallmentPlanRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM asset_installment_plans WHERE id = $1', [id],
    )
    return rows[0] ? installmentPlan(rows[0]) : null
  }
  async listAssetInstallmentPlans(assetId: string, includeInactive = false): Promise<AssetInstallmentPlanRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM asset_installment_plans
        WHERE asset_id = $1 AND ($2::boolean OR active)
        ORDER BY created_at, id`, [assetId, includeInactive],
    )
    return rows.map(installmentPlan)
  }
  async listInstallmentPlans(companyBranchId: string, includeInactive = false): Promise<AssetInstallmentPlanRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM asset_installment_plans
        WHERE branch_id = $1 AND ($2::boolean OR active)
        ORDER BY starts_on, created_at, id`, [companyBranchId, includeInactive],
    )
    return rows.map(installmentPlan)
  }
  async createAssetInstallmentPlan(row: AssetInstallmentPlanRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO asset_installment_plans
         (id,asset_id,debt_id,branch_id,currency,amount_minor,paid_from,schedule_kind,weekday,interval_days,
          starts_on,active,deactivated_on,deactivated_at,deactivated_by,deactivation_reason,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               CASE WHEN $14::bigint IS NULL THEN NULL ELSE to_timestamp($14::double precision / 1000) END,
               $15,$16,$17,to_timestamp($18::double precision / 1000))`,
      [
        row.id,row.assetId,row.debtId,row.branchId,row.currency,row.amount.toString(),row.paidFrom,
        row.scheduleKind,row.weekday,row.intervalDays,row.startsOn,row.active,row.deactivatedOn,
        row.deactivatedAtMs,row.deactivatedBy,row.deactivationReason,row.createdBy,row.createdAtMs,
      ],
    )
  }
  async deactivateAssetInstallmentPlan(row: AssetInstallmentPlanRecord): Promise<void> {
    const result = await this.pool.query(
      `UPDATE asset_installment_plans
          SET active = $2, deactivated_on = $3,
              deactivated_at = CASE WHEN $4::bigint IS NULL THEN NULL ELSE to_timestamp($4::double precision / 1000) END,
              deactivated_by = $5, deactivation_reason = $6
        WHERE id = $1`,
      [row.id,row.active,row.deactivatedOn,row.deactivatedAtMs,row.deactivatedBy,row.deactivationReason],
    )
    if (result.rowCount !== 1) throw Object.assign(new Error(`unknown asset installment plan ${row.id}`), { code: 'ASSET_INSTALLMENT_PLAN_NOT_FOUND' })
  }
  async getAssetInstallmentOccurrence(
    planId: string,
    dueDate: CalendarDate,
  ): Promise<AssetInstallmentOccurrenceRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM asset_installment_occurrences WHERE plan_id = $1 AND due_date = $2', [planId, dueDate],
    )
    return rows[0] ? installmentOccurrence(rows[0]) : null
  }
  async getAssetInstallmentOccurrenceById(id: string): Promise<AssetInstallmentOccurrenceRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM asset_installment_occurrences WHERE id = $1', [id],
    )
    return rows[0] ? installmentOccurrence(rows[0]) : null
  }
  async listAssetInstallmentOccurrencesForPlan(planId: string): Promise<AssetInstallmentOccurrenceRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM asset_installment_occurrences
        WHERE plan_id = $1
        ORDER BY due_date, id`, [planId],
    )
    return rows.map(installmentOccurrence)
  }
  async listAssetInstallmentOccurrences(
    companyBranchId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<AssetInstallmentOccurrenceRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM asset_installment_occurrences
        WHERE branch_id = $1 AND due_date BETWEEN $2 AND $3
        ORDER BY due_date, plan_id`, [companyBranchId, from, to],
    )
    return rows.map(installmentOccurrence)
  }
  async countAssetInstallmentOccurrencesBefore(planId: string, before: CalendarDate): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM asset_installment_occurrences WHERE plan_id = $1 AND due_date < $2',
      [planId, before],
    )
    return Number(rows[0]?.count ?? '0')
  }
  async createAssetInstallmentOccurrence(row: AssetInstallmentOccurrenceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO asset_installment_occurrences
         (id,plan_id,branch_id,due_date,status,debt_event_id,reason,acted_by,acted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9::double precision / 1000))`,
      [row.id,row.planId,row.branchId,row.dueDate,row.status,row.debtEventId,row.reason,row.actedBy,row.actedAtMs],
    )
  }

  async listDepreciationAllocations(companyBranchId: string, currency?: Currency): Promise<DepreciationAllocationRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT da.* FROM depreciation_allocations da JOIN fixed_assets fa ON fa.id = da.asset_id
        WHERE fa.branch_id = $1 AND ($2::text IS NULL OR fa.currency = $2)
        ORDER BY da.asset_id, da.period, da.transfer_id`, [companyBranchId, currency ?? null],
    )
    return rows.map((r) => ({ transferId: String(r.transfer_id), assetId: String(r.asset_id), period: Number(r.period), amount: amount(r.amount_minor) }))
  }
  async createDepreciationTransfer(row: DepreciationTransferRecord, allocations: readonly DepreciationAllocationRecord[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO depreciation_transfers
         (id,branch_id,currency,amount_minor,expected_amount_minor,syp_minor_per_usd,as_of_month,
          business_date,reason,journal_entry_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [row.id,row.branchId,row.currency,row.amount.toString(),row.expectedAmount.toString(),
       row.sypMinorPerUsd?.toString() ?? null,row.asOfMonth,row.businessDate,row.reason,row.journalEntryId,row.createdBy],
    )
    for (const allocation of allocations) {
      await this.pool.query(
        `INSERT INTO depreciation_allocations (transfer_id,asset_id,period,amount_minor) VALUES ($1,$2,$3,$4)`,
        [allocation.transferId,allocation.assetId,allocation.period,allocation.amount.toString()],
      )
    }
  }
  async listDepreciationTransfers(companyBranchId: string): Promise<DepreciationTransferRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM depreciation_transfers WHERE branch_id = $1 ORDER BY created_at, id', [companyBranchId],
    )
    return rows.map(transfer)
  }
  async createDepreciationRelease(row: DepreciationReleaseRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO depreciation_releases
         (id,branch_id,currency,amount_minor,syp_minor_per_usd,occurred_on,business_date,reason,journal_entry_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.id,row.branchId,row.currency,row.amount.toString(),row.sypMinorPerUsd?.toString() ?? null,
       row.occurredOn,row.businessDate,row.reason,row.journalEntryId,row.createdBy],
    )
  }
  async listDepreciationReleases(companyBranchId: string): Promise<DepreciationReleaseRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM depreciation_releases WHERE branch_id = $1 ORDER BY created_at, id', [companyBranchId],
    )
    return rows.map(release)
  }
}
