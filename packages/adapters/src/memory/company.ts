import type {
  BranchRecord,
  CompanyCommandRecord,
  CompanyCutoverRecord,
  CompanyLedgerRepo,
  CompanyLedgerSource,
  CompanyMirrorRecord,
  CompanyMovementRecord,
  CompanyOverviewRecord,
  CompanyPeriodTotals,
  CompanyReversalRecord,
  FinancialLocks,
  JournalEntryRecord,
} from '@ash/contracts'
import { type CalendarDate, type Currency, CURRENCIES, type Minor, minor } from '@ash/domain'

/**
 * «صندوق الشركة» in memory (C2).
 *
 * The memory adapter has no triggers: it stores what it is given and refuses only what a unique
 * constraint would refuse. Every accounting rule 0067 enforces — the actor, the journal identity,
 * the exact lines, the mirror invariant — is proven against PostgreSQL, not here.
 */

const duplicate = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code })

export class MemoryCompanyLedgerRepo implements CompanyLedgerRepo {
  readonly commands = new Map<string, CompanyCommandRecord>()
  readonly cutovers = new Map<string, CompanyCutoverRecord>()
  readonly mirrors = new Map<string, CompanyMirrorRecord>()
  private readonly latest: () => number

  constructor(latestEntryId: () => number) {
    this.latest = latestEntryId
  }

  snapshot(): {
    commands: Map<string, CompanyCommandRecord>
    cutovers: Map<string, CompanyCutoverRecord>
    mirrors: Map<string, CompanyMirrorRecord>
  } {
    return {
      commands: new Map([...this.commands].map(([id, row]) => [id, structuredClone(row)])),
      cutovers: new Map([...this.cutovers].map(([id, row]) => [id, structuredClone(row)])),
      mirrors: new Map([...this.mirrors].map(([id, row]) => [id, structuredClone(row)])),
    }
  }

  restore(snapshot: ReturnType<MemoryCompanyLedgerRepo['snapshot']>): void {
    for (const [target, source] of [
      [this.commands, snapshot.commands],
      [this.cutovers, snapshot.cutovers],
      [this.mirrors, snapshot.mirrors],
    ] as const) {
      ;(target as Map<string, unknown>).clear()
      for (const [id, row] of source as Map<string, unknown>) (target as Map<string, unknown>).set(id, structuredClone(row))
    }
  }

  async createCommand(row: CompanyCommandRecord): Promise<void> {
    const key = row.id.toLowerCase()
    if (this.commands.has(key)) {
      throw duplicate('DUPLICATE_COMPANY_COMMAND', `company command ${row.id} already exists`)
    }
    const journalTaken = [...this.commands.values()].some((c) => c.journalEntryId === row.journalEntryId)
    if (journalTaken) throw duplicate('DUPLICATE_COMPANY_COMMAND', `entry ${row.journalEntryId} already has a command`)
    if (row.kind === 'reversal' && (await this.findReversalOf(row.targetEntryId)) !== null) {
      throw duplicate('DUPLICATE_REVERSAL', `entry ${row.targetEntryId} is already reversed`)
    }
    this.commands.set(key, structuredClone(row))
  }

  async findCommand(id: string): Promise<CompanyCommandRecord | null> {
    const row = this.commands.get(id.toLowerCase())
    return row ? structuredClone(row) : null
  }

  async findCommandByEntry(journalEntryId: number): Promise<CompanyCommandRecord | null> {
    const row = [...this.commands.values()].find((c) => c.journalEntryId === journalEntryId)
    return row ? structuredClone(row) : null
  }

  async findReversalOf(targetEntryId: number): Promise<CompanyReversalRecord | null> {
    const row = [...this.commands.values()].find(
      (c): c is CompanyReversalRecord => c.kind === 'reversal' && c.targetEntryId === targetEntryId,
    )
    return row ? structuredClone(row) : null
  }

