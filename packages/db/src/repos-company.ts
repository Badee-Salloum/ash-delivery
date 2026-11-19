import type {
  CompanyCommandRecord,
  CompanyHistoricalBranchLink,
  CompanyCutoverRecord,
  CompanyLedgerRepo,
  CompanyLedgerSource,
  CompanyHistoricalImportReceiptRecord,
  CompanyHistoricalRestorationSettlement,
  CompanyMirrorRecord,
  CompanyMovementRecord,
  CompanyOverviewRecord,
  CompanyPeriodTotals,
  CompanyReversalRecord,
  FinancialLocks,
} from '@ash/contracts'
import { type CalendarDate, type Currency, CURRENCIES, type Minor, minor, parseMinor } from '@ash/domain'
import { PG, type Pool, isPgError } from './pool.ts'
import { JOURNAL_LINES_JSON, isoDate, journalEntryFromRow } from './repos.ts'

/**
 * «صندوق الشركة» on PostgreSQL (finance redesign C2, migration 0067).
 *
 * The repo writes the command rows 0067's guards judge, and reads them back; the source answers
 * the company screen's questions in single statements, so a mirror posted between two reads can
 * never show a clearing account out of step with its branch.
 */

const toMs = (value: unknown): number => (value instanceof Date ? value.getTime() : new Date(String(value)).getTime())
const big = (value: unknown): bigint => BigInt(String(value))
const bigOrNull = (value: unknown): bigint | null => (value === null || value === undefined ? null : big(value))
const money = (value: unknown): Minor => minor(big(value))
const settlementEncode = (row: CompanyHistoricalRestorationSettlement): string =>
  JSON.stringify(row, (_key, value: unknown) => typeof value === 'bigint' ? { minor: value.toString() } : value)
const settlementDecode = (payload: unknown): CompanyHistoricalRestorationSettlement =>
  JSON.parse(JSON.stringify(payload), (_key, value: unknown) =>
    value !== null && typeof value === 'object' && Object.keys(value).length === 1 && 'minor' in value &&
      typeof value.minor === 'string' ? minor(BigInt(value.minor)) : value) as CompanyHistoricalRestorationSettlement

const duplicate = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code })

/**
 * Every command table as one relation with the columns the record needs. `kind` distinguishes them;
 * columns a table does not have are NULL. Money travels as text.
 */
const COMMANDS_SQL = `
  SELECT id, branch_id, kind, equity_account, currency, amount_minor::text AS amount,
         syp_minor_per_usd, NULL::uuid AS category_id, NULL::text AS cost_center_kind,
         NULL::uuid AS vehicle_id, NULL::uuid AS asset_id, NULL::text AS paid_from,
         NULL::uuid AS receipt_media_id, reason AS text_value,
         NULL::text AS from_currency, NULL::text AS from_amount, NULL::text AS to_currency,
         NULL::text AS to_amount, NULL::text AS target_kind, NULL::uuid AS target_id,
         NULL::bigint AS target_entry_id,
         occurred_on, business_date, journal_entry_id, created_by, created_at
    FROM company_moves
  UNION ALL
  SELECT id, branch_id, 'expense', NULL, currency, amount_minor::text, syp_minor_per_usd,
         category_id, cost_center_kind, vehicle_id, asset_id, paid_from, receipt_media_id,
         description, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         occurred_on, business_date, journal_entry_id, created_by, created_at
    FROM company_expenses
  UNION ALL
  SELECT id, branch_id, 'income', NULL, currency, amount_minor::text, syp_minor_per_usd,
         category_id, NULL, NULL, NULL, NULL, NULL,
         description, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         occurred_on, business_date, journal_entry_id, created_by, created_at
    FROM company_incomes
  UNION ALL
  SELECT id, branch_id, 'exchange', NULL, NULL, NULL, syp_minor_per_usd,
         NULL, NULL, NULL, NULL, NULL, NULL,
         reason, from_currency, from_amount_minor::text, to_currency, to_amount_minor::text,
         NULL, NULL, NULL,
         occurred_on, business_date, journal_entry_id, created_by, created_at
    FROM company_fx_exchanges
  UNION ALL
  SELECT id, branch_id, 'reversal', NULL, NULL, NULL, syp_minor_per_usd,
         NULL, NULL, NULL, NULL, NULL, NULL,
         reason, NULL, NULL, NULL, NULL, target_kind, target_id, target_entry_id,
         occurred_on, business_date, journal_entry_id, created_by, created_at
    FROM company_reversals
`

