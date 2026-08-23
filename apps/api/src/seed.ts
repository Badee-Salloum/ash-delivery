import type { NewShiftSettlementRecord } from '@ash/contracts'
import {
  PgLedgerRepo,
  PgOrderRepo,
  PgShiftSettlementRepo,
  type Pool,
  withTransaction,
} from '@ash/db'
import {
  DEFAULT_BANDS,
  ALL_PERMISSIONS,
  DEFAULT_GRANTS,
  type Minor,
  closingBalances,
  minor,
  planFixedShareSettlement,
  postingsForCashSettledApproval,
  postingsForOpen,
  splitFixedDriverShare,
  totalFees,
  weekStartFor,
} from '@ash/domain'
import type { ShiftOrder } from '@ash/domain'
import {
  FIXED_SETTLEMENT_DRIVER_BPS,
  FIXED_SETTLEMENT_POLICY,
  fixedSettlementHash,
  varianceDirection,
} from './fixed-settlement.ts'
import { ordersHash } from './shifts.service.ts'

/**
 * Demo seed — kickoff brief §5, to the letter:
 *
 *   1 branch · GM, sysadmin, branch-manager, 2 drivers · 10 vehicles ·
 *   one demo day of shifts that passes BR1.
 *
 * Idempotent and re-runnable: stable reference rows use conflict-safe inserts, while the signed
 * settlement and journals use their production replay keys. Running it twice adds no duplicate.
 *
 * It REFUSES to run against production. The check is deliberately an OR of independent
 * conditions, not an AND — a single mis-set variable must not be enough to seed a live database
 * with demo shifts.
 */

const BRANCH = '10000000-0000-4000-8000-000000000001'
const U = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const V = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const VTYPE = '50000000-0000-4000-8000-000000000001'
const SHIFT = '60000000-0000-4000-8000-000000000001'

const syp = (n: number): Minor => minor(BigInt(n) * 100n)

/**
 * The one documented demo shift, expressed through the current fixed-40 policy.
 *
 * Keeping this pure makes the seed's accounting executable in an ordinary unit test. The database
 * half below stores this exact object and the integrity checker independently reconstructs it from
 * rows and journals.
 */
export function buildDemoShiftMoney(businessDate: string) {
  const orders: ShiftOrder[] = []
  let n = 0
  const push = (payMode: ShiftOrder['payMode'], count: number) => {
    for (let i = 0; i < count; i++) {
      n += 1
      orders.push({ orderNo: `SEED-${businessDate}-${n}`, payMode, fee: syp(5_000) })
    }
  }
  push('cash', 12)
  push('electronic', 6)
  push('free', 2)

  const input = {
    driverId: D(1),
    floatTranches: [syp(100_000)],
    topupTranches: [syp(50_000)],
    orders,
  }
  const totals = totalFees(orders.map((order) => order.fee))
  const split = splitFixedDriverShare(orders.map((order) => order.fee))
  const expected = closingBalances(input)
  const settlement = planFixedShareSettlement({
    deliveryFeeTotal: totals.feeTotal,
    fixedDriverShare: split.driverShare,
    manualDriverShare: minor(0n),
    cashDeductionTotal: minor(0n),
    expectedCash: expected.endCash,
    expectedWallet: expected.endWallet,
    actualCash: syp(160_000),
    actualWallet: syp(70_000),
  })

  return { orders, input, split, settlement }
}

export interface SeedOptions {
  /** The demo day. Defaults to today in Damascus. */
  businessDate: string
  /** bcrypt hash for every demo login. */
  passwordHash: string
  force?: boolean
}

export class SeedRefused extends Error {}

export function assertSeedAllowed(env: NodeJS.ProcessEnv, force = false): void {
  if (force) return
  const reasons: string[] = []
  if (env.NODE_ENV === 'production') reasons.push('NODE_ENV=production')
  if (env.APP_ENV === 'production') reasons.push('APP_ENV=production')
  if ((env.DATABASE_URL ?? '').includes('prod')) reasons.push('DATABASE_URL mentions "prod"')
  if (env.ALLOW_SEED === 'false') reasons.push('ALLOW_SEED=false')
  if (reasons.length > 0) {
    throw new SeedRefused(
      `refusing to seed demo data: ${reasons.join(', ')}. Pass --force only if you are certain.`,
    )
  }
}

