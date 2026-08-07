import { describe, expect, it } from 'vitest'
import type { Deps } from '@ash/contracts'
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

const transfer = (occurrenceKey: string, amount = syp(1_000)): Posting => ({
  eventType: 'float_out',
  occurrenceKey,
  lines: [
    { fund: { kind: 'driver_cash', driverId: 'driver-1' }, side: 'D', amount },
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
          expect(await deps.ledger.fundBalance(BRANCH, 'driver_cash:driver-1')).toBe(syp(1_000))
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
          expect(await deps.ledger.fundBalance(BRANCH, 'driver_cash:driver-1')).toBe(syp(100_000))
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
              { fund: { kind: 'driver_share_payable', driverId: 'driver-1' }, side: 'C', amount: syp(40_000) },
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
          expect(await deps.ledger.fundBalance(BRANCH, 'driver_cash:driver-1')).toBe(huge)
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
            id: 'o-1',
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
          }
          await deps.orders.create(order)
          await expect(deps.orders.create({ ...order, id: 'o-2' })).rejects.toThrow()
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
          expect(await deps.movements.merge(SHIFT, page)).toHaveLength(3)
          expect(await deps.movements.merge(SHIFT, page)).toHaveLength(0)
          expect(await deps.movements.listByShift(SHIFT)).toHaveLength(3)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('a second page contributes only its genuinely new rows', async () => {
        const deps = await fresh()
        try {
          await deps.movements.merge(SHIFT, [move(-47, '18:06'), move(153, '17:42')])
          // The overlap: the first row was already read off page one, the second is new.
          const added = await deps.movements.merge(SHIFT, [move(153, '17:42'), move(-24, '13:10')])
          expect(added.map((m) => m.amount)).toEqual([syp(-24)])
          expect(await deps.movements.listByShift(SHIFT)).toHaveLength(3)
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('keeps two genuinely identical movements in the same minute, numbered apart', async () => {
        const deps = await fresh()
        try {
          const both = await deps.movements.merge(SHIFT, [move(-24, '13:10'), move(-24, '13:10')])
          expect(both.map((m) => m.seq)).toEqual([1, 2])
        } finally {
          await ctx.cleanup?.(deps)
        }
      })

      it('can unlink a movement from its order — null is an instruction, not an omission', async () => {
        const deps = await fresh()
        try {
          const [row] = await deps.movements.merge(SHIFT, [{ ...move(153, '17:42'), orderId: null }])
          await deps.movements.update(row!.id, { role: 'unmatched', orderId: null, included: false })
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
          expect(rows).toHaveLength(1)
          expect(rows[0]?.actorId).toBeNull()
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