function commandFromRow(r: Record<string, unknown>): CompanyCommandRecord {
  const base = {
    id: String(r.id),
    branchId: String(r.branch_id),
    occurredOn: isoDate(r.occurred_on),
    businessDate: isoDate(r.business_date),
    journalEntryId: Number(r.journal_entry_id),
    createdBy: String(r.created_by),
    createdAtMs: toMs(r.created_at),
  }
  const kind = String(r.kind)
  switch (kind) {
    case 'deposit':
    case 'withdrawal':
      return {
        ...base,
        kind,
        equityAccount: String(r.equity_account) as 'owner_funding' | 'owner_drawings' | 'opening',
        currency: String(r.currency) as Currency,
        amount: money(r.amount),
        sypMinorPerUsd: bigOrNull(r.syp_minor_per_usd),
        reason: String(r.text_value),
      }
    case 'expense':
      return {
        ...base,
        kind,
        currency: String(r.currency) as Currency,
        amount: money(r.amount),
        sypMinorPerUsd: bigOrNull(r.syp_minor_per_usd),
        categoryId: String(r.category_id),
        costCenterKind: String(r.cost_center_kind) as 'general' | 'vehicle' | 'asset',
        vehicleId: r.vehicle_id === null ? null : String(r.vehicle_id),
        assetId: r.asset_id === null ? null : String(r.asset_id),
        paidFrom: String(r.paid_from) as 'pocket' | 'reserve' | 'owner_outside' | 'owner_custody',
        receiptMediaId: r.receipt_media_id === null ? null : String(r.receipt_media_id),
        description: String(r.text_value),
      }
    case 'income':
      return {
        ...base,
        kind,
        currency: String(r.currency) as Currency,
        amount: money(r.amount),
        sypMinorPerUsd: bigOrNull(r.syp_minor_per_usd),
        categoryId: String(r.category_id),
        description: String(r.text_value),
      }
    case 'exchange':
      return {
        ...base,
        kind,
        fromCurrency: String(r.from_currency) as Currency,
        fromAmount: money(r.from_amount),
        toCurrency: String(r.to_currency) as Currency,
        toAmount: money(r.to_amount),
        sypMinorPerUsd: big(r.syp_minor_per_usd),
        reason: String(r.text_value),
      }
    case 'reversal':
      return {
        ...base,
        kind,
        targetKind: String(r.target_kind) as CompanyReversalRecord['targetKind'],
        targetId: String(r.target_id),
        targetEntryId: Number(r.target_entry_id),
        sypMinorPerUsd: bigOrNull(r.syp_minor_per_usd),
        reason: String(r.text_value),
      }
    default:
      throw new Error(`unknown company command kind ${kind}`)
  }
}

const cutoverFromRow = (r: Record<string, unknown>): CompanyCutoverRecord => ({
  branchId: String(r.branch_id),
  companyBranchId: String(r.company_branch_id),
  openingAmount: money(r.opening_amount_minor),
  openingEntryId: r.opening_entry_id === null ? null : Number(r.opening_entry_id),
  mode: r.mode === 'link_only' ? 'link_only' : 'cash_opening',
  baselineDifference: money(r.baseline_difference_minor ?? '0'),
  watermarkEntryId: Number(r.watermark_entry_id),
  businessDate: isoDate(r.business_date),
  reason: String(r.reason),
  performedBy: String(r.performed_by),
  performedAtMs: toMs(r.performed_at),
})

