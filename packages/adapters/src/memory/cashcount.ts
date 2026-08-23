import type { CashCountRecord, CashCountRepo } from '@ash/contracts'
import type { CalendarDate } from '@ash/domain'

export class MemoryCashCountRepo implements CashCountRepo {
  readonly rows = new Map<string, CashCountRecord>()
  private key = (branchId: string, date: CalendarDate) => `${branchId}|${date}`

  async create(count: CashCountRecord): Promise<CashCountRecord> {
    const key = this.key(count.branchId, count.businessDate)
    // One count per branch per day, mirroring the UNIQUE constraint. A second count would make
    // "what did we agree the drawer held" ambiguous.
    if (this.rows.has(key)) {
      throw Object.assign(new Error(`cash count already exists for ${count.businessDate}`), {
        code: 'DUPLICATE_COUNT',
      })
    }
    const stored = structuredClone(count)
    this.rows.set(key, stored)
    return structuredClone(stored)
  }

  async find(branchId: string, businessDate: CalendarDate): Promise<CashCountRecord | null> {
    const row = this.rows.get(this.key(branchId, businessDate))
    return row ? structuredClone(row) : null
  }

  async listDatesInRange(branchId: string, from: CalendarDate, to: CalendarDate): Promise<CalendarDate[]> {
    return [...this.rows.values()]
      .filter((r) => r.branchId === branchId && r.businessDate >= from && r.businessDate <= to)
      .map((r) => r.businessDate)
      .sort()
  }
}
