import type {
  LedgerRangeLine,
  LedgerRangeRecord,
  LedgerRangeSource,
  LedgerRangeTreasuryDay,
} from '@ash/contracts'
import {
  type CalendarDate,
  MAX_REVERSAL_DEPTH,
  type Posting,
  type TreasuryFlowEntry,
  type TreasuryFlowLine,
  compareLedgerRangeLines,
  minor,
  reversalTargetId,
  treasuryFlowAmount,
  treasuryRoleOf,
} from '@ash/domain'
import type { Pool } from './pool.ts'

/**
 * P2 — the range read model, in PostgreSQL.
 *
 * Three statements, each a single aggregate or a bounded read:
 *
 *   1. the report lines, grouped by (business date, event, fund, role, side, currency) and
 *      restricted in SQL to exactly what `isRangeReportLine` keeps;
 *   2. the driver share: Σ settlement `base_driver_share_minor` over every shift with any entry in
 *      the range, plus the legacy `share_split`/deduction lines for the ones without a snapshot;
 *   3. the company-fund flow candidates, whose legacy reversal links are then resolved by id, one
 *      batch per link depth, and classified by the domain's `treasuryRoleOf`.
 *
 * Every SUM is cast to `text` and parsed into a BigInt: `numeric` is refused by the driver on
 * purpose (see `pool.ts`), and money never passes through a JS number.
 *
 * The rows are re-sorted with `compareLedgerRangeLines` rather than trusted to `ORDER BY`, because
 * the database's collation need not be the code-unit order the in-memory twin uses.
 */

/** The SQL twin of `isRangeReportLine`. Kept beside the reader so the two are reviewed together. */
const REPORT_LINE_FILTER = `(
       f.code IN ('company_revenue', 'other_income', 'yalago_income', 'company_box')
    OR left(f.code, 12) = 'cost_center:'
    OR (left(f.code, 21) = 'driver_share_payable:' AND jl.line_role IN ('driver_share', 'cash_deduction_share'))
    OR (left(f.code, 23) = 'driver_receivable_cash:' AND jl.line_role = 'cash_deduction_overflow')
  )`

/** The SQL twin of `isLegacyDriverShareLine`. */
const LEGACY_SHARE_FILTER = `(
       (left(f.code, 21) = 'driver_share_payable:' AND jl.line_role IN ('driver_share', 'cash_deduction_share'))
    OR (left(f.code, 23) = 'driver_receivable_cash:' AND jl.line_role = 'cash_deduction_overflow')
  )`

const isTreasuryRole = (role: string | null | undefined): boolean => role === 'kaish' || role === 'shahn'

export class PgLedgerRangeSource implements LedgerRangeSource {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async firstActivityDate(branchId: string): Promise<CalendarDate | null> {
    const { rows } = await this.pool.query<{ first: string | null }>(
      'SELECT MIN(business_date)::text AS first FROM journal_entries WHERE branch_id = $1',
      [branchId],
    )
    return rows[0]?.first ?? null
  }

  async readRange(branchId: string, from: CalendarDate, to: CalendarDate): Promise<LedgerRangeRecord> {
    const params = [branchId, from, to]

    const lineRows = await this.pool.query<{
      business_date: string
      event_type: string
      fund_code: string
      line_role: string | null
      side: 'D' | 'C'
      currency: string
      amount: string
      line_count: number
    }>(
      `SELECT je.business_date::text AS business_date,
              je.event_type::text   AS event_type,
              f.code                AS fund_code,
              jl.line_role,
              jl.side,
              f.currency,
              SUM(jl.amount_minor)::text AS amount,
              COUNT(*)::int              AS line_count
         FROM journal_entries je
         JOIN journal_lines jl ON jl.entry_id = je.id
         JOIN funds f ON f.id = jl.fund_id
        WHERE je.branch_id = $1
          AND je.business_date BETWEEN $2 AND $3
          AND ${REPORT_LINE_FILTER}
        GROUP BY je.business_date, je.event_type, f.code, jl.line_role, jl.side, f.currency`,
      params,
    )
    const lines: LedgerRangeLine[] = lineRows.rows
      .map((r) => ({
        businessDate: r.business_date,
        eventType: r.event_type as Posting['eventType'],
        fundCode: r.fund_code,
        role: r.line_role,
        side: r.side,
        currency: r.currency,
        amount: minor(BigInt(r.amount)),
        lineCount: Number(r.line_count),
      }))
      .sort(compareLedgerRangeLines)

    const shareRows = await this.pool.query<{ settled: string; legacy: string }>(
      `WITH ranged AS (
         SELECT je.id, je.shift_id
           FROM journal_entries je
          WHERE je.branch_id = $1
            AND je.business_date BETWEEN $2 AND $3
       ),
       touched AS (
         SELECT DISTINCT shift_id FROM ranged WHERE shift_id IS NOT NULL
       ),
       legacy AS (
         SELECT ranged.shift_id,
                SUM(CASE WHEN jl.side = 'C' THEN jl.amount_minor ELSE -jl.amount_minor END) AS amount
           FROM ranged
           JOIN journal_lines jl ON jl.entry_id = ranged.id
           JOIN funds f ON f.id = jl.fund_id
          WHERE ${LEGACY_SHARE_FILTER}
          GROUP BY ranged.shift_id
       )
       SELECT
         COALESCE((
           SELECT SUM(ss.base_driver_share_minor)
             FROM touched t
             JOIN shift_settlements ss ON ss.shift_id = t.shift_id
         ), 0)::text AS settled,
         (
           COALESCE((SELECT amount FROM legacy WHERE shift_id IS NULL), 0)
           + COALESCE((
               SELECT SUM(l.amount)
                 FROM legacy l
                WHERE l.shift_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM shift_settlements ss WHERE ss.shift_id = l.shift_id)
             ), 0)
         )::text AS legacy`,
      params,
    )
    const share = shareRows.rows[0]

    const treasuryDays = await this.treasuryDays(branchId, from, to)

    return {
      from,
      to,
      lines,
      settledDriverShare: minor(BigInt(share?.settled ?? '0')),
      legacyDriverShare: minor(BigInt(share?.legacy ?? '0')),
      treasuryDays,
    }
  }