const mirrorFromRow = (r: Record<string, unknown>): CompanyMirrorRecord => ({
  id: String(r.id),
  sourceBranchId: String(r.source_branch_id),
  sourceEntryId: Number(r.source_entry_id),
  mirrorEntryId: Number(r.mirror_entry_id),
  direction: String(r.direction) as CompanyMirrorRecord['direction'],
  amount: money(r.amount_minor),
  restorationId: r.restoration_id === null ? null : Number(r.restoration_id),
  createdBy: String(r.created_by),
  createdAtMs: toMs(r.created_at),
})

export class PgCompanyLedgerRepo implements CompanyLedgerRepo {
  async createHistoricalBranchLink(row: CompanyHistoricalBranchLink): Promise<void> {
    await this.pool.query(`INSERT INTO company_historical_branch_links
      (id,company_branch_id,source_branch_id,source_entry_id,company_entry_id,created_entry,amount_minor,direction,occurred_on,reason,request_hash,created_by,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [row.id,row.companyBranchId,row.sourceBranchId,row.sourceEntryId,row.companyEntryId,row.createdEntry,row.amount.toString(),row.direction,row.occurredOn,row.reason,row.requestHash,row.createdBy,new Date(row.createdAtMs)])
  }
  async findHistoricalBranchLink(id: string): Promise<CompanyHistoricalBranchLink | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM company_historical_branch_links WHERE id=$1',[id])
    return rows[0] ? this.historicalBranchLink(rows[0]) : null
  }
  async listHistoricalBranchLinks(companyBranchId: string): Promise<CompanyHistoricalBranchLink[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM company_historical_branch_links WHERE company_branch_id=$1 ORDER BY created_at,id',[companyBranchId])
    return rows.map(row => this.historicalBranchLink(row))
  }
  private historicalBranchLink(row: Record<string, unknown>): CompanyHistoricalBranchLink {
    return { id:String(row.id),companyBranchId:String(row.company_branch_id),sourceBranchId:String(row.source_branch_id),
      sourceEntryId:Number(row.source_entry_id),companyEntryId:Number(row.company_entry_id),createdEntry:Boolean(row.created_entry),
      amount:minor(BigInt(String(row.amount_minor))),direction:row.direction as CompanyHistoricalBranchLink['direction'],
      occurredOn:isoDate(row.occurred_on),reason:String(row.reason),requestHash:String(row.request_hash),createdBy:String(row.created_by),
      createdAtMs:row.created_at instanceof Date ? row.created_at.getTime() : new Date(String(row.created_at)).getTime() }
  }
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async createCommand(row: CompanyCommandRecord): Promise<void> {
    // One key, one command, across every table — checked here as well as by the route, so a key
    // spent on a deposit can never become an expense through a racing request.
    if ((await this.findCommand(row.id)) !== null || await this.findHistoricalBranchLink(row.id)) {
      throw duplicate('DUPLICATE_COMPANY_COMMAND', `company command ${row.id} already exists`)
    }
    try {
      switch (row.kind) {
        case 'deposit':
        case 'withdrawal':
          await this.pool.query(
            `INSERT INTO company_moves
               (id, branch_id, kind, equity_account, currency, amount_minor, syp_minor_per_usd,
                occurred_on, business_date, reason, journal_entry_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              row.id, row.branchId, row.kind, row.equityAccount, row.currency, row.amount.toString(),
              row.sypMinorPerUsd?.toString() ?? null, row.occurredOn, row.businessDate, row.reason,
              row.journalEntryId, row.createdBy,
            ],
          )
          return
        case 'expense':
          await this.pool.query(
            `INSERT INTO company_expenses
               (id, branch_id, currency, amount_minor, syp_minor_per_usd, category_id, cost_center_kind,
                vehicle_id, asset_id, paid_from, receipt_media_id, description, occurred_on,
                business_date, journal_entry_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [
              row.id, row.branchId, row.currency, row.amount.toString(), row.sypMinorPerUsd?.toString() ?? null,
              row.categoryId, row.costCenterKind, row.vehicleId, row.assetId, row.paidFrom,
              row.receiptMediaId, row.description, row.occurredOn, row.businessDate, row.journalEntryId,
              row.createdBy,
            ],
          )
          return
        case 'income':
          await this.pool.query(
            `INSERT INTO company_incomes
               (id, branch_id, currency, amount_minor, syp_minor_per_usd, category_id, description,
                occurred_on, business_date, journal_entry_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              row.id, row.branchId, row.currency, row.amount.toString(), row.sypMinorPerUsd?.toString() ?? null,
              row.categoryId, row.description, row.occurredOn, row.businessDate, row.journalEntryId,
              row.createdBy,
            ],
          )
          return
        case 'exchange':
          await this.pool.query(
            `INSERT INTO company_fx_exchanges
               (id, branch_id, from_currency, from_amount_minor, to_currency, to_amount_minor,
                syp_minor_per_usd, reason, occurred_on, business_date, journal_entry_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              row.id, row.branchId, row.fromCurrency, row.fromAmount.toString(), row.toCurrency,
              row.toAmount.toString(), row.sypMinorPerUsd.toString(), row.reason, row.occurredOn,
              row.businessDate, row.journalEntryId, row.createdBy,
            ],
          )
          return
        case 'reversal':
          await this.pool.query(
            `INSERT INTO company_reversals
               (id, branch_id, target_kind, target_id, target_entry_id, syp_minor_per_usd, reason,
                occurred_on, business_date, journal_entry_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              row.id, row.branchId, row.targetKind, row.targetId, row.targetEntryId,
              row.sypMinorPerUsd?.toString() ?? null, row.reason, row.occurredOn, row.businessDate,
              row.journalEntryId, row.createdBy,
            ],
          )
          return
      }
    } catch (error) {
      if (isPgError(error, PG.UNIQUE_VIOLATION)) {
        throw duplicate(
          row.kind === 'reversal' ? 'DUPLICATE_REVERSAL' : 'DUPLICATE_COMPANY_COMMAND',
          `company ${row.kind} ${row.id} conflicts with a stored row`,
        )
      }
      throw error
    }
  }

  async findCommand(id: string): Promise<CompanyCommandRecord | null> {
    // A malformed key is simply not one this ledger ever stored.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM (${COMMANDS_SQL}) c WHERE c.id = $1`,
      [id],
    )
    return rows[0] ? commandFromRow(rows[0]) : null
  }

  async findCommandByEntry(journalEntryId: number): Promise<CompanyCommandRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM (${COMMANDS_SQL}) c WHERE c.journal_entry_id = $1`,
      [journalEntryId],
    )
    return rows[0] ? commandFromRow(rows[0]) : null
  }

  async findReversalOf(targetEntryId: number): Promise<CompanyReversalRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM (${COMMANDS_SQL}) c WHERE c.kind = 'reversal' AND c.target_entry_id = $1`,
      [targetEntryId],
    )
    return rows[0] ? (commandFromRow(rows[0]) as CompanyReversalRecord) : null
  }

  async listCommands(
    companyBranchId: string,
    range?: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyCommandRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM (${COMMANDS_SQL}) c
        WHERE c.branch_id = $1
          AND ($2::date IS NULL OR c.business_date >= $2::date)
          AND ($3::date IS NULL OR c.business_date <= $3::date)
        ORDER BY c.journal_entry_id`,
      [companyBranchId, range?.from ?? null, range?.to ?? null],
    )
    return rows.map(commandFromRow)
  }

  async cutoverFor(branchId: string): Promise<CompanyCutoverRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT *, opening_amount_minor::text AS opening_amount_minor
         FROM company_ledger_cutovers WHERE branch_id::text = $1`,
      [branchId],
    )
    return rows[0] ? cutoverFromRow(rows[0]) : null
  }

  async listCutovers(): Promise<CompanyCutoverRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT *, opening_amount_minor::text AS opening_amount_minor
         FROM company_ledger_cutovers ORDER BY performed_at, branch_id`,
    )
    return rows.map(cutoverFromRow)
  }

  async createCutover(row: CompanyCutoverRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO company_ledger_cutovers
           (branch_id, company_branch_id, opening_amount_minor, opening_entry_id, watermark_entry_id,
            business_date, reason, performed_by, mode, baseline_difference_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          row.branchId, row.companyBranchId, row.openingAmount.toString(), row.openingEntryId,
          row.watermarkEntryId, row.businessDate, row.reason, row.performedBy,
          row.mode ?? 'cash_opening', (row.baselineDifference ?? 0n).toString(),
        ],
      )
    } catch (error) {
      if (isPgError(error, PG.UNIQUE_VIOLATION)) {
        throw duplicate('DUPLICATE_CUTOVER', `branch ${row.branchId} is already cut over`)
      }
      throw error
    }
  }

  async latestEntryId(): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT COALESCE(max(id), 0)::text AS id FROM journal_entries',
    )
    return Number(rows[0]?.id ?? '0')
  }

  async createMirror(row: CompanyMirrorRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO company_restoration_mirrors
           (id, source_branch_id, source_entry_id, mirror_entry_id, direction, amount_minor,
            restoration_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          row.id, row.sourceBranchId, row.sourceEntryId, row.mirrorEntryId, row.direction,
          row.amount.toString(), row.restorationId, row.createdBy,
        ],
      )
    } catch (error) {
      if (isPgError(error, PG.UNIQUE_VIOLATION)) {
        throw duplicate('DUPLICATE_MIRROR', `entry ${row.sourceEntryId} is already mirrored`)
      }
      throw error
    }
  }

  async findMirrorBySource(sourceEntryId: number): Promise<CompanyMirrorRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT *, amount_minor::text AS amount_minor FROM company_restoration_mirrors WHERE source_entry_id = $1`,
      [sourceEntryId],
    )
    return rows[0] ? mirrorFromRow(rows[0]) : null
  }

  async listMirrors(sourceBranchId: string): Promise<CompanyMirrorRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT *, amount_minor::text AS amount_minor FROM company_restoration_mirrors
        WHERE source_branch_id::text = $1 ORDER BY source_entry_id`,
      [sourceBranchId],
    )
    return rows.map(mirrorFromRow)
  }

  async createHistoricalSettlement(row: CompanyHistoricalRestorationSettlement, expectedVersion: number): Promise<void> {
    if (row.version !== expectedVersion + 1) throw duplicate('HISTORICAL_SETTLEMENT_VERSION_CONFLICT', 'invalid historical settlement version')
    try {
      await this.pool.query(`INSERT INTO company_historical_restoration_settlements
        (id,company_branch_id,source_branch_id,version,cutover_watermark_entry_id,evidence_hash,request_hash,business_date,reason,payload,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [row.id,row.companyBranchId,row.sourceBranchId,row.version,row.cutoverWatermarkEntryId,row.evidenceHash,row.requestHash,
        row.businessDate,row.reason,settlementEncode(row),row.createdBy,new Date(row.createdAtMs)])
      // Three set-based evidence inserts, not one network round trip per source. Database guards
      // still inspect every row and prove the complete immutable batch at commit.
      const payload = settlementEncode(row)
      await this.pool.query(`INSERT INTO company_historical_restoration_settlement_groups
        (settlement_id,restoration_id,business_date,branch_net_minor,company_net_minor,variance_minor)
        SELECT $1,(g->>'restorationId')::bigint,(g->>'businessDate')::date,
          (g->'branchNet'->>'minor')::bigint,(g->'companyNet'->>'minor')::bigint,(g->'variance'->>'minor')::bigint
        FROM jsonb_array_elements($2::jsonb->'groups') g`, [row.id,payload])
      await this.pool.query(`INSERT INTO company_historical_restoration_settlement_sources
        (settlement_id,restoration_id,source_entry_id,direction,amount_minor)
        SELECT $1,(g->>'restorationId')::bigint,(s->>'sourceEntryId')::bigint,s->>'direction',(s->'amount'->>'minor')::bigint
        FROM jsonb_array_elements($2::jsonb->'groups') g CROSS JOIN LATERAL jsonb_array_elements(g->'branchSourceEntries') s`, [row.id,payload])
      await this.pool.query(`INSERT INTO company_historical_restoration_settlement_legs
        (settlement_id,restoration_id,source_reference,historical_journal_entry_id,direction,amount_minor,journal_entry_id)
        SELECT $1,(l->>'restorationId')::bigint,l->>'sourceReference',(l->>'historicalJournalEntryId')::bigint,
          l->>'direction',(l->'amount'->>'minor')::bigint,(l->>'journalEntryId')::bigint
        FROM jsonb_array_elements($2::jsonb->'legs') l`, [row.id,payload])
    } catch (error) {
      if (isPgError(error, PG.UNIQUE_VIOLATION)) throw duplicate('DUPLICATE_HISTORICAL_SETTLEMENT', 'historical source or restoration is already settled')
      if (typeof error === 'object' && error !== null && 'constraint' in error && error.constraint === 'company_historical_settlement_version_guard') {
        throw duplicate('HISTORICAL_SETTLEMENT_VERSION_CONFLICT', 'historical settlement version changed')
      }
      throw error
    }
  }

  async findHistoricalSettlement(id: string): Promise<CompanyHistoricalRestorationSettlement | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
    const { rows } = await this.pool.query<{ payload: unknown }>('SELECT payload FROM company_historical_restoration_settlements WHERE id=$1', [id])
    return rows[0] ? settlementDecode(rows[0].payload) : null
  }

  async listHistoricalSettlements(companyBranchId: string, sourceBranchId?: string): Promise<CompanyHistoricalRestorationSettlement[]> {
    const { rows } = await this.pool.query<{ payload: unknown }>(`SELECT payload FROM company_historical_restoration_settlements
      WHERE company_branch_id=$1 AND ($2::uuid IS NULL OR source_branch_id=$2) ORDER BY version,created_at,id`, [companyBranchId,sourceBranchId ?? null])
    return rows.map(row => settlementDecode(row.payload))
  }

  async findHistoricalSettlementBySource(historicalJournalEntryId: number): Promise<CompanyHistoricalRestorationSettlement | null> {
    const { rows } = await this.pool.query<{ payload: unknown }>(`SELECT s.payload FROM company_historical_restoration_settlements s
      JOIN company_historical_restoration_settlement_legs l ON l.settlement_id=s.id WHERE l.historical_journal_entry_id=$1`, [historicalJournalEntryId])
    return rows[0] ? settlementDecode(rows[0].payload) : null
  }
}

