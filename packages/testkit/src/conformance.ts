import { describe, expect, it } from 'vitest'
import type {
  BatteryReadingRecord,
  CompanyCommandRecord,
  Deps,
  ExpenseRecord,
  GpsPingRecord,
  NewShiftSettlementRecord,
  OcrReadClaimInput,
  OcrReadCompletion,
  OcrResult,
  ShiftRecord,
} from '@ash/contracts'
// P2 — the range read model conformance.
import type { JournalEntryRecord, LedgerRangeRecord } from '@ash/contracts'
import { serializeMoney } from '@ash/contracts'
import { lockBranchThenCompany } from '@ash/contracts'
import {
  type Currency,
  type FundRef,
  type Posting,
  cashSettledReturnPostings,
  companyDeposit,
  companyExpense,
  companyFxExchange,
  companyIncome,
  companyOpeningTransfer,
  companyReversal,
  companyWithdrawal,
  currencyOf,
  fundCode,
  manualKaish,
  minor,
  money,
  planFixedShareSettlement,
  receivableAdjustment,
  restorationMirror,
} from '@ash/domain'
import {
  expense as expensePosting,
  planRestoration,
  postingsForRestoration,
  reverse,
  weekStartFor,
} from '@ash/domain'

/** `Omit` that keeps a union a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * The conformance suite.
 *
 * Every implementation of the ports must pass this, unchanged. The in-memory adapters run it in
 * milliseconds on any laptop; the PostgreSQL adapters run it in CI against a real Postgres 17.
 *
 * The point is not coverage — it is that a behaviour which differs between the two is a bug in
 * one of them, and this is the only place it can be caught. Without a shared suite, "it works
 * in the tests" and "it works in production" are two different claims.
 */

export interface ConformanceContext {
  /**
   * A fresh, empty set of dependencies. Called before every test.
   *
   * The directory must hold exactly two rows: the operating branch `BRANCH` (DAM, kind `branch`) and
   * the company row `COMPANY_BRANCH` (HQ, kind `company`, branch number 0) — what migration 0066 and
   * `seedReferenceData` leave in a real database.
   */
  makeDeps(): Promise<Deps> | Deps
  /** Optional teardown (close a pool, drop a schema). */
  cleanup?(deps: Deps): Promise<void> | void
  /**
   * Plant a fund row whose stored currency is `currency`, as a hand-written SQL insert could have
   * left it — so the suite can prove both adapters refuse to post through a mismatched fund.
   */
  plantFund(deps: Deps, branchId: string, fund: { code: string; type: string; currency: Currency }): Promise<void>
  label: string
}

/** The company (HQ) row — the fixed id migration 0066 and `seedReferenceData` both write. */
export const COMPANY_BRANCH = '10000000-0000-4000-8000-000000000100'
/** The operating branch every conformance fixture uses. */
export const CONFORMANCE_BRANCH = '11111111-1111-1111-1111-111111111111'

const syp = (n: number) => minor(BigInt(n) * 100n)

const BRANCH = '11111111-1111-1111-1111-111111111111'
const USER = '22222222-2222-2222-2222-222222222222'
const SHIFT = '55555555-5555-5555-5555-555555555555'
const OTHER_SHIFT = '55555555-5555-5555-5555-555555555556'
const DRIVER = '77777777-7777-7777-7777-777777777777'
const OTHER_DRIVER = '77777777-7777-7777-7777-777777777778'
const OTHER_VEHICLE = '88888888-8888-8888-8888-888888888889'
const BATTERY = '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const MEDIA_1 = '99999999-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const MEDIA_2 = '99999999-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const ORDER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const ORDER_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'

const settlement = (overrides: Partial<NewShiftSettlementRecord> = {}): NewShiftSettlementRecord => ({
  shiftId: SHIFT,
  branchId: BRANCH,
  driverId: DRIVER,
  businessDate: '2026-07-21',
  policyCode: 'fixed_40_cash_close_v2_receivable',
  driverRateBps: 4_000,
  deliveryFeeTotal: syp(100_000),
  fixedDriverShare: syp(40_000),
  manualDriverShare: syp(0),
  grossDriverShare: syp(40_000),
  cashDeductionTotal: syp(0),
  baseDriverShare: syp(40_000),
  managerCharge: syp(0),
  expectedTotal: syp(230_000),
  actualCash: syp(240_000),
  actualWallet: syp(-10_000),
  actualTotal: syp(230_000),
  variance: syp(0),
  varianceDirection: 'balanced',
  finalEmployeeCash: syp(40_000),
  cashClaimToOffice: syp(200_000),
  walletClaimToOffice: syp(-10_000),
  cashReceivableDeferred: syp(0),
  walletReceivableDeferred: syp(0),
  maximumCashShortageReceivable: syp(0),
  cashShortageReceivable: syp(0),
  walletToOffice: syp(-10_000),
  cashToOffice: syp(200_000),
  walletAction: 'fund',
  walletAmount: syp(10_000),
  cashAction: 'collect',
  cashAmount: syp(200_000),
  reviewedOrdersHash: 'b'.repeat(32),
  settlementHash: 'a'.repeat(64),
  walletTransferConfirmed: true,
  cashSettlementConfirmed: true,
  confirmedBy: USER,
  confirmedAtMs: 1_784_000_000_000,
  varianceReason: null,
  ...overrides,
})

const batteryReading = (overrides: Partial<BatteryReadingRecord> = {}): BatteryReadingRecord => ({
  shiftId: SHIFT,
  batteryId: BATTERY,
  package: 'start',
  slotNo: 1,
  percent: 61,
  packMillivolts: 72_110,
  cycleCount: 201,
  remainCapacityDah: 311,
  fullCapacityDah: 500,
  mosTempDc: 321,
  t1Dc: 315,
  t2Dc: 318,
  mediaId: MEDIA_1,
  source: 'ocr',
  unavailable: false,
  ocrRaw: { percent: 61, cycleCount: 201 },
  batterySwapId: null,
  ...overrides,
})

const transfer = (occurrenceKey: string, amount = syp(1_000)): Posting => ({
  eventType: 'float_out',
  occurrenceKey,
  lines: [
    { fund: { kind: 'driver_cash', driverId: DRIVER }, side: 'D', amount },
    { fund: { kind: 'office_cash' }, side: 'C', amount },
  ],
})

const META = {
  shiftId: SHIFT,
  businessDate: '2026-07-21',
  postingDate: '2026-07-21',
  weekStartDate: '2026-07-19',
  fxDayId: 1,
  sypMinorPerUsd: null,
  createdBy: USER,
}