  private async treasuryDays(branchId: string, from: CalendarDate, to: CalendarDate): Promise<LedgerRangeTreasuryDay[]> {
    const { rows: candidates } = await this.pool.query<{
      entry_id: string
      business_date: string
      event_type: string
      occurrence_key: string
      side: 'D' | 'C'
      amount: string
      line_role: string | null
    }>(
      `SELECT je.id::text AS entry_id,
              je.business_date::text AS business_date,
              je.event_type::text AS event_type,
              je.occurrence_key,
              jl.side,
              jl.amount_minor::text AS amount,
              jl.line_role
         FROM journal_entries je
         JOIN journal_lines jl ON jl.entry_id = je.id
         JOIN funds f ON f.id = jl.fund_id
        WHERE je.branch_id = $1
          AND je.business_date BETWEEN $2 AND $3
          AND f.code = 'company_box'
          AND (jl.line_role IN ('kaish', 'shahn') OR je.event_type IN ('restoration', 'correction'))
        ORDER BY je.id, jl.id`,
      [branchId, from, to],
    )
    if (candidates.length === 0) return []

    // Resolve legacy reversal links by id, one batch per depth. Only a role-less correction ever
    // needs its original; everything else classifies from its own line.
    const originals = new Map<number, TreasuryFlowEntry>()
    let pending = new Set<number>()
    for (const c of candidates) {
      if (c.event_type !== 'correction' || isTreasuryRole(c.line_role)) continue
      const target = reversalTargetId(c.occurrence_key)
      if (target !== null) pending.add(target)
    }
    for (let depth = 0; pending.size > 0 && depth <= MAX_REVERSAL_DEPTH; depth += 1) {
      const ids = [...pending].filter((id) => !originals.has(id))
      pending = new Set()
      if (ids.length === 0) break
      const { rows } = await this.pool.query<{
        id: string
        event_type: string
        occurrence_key: string
        side: 'D' | 'C' | null
        line_role: string | null
      }>(
        `SELECT je.id::text AS id,
                je.event_type::text AS event_type,
                je.occurrence_key,
                first_box.side,
                first_box.line_role
           FROM journal_entries je
           LEFT JOIN LATERAL (
             SELECT jl.side, jl.line_role
               FROM journal_lines jl
               JOIN funds f ON f.id = jl.fund_id
              WHERE jl.entry_id = je.id AND f.code = 'company_box'
              ORDER BY jl.id
              LIMIT 1
           ) first_box ON true
          WHERE je.branch_id = $1
            AND je.id = ANY($2::bigint[])`,
        [branchId, ids.map(String)],
      )
      for (const r of rows) {
        const id = Number(r.id)
        const boxLine: TreasuryFlowLine | null =
          r.side === null ? null : { fundCode: 'company_box', side: r.side, role: r.line_role }
        originals.set(id, {
          id,
          eventType: r.event_type,
          occurrenceKey: r.occurrence_key,
          lines: boxLine === null ? [] : [boxLine],
        })
        if (r.event_type === 'correction' && boxLine !== null && !isTreasuryRole(boxLine.role)) {
          const next = reversalTargetId(r.occurrence_key)
          if (next !== null && !originals.has(next)) pending.add(next)
        }
      }
    }

    const perDay = new Map<CalendarDate, { kaish: bigint; shahn: bigint }>()
    for (const c of candidates) {
      const line: TreasuryFlowLine = { fundCode: 'company_box', side: c.side, role: c.line_role }
      const entry: TreasuryFlowEntry = {
        id: Number(c.entry_id),
        eventType: c.event_type,
        occurrenceKey: c.occurrence_key,
        lines: [line],
      }
      const role = treasuryRoleOf(entry, line, (id) => originals.get(id))
      if (role === null) continue
      const day = perDay.get(c.business_date) ?? { kaish: 0n, shahn: 0n }
      day[role] += treasuryFlowAmount(role, c.side, BigInt(c.amount))
      perDay.set(c.business_date, day)
    }
    return [...perDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([businessDate, day]) => ({ businessDate, kaish: minor(day.kaish), shahn: minor(day.shahn) }))
  }
}
