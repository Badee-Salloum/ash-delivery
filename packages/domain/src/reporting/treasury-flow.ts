/**
 * «كييش» and «شحن من الصندوق» — which `company_box` lines are treasury flows, and in which column.
 *
 * The owner's sheet totals «دخل الصندوق» and «خرج الصندوق» by SUMIF over a hand-typed Arabic word.
 * Here they come from the ledger:
 *
 *   1. A line that carries the role `kaish` or `shahn` says so itself. Every current writer — the
 *      restoration, the hand «كييش», and every new correction — stamps it.
 *   2. A legacy `restoration` line without a role: a DEBIT of `company_box` is money arriving in
 *      the company fund (كييش); a CREDIT is money leaving it (شحن).
 *   3. A legacy `correction` without a role is resolved through its `reversal-of-<id>` key to the
 *      ORIGINAL entry's first `company_box` line, recursively, so a reversal of a reversal lands
 *      back in the original column. Anything else — a correction of an unrelated manual
 *      company-box entry — is not a restoration flow and is `null`.
 *
 * A correction stays in its original's column with the opposite sign; reading it as a new flow in
 * the other column would report a reversed كييش as fresh شحن.
 *
 * Pure: the caller supplies a synchronous `lookup` over the entries it has loaded (the memory
 * adapter holds them all; the PostgreSQL adapter prefetches every link before calling this).
 */

export type TreasuryFlowRole = 'kaish' | 'shahn'

export interface TreasuryFlowLine {
  readonly fundCode: string
  readonly side: 'D' | 'C'
  readonly role?: string | null | undefined
}

export interface TreasuryFlowEntry {
  readonly id: number
  readonly eventType: string
  readonly occurrenceKey: string
  readonly lines: readonly TreasuryFlowLine[]
}

export const COMPANY_BOX_FUND = 'company_box'

/** Depth guard for a pathological chain; real chains are one or two links long. */
export const MAX_REVERSAL_DEPTH = 32

/** The entry id a `reversal-of-<id>` occurrence key points at, or null. */
export function reversalTargetId(occurrenceKey: string): number | null {
  const match = /^reversal-of-(\d+)$/.exec(occurrenceKey)
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * Could this line be a treasury flow at all? The cheap pre-filter both adapters apply before
 * resolving anything: a `company_box` line that carries a treasury role or belongs to a
 * restoration or a correction.
 */
export function isTreasuryFlowCandidate(eventType: string, line: TreasuryFlowLine): boolean {
  if (line.fundCode !== COMPANY_BOX_FUND) return false
  return line.role === 'kaish' || line.role === 'shahn' || eventType === 'restoration' || eventType === 'correction'
}

/**
 * The column a `company_box` line belongs in, or null when it is not a restoration flow.
 *
 * `lookup` answers an entry id with the entry (in the SAME branch) or nothing; an unresolvable
 * link is `null`, never a guess.
 */
export function treasuryRoleOf(
  entry: TreasuryFlowEntry,
  line: TreasuryFlowLine,
  lookup: (entryId: number) => TreasuryFlowEntry | null | undefined,
): TreasuryFlowRole | null {
  const visited = new Set<number>()
  let current = entry
  let currentLine = line
  for (let depth = 0; depth <= MAX_REVERSAL_DEPTH; depth += 1) {
    if (currentLine.role === 'kaish' || currentLine.role === 'shahn') return currentLine.role
    if (current.eventType === 'restoration') return currentLine.side === 'D' ? 'kaish' : 'shahn'
    if (current.eventType !== 'correction' || visited.has(current.id)) return null
    visited.add(current.id)
    const targetId = reversalTargetId(current.occurrenceKey)
    if (targetId === null) return null
    const original = lookup(targetId)
    const originalLine = original?.lines.find((candidate) => candidate.fundCode === COMPANY_BOX_FUND)
    if (!original || !originalLine) return null
    current = original
    currentLine = originalLine
  }
  return null
}

/**
 * The signed contribution of one classified line to its column: a كييش DEBIT and a شحن CREDIT are
 * positive; the opposite side (a correction) is negative.
 */
export function treasuryFlowAmount(role: TreasuryFlowRole, side: 'D' | 'C', amount: bigint): bigint {
  if (role === 'kaish') return side === 'D' ? amount : -amount
  return side === 'C' ? amount : -amount
}