const zeroTotals = (): CompanyPeriodTotals => ({
  income: minor(0n),
  expense: minor(0n),
  deposits: minor(0n),
  withdrawals: minor(0n),
  net: minor(0n),
})

export class PgCompanyLedgerSource implements CompanyLedgerSource {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async readOverview(
    companyBranchId: string,
    range: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyOverviewRecord> {
    const pockets = { SYP_NEW: minor(0n), USD: minor(0n) } as Record<Currency, Minor>
    const reserves = { SYP_NEW: minor(0n), USD: minor(0n) } as Record<Currency, Minor>
    const balances = await this.pool.query<{ type: string; currency: Currency; balance: string }>(
      `SELECT f.type::text AS type, f.currency,
              COALESCE(SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END), 0)::text AS balance
         FROM funds f
         LEFT JOIN journal_lines jl ON jl.fund_id = f.id
        WHERE f.branch_id = $1::uuid
          AND f.type::text IN ('company_cash', 'depreciation_reserve')
        GROUP BY f.type, f.currency`,
      [companyBranchId],
    )
    for (const row of balances.rows) {
      const target = row.type === 'company_cash' ? pockets : reserves
      target[row.currency] = minor(BigInt(row.balance))
    }

    // Both sides of every branch's mirror in ONE statement: a restoration committing between two
    // reads must never show as a broken clearing account.
    const branches = await this.pool.query<{
      branch_id: string
      company_box: string
      clearing: string
      cut_over: boolean
    }>(
      `SELECT b.id::text AS branch_id,
              COALESCE((
                SELECT SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END)
                  FROM journal_lines jl JOIN funds f ON f.id = jl.fund_id
                 WHERE f.branch_id = b.id AND f.code = 'company_box'
              ), 0)::text AS company_box,
              COALESCE((
                SELECT SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END)
                  FROM journal_lines jl JOIN funds f ON f.id = jl.fund_id
                 WHERE f.branch_id = $1::uuid AND f.code = 'branch_clearing:' || b.id::text
              ), 0)::text AS clearing,
              EXISTS (SELECT 1 FROM company_ledger_cutovers c WHERE c.branch_id = b.id) AS cut_over
         FROM branches b
        WHERE b.kind = 'branch'
        ORDER BY b.code`,
      [companyBranchId],
    )

    const period = { SYP_NEW: zeroTotals(), USD: zeroTotals() } as Record<Currency, CompanyPeriodTotals>
    const flows = await this.pool.query<{ type: string; currency: Currency; role: string | null; signed: string }>(
      `SELECT f.type::text AS type, f.currency, jl.line_role AS role,
              SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END)::text AS signed
         FROM journal_entries je
         JOIN journal_lines jl ON jl.entry_id = je.id
         JOIN funds f ON f.id = jl.fund_id
        WHERE je.branch_id = $1::uuid
          AND je.business_date BETWEEN $2::date AND $3::date
          AND f.type::text IN ('company_income', 'company_expense', 'company_equity')
        GROUP BY f.type, f.currency, jl.line_role`,
      [companyBranchId, range.from, range.to],
    )
    for (const row of flows.rows) {
      const totals = period[row.currency]
      const signed = BigInt(row.signed)
      if (row.type === 'company_income') totals.income = minor(totals.income - signed)
      else if (row.type === 'company_expense') totals.expense = minor(totals.expense + signed)
      else if (row.role === 'deposit_source') totals.deposits = minor(totals.deposits - signed)
      else if (row.role === 'withdrawal_destination') totals.withdrawals = minor(totals.withdrawals + signed)
    }
    for (const currency of CURRENCIES) {
      const totals = period[currency]
      totals.net = minor(totals.income - totals.expense)
    }

    return {
      pockets,
      reserves,
      branches: branches.rows.map((r) => ({
        branchId: r.branch_id,
        companyBox: minor(BigInt(r.company_box)),
        clearing: minor(BigInt(r.clearing)),
        cutOver: r.cut_over,
      })),
      period,
    }
  }

  async listMovements(
    companyBranchId: string,
    range: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyMovementRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `WITH pocket AS (
         SELECT jl.entry_id, je.business_date, f.currency,
                SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END) AS delta
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN funds f ON f.id = jl.fund_id
          WHERE f.branch_id = $1::uuid
            AND f.type::text = 'company_cash'
          GROUP BY jl.entry_id, je.business_date, f.currency
       ),
       running AS (
         SELECT entry_id, currency,
                SUM(delta) OVER (PARTITION BY currency ORDER BY business_date, entry_id) AS after
           FROM pocket
       )
       SELECT je.*, ${JOURNAL_LINES_JSON} AS lines,
              (SELECT json_object_agg(r.currency, r.after::text) FROM running r WHERE r.entry_id = je.id) AS pocket_after
         FROM journal_entries je
         LEFT JOIN journal_lines jl ON jl.entry_id = je.id
         LEFT JOIN funds f ON f.id = jl.fund_id
        WHERE je.branch_id = $1::uuid
          AND je.business_date BETWEEN $2::date AND $3::date
        GROUP BY je.id
        ORDER BY je.business_date, je.id`,
      [companyBranchId, range.from, range.to],
    )
    return rows.map((r) => {
      const after = (r.pocket_after ?? {}) as Record<string, string>
      const pocketAfter: Partial<Record<Currency, Minor>> = {}
      for (const currency of CURRENCIES) {
        if (after[currency] !== undefined) pocketAfter[currency] = minor(BigInt(after[currency]))
      }
      return { entry: journalEntryFromRow(r), pocketAfter }
    })
  }