  async listCommands(
    companyBranchId: string,
    range?: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyCommandRecord[]> {
    return [...this.commands.values()]
      .filter(
        (c) =>
          c.branchId === companyBranchId &&
          (range === undefined || (c.businessDate >= range.from && c.businessDate <= range.to)),
      )
      .sort((a, b) => a.journalEntryId - b.journalEntryId)
      .map((c) => structuredClone(c))
  }

  async cutoverFor(branchId: string): Promise<CompanyCutoverRecord | null> {
    const row = this.cutovers.get(branchId)
    return row ? structuredClone(row) : null
  }

  async listCutovers(): Promise<CompanyCutoverRecord[]> {
    return [...this.cutovers.values()]
      .sort((a, b) => a.performedAtMs - b.performedAtMs || (a.branchId < b.branchId ? -1 : 1))
      .map((c) => structuredClone(c))
  }

  async createCutover(row: CompanyCutoverRecord): Promise<void> {
    if (this.cutovers.has(row.branchId)) {
      throw duplicate('DUPLICATE_CUTOVER', `branch ${row.branchId} is already cut over`)
    }
    if ((row.openingAmount === 0n) !== (row.openingEntryId === null)) {
      throw new Error('a cutover has an opening entry exactly when its opening amount is positive')
    }
    this.cutovers.set(row.branchId, structuredClone(row))
  }

  async latestEntryId(): Promise<number> {
    return this.latest()
  }

  async createMirror(row: CompanyMirrorRecord): Promise<void> {
    const taken = [...this.mirrors.values()].some(
      (m) => m.id === row.id || m.sourceEntryId === row.sourceEntryId || m.mirrorEntryId === row.mirrorEntryId,
    )
    if (taken) throw duplicate('DUPLICATE_MIRROR', `entry ${row.sourceEntryId} is already mirrored`)
    this.mirrors.set(row.id, structuredClone(row))
  }

  async findMirrorBySource(sourceEntryId: number): Promise<CompanyMirrorRecord | null> {
    const row = [...this.mirrors.values()].find((m) => m.sourceEntryId === sourceEntryId)
    return row ? structuredClone(row) : null
  }

  async listMirrors(sourceBranchId: string): Promise<CompanyMirrorRecord[]> {
    return [...this.mirrors.values()]
      .filter((m) => m.sourceBranchId === sourceBranchId)
      .sort((a, b) => a.sourceEntryId - b.sourceEntryId)
      .map((m) => structuredClone(m))
  }
}

const zeroTotals = (): CompanyPeriodTotals => ({
  income: minor(0n),
  expense: minor(0n),
  deposits: minor(0n),
  withdrawals: minor(0n),
  net: minor(0n),
})

const signed = (line: JournalEntryRecord['lines'][number]): bigint => (line.side === 'D' ? line.amount : -line.amount)
const head = (fundCode: string): string => fundCode.split(':')[0] ?? ''

/** The memory twin of `PgCompanyLedgerSource` — the same sums over the same lines. */
export class MemoryCompanyLedgerSource implements CompanyLedgerSource {
  private readonly entries: () => readonly JournalEntryRecord[]
  private readonly branches: () => Promise<BranchRecord[]>
  private readonly company: MemoryCompanyLedgerRepo

  constructor(
    entries: () => readonly JournalEntryRecord[],
    branches: () => Promise<BranchRecord[]>,
    company: MemoryCompanyLedgerRepo,
  ) {
    this.entries = entries
    this.branches = branches
    this.company = company
  }

  private balance(branchId: string, fundCode: string): Minor {
    let total = 0n
    for (const entry of this.entries()) {
      if (entry.branchId !== branchId) continue
      for (const line of entry.lines) if (line.fundCode === fundCode) total += signed(line)
    }
    return minor(total)
  }

  async readOverview(
    companyBranchId: string,
    range: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyOverviewRecord> {
    const pockets = {} as Record<Currency, Minor>
    const reserves = {} as Record<Currency, Minor>
    for (const currency of CURRENCIES) {
      pockets[currency] = this.balance(companyBranchId, `company_cash:${currency}`)
      reserves[currency] = this.balance(companyBranchId, `depreciation_reserve:${currency}`)
    }
    const operating = (await this.branches()).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    const period = { SYP_NEW: zeroTotals(), USD: zeroTotals() } as Record<Currency, CompanyPeriodTotals>
    for (const entry of this.entries()) {
      if (entry.branchId !== companyBranchId) continue
      if (entry.businessDate < range.from || entry.businessDate > range.to) continue
      for (const line of entry.lines) {
        const totals = period[line.currency]
        const value = signed(line)
        switch (head(line.fundCode)) {
          case 'company_income':
            totals.income = minor(totals.income - value)
            break
          case 'company_expense':
            totals.expense = minor(totals.expense + value)
            break
          case 'company_equity':
            if (line.role === 'deposit_source') totals.deposits = minor(totals.deposits - value)
            else if (line.role === 'withdrawal_destination') totals.withdrawals = minor(totals.withdrawals + value)
            break
        }
      }
    }
    for (const currency of CURRENCIES) {
      period[currency].net = minor(period[currency].income - period[currency].expense)
    }
    return {
      pockets,
      reserves,
      branches: operating.map((b) => ({
        branchId: b.id,
        companyBox: this.balance(b.id, 'company_box'),
        clearing: this.balance(companyBranchId, `branch_clearing:${b.id}`),
        cutOver: this.company.cutovers.has(b.id),
      })),
      period,
    }
  }

  async listMovements(
    companyBranchId: string,
    range: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyMovementRecord[]> {
    const running: Record<Currency, bigint> = { SYP_NEW: 0n, USD: 0n }
    const out: CompanyMovementRecord[] = []
    const ordered = this.entries()
      .filter((e) => e.branchId === companyBranchId)
      .sort((a, b) => a.id - b.id)
    for (const entry of ordered) {
      const pocketAfter: Partial<Record<Currency, Minor>> = {}
      for (const line of entry.lines) {
        if (head(line.fundCode) !== 'company_cash') continue
        running[line.currency] += signed(line)
        pocketAfter[line.currency] = minor(running[line.currency])
      }
      if (entry.businessDate < range.from || entry.businessDate > range.to) continue
      out.push({ entry: structuredClone(entry), pocketAfter })
    }
    return out
  }
}

/** The memory unit of work already runs one transaction at a time; a lock is always held. */
export class MemoryFinancialLocks implements FinancialLocks {
  readonly taken: string[] = []
  async acquire(lockKey: string): Promise<void> {
    if (!this.taken.includes(lockKey)) this.taken.push(lockKey)
  }
}
