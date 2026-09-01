import type {
  AdvanceEventRecord,
  AdvanceOutstandingRecord,
  AdvanceRecord,
  AdvanceRepo,
} from '@ash/contracts'
import type { CalendarDate, Minor } from '@ash/domain'
import { minor } from '@ash/domain'

/**
 * «السلفة» — an expense that must come back, in memory.
 *
 * Modelled line for line on `MemoryIncomeRepo`, including the snapshot/restore pairs the in-memory
 * unit of work needs to roll a failed transaction back.
 *
 * `listOutstanding` reads what is still owed from the LEDGER, exactly as the Postgres repo does —
 * never by subtracting the event rows. The advance's own fund is the record; a second arithmetic
 * would be one more thing to keep in step with it, and the conformance suite would have no way to
 * notice when the two disagreed.
 */
export class MemoryAdvanceRepo implements AdvanceRepo {
  readonly rows = new Map<string, AdvanceRecord>()
  readonly events = new Map<string, AdvanceEventRecord>()

  /** Injected rather than imported so this repo stays as dumb as its Postgres twin. */
  private fundBalance: (branchId: string, fundCode: string) => bigint = () => 0n

  bindLedger(read: (branchId: string, fundCode: string) => bigint): void {
    this.fundBalance = read
  }

  async get(id: string): Promise<AdvanceRecord | null> {
    const row = this.rows.get(id)
    return row ? { ...row } : null
  }

  async create(advance: AdvanceRecord): Promise<void> {
    if (this.rows.has(advance.id)) {
      throw Object.assign(new Error(`duplicate advance ${advance.id}`), { code: 'DUPLICATE_ADVANCE' })
    }
    this.rows.set(advance.id, { ...advance })
  }

  async listByBranchAndDate(branchId: string, from: CalendarDate, to: CalendarDate): Promise<AdvanceRecord[]> {
    return [...this.rows.values()]
      .filter((a) => a.branchId === branchId && a.businessDate >= from && a.businessDate <= to)
      .sort((a, b) => (a.businessDate < b.businessDate ? -1 : 1))
  }

  async listOutstanding(branchId: string): Promise<AdvanceOutstandingRecord[]> {
    const out: AdvanceOutstandingRecord[] = []
    for (const advance of this.rows.values()) {
      if (advance.branchId !== branchId) continue
      const outstanding = this.fundBalance(branchId, fundCodeForAdvance(advance))
      const events = [...this.events.values()].filter((e) => e.advanceId === advance.id)
      const sumOf = (kind: AdvanceEventRecord['kind']): Minor =>
        minor(events.filter((e) => e.kind === kind).reduce((acc, e) => acc + e.amount, 0n))
      if (outstanding === 0n) continue
      out.push({
        advance: { ...advance },
        outstanding: minor(outstanding),
        repaid: sumOf('repayment'),
        converted: sumOf('conversion'),
      })
    }
    return out.sort((a, b) => (a.advance.businessDate < b.advance.businessDate ? 1 : -1))
  }

  async listParties(branchId: string): Promise<Array<{ partyName: string; partyKey: string }>> {
    const seen = new Map<string, string>()
    for (const a of this.rows.values()) {
      if (a.branchId !== branchId) continue
      // First spelling wins, so the suggestion list shows what somebody actually typed.
      if (!seen.has(a.partyKey)) seen.set(a.partyKey, a.partyName)
    }
    return [...seen].map(([partyKey, partyName]) => ({ partyKey, partyName }))
  }

  async getEvent(id: string): Promise<AdvanceEventRecord | null> {
    const row = this.events.get(id)
    return row ? { ...row } : null
  }

  async createEvent(event: AdvanceEventRecord): Promise<void> {
    if (this.events.has(event.id)) {
      throw Object.assign(new Error(`duplicate advance event ${event.id}`), { code: 'DUPLICATE_ADVANCE_EVENT' })
    }
    this.events.set(event.id, { ...event })
  }

  async listEvents(advanceId: string): Promise<AdvanceEventRecord[]> {
    return [...this.events.values()]
      .filter((e) => e.advanceId === advanceId)
      .sort((a, b) => (a.businessDate < b.businessDate ? -1 : 1))
  }

  snapshotRows(): { rows: Map<string, AdvanceRecord>; events: Map<string, AdvanceEventRecord> } {
    return {
      rows: new Map([...this.rows].map(([id, row]) => [id, structuredClone(row)])),
      events: new Map([...this.events].map(([id, row]) => [id, structuredClone(row)])),
    }
  }

  restoreRows(snapshot: { rows: Map<string, AdvanceRecord>; events: Map<string, AdvanceEventRecord> }): void {
    this.rows.clear()
    for (const [id, row] of snapshot.rows) this.rows.set(id, structuredClone(row))
    this.events.clear()
    for (const [id, row] of snapshot.events) this.events.set(id, structuredClone(row))
  }
}

/** The advance's own ledger fund — suffixed by the ADVANCE, never by the free-text party. */
export function fundCodeForAdvance(advance: Pick<AdvanceRecord, 'id' | 'channel'>): string {
  const kind = advance.channel === 'office_cash' ? 'advance_receivable_cash' : 'advance_receivable_wallet'
  return `${kind}:${advance.id}`
}