export function runConformanceSuite(ctx: ConformanceContext): void {
  describe(`port conformance — ${ctx.label}`, () => {
    async function fresh(): Promise<Deps> {
      return await ctx.makeDeps()
    }

    async function freshSettlement(): Promise<Deps> {
      const deps = await fresh()
      const shift = await deps.shifts.findById(SHIFT)
      if (!shift) throw new Error('conformance shift missing')
      await deps.shifts.update({
        ...shift,
        state: 'pending_review',
        submittedAt: '2026-07-21T05:00:00.000Z',
      }, USER)
      return deps
    }

    async function createAndApproveSettlement(
      deps: Deps,
      record: NewShiftSettlementRecord,
    ): Promise<Awaited<ReturnType<Deps['settlements']['create']>>> {
      return deps.closeUnitOfWork.run({ shiftId: SHIFT, actorId: USER }, async (transaction) => {
        // Exercise the real close order and canonical return recipe in every port: journals first,
        // immutable settlement second, terminal projection last. Pin expectedWallet to actualWallet
        // so this repository-focused fixture has a known zero wallet split without fabricating the
        // order/adjustment inputs that the API uses to calculate it.
        const plan = planFixedShareSettlement({
          deliveryFeeTotal: record.deliveryFeeTotal,
          fixedDriverShare: record.fixedDriverShare,
          manualDriverShare: record.manualDriverShare,
          cashDeductionTotal: record.cashDeductionTotal,
          expectedCash: minor(record.expectedTotal - record.actualWallet),
          expectedWallet: record.actualWallet,
          actualCash: record.actualCash,
          actualWallet: record.actualWallet,
          cashReceivableDeferred: record.cashReceivableDeferred,
          walletReceivableDeferred: record.walletReceivableDeferred,
        })
        await transaction.ledger.post(
          record.branchId,
          cashSettledReturnPostings({ driverId: record.driverId, settlement: plan }),
          {
            shiftId: record.shiftId,
            businessDate: record.businessDate,
            postingDate: record.businessDate,
            weekStartDate: '2026-07-19',
            fxDayId: 1,
            sypMinorPerUsd: null,
            createdBy: USER,
            ...(record.varianceReason === null ? {} : { reason: record.varianceReason }),
          },
        )
        const created = await transaction.settlements.create(record)
        const pending = await transaction.shifts.findById(SHIFT)
        if (!pending) throw new Error('conformance shift missing while approving settlement')
        await transaction.shifts.update({
          ...pending,
          state: 'approved',
          approvedBy: USER,
          keptAsReceivable: created.cashReceivableDeferred,
          walletDiff: minor(0n),
        }, USER)
        return created
      })
    }

    describe('working-now shift counts', () => {
      it('counts distinct open actors across dates and excludes suspended shifts', async () => {
        const deps = await fresh()
        const original = await deps.shifts.findById(SHIFT)
        if (!original) throw new Error('conformance shift missing')

        expect(await deps.shifts.countOpenActorsForBranch(BRANCH)).toEqual({ drivers: 0, vehicles: 0 })

        await deps.shifts.update({ ...original, state: 'open' }, USER)
        expect(await deps.shifts.countOpenActorsForBranch(BRANCH)).toEqual({ drivers: 1, vehicles: 1 })

        // Production's partial unique indexes forbid two live shifts for the same driver or
        // vehicle. Use the second seeded assignment to keep this fixture valid in PostgreSQL.
        const distinct: ShiftRecord = {
          ...original,
          id: OTHER_SHIFT,
          driverId: OTHER_DRIVER,
          vehicleId: OTHER_VEHICLE,
          state: 'open',
          businessDate: '2026-07-20',
          shiftNo: 1,
        }
        await deps.shifts.create(distinct, USER)
        expect(await deps.shifts.countOpenActorsForBranch(BRANCH)).toEqual({ drivers: 2, vehicles: 2 })

        await deps.shifts.update({ ...distinct, state: 'suspended' }, USER)
        expect(await deps.shifts.countOpenActorsForBranch(BRANCH)).toEqual({ drivers: 1, vehicles: 1 })

        await deps.shifts.update({ ...original, state: 'pending_review' }, USER)
        expect(await deps.shifts.countOpenActorsForBranch(BRANCH)).toEqual({ drivers: 0, vehicles: 0 })
      })
    })

    // ── P2: the range read model and the timing-only shift read ──────────────────────────────
    describe('P2 range read model (LedgerRangeSource) and shift timing', () => {
      const WEEK_ONE = '2026-07-19'
      const WEEK_TWO = '2026-07-26'
      const RANGE_REASON = 'range read model conformance'

      interface RangeFixture {
        kaishAmount: bigint
        shahnAmount: bigint
      }

      /**
       * Everything the dashboard's range read has to get right, posted through the real ports:
       * a settled shift approval (its share_split must NOT count as legacy share), a legacy shift
       * with a deduction overflow, a shift-less legacy share line, a vehicle expense on a bare-uuid
       * cost centre, owner funding into the office boxes and the company fund, a ledger-backed
       * restoration (one كييش leg, one شحن leg), corrections of both, and a reversal of the شحن
       * correction in the NEXT financial week — whose original lives outside a second-week range.
       */
      async function seedRangeFixture(deps: Deps): Promise<RangeFixture> {
        const fxDayId = (await deps.fx.idFor('2026-07-21')) ?? await deps.fx.upsert({
          businessDate: '2026-07-21',
          sypMinorPerUsd: 13_000n,
          provisional: false,
        })
        const on = (businessDate: string, shiftId: string | null, reason?: string) => ({
          shiftId,
          businessDate,
          postingDate: businessDate,
          weekStartDate: weekStartFor(businessDate),
          fxDayId,
          // Branch postings carry no USD line, so they freeze no rate (C1: the field is required).
          sypMinorPerUsd: null,
          createdBy: USER,
          ...(reason === undefined ? {} : { reason }),
        })

        // A settled shift: its gross share_split is on the ledger, but its settlement decides.
        await deps.ledger.post(BRANCH, [{
          eventType: 'share_split',
          occurrenceKey: 'range-split',
          lines: [
            { fund: { kind: 'fee_earned' }, side: 'D', amount: syp(100_000) },
            { fund: { kind: 'driver_share_payable', driverId: DRIVER }, side: 'C', amount: syp(40_000), role: 'driver_share' },
            { fund: { kind: 'company_revenue' }, side: 'C', amount: syp(40_000) },
            { fund: { kind: 'yalago_income' }, side: 'C', amount: syp(20_000) },
          ],
        }], on('2026-07-21', SHIFT))
        await createAndApproveSettlement(deps, settlement())

        // A legacy shift with no settlement, one day earlier, on the other seeded driver and bike.
        const original = await deps.shifts.findById(SHIFT)
        if (!original) throw new Error('conformance shift missing')
        await deps.shifts.create({
          ...original,
          id: OTHER_SHIFT,
          driverId: OTHER_DRIVER,
          vehicleId: OTHER_VEHICLE,
          state: 'draft',
          businessDate: '2026-07-20',
          shiftNo: 1,
          submittedAt: null,
          approvedBy: null,
          keptAsReceivable: minor(0n),
          walletDiff: null,
        }, USER)
        await deps.ledger.post(BRANCH, [
          {
            eventType: 'share_split',
            occurrenceKey: 'legacy-split',
            lines: [
              { fund: { kind: 'fee_earned' }, side: 'D', amount: syp(5_000) },
              { fund: { kind: 'driver_share_payable', driverId: OTHER_DRIVER }, side: 'C', amount: syp(2_000), role: 'driver_share' },
              { fund: { kind: 'company_revenue' }, side: 'C', amount: syp(2_000) },
              { fund: { kind: 'yalago_income' }, side: 'C', amount: syp(1_000) },
            ],
          },
          {
            eventType: 'driver_cash_deduction',
            occurrenceKey: 'legacy-deduction',
            lines: [
              { fund: { kind: 'driver_share_payable', driverId: OTHER_DRIVER }, side: 'D', amount: syp(300), role: 'cash_deduction_share' },
              { fund: { kind: 'driver_receivable_cash', driverId: OTHER_DRIVER }, side: 'D', amount: syp(100), role: 'cash_deduction_overflow' },
              { fund: { kind: 'driver_cash', driverId: OTHER_DRIVER }, side: 'C', amount: syp(400), role: 'cash_deduction' },
            ],
          },
        ], on('2026-07-20', OTHER_SHIFT))

        // Shift-less: a legacy share line, the owner's capital, and a vehicle expense.
        await deps.ledger.post(BRANCH, [{
          eventType: 'manual',
          occurrenceKey: 'legacy-shiftless-share',
          lines: [
            { fund: { kind: 'office_cash' }, side: 'D', amount: syp(50) },
            { fund: { kind: 'driver_share_payable', driverId: DRIVER }, side: 'C', amount: syp(50), role: 'driver_share' },
          ],
        }], on('2026-07-22', null, RANGE_REASON))
        await deps.ledger.post(BRANCH, [{
          eventType: 'manual',
          occurrenceKey: 'range-owner-funding',
          lines: [
            { fund: { kind: 'office_cash' }, side: 'D', amount: syp(90_000) },
            { fund: { kind: 'office_wallet' }, side: 'D', amount: syp(20_000) },
            { fund: { kind: 'company_box' }, side: 'D', amount: syp(5_000) },
            { fund: { kind: 'cost_center', costCenterId: 'owner_funding' }, side: 'C', amount: syp(115_000) },
          ],
        }], on('2026-07-21', null, RANGE_REASON))
        await deps.ledger.post(
          BRANCH,
          [expensePosting('office_cash', OTHER_VEHICLE, syp(700), 'range-vehicle-expense')],
          on('2026-07-22', null, 'charging D2'),
        )

        // A ledger-backed restoration exactly as the API performs it: sweep 50 of cash, fund 30 of wallet.
        const kaishAmount = syp(50)
        const shahnAmount = syp(30)
        const restoration = await deps.financialUnitOfWork.run(
          { lockKey: `receivables:${BRANCH}`, actorId: USER, requestId: 'range-restoration' },
          async (tx) => {
            const [ordinary, funding, advances] = await Promise.all([
              tx.ledger.balancesByPrefix(BRANCH, 'driver_receivable_'),
              tx.ledger.balancesByPrefix(BRANCH, 'driver_shift_funding_'),
              tx.ledger.balancesByPrefix(BRANCH, 'advance_receivable_'),
            ])
            const prefixed = (balances: Record<string, bigint>, prefix: string): bigint =>
              Object.entries(balances)
                .filter(([code]) => code.startsWith(prefix))
                .reduce((total, [, balance]) => total + balance, 0n)
            const positionOf = async (fundCode: 'office_cash' | 'office_wallet') => {
              const channel = fundCode === 'office_cash' ? 'cash' : 'wallet'
              return {
                fundCode,
                officeBalance: await tx.ledger.fundBalance(BRANCH, fundCode),
                receivables: minor(
                  prefixed(ordinary, `driver_receivable_${channel}:`) + prefixed(funding, `driver_shift_funding_${channel}:`),
                ),
                advances: minor(prefixed(advances, `advance_receivable_${channel}:`)),
              }
            }
            const cash = await positionOf('office_cash')
            const wallet = await positionOf('office_wallet')
            const cashTarget = minor(cash.officeBalance + cash.receivables + cash.advances - kaishAmount)
            const walletTarget = minor(wallet.officeBalance + wallet.receivables + wallet.advances + shahnAmount)
            for (const [fundCode, target] of [['office_cash', cashTarget], ['office_wallet', walletTarget]] as const) {
              await tx.capitalTargets.upsert({
                branchId: BRANCH,
                fundCode,
                target,
                effectiveFrom: '2026-07-21',
                createdBy: USER,
                note: RANGE_REASON,
              })
            }
            const plan = planRestoration([
              { ...cash, capitalTarget: cashTarget },
              { ...wallet, capitalTarget: walletTarget },
            ])
            if (!plan.feasible) throw new Error(`range restoration infeasible: ${plan.refusals.join(',')}`)
            const postings = postingsForRestoration(plan, '2026-07-21#1')
            const entries = await tx.ledger.post(BRANCH, postings, on('2026-07-21', null, RANGE_REASON))
            if (entries.length !== 2) throw new Error('range restoration did not post both legs')
            await tx.restorations.create({
              branchId: BRANCH,
              businessDate: '2026-07-21',
              runNo: 1,
              cashCountId: null,
              plan: {
                schemaVersion: 4,
                source: 'live_ledger',
                openingBalances: plan.legs.map((leg) => ({
                  fundCode: leg.fundCode,
                  balance: serializeMoney(leg.officeBalance),
                })),
                restorationJournalEntryIds: entries.map((entry) => entry.id),
                legs: plan.legs.map((leg) => ({
                  fundCode: leg.fundCode,
                  officeBalance: serializeMoney(leg.officeBalance),
                  receivables: serializeMoney(leg.receivables),
                  advances: serializeMoney(leg.advances),
                  position: serializeMoney(leg.position),
                  capitalTarget: serializeMoney(leg.capitalTarget),
                  delta: serializeMoney(leg.delta),
                  direction: leg.direction,
                  amount: serializeMoney(leg.amount),
                  feasible: leg.feasible,
                  refusals: leg.refusals,
                })),
              },
              netToCompany: plan.netToCompany,
              reason: RANGE_REASON,
              performedBy: USER,
            })
            return { postings, entries }
          },
        )
        const kaishIndex = restoration.postings.findIndex((posting) => posting.lines.some((line) => line.role === 'kaish'))
        const shahnIndex = kaishIndex === 0 ? 1 : 0
        const kaishPosting = restoration.postings[kaishIndex]!
        const shahnPosting = restoration.postings[shahnIndex]!
        const kaishEntry = restoration.entries.find((entry) => entry.occurrenceKey === kaishPosting.occurrenceKey)!
        const shahnEntry = restoration.entries.find((entry) => entry.occurrenceKey === shahnPosting.occurrenceKey)!

        // Corrections of both legs two days later. The شحن leg's company_box line carries no role,
        // so its correction can only be classified by following the reversal link.
        const shahnCorrection = reverse(shahnPosting, `reversal-of-${shahnEntry.id}`)
        const [, shahnCorrectionEntry] = await deps.ledger.post(
          BRANCH,
          [reverse(kaishPosting, `reversal-of-${kaishEntry.id}`), shahnCorrection],
          on('2026-07-23', null, RANGE_REASON),
        )
        if (!shahnCorrectionEntry) throw new Error('range correction did not post')
        // The double reversal, in the next financial week.
        await deps.ledger.post(
          BRANCH,
          [reverse(shahnCorrection, `reversal-of-${shahnCorrectionEntry.id}`)],
          on('2026-07-27', null, RANGE_REASON),
        )
        return { kaishAmount, shahnAmount }
      }

      /**
       * The REFERENCE: the week-walking algorithm `/dashboard/profit` and `/dashboard/treasury` ran
       * before the range source existed, restated here on purpose rather than imported.
       */
      async function referenceRange(deps: Deps, from: string, to: string): Promise<LedgerRangeRecord> {
        const all: JournalEntryRecord[] = []
        for (const week of [WEEK_ONE, WEEK_TWO]) all.push(...(await deps.ledger.listByWeek(BRANCH, week)))
        const byId = new Map(all.map((entry) => [entry.id, entry]))
        const entries = all.filter((entry) => entry.businessDate >= from && entry.businessDate <= to)

        const keep = (fundCode: string, role: string | undefined): boolean =>
          ['company_revenue', 'other_income', 'yalago_income', 'company_box'].includes(fundCode) ||
          fundCode.startsWith('cost_center:') ||
          legacyShare(fundCode, role)
        const legacyShare = (fundCode: string, role: string | undefined): boolean =>
          (fundCode.startsWith('driver_share_payable:') && (role === 'driver_share' || role === 'cash_deduction_share')) ||
          (fundCode.startsWith('driver_receivable_cash:') && role === 'cash_deduction_overflow')

        const groups = new Map<string, LedgerRangeRecord['lines'][number]>()
        const legacyByShift = new Map<string | null, bigint>()
        const shiftIds = new Set<string>()
        const perDay = new Map<string, { kaish: bigint; shahn: bigint }>()

        const roleOf = (entry: JournalEntryRecord, line: JournalEntryRecord['lines'][number], visited = new Set<number>()): 'kaish' | 'shahn' | null => {
          if (line.role === 'kaish' || line.role === 'shahn') return line.role
          if (entry.eventType === 'restoration') return line.side === 'D' ? 'kaish' : 'shahn'
          if (entry.eventType !== 'correction' || visited.has(entry.id)) return null
          const match = /^reversal-of-(\d+)$/.exec(entry.occurrenceKey)
          if (!match) return null
          visited.add(entry.id)
          const found = byId.get(Number(match[1]))
          const foundLine = found?.lines.find((candidate) => candidate.fundCode === 'company_box')
          return found && foundLine ? roleOf(found, foundLine, visited) : null
        }

        for (const entry of entries) {
          if (entry.shiftId !== null) shiftIds.add(entry.shiftId)
          for (const line of entry.lines) {
            const signed = line.side === 'C' ? line.amount : -line.amount
            if (legacyShare(line.fundCode, line.role)) {
              legacyByShift.set(entry.shiftId, (legacyByShift.get(entry.shiftId) ?? 0n) + signed)
            }
            if (keep(line.fundCode, line.role)) {
              const key = JSON.stringify([entry.businessDate, entry.eventType, line.fundCode, line.role ?? null, line.side])
              const group = groups.get(key)
              if (group) {
                group.amount = minor(group.amount + line.amount)
                group.lineCount += 1
              } else {
                groups.set(key, {
                  businessDate: entry.businessDate,
                  eventType: entry.eventType,
                  fundCode: line.fundCode,
                  role: line.role ?? null,
                  side: line.side,
                  currency: 'SYP_NEW',
                  amount: minor(line.amount),
                  lineCount: 1,
                })
              }
            }
            const carriesRole = line.role === 'kaish' || line.role === 'shahn'
            if (line.fundCode !== 'company_box') continue
            if (!carriesRole && entry.eventType !== 'restoration' && entry.eventType !== 'correction') continue
            const role = roleOf(entry, line)
            if (role === null) continue
            const day = perDay.get(entry.businessDate) ?? { kaish: 0n, shahn: 0n }
            if (role === 'kaish') day.kaish += line.side === 'D' ? line.amount : -line.amount
            else day.shahn += line.side === 'C' ? line.amount : -line.amount
            perDay.set(entry.businessDate, day)
          }
        }

        const settlements = await deps.settlements.listByShiftIds([...shiftIds])
        const bySettledShift = new Map(settlements.map((row) => [row.shiftId, row]))
        let settled = 0n
        let legacy = legacyByShift.get(null) ?? 0n
        for (const shiftId of shiftIds) {
          const row = bySettledShift.get(shiftId)
          if (row) settled += row.baseDriverShare
          else legacy += legacyByShift.get(shiftId) ?? 0n
        }

        const order = (a: string | null, b: string | null): number =>
          a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1
        return {
          from,
          to,
          lines: [...groups.values()].sort((a, b) =>
            order(a.businessDate, b.businessDate) ||
            order(a.eventType, b.eventType) ||
            order(a.fundCode, b.fundCode) ||
            order(a.role, b.role) ||
            order(a.side, b.side),
          ),
          settledDriverShare: minor(settled),
          legacyDriverShare: minor(legacy),
          treasuryDays: [...perDay.entries()]
            .sort(([a], [b]) => order(a, b))
            .map(([businessDate, day]) => ({ businessDate, kaish: minor(day.kaish), shahn: minor(day.shahn) })),
        }
      }

      it('equals the week-by-week reference for every range, including chains that leave the range', async () => {
        const deps = await freshSettlement()
        try {
          const { kaishAmount, shahnAmount } = await seedRangeFixture(deps)
          for (const [from, to] of [
            ['2026-07-19', '2026-07-31'],
            ['2026-07-20', '2026-07-20'],
            ['2026-07-21', '2026-07-21'],
            ['2026-07-22', '2026-07-23'],
            ['2026-07-26', '2026-07-27'],
            ['2026-07-28', '2026-08-30'],
          ] as const) {
            const actual = await deps.ledgerRange.readRange(BRANCH, from, to)
            expect(actual, `${from}..${to}`).toEqual(await referenceRange(deps, from, to))
          }

          // And the reference itself says what the fixture means.
          const whole = await deps.ledgerRange.readRange(BRANCH, '2026-07-19', '2026-07-31')
          expect(whole.settledDriverShare).toBe(syp(40_000))
          // 2,000 − 300 − 100 on the legacy shift, + 50 shift-less. The settled shift's 40,000 split is NOT here.
          expect(whole.legacyDriverShare).toBe(syp(1_650))
          expect(whole.treasuryDays).toEqual([
            { businessDate: '2026-07-21', kaish: kaishAmount, shahn: shahnAmount },
            { businessDate: '2026-07-23', kaish: minor(-kaishAmount), shahn: minor(-shahnAmount) },
            { businessDate: '2026-07-27', kaish: minor(0n), shahn: shahnAmount },
          ])
          // The owner's company-fund deposit is on the ledger but is not a restoration flow.
          expect(whole.lines.some((line) => line.fundCode === 'company_box' && line.eventType === 'manual')).toBe(true)
          expect(whole.lines.find((line) => line.fundCode === `cost_center:${OTHER_VEHICLE}`)).toMatchObject({
            businessDate: '2026-07-22',
            eventType: 'expense',
            side: 'D',
            amount: syp(700),
            lineCount: 1,
            currency: 'SYP_NEW',
          })
          // Positions never enter the aggregate.
          expect(whole.lines.some((line) => line.fundCode.startsWith('office_') || line.fundCode.startsWith('driver_cash:'))).toBe(false)

          // A second-week range still classifies the double reversal through first-week originals.
          const second = await deps.ledgerRange.readRange(BRANCH, '2026-07-26', '2026-07-27')
          expect(second.treasuryDays).toEqual([{ businessDate: '2026-07-27', kaish: minor(0n), shahn: shahnAmount }])
          expect(second.settledDriverShare).toBe(minor(0n))
          expect(second.legacyDriverShare).toBe(minor(0n))

          // Another branch sees nothing.
          const elsewhere = await deps.ledgerRange.readRange('11111111-1111-1111-1111-111111111112', '2026-07-19', '2026-07-31')
          expect(elsewhere).toEqual({
            from: '2026-07-19',
            to: '2026-07-31',
            lines: [],
            settledDriverShare: minor(0n),
            legacyDriverShare: minor(0n),
            treasuryDays: [],
          })
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('knows the first day the branch ledger moved', async () => {
        const deps = await fresh()
        try {
          expect(await deps.ledgerRange.firstActivityDate(BRANCH)).toBeNull()
          await deps.ledger.post(BRANCH, [transfer('first-activity')], { ...META, businessDate: '2026-07-22' })
          await deps.ledger.post(BRANCH, [transfer('earlier-activity')], { ...META, businessDate: '2026-07-20' })
          expect(await deps.ledgerRange.firstActivityDate(BRANCH)).toBe('2026-07-20')
          expect(await deps.ledgerRange.firstActivityDate('11111111-1111-1111-1111-111111111112')).toBeNull()
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('lists shift timing for a date range, every state, with the window fallback', async () => {
        const deps = await fresh()
        try {
          const original = await deps.shifts.findById(SHIFT)
          if (!original) throw new Error('conformance shift missing')
          await deps.shifts.update({
            ...original,
            state: 'pending_review',
            openApprovedAt: '2026-07-21T05:00:00.000Z',
            openApprovedBy: USER,
            // The driver confirmed after the approval: the window opens at his confirmation.
            windowOpensAt: '2026-07-21T05:30:00.000Z',
            submittedAt: '2026-07-21T13:45:00.000Z',
            odoStart: 1_200,
            odoEnd: 1_275,
          }, USER)
          await deps.shifts.create({
            ...original,
            id: OTHER_SHIFT,
            driverId: OTHER_DRIVER,
            vehicleId: OTHER_VEHICLE,
            state: 'draft',
            businessDate: '2026-07-20',
            shiftNo: 1,
          }, USER)

          expect(await deps.shifts.listTimingBetween(BRANCH, '2026-07-20', '2026-07-21')).toEqual([
            {
              id: OTHER_SHIFT,
              branchId: BRANCH,
              driverId: OTHER_DRIVER,
              vehicleId: OTHER_VEHICLE,
              shiftNo: 1,
              businessDate: '2026-07-20',
              state: 'draft',
              windowOpensAt: null,
              submittedAt: null,
              odoStart: null,
              odoEnd: null,
            },
            {
              id: SHIFT,
              branchId: BRANCH,
              driverId: DRIVER,
              vehicleId: '88888888-8888-8888-8888-888888888888',
              shiftNo: 1,
              businessDate: '2026-07-21',
              state: 'pending_review',
              windowOpensAt: '2026-07-21T05:30:00.000Z',
              submittedAt: '2026-07-21T13:45:00.000Z',
              odoStart: 1_200,
              odoEnd: 1_275,
            },
          ])
          expect((await deps.shifts.listTimingBetween(BRANCH, '2026-07-21', '2026-07-21')).map((row) => row.id)).toEqual([SHIFT])
          expect(await deps.shifts.listTimingBetween(BRANCH, '2026-07-22', '2026-08-30')).toEqual([])
          expect(await deps.shifts.listTimingBetween('11111111-1111-1111-1111-111111111112', '2026-07-01', '2026-07-31')).toEqual([])
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('GPS pings (SRS K)', () => {
      /*
       * These two implementations had NEVER been compared. `gps_pings` carried no conformance case
       * at all, which mattered little while the repo only appended one row and read the latest —
       * and matters a great deal now that it dedupes on a natural key and orders a trail.
       *
       * Every API test in the system runs against the memory adapter. A rule that holds there and
       * not in PostgreSQL is a rule CI proves and production does not have.
       */
      const fix = (capturedAtMs: number, over: Partial<Omit<GpsPingRecord, 'id'>> = {}) => ({
        shiftId: SHIFT,
        driverId: DRIVER,
        branchId: BRANCH,
        lat: 33.5138,
        lng: 36.2765,
        accuracyM: 10,
        capturedAtMs,
        receivedAtMs: capturedAtMs + 1_000,
        source: 'phone_fg' as const,
        ...over,
      })

      it('ignores a fix it already holds — the retried batch must be free', async () => {
        const deps = await fresh()
        expect(await deps.gps.appendMany([fix(1_000), fix(2_000)])).toEqual({ inserted: 2 })
        // The same bytes again: a 202 that never reached the phone.
        expect(await deps.gps.appendMany([fix(1_000), fix(2_000)])).toEqual({ inserted: 0 })
        // …and a batch straddling the boundary inserts only what is new.
        expect(await deps.gps.appendMany([fix(2_000), fix(3_000)])).toEqual({ inserted: 1 })
        expect(await deps.gps.countForShift(SHIFT)).toBe(3)
      })

      it('dedupes WITHIN one batch, the way a single INSERT does', async () => {
        // Where parity is most easily lost: PostgreSQL resolves the conflict inside the statement,
        // so a naive in-memory loop that only checks already-stored rows would insert both.
        const deps = await fresh()
        expect(await deps.gps.appendMany([fix(5_000), fix(5_000)])).toEqual({ inserted: 1 })
        expect(await deps.gps.countForShift(SHIFT)).toBe(1)
      })

      it('reads a trail in CAPTURE order, whatever order it arrived in', async () => {
        const deps = await fresh()
        // A buffered run flushed late, interleaved with fixes that arrived live.
        await deps.gps.appendMany([fix(30_000, { receivedAtMs: 90_000 })])
        await deps.gps.appendMany([fix(10_000, { receivedAtMs: 95_000 })])
        await deps.gps.appendMany([fix(20_000, { receivedAtMs: 20_500 })])
        const trail = await deps.gps.listForShift(SHIFT)
        expect(trail.map((p) => p.capturedAtMs)).toEqual([10_000, 20_000, 30_000])
      })

      it('returns the latest fix per named driver, and nothing older than the window', async () => {
        const deps = await fresh()
        await deps.gps.appendMany([
          fix(1_000, { receivedAtMs: 1_000, lat: 33.1 }),
          fix(2_000, { receivedAtMs: 2_000, lat: 33.2 }),
        ])
        const latest = await deps.gps.latestForDriversInBranch(BRANCH, [DRIVER], 0)
        expect(latest).toHaveLength(1)
        expect(latest[0]!.lat).toBeCloseTo(33.2)

        // A driver nobody asked about is not returned, even though his fix exists.
        expect(await deps.gps.latestForDriversInBranch(BRANCH, [OTHER_DRIVER], 0)).toEqual([])
        // And a fix older than the window is a memory, not a position.
        expect(await deps.gps.latestForDriversInBranch(BRANCH, [DRIVER], 3_000)).toEqual([])
      })

      it('round-trips every field, including the capture layer', async () => {
        const deps = await fresh()
        await deps.gps.appendMany([fix(7_000, { accuracyM: null, source: 'phone_bg' })])
        const [stored] = await deps.gps.listForShift(SHIFT)
        expect(stored).toMatchObject({
          shiftId: SHIFT,
          driverId: DRIVER,
          branchId: BRANCH,
          accuracyM: null,
          capturedAtMs: 7_000,
          receivedAtMs: 8_000,
          source: 'phone_bg',
        })
        expect(stored!.lat).toBeCloseTo(33.5138)
        expect(stored!.lng).toBeCloseTo(36.2765)
      })
    })

    describe('OCR paid-read reservations', () => {
      const claim = (overrides: Partial<OcrReadClaimInput> = {}): OcrReadClaimInput => ({
        id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
        branchId: BRANCH,
        requestingShiftId: SHIFT,
        field: 'orders',
        sha256: 'a'.repeat(64),
        byteSize: 123,
        model: 'reader-v2',
        cacheSignature: 'reader-v2:orders-prompt-v2',
        createdAt: 1_784_000_000_000,
        createdBy: USER,
        reservationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
        nowMs: 1_000,
        leaseMs: 100,
        retryFailed: false,
        maxReadsPerShift: 15,
        ...overrides,
      })

      const addOtherShift = async (deps: Deps): Promise<void> => {
        const original = await deps.shifts.findById(SHIFT)
        if (!original) throw new Error('conformance shift missing')
        await deps.shifts.create(
          {
            ...original,
            id: OTHER_SHIFT,
            driverId: OTHER_DRIVER,
            vehicleId: OTHER_VEHICLE,
            shiftNo: 1,
          },
          USER,
        )
      }

      it('reserves initial/retry once, aggregates telemetry, and charges the requesting shifts', async () => {
        const deps = await fresh()
        try {
          await addOtherShift(deps)
          const first = await deps.ocrReads.claimReadAttempt(claim())
          expect(first).toMatchObject({ kind: 'call', attempt: 1, used: 1, record: { state: 'running' } })
          if (first.kind !== 'call') throw new Error('initial OCR attempt was not reserved')

          const failed = await deps.ocrReads.completeReadAttempt({
            branchId: BRANCH,
            field: 'orders',
            sha256: 'a'.repeat(64),
            cacheSignature: first.record.cacheSignature,
            reservationId: first.record.reservationId!,
            result: { ok: false, reason: 'timeout' },
            usage: { tokensIn: 10, tokensOut: 1, latencyMs: 100 },
          })
          expect(failed?.result).toMatchObject({ ok: false, attemptCount: 1 })
          expect(await deps.ocrReads.countBilledForShift(SHIFT)).toBe(1)

          const ordinaryDuplicate = await deps.ocrReads.claimReadAttempt(
            claim({ reservationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2' }),
          )
          expect(ordinaryDuplicate.kind).toBe('cached')

          const retry = await deps.ocrReads.claimReadAttempt(
            claim({
              requestingShiftId: OTHER_SHIFT,
              reservationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
              retryFailed: true,
              nowMs: 1_100,
            }),
          )
          expect(retry).toMatchObject({ kind: 'call', attempt: 2, used: 1 })
          if (retry.kind !== 'call') throw new Error('OCR retry was not reserved')

          const completed = await deps.ocrReads.completeReadAttempt({
            branchId: BRANCH,
            field: 'orders',
            sha256: 'a'.repeat(64),
            cacheSignature: retry.record.cacheSignature,
            reservationId: retry.record.reservationId!,
            result: { ok: true, rows: [], fields: { odometerKm: '6034' }, raw: null },
            usage: { tokensIn: 20, tokensOut: 3, latencyMs: 150 },
          })
          expect(completed).toMatchObject({
            state: 'complete',
            result: { ok: true, attemptCount: 2 },
            retryCreatedAt: expect.any(Number),
            retryCreatedBy: USER,
            tokensIn: 30,
            tokensOut: 4,
            latencyMs: 250,
          })
          expect(await deps.ocrReads.countBilledForShift(SHIFT)).toBe(1)
          expect(await deps.ocrReads.countBilledForShift(OTHER_SHIFT)).toBe(1)

          const third = await deps.ocrReads.claimReadAttempt(
            claim({
              requestingShiftId: OTHER_SHIFT,
              reservationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
              retryFailed: true,
              nowMs: 1_200,
            }),
          )
          expect(third.kind).toBe('cached')
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('serializes the cap across different hashes and ignores an older cache signature', async () => {
        const deps = await fresh()
        try {
          const [left, right] = await Promise.all([
            deps.ocrReads.claimReadAttempt(claim({ maxReadsPerShift: 1 })),
            deps.ocrReads.claimReadAttempt(
              claim({
                id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
                sha256: 'b'.repeat(64),
                reservationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
                maxReadsPerShift: 1,
              }),
            ),
          ])
          expect([left.kind, right.kind].sort()).toEqual(['call', 'capped'])
          expect(await deps.ocrReads.countBilledForShift(SHIFT)).toBe(1)

          const changedSignature = await deps.ocrReads.claimReadAttempt(
            claim({
              id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
              cacheSignature: 'reader-v2:orders-prompt-v3',
              reservationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
              maxReadsPerShift: 2,
            }),
          )
          expect(changedSignature).toMatchObject({ kind: 'call', attempt: 1, used: 2 })
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('deduplicates concurrent claims for one identity and rejects wrong or late completion owners', async () => {
        const deps = await fresh()
        try {
          const reservationIds = [
            'dddddddd-dddd-4ddd-8ddd-dddddddddda1',
            'dddddddd-dddd-4ddd-8ddd-dddddddddda2',
          ] as const
          const claims = await Promise.all([
            deps.ocrReads.claimReadAttempt(claim({ reservationId: reservationIds[0] })),
            deps.ocrReads.claimReadAttempt(claim({ reservationId: reservationIds[1] })),
          ])
          expect(claims.map(({ kind }) => kind).sort()).toEqual(['call', 'running'])

          const owner = claims.find((candidate) => candidate.kind === 'call')
          if (!owner || owner.kind !== 'call') throw new Error('same-identity OCR claim had no owner')
          const wrongReservation = reservationIds.find((id) => id !== owner.record.reservationId)!
          const completion = (reservationId: string, result: OcrResult): OcrReadCompletion => ({
            branchId: BRANCH,
            field: 'orders',
            sha256: 'a'.repeat(64),
            cacheSignature: owner.record.cacheSignature,
            reservationId,
            result,
            usage: { tokensIn: 7, tokensOut: 2, latencyMs: 50 },
          })

          expect(await deps.ocrReads.completeReadAttempt(
            completion(wrongReservation, { ok: false, reason: 'timeout' }),
          )).toBeNull()
          expect(await deps.ocrReads.findBySha(BRANCH, 'a'.repeat(64), 'orders', owner.record.cacheSignature))
            .toMatchObject({ state: 'running', reservationId: owner.record.reservationId })

          expect(await deps.ocrReads.completeReadAttempt(completion(owner.record.reservationId!, {
            ok: true,
            rows: [],
            fields: { odometerKm: '6034' },
            raw: null,
          }))).toMatchObject({ state: 'complete', result: { ok: true, attemptCount: 1 } })

          expect(await deps.ocrReads.completeReadAttempt(
            completion(wrongReservation, { ok: false, reason: 'timeout' }),
          )).toBeNull()
          expect(await deps.ocrReads.findBySha(BRANCH, 'a'.repeat(64), 'orders', owner.record.cacheSignature))
            .toMatchObject({ state: 'complete', result: { ok: true, attemptCount: 1 }, tokensIn: 7, tokensOut: 2 })
          expect(await deps.ocrReads.countBilledForShift(SHIFT)).toBe(1)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('waits on a live lease and makes an expired attempt terminal without calling it again', async () => {
        const deps = await fresh()
        try {
          const leaseMs = 500
          const firstStartedAt = Date.now()
          const first = await deps.ocrReads.claimReadAttempt(claim({ nowMs: firstStartedAt, leaseMs }))
          expect(first.kind).toBe('call')

          const live = await deps.ocrReads.claimReadAttempt(
            claim({ reservationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', nowMs: firstStartedAt + 499, leaseMs }),
          )
          expect(live.kind).toBe('running')

          await new Promise((resolve) => setTimeout(resolve, leaseMs + 50))
          const expired = await deps.ocrReads.claimReadAttempt(
            claim({ reservationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3', nowMs: firstStartedAt + leaseMs, leaseMs }),
          )
          expect(expired).toMatchObject({
            kind: 'cached',
            record: { state: 'complete', result: { ok: false, reason: 'timeout', attemptCount: 1 } },
          })

          const retryStartedAt = Date.now()
          const retry = await deps.ocrReads.claimReadAttempt(
            claim({
              reservationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
              nowMs: retryStartedAt,
              leaseMs,
              retryFailed: true,
            }),
          )
          expect(retry).toMatchObject({ kind: 'call', attempt: 2 })

          await new Promise((resolve) => setTimeout(resolve, leaseMs + 50))
          const terminal = await deps.ocrReads.claimReadAttempt(
            claim({
              reservationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd5',
              nowMs: retryStartedAt + leaseMs,
              leaseMs,
              retryFailed: true,
            }),
          )
          expect(terminal).toMatchObject({
            kind: 'cached',
            record: { state: 'complete', result: { ok: false, reason: 'timeout', attemptCount: 2 } },
          })
          expect(await deps.ocrReads.countBilledForShift(SHIFT)).toBe(2)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('ledger idempotency (the rule that stops a double-approve double-posting)', () => {
      it('writes a posting once', async () => {
        const deps = await fresh()
        try {
          const written = await deps.ledger.post(BRANCH, [transfer('1')], META)
          expect(written).toHaveLength(1)
          expect(await deps.ledger.listByShift(SHIFT)).toHaveLength(1)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('a replay of the SAME (shift, event, occurrence) writes nothing', async () => {
        const deps = await fresh()
        try {
          await deps.ledger.post(BRANCH, [transfer('1')], META)
          const replay = await deps.ledger.post(BRANCH, [transfer('1')], META)

          expect(replay).toHaveLength(0)
          expect(await deps.ledger.listByShift(SHIFT)).toHaveLength(1)
          // And crucially the money did not double.
          expect(await deps.ledger.fundBalance(BRANCH, `driver_cash:${DRIVER}`)).toBe(syp(1_000))
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('a SECOND float tranche does post — SRS C-5, the reason occurrenceKey exists', async () => {
        const deps = await fresh()
        try {
          await deps.ledger.post(BRANCH, [transfer('1', syp(60_000))], META)
          const second = await deps.ledger.post(BRANCH, [transfer('2', syp(40_000))], META)

          expect(second).toHaveLength(1)
          expect(await deps.ledger.fundBalance(BRANCH, `driver_cash:${DRIVER}`)).toBe(syp(100_000))
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      /**
       * A BATCH WHERE ONLY SOME POSTINGS ARE REPLAYS — the case an approval actually retries.
       *
       * Every test above posts ONE posting per call, which is exactly the shape that cannot see
       * the defect this pins. The Postgres adapter used to `try { INSERT } catch (23505)
       * { continue }`, and in PostgreSQL a statement error aborts the WHOLE transaction: the next
       * posting failed with 25P02, and `COMMIT` on an aborted block silently rolls back while
       * reporting success. So a re-approved shift either 500'd on the second posting or wrote
       * nothing at all while `post()` returned the rows it believed it had written.
       *
       * The in-memory adapter was always correct here — an array has no transaction to poison —
       * which is why thirty API test files were blind to it. Running this against BOTH is the
       * whole point of a conformance suite.
       */
      it('a batch mixing a replay with new postings still writes the new ones', async () => {
        const deps = await fresh()
        try {
          await deps.ledger.post(BRANCH, [transfer('1', syp(10_000))], META)

          // '1' is already posted; '2' and '3' are not. The replay is FIRST, so an aborted
          // transaction would take the other two down with it.
          const written = await deps.ledger.post(
            BRANCH,
            [transfer('1', syp(10_000)), transfer('2', syp(20_000)), transfer('3', syp(30_000))],
            META,
          )

          expect(written).toHaveLength(2)
          expect(await deps.ledger.listByShift(SHIFT)).toHaveLength(3)
          // 10 + 20 + 30, with the replay contributing nothing: the figure is wrong in BOTH
          // failure modes — 10,000 if everything rolled back, 70,000 if the replay double-posted.
          expect(await deps.ledger.fundBalance(BRANCH, `driver_cash:${DRIVER}`)).toBe(syp(60_000))
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      /*
       * A command whose only record is its journal entry (صندوق الشركة, a treasury deposit) reads its
       * receipt back through this to tell a lost-response retry from a reused key. It must find the
       * shift-less row under exactly the idempotency index's key — and never a shift's row, another
       * event type's, or another branch's.
       */
      it('finds a shift-less posting by (branch, event, occurrence) and nothing else', async () => {
        const deps = await fresh()
        try {
          const standalone: Posting = {
            eventType: 'manual',
            occurrenceKey: 'company-fund-receipt',
            lines: [
              { fund: { kind: 'company_box' }, side: 'D', amount: syp(2_500) },
              { fund: { kind: 'cost_center', costCenterId: 'owner_funding' }, side: 'C', amount: syp(2_500) },
            ],
          }
          const standaloneMeta = { ...META, shiftId: null, reason: 'conformance receipt' }
          const [written] = await deps.ledger.post(BRANCH, [standalone], standaloneMeta)
          expect(written).toBeDefined()
          // A shift posting under the same event and key is a different row the lookup must ignore.
          await deps.ledger.post(BRANCH, [{ ...standalone }], { ...META, reason: 'shift twin' })

          const found = await deps.ledger.findStandaloneEntry(BRANCH, 'manual', 'company-fund-receipt')
          expect(found).not.toBeNull()
          expect(found!.id).toBe(written!.id)
          expect(found!.shiftId).toBeNull()
          expect(found!.reason).toBe('conformance receipt')
          // Every line reports its fund's currency (0066); every branch fund is new lira.
          expect(found!.lines).toEqual([
            { fundCode: 'company_box', side: 'D', amount: syp(2_500), currency: 'SYP_NEW' },
            { fundCode: 'cost_center:owner_funding', side: 'C', amount: syp(2_500), currency: 'SYP_NEW' },
          ])
          expect(found!.sypMinorPerUsd).toBeNull()

          expect(await deps.ledger.findStandaloneEntry(BRANCH, 'manual', 'no-such-key')).toBeNull()
          expect(await deps.ledger.findStandaloneEntry(BRANCH, 'income', 'company-fund-receipt')).toBeNull()
          expect(
            await deps.ledger.findStandaloneEntry(
              '11111111-1111-1111-1111-111111111112',
              'manual',
              'company-fund-receipt',
            ),
          ).toBeNull()
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('what post() RETURNS is what was actually committed', async () => {
        // The silent half of the same defect: rows reported as written that a rolled-back
        // transaction never kept. Whatever comes back must be readable afterwards.
        const deps = await fresh()
        try {
          await deps.ledger.post(BRANCH, [transfer('1')], META)
          const written = await deps.ledger.post(BRANCH, [transfer('1'), transfer('2')], META)
          const stored = await deps.ledger.listByShift(SHIFT)
          for (const w of written) expect(stored.some((s) => s.id === w.id)).toBe(true)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('journal line metadata', () => {
      it('round-trips a semantic line role through post() and listByShift()', async () => {
        const deps = await fresh()
        try {
          const posting: Posting = {
            // This test proves metadata round-trip only. A real restoration event is now coupled
            // to sealed count evidence and its immutable fact at commit, so use a manual entry.
            eventType: 'manual',
            occurrenceKey: 'role-round-trip',
            lines: [
              { fund: { kind: 'company_box' }, side: 'D', amount: syp(1_000), role: 'kaish' },
              { fund: { kind: 'office_cash' }, side: 'C', amount: syp(1_000) },
            ],
          }

          const written = await deps.ledger.post(BRANCH, [posting], {
            ...META,
            reason: 'role round-trip conformance',
          })
          expect(written[0]?.lines.find((line) => line.fundCode === 'company_box')?.role).toBe('kaish')

          const stored = await deps.ledger.listByShift(SHIFT)
          expect(stored[0]?.lines.find((line) => line.fundCode === 'company_box')?.role).toBe('kaish')
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('double-entry balance', () => {
      it('rejects an unbalanced posting', async () => {
        const deps = await fresh()
        try {
          const unbalanced: Posting = {
            eventType: 'manual',
            occurrenceKey: '1',
            lines: [
              { fund: { kind: 'office_cash' }, side: 'D', amount: syp(100) },
              { fund: { kind: 'office_wallet' }, side: 'C', amount: syp(90) },
            ],
          }
          await expect(deps.ledger.post(BRANCH, [unbalanced], META)).rejects.toThrow()
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('accepts a balanced multi-line posting', async () => {
        const deps = await fresh()
        try {
          const split: Posting = {
            eventType: 'share_split',
            occurrenceKey: '1',
            lines: [
              { fund: { kind: 'fee_earned' }, side: 'D', amount: syp(100_000) },
              { fund: { kind: 'driver_share_payable', driverId: DRIVER }, side: 'C', amount: syp(40_000) },
              { fund: { kind: 'company_revenue' }, side: 'C', amount: syp(40_000) },
              { fund: { kind: 'yalago_income' }, side: 'C', amount: syp(20_000) },
            ],
          }
          expect(await deps.ledger.post(BRANCH, [split], META)).toHaveLength(1)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('money precision', () => {
      it('survives an amount beyond 2^53 — the number a float would silently round', async () => {
        const deps = await fresh()
        try {
          // 9,007,199,254,740,993 minor units. If int8 came back as a JS Number this would
          // return ...992 and nobody would notice until an audit.
          const huge = minor(9_007_199_254_740_993n)
          await deps.ledger.post(BRANCH, [transfer('1', huge)], META)
          expect(await deps.ledger.fundBalance(BRANCH, `driver_cash:${DRIVER}`)).toBe(huge)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    /**
     * «صندوق الشركة» as its own ledger (C1). Both adapters must store every fund under the DOMAIN's
     * code — there is one `fundCode` now, not three — report each line's currency from its fund,
     * freeze the USD rate on the entry, and refuse the same malformed postings.
     */
    describe('company ledger foundation (C1)', () => {
      const HQ_META = { ...META, shiftId: null, reason: 'company ledger conformance' }
      const RATE = 13_050n
      const cash = (currency: Currency) => ({ kind: 'company_cash', currency }) as const
      const line = (fund: FundRef, side: 'D' | 'C', amount: bigint) => ({ fund, side, amount: minor(amount) })

      const branchFunds: FundRef[] = [
        { kind: 'office_cash' },
        { kind: 'office_wallet' },
        { kind: 'yalago_share' },
        { kind: 'company_revenue' },
        { kind: 'yalago_income' },
        { kind: 'fee_earned' },
        { kind: 'other_income' },
        { kind: 'company_box' },
        { kind: 'driver_cash', driverId: DRIVER },
        { kind: 'driver_wallet', driverId: DRIVER },
        { kind: 'driver_share_payable', driverId: DRIVER },
        { kind: 'cost_center', costCenterId: 'owner_funding' },
      ]
      /** Every company kind but the clearing account, which moves only under its two events. */
      const companyFunds = (currency: Currency): FundRef[] => [
        { kind: 'company_cash', currency },
        { kind: 'depreciation_reserve', currency },
        { kind: 'company_fx_position', currency },
        { kind: 'company_equity', currency, account: 'owner_funding' },
        { kind: 'company_equity', currency, account: 'opening' },
        { kind: 'company_expense', currency, centre: 'general' },
        { kind: 'company_expense', currency, centre: `vehicle:${OTHER_VEHICLE}` },
        { kind: 'company_expense', currency, centre: 'receivable_writeoff' },
        { kind: 'company_income', currency, account: 'general' },
        { kind: 'company_income', currency, account: 'payable_forgiven' },
        { kind: 'company_payable', currency, debtId: ORDER_1 },
        { kind: 'company_receivable', currency, debtId: ORDER_2 },
        { kind: 'fixed_asset', currency, assetId: BATTERY },
      ]
      /** All debits but the last, one credit that balances them: no company pocket is ever lowered. */
      const spread = (funds: FundRef[], unit: bigint): Posting['lines'] => {
        const [first, ...rest] = funds
        return [
          ...rest.map((fund) => line(fund, 'D', unit)),
          line(first!, 'C', unit * BigInt(rest.length)),
        ]
      }
      const expectStored = (
        stored: { lines: Array<{ fundCode: string; currency: Currency; side: 'D' | 'C'; amount: bigint }> },
        posting: Posting,
      ) => {
        expect(stored.lines.map((l) => [l.fundCode, l.currency, l.side, l.amount])).toEqual(
          posting.lines.map((l) => [fundCode(l.fund), currencyOf(l.fund), l.side, l.amount]),
        )
      }

      it('lists only operating branches, and names the company row apart', async () => {
        const deps = await fresh()
        try {
          const listed = await deps.directory.listBranches()
          expect(listed.map((b) => [b.id, b.kind])).toEqual([[BRANCH, 'branch']])
          const company = await deps.directory.companyBranch()
          expect(company).toMatchObject({ id: COMPANY_BRANCH, kind: 'company', branchNo: 0, code: 'HQ' })
          expect(await deps.directory.branch(COMPANY_BRANCH)).toMatchObject({ kind: 'company' })
          expect(await deps.directory.branch(BRANCH)).toMatchObject({ kind: 'branch' })
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('stores every fund kind under the domain code, with its fund currency and the frozen rate', async () => {
        const deps = await fresh()
        try {
          // A branch entry: every line new lira, no rate.
          const branchEntry: Posting = { eventType: 'manual', occurrenceKey: 'c1-branch-kinds', lines: spread(branchFunds, 100n) }
          const [branchWritten] = await deps.ledger.post(BRANCH, [branchEntry], HQ_META)
          expectStored(branchWritten!, branchEntry)
          expect(branchWritten!.sypMinorPerUsd).toBeNull()
          expect(branchWritten!.lines.every((l) => l.currency === 'SYP_NEW')).toBe(true)

          // The company ledger, in the order a real day would need: cutover, a dollar deposit, then
          // an exchange that spends some of those dollars.
          const cutover: Posting = {
            eventType: 'company_opening_transfer',
            occurrenceKey: 'c1-cutover',
            lines: [
              line(cash('SYP_NEW'), 'D', 7_905_726n),
              line({ kind: 'branch_clearing', branchId: BRANCH }, 'C', 7_905_726n),
            ],
          }
          const sypKinds: Posting = {
            eventType: 'company_correction',
            occurrenceKey: 'c1-syp-kinds',
            lines: spread([{ kind: 'company_equity', currency: 'SYP_NEW', account: 'owner_drawings' }, ...companyFunds('SYP_NEW')], 100n),
          }
          const usdKinds: Posting = {
            eventType: 'company_correction',
            occurrenceKey: 'c1-usd-kinds',
            lines: spread([{ kind: 'company_equity', currency: 'USD', account: 'owner_drawings' }, ...companyFunds('USD')], 10_000n),
          }
          const exchange: Posting = {
            eventType: 'company_fx_exchange',
            occurrenceKey: 'c1-exchange',
            lines: [
              line({ kind: 'company_fx_position', currency: 'USD' }, 'D', 5_000n),
              line(cash('USD'), 'C', 5_000n),
              line(cash('SYP_NEW'), 'D', 652_500n),
              line({ kind: 'company_fx_position', currency: 'SYP_NEW' }, 'C', 652_500n),
            ],
          }

          /*
           * Since C2 (0067) a company entry commits only beside its command row, and these probes —
           * every account kind under one correction — are no command anyone may issue. So they are
           * stored, read back and checked INSIDE one unit of work that is then rolled back: the
           * storage round-trip is what this test is about, and nothing fact-less ever commits.
           */
          const rolledBack = new Error('conformance probe rolled back')
          await expect(
            deps.financialUnitOfWork.run({ lockKey: `receivables:${COMPANY_BRANCH}`, actorId: USER }, async (tx) => {
              const [cutoverWritten] = await tx.ledger.post(COMPANY_BRANCH, [cutover], HQ_META)
              const [sypWritten] = await tx.ledger.post(COMPANY_BRANCH, [sypKinds], HQ_META)
              const [usdWritten] = await tx.ledger.post(COMPANY_BRANCH, [usdKinds], { ...HQ_META, sypMinorPerUsd: RATE })
              const [exchangeWritten] = await tx.ledger.post(COMPANY_BRANCH, [exchange], {
                ...HQ_META,
                sypMinorPerUsd: 13_050n,
              })
              for (const [written, posting] of [
                [cutoverWritten, cutover],
                [sypWritten, sypKinds],
                [usdWritten, usdKinds],
                [exchangeWritten, exchange],
              ] as const) {
                expectStored(written!, posting)
                // What was returned is what a reader gets back.
                const found = await tx.ledger.findStandaloneEntry(COMPANY_BRANCH, posting.eventType, posting.occurrenceKey)
                expectStored(found!, posting)
                expect(found!.sypMinorPerUsd).toBe(written!.sypMinorPerUsd)
              }
              expect(cutoverWritten!.sypMinorPerUsd).toBeNull()
              expect(sypWritten!.sypMinorPerUsd).toBeNull()
              expect(usdWritten!.sypMinorPerUsd).toBe(RATE)
              expect(exchangeWritten!.lines.map((l) => l.currency)).toEqual(['USD', 'USD', 'SYP_NEW', 'SYP_NEW'])

              // Balances are per code, and the two pockets never mix.
              expect(await tx.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:USD')).toBe(10_000n - 5_000n)
              expect(await tx.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(7_905_726n + 100n + 652_500n)
              expect(await tx.ledger.fundBalance(COMPANY_BRANCH, `branch_clearing:${BRANCH}`)).toBe(-7_905_726n)
              // The company ledger is not the branch's: nothing of it shows under DAM.
              expect(await tx.ledger.fundBalance(BRANCH, 'company_cash:SYP_NEW')).toBe(0n)
              throw rolledBack
            }),
          ).rejects.toBe(rolledBack)
          // …and nothing of it survived the rollback.
          expect(await deps.ledger.findStandaloneEntry(COMPANY_BRANCH, 'company_opening_transfer', 'c1-cutover')).toBeNull()
          expect(await deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:USD')).toBe(0n)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('refuses a USD line without a rate, a rate without a USD line, and currencies that do not balance', async () => {
        const deps = await fresh()
        try {
          const deposit: Posting = {
            eventType: 'company_deposit',
            occurrenceKey: 'c1-refused',
            lines: [
              line(cash('USD'), 'D', 100n),
              line({ kind: 'company_equity', currency: 'USD', account: 'owner_funding' }, 'C', 100n),
            ],
          }
          await expect(deps.ledger.post(COMPANY_BRANCH, [deposit], HQ_META)).rejects.toThrow(/syp_minor_per_usd/)
          const sypDeposit: Posting = {
            ...deposit,
            lines: [
              line(cash('SYP_NEW'), 'D', 100n),
              line({ kind: 'company_equity', currency: 'SYP_NEW', account: 'owner_funding' }, 'C', 100n),
            ],
          }
          await expect(
            deps.ledger.post(COMPANY_BRANCH, [sypDeposit], { ...HQ_META, sypMinorPerUsd: RATE }),
          ).rejects.toThrow(/no USD line/)
          const crossed: Posting = {
            eventType: 'company_correction',
            occurrenceKey: 'c1-crossed',
            lines: [line(cash('USD'), 'D', 100n), line(cash('SYP_NEW'), 'C', 100n)],
          }
          await expect(
            deps.ledger.post(COMPANY_BRANCH, [crossed], { ...HQ_META, sypMinorPerUsd: RATE }),
          ).rejects.toThrow(/unbalanced/)
          // A deposit, not a correction: since C2 a two-currency company_correction is how an
          // exchange is taken back (and 0067 requires it to be the exact inverse of one).
          const balancedButMixed: Posting = {
            eventType: 'company_deposit',
            occurrenceKey: 'c1-mixed',
            lines: [
              line(cash('USD'), 'D', 100n),
              line({ kind: 'company_fx_position', currency: 'USD' }, 'C', 100n),
              line(cash('SYP_NEW'), 'D', 13_050n),
              line({ kind: 'company_fx_position', currency: 'SYP_NEW' }, 'C', 13_050n),
            ],
          }
          await expect(
            deps.ledger.post(COMPANY_BRANCH, [balancedButMixed], { ...HQ_META, sypMinorPerUsd: RATE }),
          ).rejects.toThrow(/company_fx_exchange/)
          expect(await deps.ledger.findStandaloneEntry(COMPANY_BRANCH, 'company_deposit', 'c1-refused')).toBeNull()
          expect(await deps.ledger.findStandaloneEntry(COMPANY_BRANCH, 'company_deposit', 'c1-mixed')).toBeNull()
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('refuses to post through a fund whose stored currency disagrees with its reference', async () => {
        const deps = await fresh()
        try {
          await ctx.plantFund(deps, COMPANY_BRANCH, { code: 'company_cash:USD', type: 'company_cash', currency: 'SYP_NEW' })
          const deposit: Posting = {
            eventType: 'company_deposit',
            occurrenceKey: 'c1-mismatch',
            lines: [
              line(cash('USD'), 'D', 100n),
              line({ kind: 'company_equity', currency: 'USD', account: 'owner_funding' }, 'C', 100n),
            ],
          }
          await expect(
            deps.ledger.post(COMPANY_BRANCH, [deposit], { ...HQ_META, sypMinorPerUsd: RATE }),
          ).rejects.toMatchObject({ code: 'fund_currency_mismatch' })
          expect(await deps.ledger.findStandaloneEntry(COMPANY_BRANCH, 'company_deposit', 'c1-mismatch')).toBeNull()
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('company ledger commands, cutover and mirror (C2)', () => {
      const TODAY = '2026-07-21'
      const RATE = 13_050n
      const CMD = {
        shiftId: null,
        businessDate: TODAY,
        postingDate: TODAY,
        weekStartDate: '2026-07-19',
        fxDayId: 1,
        createdBy: USER,
      }
      const KEY = (n: number) => `c2000000-0000-4000-8000-${String(n).padStart(12, '0')}`
      const EXPENSE_CATEGORY = 'c2000000-0000-4000-8000-00000000ca01'
      const INCOME_CATEGORY = 'c2000000-0000-4000-8000-00000000ca02'
      const base = { branchId: COMPANY_BRANCH, occurredOn: TODAY, businessDate: TODAY, createdBy: USER, createdAtMs: 0 }
      const hq = (deps: Deps) => ({ lockKey: `receivables:${COMPANY_BRANCH}`, actorId: USER, deps })
      const withoutTime = <T extends { createdAtMs: number }>(row: T | null): T | null =>
        row === null ? null : { ...row, createdAtMs: 0 }

      async function categories(deps: Deps): Promise<void> {
        if (!(await deps.expenses.listCategories()).some((c) => c.id === EXPENSE_CATEGORY)) {
          await deps.expenses.createCategory({ id: EXPENSE_CATEGORY, code: 'c2-company-expense', nameAr: 'صرفية شركة', active: true })
        }
        if (!(await deps.incomes.listCategories()).some((c) => c.id === INCOME_CATEGORY)) {
          await deps.incomes.createCategory({ id: INCOME_CATEGORY, code: 'c2-company-income', nameAr: 'مدخول شركة', active: true })
        }
      }

      /** Post a company command the way the API does: journal first, its row second, one unit of work. */
      async function issue(
        deps: Deps,
        posting: Posting,
        rate: bigint | null,
        reason: string,
        row: DistributiveOmit<CompanyCommandRecord, 'journalEntryId'>,
      ): Promise<CompanyCommandRecord> {
        const { lockKey, actorId } = hq(deps)
        return deps.financialUnitOfWork.run({ lockKey, actorId }, async (tx) => {
          const [entry] = await tx.ledger.post(COMPANY_BRANCH, [posting], { ...CMD, sypMinorPerUsd: rate, reason })
          const command = { ...row, journalEntryId: entry!.id } as CompanyCommandRecord
          await tx.companyLedger.createCommand(command)
          return command
        })
      }

      it('stores every command kind, reads it back by key and by entry, and sums the pockets', async () => {
        const deps = await fresh()
        try {
          await categories(deps)
          const deposit = await issue(deps, companyDeposit('SYP_NEW', minor(500_000n), 'owner_funding', KEY(1)), null, 'إيداع المالك', {
            ...base, id: KEY(1), kind: 'deposit', equityAccount: 'owner_funding', currency: 'SYP_NEW',
            amount: minor(500_000n), sypMinorPerUsd: null, reason: 'إيداع المالك',
          })
          const opening = await issue(deps, companyDeposit('USD', minor(20_000n), 'opening', KEY(2)), RATE, 'رصيد افتتاحي بالدولار', {
            ...base, id: KEY(2), kind: 'deposit', equityAccount: 'opening', currency: 'USD',
            amount: minor(20_000n), sypMinorPerUsd: RATE, reason: 'رصيد افتتاحي بالدولار',
          })
          const withdrawal = await issue(deps, companyWithdrawal('SYP_NEW', minor(100_000n), KEY(3)), null, 'سحب المالك', {
            ...base, id: KEY(3), kind: 'withdrawal', equityAccount: 'owner_drawings', currency: 'SYP_NEW',
            amount: minor(100_000n), sypMinorPerUsd: null, reason: 'سحب المالك',
          })
          const expense = await issue(
            deps,
            companyExpense('USD', minor(5_000n), `vehicle:${OTHER_VEHICLE}`, 'pocket', KEY(4)),
            RATE,
            'إطارات',
            {
              ...base, id: KEY(4), kind: 'expense', currency: 'USD', amount: minor(5_000n), sypMinorPerUsd: RATE,
              categoryId: EXPENSE_CATEGORY, costCenterKind: 'vehicle', vehicleId: OTHER_VEHICLE, assetId: null,
              paidFrom: 'pocket', receiptMediaId: null, description: 'إطارات', occurredOn: '2026-07-01',
            },
          )
          const income = await issue(deps, companyIncome('SYP_NEW', minor(30_000n), KEY(5)), null, 'بيع خردة', {
            ...base, id: KEY(5), kind: 'income', currency: 'SYP_NEW', amount: minor(30_000n), sypMinorPerUsd: null,
            categoryId: INCOME_CATEGORY, description: 'بيع خردة',
          })
          const exchangePosting = companyFxExchange(money('USD', minor(10_000n)), money('SYP_NEW', minor(1_305_000n)), KEY(6))
          const exchange = await issue(deps, exchangePosting, RATE, 'تصريف', {
            ...base, id: KEY(6), kind: 'exchange', fromCurrency: 'USD', fromAmount: minor(10_000n),
            toCurrency: 'SYP_NEW', toAmount: minor(1_305_000n), sypMinorPerUsd: RATE, reason: 'تصريف',
          })
          const reversal = await issue(
            deps,
            companyReversal(companyIncome('SYP_NEW', minor(30_000n), KEY(5)), KEY(7)),
            null,
            'مدخول مكرر',
            {
              ...base, id: KEY(7), kind: 'reversal', targetKind: 'income', targetId: KEY(5),
              targetEntryId: income.journalEntryId, sypMinorPerUsd: null, reason: 'مدخول مكرر',
            },
          )

          const all = [deposit, opening, withdrawal, expense, income, exchange, reversal]
          for (const command of all) {
            expect(withoutTime(await deps.companyLedger.findCommand(command.id))).toEqual(withoutTime(command))
            expect(withoutTime(await deps.companyLedger.findCommand(command.id.toUpperCase()))).toEqual(withoutTime(command))
            expect(withoutTime(await deps.companyLedger.findCommandByEntry(command.journalEntryId))).toEqual(withoutTime(command))
          }
          expect(await deps.companyLedger.findCommand(KEY(99))).toBeNull()
          expect(await deps.companyLedger.findCommand('not-a-uuid')).toBeNull()
          expect((await deps.companyLedger.listCommands(COMPANY_BRANCH)).map((c) => c.id)).toEqual(all.map((c) => c.id))
          expect(await deps.companyLedger.listCommands(COMPANY_BRANCH, { from: '2026-07-22', to: '2026-07-30' })).toEqual([])
          expect(await deps.companyLedger.listCommands(BRANCH)).toEqual([])
          expect(withoutTime(await deps.companyLedger.findReversalOf(income.journalEntryId))).toEqual(withoutTime(reversal))
          expect(await deps.companyLedger.findReversalOf(deposit.journalEntryId)).toBeNull()

          // 500,000 − 100,000 + 30,000 − 30,000 + 1,305,000 lira; 20,000 − 5,000 − 10,000 cents.
          const overview = await deps.companyLedgerSource.readOverview(COMPANY_BRANCH, { from: TODAY, to: TODAY })
          expect(overview.pockets).toEqual({ SYP_NEW: 1_705_000n, USD: 5_000n })
          expect(overview.reserves).toEqual({ SYP_NEW: 0n, USD: 0n })
          expect(overview.branches).toEqual([{ branchId: BRANCH, companyBox: 0n, clearing: 0n, cutOver: false }])
          expect(overview.period.SYP_NEW).toEqual({ income: 0n, expense: 0n, deposits: 500_000n, withdrawals: 100_000n, net: 0n })
          expect(overview.period.USD).toEqual({ income: 0n, expense: 5_000n, deposits: 20_000n, withdrawals: 0n, net: -5_000n })
          const outside = await deps.companyLedgerSource.readOverview(COMPANY_BRANCH, { from: '2026-07-22', to: '2026-07-22' })
          expect(outside.pockets).toEqual(overview.pockets)
          expect(outside.period.USD).toEqual({ income: 0n, expense: 0n, deposits: 0n, withdrawals: 0n, net: 0n })

          // The running pocket balance follows posting order, per currency.
          const movements = await deps.companyLedgerSource.listMovements(COMPANY_BRANCH, { from: TODAY, to: TODAY })
          expect(movements.map((m) => m.entry.id)).toEqual(all.map((c) => c.journalEntryId))
          expect(movements.map((m) => m.pocketAfter)).toEqual([
            { SYP_NEW: 500_000n },
            { USD: 20_000n },
            { SYP_NEW: 400_000n },
            { USD: 15_000n },
            { SYP_NEW: 430_000n },
            { USD: 5_000n, SYP_NEW: 1_735_000n },
            { SYP_NEW: 1_705_000n },
          ])
          expect(movements[5]!.entry.sypMinorPerUsd).toBe(RATE)
          expect(await deps.companyLedgerSource.listMovements(COMPANY_BRANCH, { from: '2026-07-22', to: '2026-07-22' })).toEqual([])
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('refuses a key already spent on another command, and a second reversal of one entry', async () => {
        const deps = await fresh()
        try {
          await categories(deps)
          const deposit = await issue(deps, companyDeposit('SYP_NEW', minor(9_000n), 'owner_funding', KEY(11)), null, 'إيداع', {
            ...base, id: KEY(11), kind: 'deposit', equityAccount: 'owner_funding', currency: 'SYP_NEW',
            amount: minor(9_000n), sypMinorPerUsd: null, reason: 'إيداع',
          })
          // The same key sent to an expense: refused, and nothing it posted survives.
          await expect(
            issue(deps, companyExpense('SYP_NEW', minor(1n), 'general', 'pocket', KEY(11)), null, 'صرفية', {
              ...base, id: KEY(11), kind: 'expense', currency: 'SYP_NEW', amount: minor(1n), sypMinorPerUsd: null,
              categoryId: EXPENSE_CATEGORY, costCenterKind: 'general', vehicleId: null, assetId: null,
              paidFrom: 'pocket', receiptMediaId: null, description: 'صرفية',
            }),
          ).rejects.toMatchObject({ code: 'DUPLICATE_COMPANY_COMMAND' })
          expect(await deps.ledger.findStandaloneEntry(COMPANY_BRANCH, 'company_expense', KEY(11))).toBeNull()

          const reverse = (id: string) =>
            issue(deps, companyReversal(companyDeposit('SYP_NEW', minor(9_000n), 'owner_funding', KEY(11)), id), null, 'خطأ', {
              ...base, id, kind: 'reversal', targetKind: 'move', targetId: KEY(11),
              targetEntryId: deposit.journalEntryId, sypMinorPerUsd: null, reason: 'خطأ',
            })
          await reverse(KEY(12))
          await expect(reverse(KEY(13))).rejects.toMatchObject({ code: 'DUPLICATE_REVERSAL' })
          expect(await deps.ledger.findStandaloneEntry(COMPANY_BRANCH, 'company_correction', KEY(13))).toBeNull()
          expect(await deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(0n)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('cuts a branch over once, then mirrors every company_box movement into the company pocket', async () => {
        const deps = await fresh()
        try {
          const branchMeta = { ...CMD, sypMinorPerUsd: null }
          // History before the cutover: the branch's company_box is the branch's own business.
          const [history] = await deps.financialUnitOfWork.run({ lockKey: `receivables:${BRANCH}`, actorId: USER }, (tx) =>
            tx.ledger.post(BRANCH, [manualKaish('office_cash', minor(700n), 'c2-history')], { ...branchMeta, reason: 'كييش قديم' }),
          )
          expect(await deps.companyLedger.cutoverFor(BRANCH)).toBeNull()

          const cutover = await deps.financialUnitOfWork.run({ lockKey: `receivables:${BRANCH}`, actorId: USER }, async (tx) => {
            await lockBranchThenCompany(tx, BRANCH, COMPANY_BRANCH)
            const opening = await tx.ledger.fundBalance(BRANCH, 'company_box')
            const watermark = await tx.companyLedger.latestEntryId()
            const [entry] = await tx.ledger.post(COMPANY_BRANCH, [companyOpeningTransfer(BRANCH, opening)], {
              ...branchMeta,
              reason: 'الانتقال إلى الصندوق المستقل',
            })
            const row = {
              branchId: BRANCH,
              companyBranchId: COMPANY_BRANCH,
              openingAmount: opening,
              openingEntryId: entry!.id,
              watermarkEntryId: watermark,
              businessDate: TODAY,
              reason: 'الانتقال إلى الصندوق المستقل',
              performedBy: USER,
              performedAtMs: 0,
            }
            await tx.companyLedger.createCutover(row)
            return row
          })
          expect(cutover.openingAmount).toBe(700n)
          expect(cutover.watermarkEntryId).toBeGreaterThanOrEqual(history!.id)
          expect({ ...(await deps.companyLedger.cutoverFor(BRANCH))!, performedAtMs: 0 }).toEqual(cutover)
          expect((await deps.companyLedger.listCutovers()).map((c) => c.branchId)).toEqual([BRANCH])
          await expect(
            deps.financialUnitOfWork.run({ lockKey: `receivables:${BRANCH}`, actorId: USER }, (tx) =>
              tx.companyLedger.createCutover(cutover),
            ),
          ).rejects.toMatchObject({ code: 'DUPLICATE_CUTOVER' })

          // A hand «كييش» after the cutover, with its HQ half in the same unit of work.
          const mirror = await deps.financialUnitOfWork.run({ lockKey: `receivables:${BRANCH}`, actorId: USER }, async (tx) => {
            await lockBranchThenCompany(tx, BRANCH, COMPANY_BRANCH)
            const [source] = await tx.ledger.post(BRANCH, [manualKaish('office_wallet', minor(300n), 'c2-after')], {
              ...branchMeta,
              reason: 'كييش بعد الانتقال',
            })
            const [half] = await tx.ledger.post(
              COMPANY_BRANCH,
              [restorationMirror('to_company', minor(300n), BRANCH, source!.id)],
              {
                ...branchMeta,
                businessDate: source!.businessDate,
                postingDate: source!.postingDate,
                weekStartDate: source!.weekStartDate,
                reason: 'كييش بعد الانتقال',
              },
            )
            const row = {
              id: KEY(21),
              sourceBranchId: BRANCH,
              sourceEntryId: source!.id,
              mirrorEntryId: half!.id,
              direction: 'to_company' as const,
              amount: minor(300n),
              restorationId: null,
              createdBy: USER,
              createdAtMs: 0,
            }
            await tx.companyLedger.createMirror(row)
            return row
          })
          expect(mirror.sourceEntryId).toBeGreaterThan(cutover.watermarkEntryId)
          expect(withoutTime(await deps.companyLedger.findMirrorBySource(mirror.sourceEntryId))).toEqual(mirror)
          expect((await deps.companyLedger.listMirrors(BRANCH)).map((m) => m.sourceEntryId)).toEqual([mirror.sourceEntryId])
          expect(await deps.companyLedger.findMirrorBySource(history!.id)).toBeNull()
          expect(await deps.companyLedger.latestEntryId()).toBe(mirror.mirrorEntryId)

          const overview = await deps.companyLedgerSource.readOverview(COMPANY_BRANCH, { from: TODAY, to: TODAY })
          expect(overview.branches).toEqual([{ branchId: BRANCH, companyBox: 1_000n, clearing: -1_000n, cutOver: true }])
          expect(overview.pockets.SYP_NEW).toBe(1_000n)
          const movements = await deps.companyLedgerSource.listMovements(COMPANY_BRANCH, { from: TODAY, to: TODAY })
          expect(movements.map((m) => [m.entry.eventType, m.pocketAfter])).toEqual([
            ['company_opening_transfer', { SYP_NEW: 700n }],
            ['company_restoration_mirror', { SYP_NEW: 1_000n }],
          ])
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('orders', () => {
      it('refuses a duplicate provider order number', async () => {
        const deps = await fresh()
        try {
          const order = {
            id: ORDER_1,
            shiftId: SHIFT,
            providerOrderNo: 'YAL-1',
            payMode: 'cash' as const,
            fee: syp(5_000),
            zone: null,
            driverConfirmed: true,
            source: 'manual' as const,
            feeOcr: null,
            kind: 'yallago' as const,
            driverShare: null,
            companyShare: null,
            notes: null,
            createdBy: null,
            points: [],
            included: true,
            walletAmount: null,
            occurredMinute: null,
            occurredDate: null,
            windowStatus: 'unknown' as const,
            decisionReason: null,
            decidedBy: null,
            decidedAt: null,
          }
          await deps.orders.create(order, USER)
          await expect(deps.orders.create({ ...order, id: ORDER_2 }, USER)).rejects.toThrow()
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('battery reading replacement generations', () => {
      it('same-image correction replaces the OCR baseline submitted with the correction', async () => {
        const deps = await fresh()
        try {
          await deps.media.attach(SHIFT, 'start', 'bms_1', MEDIA_1, {
            actorId: USER,
            attachedAtMs: 1_784_000_000_000,
          })
          await deps.batteryReadings.upsert(batteryReading())

          const corrected = batteryReading({
            percent: 64,
            packMillivolts: 72_260,
            cycleCount: 203,
            remainCapacityDah: 326,
            fullCapacityDah: 502,
            mosTempDc: 329,
            t1Dc: 322,
            t2Dc: 324,
            source: 'manual',
            // A cloud retry of the same bytes produced a better baseline before the correction.
            ocrRaw: { percent: 63, cycleCount: 203 },
          })
          await deps.batteryReadings.upsert(corrected)

          expect(await deps.batteryReadings.listByShift(SHIFT)).toEqual([corrected])
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('replacement-photo manual revision clears OCR data from the superseded photo', async () => {
        const deps = await fresh()
        try {
          await deps.media.attach(SHIFT, 'start', 'bms_1', MEDIA_1, {
            actorId: USER,
            attachedAtMs: 1_784_000_000_000,
          })
          await deps.batteryReadings.upsert(batteryReading())

          const replacement = batteryReading({
            percent: 78,
            packMillivolts: 73_040,
            cycleCount: 207,
            remainCapacityDah: 391,
            fullCapacityDah: 505,
            mosTempDc: 337,
            t1Dc: 331,
            t2Dc: 334,
            mediaId: MEDIA_2,
            source: 'manual',
            ocrRaw: null,
          })
          await deps.media.attach(SHIFT, 'start', 'bms_1', MEDIA_2, {
            actorId: USER,
            attachedAtMs: 1_784_000_060_000,
          })
          await deps.batteryReadings.upsert(replacement)

          expect(await deps.batteryReadings.listByShift(SHIFT)).toEqual([replacement])
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    /**
     * Two screenshots of one scrolling log overlap, so the same rows arrive twice. Both adapters
     * must merge them identically or a test passes against a laxer rule than production runs.
     */
    describe('wallet movements', () => {
      const move = (amount: number, occurredMinute: string) => ({ amount: syp(amount), occurredMinute })

      it('re-reading a page adds nothing', async () => {
        const deps = await fresh()
        try {
          const page = [move(-47, '18:06'), move(153, '17:42'), move(-42, '17:42')]
          expect(await deps.movements.merge(SHIFT, page, USER)).toHaveLength(3)
          expect(await deps.movements.merge(SHIFT, page, USER)).toHaveLength(0)
          expect(await deps.movements.listByShift(SHIFT)).toHaveLength(3)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('a second page contributes only its genuinely new rows', async () => {
        const deps = await fresh()
        try {
          await deps.movements.merge(SHIFT, [move(-47, '18:06'), move(153, '17:42')], USER)
          // The overlap: the first row was already read off page one, the second is new.
          const added = await deps.movements.merge(SHIFT, [move(153, '17:42'), move(-24, '13:10')], USER)
          expect(added.map((m) => m.amount)).toEqual([syp(-24)])
          expect(await deps.movements.listByShift(SHIFT)).toHaveLength(3)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('keeps two genuinely identical movements in the same minute, numbered apart', async () => {
        const deps = await fresh()
        try {
          const both = await deps.movements.merge(SHIFT, [move(-24, '13:10'), move(-24, '13:10')], USER)
          expect(both.map((m) => m.seq)).toEqual([1, 2])
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('can unlink a movement from its order — null is an instruction, not an omission', async () => {
        const deps = await fresh()
        try {
          const [row] = await deps.movements.merge(
            SHIFT,
            [{ ...move(153, '17:42'), orderId: null }],
            USER,
          )
          await deps.movements.update(row!.id, { role: 'unmatched', orderId: null, included: false }, USER)
          const after = (await deps.movements.listByShift(SHIFT))[0]!
          expect(after.included).toBe(false)
          expect(after.orderId).toBeNull()
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('audit', () => {
      it('accepts a record with NO actor — the unauthenticated lockout path depends on it', async () => {
        const deps = await fresh()
        try {
          await deps.audit.append({
            tableName: 'users',
            recordId: USER,
            action: 'UPDATE',
            actorId: null,
            actorKind: 'anonymous',
            branchId: null,
            requestId: 'req-1',
            before: null,
            after: { failedAttempts: 1 },
            occurredAtMs: 1_784_000_000_000,
          })
          const rows = await deps.audit.list({ tableName: 'users' })
          const appended = rows.filter((row) => row.requestId === 'req-1')
          expect(appended).toHaveLength(1)
          expect(appended[0]).toMatchObject({
            tableName: 'users',
            recordId: USER,
            action: 'UPDATE',
            actorId: null,
            actorKind: 'anonymous',
            branchId: null,
            before: null,
            after: { failedAttempts: 1 },
            occurredAtMs: 1_784_000_000_000,
          })
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('expenses', () => {
      const expenseRecord = (): ExpenseRecord => ({
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        branchId: BRANCH,
        categoryId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        costCenterKind: 'general',
        vehicleId: null,
        amount: syp(250),
        businessDate: '2026-07-21',
        description: 'Charging electricity',
        receiptMediaId: null,
        channel: 'office_cash',
    journalEntryId: null,
  advanceId: null,
        createdBy: USER,
      })

      it('finds a client-keyed expense exactly and refuses a duplicate identity', async () => {
        const deps = await fresh()
        try {
          await deps.expenses.createCategory({
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            code: 'POWER',
            nameAr: 'كهرباء الشحن',
            active: true,
          })
          expect(await deps.expenses.get('dddddddd-dddd-4ddd-8ddd-dddddddddddd')).toBeNull()

          const row = expenseRecord()
          await deps.expenses.create(row)
          expect(await deps.expenses.get(row.id)).toEqual(row)
          await expect(deps.expenses.create(row)).rejects.toThrow()
          expect(await deps.expenses.listByBranchAndDate(BRANCH, '2026-07-21', '2026-07-21')).toEqual([row])
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('receivable event commands', () => {
      const eventId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      const key = 'receivable-conformance-1'

      it('round-trips an immutable event linked to its exact balanced journal', async () => {
        const deps = await fresh()
        try {
          const fxDayId = (await deps.fx.idFor('2026-07-21')) ?? await deps.fx.upsert({
            businessDate: '2026-07-21',
            sypMinorPerUsd: 13_000n,
            provisional: false,
          })
          const saved = await deps.financialUnitOfWork.run(
            { lockKey: `receivable:${BRANCH}:${key}`, actorId: USER, requestId: 'receivable-conformance' },
            async (tx) => {
              const [entry] = await tx.ledger.post(
                BRANCH,
                [receivableAdjustment(DRIVER, 'ordinary', 'cash', 'create', syp(250), key)],
                {
                  ...META,
                  shiftId: null,
                  fxDayId,
                  reason: 'direct driver debt',
                },
              )
              const event = {
                id: eventId,
                branchId: BRANCH,
                driverId: DRIVER,
                receivableKind: 'ordinary' as const,
                channel: 'cash' as const,
                direction: 'create' as const,
                amount: syp(250),
                businessDate: '2026-07-21' as const,
                reason: 'direct driver debt',
                intent: 'command' as const,
                priorBalance: null,
                targetBalance: null,
                idempotencyKey: key,
                journalEntryId: entry!.id,
                createdBy: USER,
                createdAtMs: 1_784_000_000_000,
              }
              await tx.receivableEvents.create(event)
              return event
            },
          )

          expect(await deps.receivableEvents.findByIdempotencyKey(BRANCH, key)).toEqual(saved)
          expect(await deps.receivableEvents.listByBranchAndDriver(BRANCH, DRIVER)).toEqual([saved])
          expect(await deps.receivableEvents.listByBranchAndDriver(BRANCH, OTHER_DRIVER)).toEqual([])
          expect(
            await deps.receivableEvents.listByBranchAndDriver(
              '11111111-1111-1111-1111-111111111199',
            ),
          ).toEqual([])
          await expect(deps.receivableEvents.create(saved)).rejects.toMatchObject({
            code: 'DUPLICATE_IDEMPOTENCY_KEY',
          })
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('rolls both the event and journal back when a later financial write fails', async () => {
        const deps = await fresh()
        try {
          const rollbackKey = 'receivable-conformance-rollback'
          const fxDayId = (await deps.fx.idFor('2026-07-21')) ?? await deps.fx.upsert({
            businessDate: '2026-07-21',
            sypMinorPerUsd: 13_000n,
            provisional: false,
          })
          await expect(
            deps.financialUnitOfWork.run(
              { lockKey: `receivable:${BRANCH}:${rollbackKey}`, actorId: USER },
              async (tx) => {
                const [entry] = await tx.ledger.post(
                  BRANCH,
                  [receivableAdjustment(DRIVER, 'ordinary', 'wallet', 'create', syp(75), rollbackKey)],
                  { ...META, shiftId: null, fxDayId, reason: 'rollback proof' },
                )
                await tx.receivableEvents.create({
                  id: 'ffffffff-ffff-4fff-8fff-fffffffffffe',
                  branchId: BRANCH,
                  driverId: DRIVER,
                  receivableKind: 'ordinary',
                  channel: 'wallet',
                  direction: 'create',
                  amount: syp(75),
                  businessDate: '2026-07-21',
                  reason: 'rollback proof',
                  intent: 'command',
                  priorBalance: null,
                  targetBalance: null,
                  idempotencyKey: rollbackKey,
                  journalEntryId: entry!.id,
                  createdBy: USER,
                  createdAtMs: 1_784_000_000_001,
                })
                throw new Error('fail after receivable event')
              },
            ),
          ).rejects.toThrow('fail after receivable event')

          expect(await deps.receivableEvents.findByIdempotencyKey(BRANCH, rollbackKey)).toBeNull()
          expect(
            (await deps.ledger.listByWeek(BRANCH, META.weekStartDate))
              .some((entry) => entry.occurrenceKey === rollbackKey),
          ).toBe(false)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('cash count identity and atomic restoration', () => {
      const createCount = async (deps: Deps, businessDate: '2026-07-21' | '2026-07-22') =>
        await (async () => {
          await deps.financialUnitOfWork.run(
            { lockKey: `receivables:${BRANCH}`, actorId: USER },
            async (tx) => {
              await tx.capitalTargets.upsert({
                branchId: BRANCH,
                fundCode: 'office_cash',
                target: syp(10),
                effectiveFrom: businessDate,
                createdBy: USER,
                note: 'restoration conformance target',
              })
              await tx.capitalTargets.upsert({
                branchId: BRANCH,
                fundCode: 'office_wallet',
                target: minor(0n),
                effectiveFrom: businessDate,
                createdBy: USER,
                note: 'restoration conformance target',
              })
            },
          )
          return deps.cashCounts.create({
            // Memory may preserve this value; PostgreSQL must replace it with its generated BIGINT.
            id: `client-placeholder-${businessDate}`,
            branchId: BRANCH,
            businessDate,
            countedBy: USER,
            countedAtMs: 1_784_000_000_000,
            lines: [
              {
                fundCode: 'office_cash',
                counted: syp(10),
                computed: minor(0n),
                variance: syp(10),
                resolution: 'signed daily count variance',
              },
              {
                fundCode: 'office_wallet',
                counted: minor(0n),
                computed: minor(0n),
                variance: minor(0n),
                resolution: null,
              },
            ],
            proofSha256: 'c'.repeat(64),
            sealedAtMs: 1_784_000_000_000,
            status: 'active',
            supersededById: null,
            closedAtMs: null,
            closedBy: null,
            closedReason: null,
            notes: null,
          })
        })()

      const reconciliation = (key: string): Posting => ({
        eventType: 'correction',
        occurrenceKey: key,
        lines: [
          { fund: { kind: 'office_cash' }, side: 'D', amount: syp(10), role: 'cash_count_reconciled_fund' },
          {
            fund: { kind: 'cost_center', costCenterId: `cash_count_variance:${BRANCH}:office_cash` },
            side: 'C',
            amount: syp(10),
            role: 'cash_count_variance_counterpart',
          },
        ],
      })

      it('returns the persisted count id and commits a restoration record pointing to it', async () => {
        const deps = await fresh()
        try {
          const count = await createCount(deps, '2026-07-21')
          expect(count.id).toBeTruthy()
          expect(await deps.cashCounts.find(BRANCH, '2026-07-21')).toEqual(count)

          const key = `cash-count:${count.id}:${count.proofSha256}:office_cash`
          await deps.financialUnitOfWork.run(
            { lockKey: `receivables:${BRANCH}`, actorId: USER, requestId: 'restoration-conformance' },
            async (tx) => {
              expect(await tx.cashCounts.find(BRANCH, '2026-07-21')).toEqual(count)
              const entries = await tx.ledger.post(BRANCH, [reconciliation(key)], {
                ...META,
                shiftId: null,
                reason: 'signed daily count variance',
              })
              expect(entries).toHaveLength(1)
              // The row id comes back: a company mirror of the run's journals names it (C2).
              const restorationId = await tx.restorations.create({
                branchId: BRANCH,
                businessDate: '2026-07-21',
                runNo: 1,

                cashCountId: count.id,
                plan: {
                  schemaVersion: 2,
                  cashCountProofSha256: count.proofSha256,
                  cashCountSealedAt: new Date(count.sealedAtMs!).toISOString(),
                  countReconciliation: [
                    { fundCode: 'office_cash', variance: '10.00', resolution: 'signed daily count variance' },
                    { fundCode: 'office_wallet', variance: '0.00', resolution: null },
                  ],
                  reconciliationJournalEntryIds: [entries[0]!.id],
                  restorationJournalEntryIds: [],
                  legs: [
                    {
                      fundCode: 'office_cash', counted: '10.00', receivables: '0.00',
                      position: '10.00', capitalTarget: '10.00', delta: '0.00', direction: null,
                      amount: '0.00', feasible: true, refusals: [],
                    },
                    {
                      fundCode: 'office_wallet', counted: '0.00', receivables: '0.00',
                      position: '0.00', capitalTarget: '0.00', delta: '0.00', direction: null,
                      amount: '0.00', feasible: true, refusals: [],
                    },
                  ],
                },
                netToCompany: minor(0n),
                reason: 'signed daily count variance',
                performedBy: USER,
              })
              expect(Number.isSafeInteger(restorationId) && restorationId > 0).toBe(true)
            },
          )

          expect(await deps.restorations.find(BRANCH, '2026-07-21')).toMatchObject({
            cashCountId: count.id,
            reason: 'signed daily count variance',
          })
          expect(
            (await deps.ledger.listByWeek(BRANCH, META.weekStartDate))
              .filter((entry) => entry.occurrenceKey === key),
          ).toHaveLength(1)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('rolls both the restoration record and its journal back after a late failure', async () => {
        const deps = await fresh()
        try {
          const count = await createCount(deps, '2026-07-22')
          const key = `cash-count:${count.id}:${count.proofSha256}:office_cash`
          await expect(
            deps.financialUnitOfWork.run(
              { lockKey: `receivables:${BRANCH}`, actorId: USER },
              async (tx) => {
                const entries = await tx.ledger.post(BRANCH, [reconciliation(key)], {
                  ...META,
                  shiftId: null,
                  businessDate: '2026-07-22',
                  postingDate: '2026-07-22',
                  reason: 'signed daily count variance',
                })
                await tx.restorations.create({
                  branchId: BRANCH,
                  businessDate: '2026-07-22',
                  runNo: 1,

                cashCountId: count.id,
                  plan: {
                    schemaVersion: 2,
                    cashCountProofSha256: count.proofSha256,
                    cashCountSealedAt: new Date(count.sealedAtMs!).toISOString(),
                    countReconciliation: [
                      { fundCode: 'office_cash', variance: '10.00', resolution: 'signed daily count variance' },
                      { fundCode: 'office_wallet', variance: '0.00', resolution: null },
                    ],
                    reconciliationJournalEntryIds: [entries[0]!.id],
                    restorationJournalEntryIds: [],
                    legs: [
                      {
                        fundCode: 'office_cash', counted: '10.00', receivables: '0.00',
                        position: '10.00', capitalTarget: '10.00', delta: '0.00', direction: null,
                        amount: '0.00', feasible: true, refusals: [],
                      },
                      {
                        fundCode: 'office_wallet', counted: '0.00', receivables: '0.00',
                        position: '0.00', capitalTarget: '0.00', delta: '0.00', direction: null,
                        amount: '0.00', feasible: true, refusals: [],
                      },
                    ],
                  },
                  netToCompany: minor(0n),
                  reason: 'signed daily count variance',
                  performedBy: USER,
                })
                throw new Error('fail after restoration record')
              },
            ),
          ).rejects.toThrow('fail after restoration record')

          expect(await deps.restorations.find(BRANCH, '2026-07-22')).toBeNull()
          expect(
            (await deps.ledger.listByWeek(BRANCH, META.weekStartDate))
              .some((entry) => entry.occurrenceKey === key),
          ).toBe(false)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('immutable shift settlement', () => {
      it('round-trips every minor-unit field exactly, including a signed wallet action', async () => {
        const deps = await freshSettlement()
        try {
          const created = await createAndApproveSettlement(deps, settlement())
          const stored = await deps.settlements.findByShift(SHIFT)

          expect(created.id).toBeGreaterThan(0)
          expect(stored).toEqual(created)
          expect(stored?.actualWallet).toBe(syp(-10_000))
          expect(stored?.walletToOffice).toBe(syp(-10_000))
          expect(stored?.walletAction).toBe('fund')
          expect(typeof stored?.cashToOffice).toBe('bigint')
          expect(await deps.settlements.listByShiftIds([
            '00000000-0000-4000-8000-000000009999',
            SHIFT,
            SHIFT,
          ])).toEqual([created])
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('stores a shortage beyond the share as immediate signed employee cash, not a receivable', async () => {
        const deps = await freshSettlement()
        try {
          const stored = await createAndApproveSettlement(deps,
            settlement({
              actualCash: syp(110_000),
              actualWallet: syp(70_000),
              actualTotal: syp(180_000),
              variance: syp(-50_000),
              varianceDirection: 'shortage',
              finalEmployeeCash: syp(-10_000),
              maximumCashShortageReceivable: syp(10_000),
              cashClaimToOffice: syp(120_000),
              walletClaimToOffice: syp(70_000),
              walletToOffice: syp(70_000),
              walletAction: 'collect',
              walletAmount: syp(70_000),
              cashToOffice: syp(120_000),
              cashAction: 'collect',
              cashAmount: syp(120_000),
              varianceReason: 'نقص مؤكد ويُحصّل الآن',
            }),
          )
          expect(stored.finalEmployeeCash).toBe(syp(-10_000))
          expect(stored.cashToOffice).toBe(syp(120_000))
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('supports a wallet-heavy close where the office collects the wallet and pays cash', async () => {
        const deps = await freshSettlement()
        try {
          const stored = await createAndApproveSettlement(deps,
            settlement({
              actualCash: syp(20_000),
              actualWallet: syp(210_000),
              actualTotal: syp(230_000),
              cashClaimToOffice: syp(-20_000),
              walletClaimToOffice: syp(210_000),
              walletToOffice: syp(210_000),
              walletAction: 'collect',
              walletAmount: syp(210_000),
              cashToOffice: syp(-20_000),
              cashAction: 'pay',
              cashAmount: syp(20_000),
            }),
          )
          expect(stored.walletAction).toBe('collect')
          expect(stored.cashAction).toBe('pay')
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('stores reviewed cash and wallet receivables while moving only the remainder', async () => {
        const deps = await freshSettlement()
        try {
          const stored = await createAndApproveSettlement(deps,
            settlement({
              actualCash: syp(220_000),
              actualWallet: syp(10_000),
              actualTotal: syp(230_000),
              cashClaimToOffice: syp(180_000),
              walletClaimToOffice: syp(10_000),
              cashReceivableDeferred: syp(6_000),
              walletReceivableDeferred: syp(1_000),
              cashToOffice: syp(174_000),
              walletToOffice: syp(9_000),
              cashAction: 'collect',
              cashAmount: syp(174_000),
              walletAction: 'collect',
              walletAmount: syp(9_000),
            }),
          )
          expect(stored.cashReceivableDeferred).toBe(syp(6_000))
          expect(stored.walletReceivableDeferred).toBe(syp(1_000))
          expect(stored.cashToOffice).toBe(syp(174_000))
          expect(stored.walletToOffice).toBe(syp(9_000))
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('rejects a snapshot that bypasses the fixed 40% policy or either handover confirmation', async () => {
        const deps = await freshSettlement()
        try {
          await expect(
            deps.settlements.create(settlement({ fixedDriverShare: syp(39_999) })),
          ).rejects.toThrow()
          await expect(
            deps.settlements.create(settlement({ walletTransferConfirmed: false })),
          ).rejects.toThrow()
          expect(await deps.settlements.findByShift(SHIFT)).toBeNull()
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('rejects an unexplained non-zero variance', async () => {
        const deps = await freshSettlement()
        try {
          await expect(
            deps.settlements.create(
              settlement({
                actualCash: syp(239_999),
                actualTotal: syp(229_999),
                variance: syp(-1),
                varianceDirection: 'shortage',
                finalEmployeeCash: syp(39_999),
                cashToOffice: syp(200_000),
                varianceReason: null,
              }),
            ),
          ).rejects.toThrow()
          expect(await deps.settlements.findByShift(SHIFT)).toBeNull()
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('accepts an exact hash replay but refuses a different second snapshot for the shift', async () => {
        const deps = await freshSettlement()
        try {
          const first = await createAndApproveSettlement(deps, settlement())
          const replay = await deps.settlements.create(settlement())
          expect(replay).toEqual(first)

          await expect(
            deps.settlements.create(settlement({ settlementHash: 'c'.repeat(64) })),
          ).rejects.toMatchObject({ code: 'SHIFT_SETTLEMENT_IMMUTABLE' })
          expect(await deps.settlements.findByShift(SHIFT)).toEqual(first)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('rolls the snapshot back with every other close write when the unit of work fails', async () => {
        const deps = await freshSettlement()
        try {
          await expect(
            deps.closeUnitOfWork.run({ shiftId: SHIFT, actorId: USER }, async (transaction) => {
              await transaction.settlements.create(settlement())
              throw new Error('fail after settlement')
            }),
          ).rejects.toThrow('fail after settlement')
          expect(await deps.settlements.findByShift(SHIFT)).toBeNull()
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })

    describe('fx', () => {
      it('upserts a rate and finds it by business date', async () => {
        const deps = await fresh()
        try {
          const id = await deps.fx.upsert({
            businessDate: '2026-07-21',
            sypMinorPerUsd: 13_000n,
            provisional: false,
          })
          expect(await deps.fx.idFor('2026-07-21')).toBe(id)
          expect(await deps.fx.idFor('2026-07-22')).toBeNull()
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('keeps the rate a bigint, not a Number', async () => {
        const deps = await fresh()
        try {
          await deps.fx.upsert({ businessDate: '2026-07-21', sypMinorPerUsd: 13_000n, provisional: false })
          const [day] = await deps.fx.list()
          expect(typeof day?.sypMinorPerUsd).toBe('bigint')
        } finally {
          await ctx.cleanup?.(deps)
        }
      })
    })
  })
}