/** The stable id of the one Damascus branch — reference data every environment needs. */
export const DAMASCUS_BRANCH = BRANCH

/**
 * Reference data that EVERY environment needs — production included: the one branch, the five
 * roles, and the §3 permission matrix (from the domain's authoritative `ALL_PERMISSIONS` /
 * `DEFAULT_GRANTS`, so it can never drift from the RBAC the code enforces). No users, no fleet,
 * no ledger — nothing that would be wrong to have in a live database. Idempotent.
 */
export async function seedReferenceData(pool: Pool): Promise<{ branchId: string }> {
  await pool.query(
    `INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no)
     VALUES ($1,'DAM','دمشق','Damascus',(SELECT id FROM governorates WHERE no = 1),1)
     ON CONFLICT (code) DO NOTHING`,
    [BRANCH],
  )

  // Roles and the §3 permission matrix, stored as DATA (SRS A-2 requires it be editable).
  const roles: Array<[string, string, string]> = [
    ['general_manager', 'المدير العام', 'General Manager'],
    ['system_admin', 'مدير النظام', 'System Admin'],
    ['branch_manager', 'مدير الفرع', 'Branch Manager'],
    ['driver', 'سائق', 'Driver'],
    ['accountant', 'محاسب', 'Accountant'], // seeded with NO grants — enabling it is data (A-17)
  ]
  for (const [key, ar, en] of roles) {
    await pool.query('INSERT INTO roles (key, name_ar, name_en) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING', [key, ar, en])
  }
  for (const permission of ALL_PERMISSIONS) {
    await pool.query(
      'INSERT INTO permissions (key, name_ar, name_en) VALUES ($1,$1,$1) ON CONFLICT (key) DO NOTHING',
      [permission],
    )
    for (const [roleKey, scope] of Object.entries(DEFAULT_GRANTS[permission] ?? {})) {
      await pool.query(
        `INSERT INTO role_permissions (role_key, permission_key, scope) VALUES ($1,$2,$3)
         ON CONFLICT (role_key, permission_key) DO NOTHING`,
        [roleKey, permission, scope],
      )
    }
  }
  // A vehicle type is NOT optional reference data: vehicles.vehicle_type_id is NOT NULL, so
  // without a row here the console's "add vehicle" button cannot work at all. This used to live
  // only in the demo seed, which refuses to run against production — the reason a live install
  // had an empty vehicle_types table and a create-vehicle button that reported success while
  // failing. `type_no` is the third segment of «رقم الآلية»; the sysadmin can renumber it later.
  await pool.query(
    `INSERT INTO vehicle_types (id, code, name_ar, name_en, type_no)
     VALUES ($1,'e_motorbike','دراجة كهربائية','Electric Motorbike',1)
     ON CONFLICT (code) DO NOTHING`,
    [VTYPE],
  )

  return { branchId: BRANCH }
}

