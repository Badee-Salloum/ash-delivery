import type { Pool } from '@ash/db'
import {
  DEFAULT_BANDS,
  ALL_PERMISSIONS,
  DEFAULT_GRANTS,
  type Minor,
  bpsForCount,
  minor,
  postingsForApproval,
  postingsForOpen,
  splitBlock,
  totalFees,
  weekStartFor,
} from '@ash/domain'
import type { ShiftOrder } from '@ash/domain'
import { PgLedgerRepo } from '@ash/db'

/**
 * Demo seed — kickoff brief §5, to the letter:
 *
 *   1 branch · GM, sysadmin, branch-manager, 2 drivers · 10 vehicles ·
 *   one demo day of shifts that passes BR1.
 *
 * Idempotent and re-runnable: every insert is ON CONFLICT DO NOTHING, so running it twice
 * changes nothing rather than duplicating a fleet.
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
    `INSERT INTO branches (id, code, name_ar, name_en) VALUES ($1,'DAM','دمشق','Damascus')
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
    `INSERT INTO vehicle_types (id, code, name_ar, name_en)
     VALUES ($1,'e_motorbike','دراجة كهربائية','Electric Motorbike') ON CONFLICT (code) DO NOTHING`,
    [VTYPE],
  )

  await pool.query(
    `INSERT INTO drivers (id, branch_id, user_id, code, full_name_ar)
     VALUES ($1,$2,$3,'DRV-001','أحمد'), ($4,$2,$5,'DRV-002','خالد')
     ON CONFLICT (code) DO NOTHING`,
    [D(1), BRANCH, U(4), D(2), U(5)],
  )

  // Ten electric motorbikes — the client's actual fleet today (SRS س61).
  for (let i = 1; i <= 10; i++) {
    await pool.query(
      `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, plate_no, state)
       VALUES ($1,$2,$3,$4,$5,'ready') ON CONFLICT (code) DO NOTHING`,
      [V(i), BRANCH, VTYPE, `VEH-${String(i).padStart(3, '0')}`, `DAM-${1000 + i}`],
    )
  }

  await pool.query(
    `INSERT INTO tier_rules (basis, mode, vehicle_type_id, bands, effective_from, status, created_by)
     VALUES ('orders','whole',NULL,$1,'2026-01-01','active',$2)
     ON CONFLICT (vehicle_type_id, effective_from) DO NOTHING`,
    [JSON.stringify(DEFAULT_BANDS), U(2)],
  )

  const fx = await pool.query<{ id: string }>(
    `INSERT INTO fx_days (business_date, syp_minor_per_usd, provisional, entered_by)
     VALUES ($1, 13000, false, $2)
     ON CONFLICT (business_date) DO UPDATE SET syp_minor_per_usd = EXCLUDED.syp_minor_per_usd
     RETURNING id`,
    [businessDate, U(2)],
  )
  const fxDayId = Number(fx.rows[0]!.id)

  // ── The demo day: the SRS §2.3 shift, so the seed itself proves BR1 ──────────────────
  await pool.query(
    `INSERT INTO shifts (id, branch_id, driver_id, vehicle_id, shift_no, business_date,
                         week_start_date, state, start_cash_float_minor, start_wallet_topup_minor,
                         end_cash_declared_minor, end_wallet_declared_minor,
                         odo_start, odo_end, battery_start, battery_end, equation_diff_minor,
                         cash_diff_minor, wallet_diff_minor, approved_by, approved_at)
     VALUES ($1,$2,$3,$4,1,$5,$6,'approved',$7,$8,$9,$10,15320,15412,95,22,0,0,0,$11, now())
     ON CONFLICT (id) DO NOTHING`,
    [
      SHIFT, BRANCH, D(1), V(1), businessDate, weekStart,
      syp(100_000).toString(), syp(50_000).toString(),
      syp(160_000).toString(), syp(70_000).toString(), U(3),
    ],
  )

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

  for (const order of orders) {
    await pool.query(
      `INSERT INTO shift_orders (shift_id, provider_order_no, pay_mode, fee_minor, zone, driver_confirmed)
       VALUES ($1,$2,$3::pay_mode,$4,'المزة',true)
       ON CONFLICT (provider_order_no) DO NOTHING`,
      [SHIFT, order.orderNo, order.payMode, order.fee.toString()],
    )
  }

  // Post the whole shift through the SAME recipes the API uses — no hand-written INSERTs, so
  // the seed cannot drift from production behaviour.
  const totals = totalFees(orders.map((o) => o.fee))
  const split = splitBlock(totals, bpsForCount(DEFAULT_BANDS, orders.length))
  const input = {
    driverId: D(1),
    floatTranches: [syp(100_000)],
    topupTranches: [syp(50_000)],
    orders,
  }
  const ledger = new PgLedgerRepo(pool)
  await ledger.post(BRANCH, [...postingsForOpen(input), ...postingsForApproval(input, split)], {
    shiftId: SHIFT,
    businessDate,
    postingDate: businessDate,
    weekStartDate: weekStart,
    fxDayId,
    createdBy: U(3),
  })

  // The seed asserts its own correctness: 160,000 + 70,000 == 100,000 + 50,000 + 80,000.
  const expectedTotal = syp(100_000) + syp(50_000) + totals.blockTotal
  const actualTotal = syp(160_000) + syp(70_000)
  return { br1Difference: minor(actualTotal - expectedTotal) }
}
