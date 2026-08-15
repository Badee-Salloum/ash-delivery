import { describe, expect, it } from 'vitest'
import type {
  BatteryReadingRecord,
  Deps,
  NewShiftSettlementRecord,
  OcrReadClaimInput,
  OcrReadCompletion,
  OcrResult,
} from '@ash/contracts'
import { type Posting, minor } from '@ash/domain'

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
  /** A fresh, empty set of dependencies. Called before every test. */
  makeDeps(): Promise<Deps> | Deps
  /** Optional teardown (close a pool, drop a schema). */
  cleanup?(deps: Deps): Promise<void> | void
  label: string
}

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
  policyCode: 'fixed_40_cash_close_v1',
  driverRateBps: 4_000,
  deliveryFeeTotal: syp(100_000),
  fixedDriverShare: syp(40_000),
  manualDriverShare: syp(0),
  grossDriverShare: syp(40_000),
  cashDeductionTotal: syp(0),
  baseDriverShare: syp(40_000),
  expectedTotal: syp(230_000),
  actualCash: syp(240_000),
  actualWallet: syp(-10_000),
  actualTotal: syp(230_000),
  variance: syp(0),
  varianceDirection: 'balanced',
  finalEmployeeCash: syp(40_000),
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
            eventType: 'restoration',
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

    describe('immutable shift settlement', () => {
      it('round-trips every minor-unit field exactly, including a signed wallet action', async () => {
        const deps = await freshSettlement()
        try {
          const created = await deps.settlements.create(settlement())
          const stored = await deps.settlements.findByShift(SHIFT)

          expect(created.id).toBeGreaterThan(0)
          expect(stored).toEqual(created)
          expect(stored?.actualWallet).toBe(syp(-10_000))
          expect(stored?.walletToOffice).toBe(syp(-10_000))
          expect(stored?.walletAction).toBe('fund')
          expect(typeof stored?.cashToOffice).toBe('bigint')
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('stores a shortage beyond the share as immediate signed employee cash, not a receivable', async () => {
        const deps = await freshSettlement()
        try {
          const stored = await deps.settlements.create(
            settlement({
              actualCash: syp(110_000),
              actualWallet: syp(70_000),
              actualTotal: syp(180_000),
              variance: syp(-50_000),
              varianceDirection: 'shortage',
              finalEmployeeCash: syp(-10_000),
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
          const stored = await deps.settlements.create(
            settlement({
              actualCash: syp(20_000),
              actualWallet: syp(210_000),
              actualTotal: syp(230_000),
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
          const first = await deps.settlements.create(settlement())
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