  async listHistoricalImportReceipts(companyBranchId: string,
    range: { from: CalendarDate; to: CalendarDate }): Promise<CompanyHistoricalImportReceiptRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT r.source_reference,r.source_position,r.occurred_on,r.movement_type,r.paid_from,r.source_branch_id,
              r.journal_entry_id,r.branch_journal_entry_id,r.restoration_id,
              r.original_evidence AS evidence,r.original_evidence->'payload' AS payload,
              j.syp_minor_per_usd::text AS journal_rate
         FROM company_historical_import_receipts r
         JOIN company_historical_import_batches b ON b.id=r.batch_id
         LEFT JOIN journal_entries j ON j.id=r.journal_entry_id
        WHERE b.branch_id=$1::uuid AND r.occurred_on BETWEEN $2::date AND $3::date
        ORDER BY r.occurred_on,r.source_position`, [companyBranchId, range.from, range.to])
    return rows.map(row => {
      const payload = row.payload as Record<string, unknown>
      const evidence = row.evidence as Record<string, unknown>
      const deltas = evidence.originalDeltas as number[]
      if (!Array.isArray(deltas) || deltas.length !== 4 || deltas.some(value => !Number.isSafeInteger(value))) {
        throw new Error(`invalid historical source deltas for ${String(row.source_reference)}`)
      }
      const currency = payload.currency === 'SYP_NEW' || payload.currency === 'USD' ? payload.currency : null
      const amount = currency === null ? null : parseMinor(String(payload.amount))
      const historicalRate = typeof payload.historicalRate === 'string' ? parseMinor(payload.historicalRate) : null
      return {
        sourceReference: String(row.source_reference), sourcePosition: Number(row.source_position), occurredOn: isoDate(row.occurred_on),
        movementType: row.movement_type as CompanyHistoricalImportReceiptRecord['movementType'],
        paidFrom: row.paid_from as CompanyHistoricalImportReceiptRecord['paidFrom'],
        currency, amount, description: String(payload.description ?? ''),
        originalAmount: String(evidence.originalAmount ?? ''), originalDescription: String(evidence.originalDescription ?? ''),
        sourceFunding: String(evidence.sourceFunding ?? ''), originalDeltas: deltas as [number,number,number,number],
        fromCurrency: payload.fromCurrency === 'SYP_NEW' || payload.fromCurrency === 'USD' ? payload.fromCurrency : null,
        fromAmount: typeof payload.fromAmount === 'string' ? parseMinor(payload.fromAmount) : null,
        toCurrency: payload.toCurrency === 'SYP_NEW' || payload.toCurrency === 'USD' ? payload.toCurrency : null,
        toAmount: typeof payload.toAmount === 'string' ? parseMinor(payload.toAmount) : null,
        rateBasis: payload.rateBasis === 'documented' || payload.rateBasis === 'estimated' ? payload.rateBasis : null,
        sypMinorPerUsd: row.journal_rate === null ? historicalRate : BigInt(String(row.journal_rate)),
        sourceBranchId: row.source_branch_id === null ? null : String(row.source_branch_id),
        journalEntryId: row.journal_entry_id === null ? null : Number(row.journal_entry_id),
        branchJournalEntryId: row.branch_journal_entry_id === null ? null : Number(row.branch_journal_entry_id),
        restorationId: row.restoration_id === null ? null : Number(row.restoration_id),
        linkStatus: typeof evidence.linkStatus === 'string' ? evidence.linkStatus : null,
        linkNote: typeof evidence.linkNote === 'string' ? evidence.linkNote : null,
      }
    })
  }
}

/** Advisory locks in the financial namespace, on the transaction's own connection. */
export class PgFinancialLocks implements FinancialLocks {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async acquire(lockKey: string): Promise<void> {
    await this.pool.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ash:financial:${lockKey}`])
  }
}