/** Insert one user. Idempotent on username. Shared by the demo seed and the production bootstrap. */
export async function createUser(
  pool: Pool,
  user: { id: string; branchId: string | null; roleKey: string; username: string; fullNameAr: string; passwordHash: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (username) DO NOTHING`,
    [user.id, user.branchId, user.roleKey, user.username, user.fullNameAr, user.passwordHash],
  )
}

export async function seed(pool: Pool, opts: SeedOptions): Promise<{ br1Difference: Minor }> {
  const { businessDate, passwordHash } = opts
  const weekStart = weekStartFor(businessDate)

  await seedReferenceData(pool)

  const users: Array<[string, string, string, string, string | null]> = [
    [U(1), 'gm', 'general_manager', 'المدير العام', null],
    [U(2), 'sysadmin', 'system_admin', 'مدير النظام', null],
    [U(3), 'manager', 'branch_manager', 'مدير فرع دمشق', BRANCH],
    [U(4), 'driver1', 'driver', 'أحمد', BRANCH],
    [U(5), 'driver2', 'driver', 'خالد', BRANCH],
  ]
  for (const [id, username, roleKey, nameAr, branchId] of users) {
    await createUser(pool, { id, branchId, roleKey, username, fullNameAr: nameAr, passwordHash })
  }

  await pool.query(
    `INSERT INTO drivers (id, branch_id, user_id, code, full_name_ar)
     VALUES ($1,$2,$3,'DRV-001','أحمد'), ($4,$2,$5,'DRV-002','خالد')
     ON CONFLICT (code) DO NOTHING`,
    [D(1), BRANCH, U(4), D(2), U(5)],
  )

  // Ten electric motorbikes — the client's actual fleet today (SRS س61).
  for (let i = 1; i <= 10; i++) {
    await pool.query(
      // «رقم الآلية»: governorate 1 (دمشق), branch 1, type 1 (e-motorbike), machine i.
      `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no, plate_no, state)
       SELECT $1,$2,vt.id,$3,$4,$5,'ready'
         FROM vehicle_types vt
        WHERE vt.code = 'e_motorbike'
       ON CONFLICT (code) DO NOTHING`,
      [V(i), BRANCH, `1-1-1-${i}`, i, `DAM-${1000 + i}`],
    )
  }

  // PostgreSQL unique constraints treat NULL vehicle ids as distinct. Serialize and check the
  // branch-wide default explicitly; ON CONFLICT alone would add another rule on every seed run.
  await withTransaction(pool, { actorId: U(2), requestId: 'demo-seed-tier' }, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['demo-seed:default-tier'])
    await client.query(
      `INSERT INTO tier_rules (basis, mode, vehicle_type_id, bands, effective_from, status, created_by)
       SELECT 'orders','whole',NULL,$1,'2026-01-01','active',$2
        WHERE NOT EXISTS (
          SELECT 1 FROM tier_rules
           WHERE vehicle_type_id IS NULL AND effective_from = '2026-01-01'
        )`,
      [JSON.stringify(DEFAULT_BANDS), U(2)],
    )
  })

  // ── The demo day: the SRS §2.3 shift, so the seed itself proves BR1 ──────────────────
  await pool.query(
    `INSERT INTO shifts (id, branch_id, driver_id, vehicle_id, shift_no, business_date,
                         week_start_date, state, start_cash_float_minor, start_wallet_topup_minor,
                         end_cash_declared_minor, end_wallet_declared_minor,
                         odo_start, odo_end, battery_start, battery_end, equation_diff_minor,
                         cash_diff_minor, wallet_diff_minor, driver_confirmed_at, opened_by,
                         open_approved_by, open_approved_at, submitted_at)
     VALUES ($1,$2,$3,$4,1,$5,$6,'pending_review',$7,$8,$9,$10,15320,15412,95,22,0,0,0,
             now(),$11,$12,now() - interval '8 hours',now())
     ON CONFLICT (id) DO NOTHING`,
    [
      SHIFT, BRANCH, D(1), V(1), businessDate, weekStart,
      syp(100_000).toString(), syp(50_000).toString(),
      syp(160_000).toString(), syp(70_000).toString(), U(4), U(3),
    ],
  )

  // Re-running tomorrow must replay the existing one demo day, not attach a second date's orders
  // to the fixed demo shift id. Read the durable date back after the idempotent insert.
  const storedShift = await pool.query<{
    business_date: string
    week_start_date: string
    state: string
    has_settlement: boolean
  }>(
    `SELECT to_char(s.business_date, 'YYYY-MM-DD') AS business_date,
            to_char(s.week_start_date, 'YYYY-MM-DD') AS week_start_date,
            s.state::text AS state,
            EXISTS (SELECT 1 FROM shift_settlements ss WHERE ss.shift_id = s.id) AS has_settlement
       FROM shifts s
      WHERE s.id = $1`,
    [SHIFT],
  )
  const durableShift = storedShift.rows[0]
  if (!durableShift) throw new Error('demo shift insert disappeared')
  if (durableShift.state === 'approved' && !durableShift.has_settlement) {
    throw new Error(
      'the demo shift predates fixed-40 settlements; recreate this disposable database before reseeding',
    )
  }
  if (durableShift.state !== 'pending_review' && durableShift.state !== 'approved') {
    throw new Error(`demo shift is unexpectedly ${durableShift.state}; refusing to rewrite it`)
  }

  const effectiveBusinessDate = durableShift.business_date
  const effectiveWeekStart = durableShift.week_start_date
  const demo = buildDemoShiftMoney(effectiveBusinessDate)

  const fx = await pool.query<{ id: string }>(
    `INSERT INTO fx_days (business_date, syp_minor_per_usd, provisional, entered_by)
     VALUES ($1, 13000, false, $2)
     ON CONFLICT (business_date) DO UPDATE SET syp_minor_per_usd = EXCLUDED.syp_minor_per_usd
     RETURNING id`,
    [effectiveBusinessDate, U(2)],
  )
  const fxDayId = Number(fx.rows[0]!.id)

  const tranches: ReadonlyArray<readonly ['cash_float' | 'wallet_topup', number, Minor]> = [
    ['cash_float', 1, demo.input.floatTranches[0]!],
    ['wallet_topup', 1, demo.input.topupTranches[0]!],
  ]
  for (const [kind, seqNo, amount] of tranches) {
    await pool.query(
      `INSERT INTO float_tranches (shift_id, kind, seq_no, amount_minor, handed_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (shift_id, kind, seq_no) DO NOTHING`,
      [SHIFT, kind, seqNo, amount.toString(), U(3)],
    )
  }
  const storedTranches = await pool.query<{ kind: string; seq_no: number; amount_minor: string }>(
    `SELECT kind, seq_no::int AS seq_no, amount_minor::text AS amount_minor
       FROM float_tranches
      WHERE shift_id = $1
      ORDER BY kind, seq_no`,
    [SHIFT],
  )
  const expectedTranches = new Map(
    tranches.map(([kind, seqNo, amount]) => [`${kind}:${seqNo}`, amount.toString()]),
  )
  if (
    storedTranches.rows.length !== expectedTranches.size ||
    storedTranches.rows.some(
      (row) => expectedTranches.get(`${row.kind}:${row.seq_no}`) !== row.amount_minor,
    )
  ) {
    throw new Error('the demo shift has non-canonical float tranches; refusing to hide the mismatch')
  }

  for (const order of demo.orders) {
    await pool.query(
      `INSERT INTO shift_orders (shift_id, provider_order_no, pay_mode, fee_minor, zone, driver_confirmed)
       VALUES ($1,$2,$3::pay_mode,$4,'المزة',true)
       ON CONFLICT (provider_order_no) DO NOTHING`,
      [SHIFT, order.orderNo, order.payMode, order.fee.toString()],
    )
  }

  await withTransaction(pool, { actorId: U(3), requestId: 'demo-seed-windowing' }, async (client) => {
    await client.query(
      `UPDATE shift_orders
          SET occurred_date = $3, occurred_minute = '12:00', window_status = 'in_window',
              decision_reason = 'Demo seed: operation belongs to the documented shift',
              decided_by = $4, decided_at = clock_timestamp(), window_basis = 'manager',
              created_by = COALESCE(created_by, $5)
        WHERE shift_id = $1
          AND provider_order_no = ANY($2::text[])
          AND window_status = 'unknown'`,
      [SHIFT, demo.orders.map((order) => order.orderNo), effectiveBusinessDate, U(3), U(4)],
    )
  })

  const storedOrders = await new PgOrderRepo(pool).listByShift(SHIFT)
  const expectedOrders = new Map(demo.orders.map((order) => [order.orderNo, order]))
  if (
    storedOrders.length !== expectedOrders.size ||
    storedOrders.some((row) => {
      const expected = expectedOrders.get(row.providerOrderNo)
      return expected === undefined ||
        row.shiftId !== SHIFT ||
        row.payMode !== expected.payMode ||
        row.fee !== expected.fee ||
        row.kind !== 'yallago' ||
        !row.included ||
        row.occurredDate !== effectiveBusinessDate ||
        row.occurredMinute !== '12:00' ||
        row.windowStatus !== 'in_window' ||
        row.decisionReason !== 'Demo seed: operation belongs to the documented shift' ||
        row.decidedBy !== U(3) ||
        row.closeDraftReviewReasons?.length !== 0
    })
  ) {
    throw new Error('the demo shift has non-canonical orders; refusing to hide the mismatch')
  }

  const reviewedOrdersHash = ordersHash(storedOrders)
  const settlementHash = fixedSettlementHash(
    {
      shiftId: SHIFT,
      branchId: BRANCH,
      driverId: D(1),
      businessDate: effectiveBusinessDate,
      reviewedOrdersHash,
      closeDraftRevision: null,
      closeDraftHash: null,
      closeDraftSubmittedAt: null,
    },
    demo.settlement,
  )
  const confirmedAtMs = Date.now()

  // Post the whole shift through the SAME recipes the API uses — no hand-written INSERTs, so
  // the seed cannot drift from production behaviour.
  const ledger = new PgLedgerRepo(pool)
  await ledger.post(
    BRANCH,
    [
      ...postingsForOpen(demo.input),
      ...postingsForCashSettledApproval(demo.input, demo.split, demo.settlement),
    ],
    {
      shiftId: SHIFT,
      businessDate: effectiveBusinessDate,
      postingDate: effectiveBusinessDate,
      weekStartDate: effectiveWeekStart,
      fxDayId,
      createdBy: U(3),
    },
  )

  const settlementRecord: NewShiftSettlementRecord = {
    shiftId: SHIFT,
    branchId: BRANCH,
    driverId: D(1),
    businessDate: effectiveBusinessDate,
    policyCode: FIXED_SETTLEMENT_POLICY,
    driverRateBps: FIXED_SETTLEMENT_DRIVER_BPS,
    deliveryFeeTotal: demo.settlement.deliveryFeeTotal,
    fixedDriverShare: demo.settlement.fixedDriverShare,
    manualDriverShare: demo.settlement.manualDriverShare,
    grossDriverShare: demo.settlement.grossDriverShare,
    cashDeductionTotal: demo.settlement.cashDeductionTotal,
    baseDriverShare: demo.settlement.baseDriverShare,
    expectedTotal: demo.settlement.expectedTotal,
    actualCash: demo.settlement.actualCash,
    actualWallet: demo.settlement.actualWallet,
    actualTotal: demo.settlement.actualTotal,
    variance: demo.settlement.variance,
    varianceDirection: varianceDirection(demo.settlement.variance),
    finalEmployeeCash: demo.settlement.finalEmployeeCash,
    walletToOffice: demo.settlement.walletToOffice,
    cashToOffice: demo.settlement.cashToOffice,
    walletAction: demo.settlement.wallet.action,
    walletAmount: demo.settlement.wallet.amount,
    cashAction: demo.settlement.cash.action,
    cashAmount: demo.settlement.cash.amount,
    reviewedOrdersHash,
    settlementHash,
    walletTransferConfirmed: true,
    cashSettlementConfirmed: true,
    confirmedBy: U(3),
    confirmedAtMs,
    varianceReason: null,
  }
  await new PgShiftSettlementRepo(pool).create(settlementRecord)

  // Approval and its append-only decision are one final transaction. The advisory lock closes the
  // only remaining race in concurrent demo-seed invocations (the decision table intentionally has
  // no uniqueness constraint because real shifts can carry several different close decisions).
  await withTransaction(pool, { actorId: U(3), requestId: 'demo-seed-fixed-40' }, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`demo-seed:${SHIFT}`])
    await client.query(
      `UPDATE shifts
          SET state = 'approved', approved_by = $2,
              approved_at = to_timestamp($3::double precision / 1000),
              equation_diff_minor = $4, cash_diff_minor = $5, wallet_diff_minor = $6,
              orders_hash = $7, kept_as_receivable_minor = 0,
              driver_share_paid_minor = $8
        WHERE id = $1 AND state = 'pending_review'`,
      [
        SHIFT,
        U(3),
        confirmedAtMs,
        demo.settlement.variance.toString(),
        (demo.settlement.actualCash - demo.settlement.expectedCash).toString(),
        (demo.settlement.actualWallet - demo.settlement.expectedWallet).toString(),
        reviewedOrdersHash,
        demo.settlement.finalEmployeeCash.toString(),
      ],
    )
    await client.query(
      `INSERT INTO shift_decisions (shift_id, gate, decision, notes, decided_by, decided_at)
       SELECT $1, 'close', 'approved', NULL, $2, to_timestamp($3::double precision / 1000)
        WHERE EXISTS (SELECT 1 FROM shifts s WHERE s.id = $1 AND s.state = 'approved')
          AND NOT EXISTS (
            SELECT 1 FROM shift_decisions sd
             WHERE sd.shift_id = $1 AND sd.gate = 'close' AND sd.decision = 'approved'
          )`,
      [SHIFT, U(3), confirmedAtMs],
    )
  })

  // The seed asserts its own correctness: 160,000 + 70,000 == 100,000 + 50,000 + 80,000.
  return { br1Difference: minor(demo.settlement.actualTotal - demo.settlement.expectedTotal) }
}
