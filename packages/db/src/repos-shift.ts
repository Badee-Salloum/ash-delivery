import type {
  AssignmentRecord,
  AssignmentRepo,
  AttachedSlot,
  AttachmentHistoryRecord,
  AttendanceRecord,
  AttendanceRepo,
  CheckInRepo,
  CheckInRecord,
  CheckInWindowRecord,
  BatteryReadingRecord,
  BatteryReadingRepo,
  BatteryRecord,
  BatterySwapRecord,
  BatterySwapRepo,
  BranchRecord,
  EvidencePackage,
  GovernorateRecord,
  VehicleTypeRecord,
  MediaRecord,
  MediaRepo,
  OcrField,
  OcrReadClaim,
  OcrReadClaimInput,
  OcrReadCompletion,
  OcrReadRecord,
  OcrReadRepo,
  CashCountRecord,
  CashCountRepo,
  DirectoryRepo,
  DocumentRecord,
  ExpenseCategoryRecord,
  ExpenseRecord,
  ExpenseRepo,
  IncomeCategoryRecord,
  IncomeRecord,
  IncomeRepo,
  AdvanceEventRecord,
  AdvanceOutstandingRecord,
  AdvanceRecord,
  AdvanceRepo,
  NotificationRecord,
  NotificationRepo,
  PreapprovedShiftRuleRecord,
  PreapprovedShiftRuleRepo,
  SettingsRepo,
  TierRepo,
  TierRuleRecord,
  DriverRecord,
  RoleGrantRecord,
  OperationRemovalRecord,
  OperationRemovalRepo,
  ShiftDecisionRecord,
  ShiftDecisionRepo,
  GpsPingRecord,
  GpsPingRepo,
  ShiftRecord,
  ShiftRepo,
  VehicleEventRecord,
  VehicleEventRepo,
  VehicleRecord,
  WeekLockRecord,
  WeekLockRepo,
} from '@ash/contracts'
import { AWAITING_DECISION_STATES, type CalendarDate, LIVE_STATES, type Minor, minor } from '@ash/domain'
import type { Pool, PoolClient } from './pool.ts'
import { PG, isPgError, withTransaction } from './pool.ts'

/**
 * The remaining PostgreSQL adapters: shifts, week locks, and the directory.
 *
 * The shift record is assembled from three tables, because the schema normalises what the
 * application treats as one aggregate:
 *   shifts          the scalar fields
 *   float_tranches  the several cash/top-up handovers SRS C-5 allows per day
 *   shift_media     the evidence slots, one row per (package, slot)
 *
 * Writes go through a single transaction so a shift is never half-updated — a partially written
 * start package would let the open gate see an inconsistent view of its own preconditions.
 */

function isoDate(value: unknown): CalendarDate {
  if (typeof value === 'string') return value.slice(0, 10)
  const d = value as Date
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const bigintOrNull = (v: unknown): Minor | null => (v === null || v === undefined ? null : minor(BigInt(String(v))))

export class PgShiftRepo implements ShiftRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async create(shift: ShiftRecord, actorId: string | null): Promise<void> {
    await this.persist(shift, true, actorId)
  }

  async update(shift: ShiftRecord, actorId: string | null): Promise<void> {
    await this.persist(shift, false, actorId)
  }

  private async persist(shift: ShiftRecord, insert: boolean, actorId: string | null): Promise<void> {
    await withTransaction(this.pool, { actorId }, async (client) => {
      if (insert) {
        try {
          await client.query(
            `INSERT INTO shifts (id, branch_id, driver_id, vehicle_id, shift_no, business_date,
                                 week_start_date, state)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::shift_state)`,
            [
              shift.id,
              shift.branchId,
              shift.driverId,
              shift.vehicleId,
              shift.shiftNo,
              shift.businessDate,
              shift.weekStartDate,
              shift.state,
            ],
          )
        } catch (err) {
          /*
           * `shifts_no_uq` is UNIQUE (driver_id, business_date, shift_no). `nextShiftNo` is meant
           * to make this unreachable, but two starts racing on the same driver can still collide —
           * and when it happened the raw DatabaseError reached the error handler's last branch and
           * a driver read «internal_error» on the one screen he cannot get past. A typed code lets
           * the route answer 409 with a sentence in Arabic. Same shape `PgAssignmentRepo.create`
           * throws, so the caller handles one case rather than two.
           */
          if (isPgError(err, PG.UNIQUE_VIOLATION)) {
            throw Object.assign(new Error('shift number already taken'), { code: 'DUPLICATE_SHIFT_NO' })
          }
          throw err
        }
      }

      await client.query(
        `UPDATE shifts SET
           state = $2::shift_state,
           start_cash_float_minor   = $3,
           start_wallet_topup_minor = $4,
           end_cash_declared_minor  = $5,
           end_wallet_declared_minor= $6,
           odo_start = $7, odo_end = $8,
           battery_start = $9, battery_end = $10,
           equation_diff_minor = $11, cash_diff_minor = $12, wallet_diff_minor = $13,
           orders_hash = $14,
           driver_confirmed_at = $15::timestamptz,
           -- These two columns are write-once historical identity. PostgreSQL keeps microseconds,
           -- while the JS Date returned by the driver only keeps milliseconds. Rewriting an
           -- already-populated value from a loaded ShiftRecord would therefore round it and trip
           -- shifts_open_approval_immutable even when the caller did not change anything.
           -- Fill either missing half, but preserve the database's exact value once present.
           open_approved_at = COALESCE(open_approved_at, $16::timestamptz),
           open_approved_by = COALESCE(open_approved_by, $17::uuid),
           -- Write-once for the same reason: it is the bound this shift's rows were judged by, and
           -- a settled shift must keep the exact instant it was judged by.
           window_opens_at = COALESCE(window_opens_at, $28::timestamptz),
           submitted_at = $18::timestamptz,
           approved_by = $19,
           -- Write-once, like the open pair above: the instant a close was signed is historical
           -- identity, and re-saving a loaded record must not restamp it.
           approved_at = COALESCE(approved_at, $29::timestamptz),
           odo_start_ocr = $20, odo_end_ocr = $21,
           odo_end_anomaly_confirmed_at = $22::timestamptz,
           odo_end_anomaly_confirmed_by = $23::uuid,
           battery_start_ocr = $24,
           end_wallet_declared_ocr_minor = $25,
           kept_as_receivable_minor = $26,
           driver_share_paid_minor = $27,
           -- «الحسم» is set and cleared freely while the shift is under review, so unlike the
           -- write-once identity columns above it is an ordinary assignment. The CHECK constraint
           -- refuses a non-zero amount without a reason, so the pair always moves together.
           manager_charge_minor = $30,
           manager_charge_reason = $31
         WHERE id = $1`,
        [
          shift.id,
          shift.state,
          sumOf(shift.floatTranches).toString(),
          sumOf(shift.topupTranches).toString(),
          shift.endCashDeclared?.toString() ?? null,
          shift.endWalletDeclared?.toString() ?? null,
          shift.odoStart,
          shift.odoEnd,
          shift.batteryStart,
          shift.batteryEnd,
          shift.equationDiff?.toString() ?? null,
          shift.cashDiff?.toString() ?? null,
          shift.walletDiff?.toString() ?? null,
          shift.ordersHash,
          shift.driverConfirmedAt,
          shift.openApprovedAt,
          shift.openApprovedBy,
          shift.submittedAt,
          shift.approvedBy,
          shift.odoStartOcr,
          shift.odoEndOcr,
          shift.odoEndAnomalyConfirmedAt,
          shift.odoEndAnomalyConfirmedBy,
          shift.batteryStartOcr,
          shift.endWalletDeclaredOcr?.toString() ?? null,
          shift.keptAsReceivable.toString(),
          shift.driverSharePaid.toString(),
          shift.windowOpensAt,
          shift.approvedAt,
          String(shift.managerCharge),
          shift.managerChargeReason,
        ],
      )

      // Tranches are replaced wholesale rather than diffed: the list is short, and a diff is
      // where an off-by-one silently drops a cash handover.
      await client.query('DELETE FROM float_tranches WHERE shift_id = $1', [shift.id])
      const writeTranches = async (
        kind: 'cash_float' | 'wallet_topup' | 'carried_receivable' | 'carried_wallet_receivable',
        amounts: readonly Minor[],
      ) => {
        for (const [i, amount] of amounts.entries()) {
          if (amount <= 0n) continue
          await client.query(
            'INSERT INTO float_tranches (shift_id, kind, seq_no, amount_minor) VALUES ($1,$2,$3,$4)',
            [shift.id, kind, i + 1, amount.toString()],
          )
        }
      }
      await writeTranches('cash_float', shift.floatTranches)
      await writeTranches('wallet_topup', shift.topupTranches)
      await writeTranches('carried_receivable', shift.carriedTranches)
      await writeTranches('carried_wallet_receivable', shift.carriedWalletTranches ?? [])

      // shift_media is deliberately NOT written here. Evidence slots exist only because a photo
      // was uploaded, and PgMediaRepo owns that. Writing a caller-supplied slot list would let
      // the driver's app assert a photo that never arrived — and the BR5 gates read this field.
    })
  }

  async findById(id: string): Promise<ShiftRecord | null> {
    const rows = await this.load('s.id = $1', [id])
    return rows[0] ?? null
  }

  async countOpenActorsForBranch(branchId: string): Promise<{ drivers: number; vehicles: number }> {
    const { rows } = await this.pool.query<{ drivers: number; vehicles: number }>(
      `SELECT COUNT(DISTINCT driver_id)::int AS drivers,
              COUNT(DISTINCT vehicle_id)::int AS vehicles
         FROM shifts
        WHERE branch_id = $1
          AND state = 'open'`,
      [branchId],
    )
    return {
      drivers: Number(rows[0]?.drivers ?? 0),
      vehicles: Number(rows[0]?.vehicles ?? 0),
    }
  }

  async listLiveForDriver(driverId: string): Promise<ShiftRecord[]> {
    return this.load('s.driver_id = $1 AND s.state = ANY($2::shift_state[])', [driverId, LIVE_STATES])
  }

  async listLiveForVehicle(vehicleId: string): Promise<ShiftRecord[]> {
    return this.load('s.vehicle_id = $1 AND s.state = ANY($2::shift_state[])', [vehicleId, LIVE_STATES])
  }

  async listLiveForBranch(branchId: string): Promise<ShiftRecord[]> {
    return this.load('s.branch_id = $1 AND s.state = ANY($2::shift_state[])', [branchId, LIVE_STATES])
  }

  async listAwaitingDecisionForBranch(branchId: string): Promise<ShiftRecord[]> {
    return this.load('s.branch_id = $1 AND s.state = ANY($2::shift_state[])', [branchId, AWAITING_DECISION_STATES])
  }

  async existsForVehicle(vehicleId: string): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT 1 FROM shifts WHERE vehicle_id = $1 LIMIT 1', [vehicleId])
    return rows.length > 0
  }

  async listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<ShiftRecord[]> {
    return this.load('s.branch_id = $1 AND s.business_date = $2', [branchId, businessDate])
  }

  async listByBranchAndDateRange(branchId: string, from: CalendarDate, to: CalendarDate): Promise<ShiftRecord[]> {
    return this.load('s.branch_id = $1 AND s.business_date BETWEEN $2 AND $3', [branchId, from, to])
  }

  /** Only ever called for a shift that never opened; the route enforces that. */
  async delete(id: string, actorId: string | null): Promise<void> {
    await withTransaction(this.pool, { actorId }, async (client) => {
      await client.query('DELETE FROM shifts WHERE id = $1', [id])
    })
  }

  async listApprovedForDriverOnDate(driverId: string, businessDate: CalendarDate): Promise<ShiftRecord[]> {
    return this.load(
      "s.driver_id = $1 AND s.business_date = $2 AND s.state IN ('approved','week_locked')",
      [driverId, businessDate],
    )
  }

  /** Counts EVERY state: a cancelled shift keeps its number, because the unique index does. */
  async nextShiftNo(driverId: string, businessDate: CalendarDate): Promise<number> {
    const { rows } = await this.pool.query<{ next: string }>(
      'SELECT COALESCE(MAX(shift_no), 0) + 1 AS next FROM shifts WHERE driver_id = $1 AND business_date = $2',
      [driverId, businessDate],
    )
    return Number(rows[0]!.next)
  }

  private async load(where: string, params: unknown[]): Promise<ShiftRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT s.*,
         COALESCE((SELECT json_agg(t.amount_minor::text ORDER BY t.seq_no)
                     FROM float_tranches t
                    WHERE t.shift_id = s.id AND t.kind = 'cash_float'), '[]') AS float_tranches,
         COALESCE((SELECT json_agg(t.amount_minor::text ORDER BY t.seq_no)
                     FROM float_tranches t
                    WHERE t.shift_id = s.id AND t.kind = 'wallet_topup'), '[]') AS topup_tranches,
         -- DISJOINT from cash_float on purpose: both are summed into the closing cash, so an
         -- amount in both lists would be returned twice and leave the office over by that much.
         COALESCE((SELECT json_agg(t.amount_minor::text ORDER BY t.seq_no)
                     FROM float_tranches t
                    WHERE t.shift_id = s.id AND t.kind = 'carried_receivable'), '[]') AS carried_tranches,
         COALESCE((SELECT json_agg(t.amount_minor::text ORDER BY t.seq_no)
                     FROM float_tranches t
                    WHERE t.shift_id = s.id AND t.kind = 'carried_wallet_receivable'), '[]') AS carried_wallet_tranches,
         COALESCE((SELECT json_agg(m.slot ORDER BY m.slot)
                     FROM shift_media m
                    WHERE m.shift_id = s.id AND m.package = 'start'), '[]') AS media_start,
         COALESCE((SELECT json_agg(m.slot ORDER BY m.slot)
                     FROM shift_media m
                    WHERE m.shift_id = s.id AND m.package = 'end'), '[]') AS media_end
       FROM shifts s
       WHERE ${where}
       ORDER BY s.shift_no`,
      params,
    )

    return rows.map((r) => ({
      id: String(r.id),
      branchId: String(r.branch_id),
      driverId: String(r.driver_id),
      vehicleId: String(r.vehicle_id),
      shiftNo: Number(r.shift_no),
      businessDate: isoDate(r.business_date),
      weekStartDate: isoDate(r.week_start_date),
      state: r.state as ShiftRecord['state'],
      // Amounts arrive as ::text and become BigInt here — never via Number().
      floatTranches: (r.float_tranches as string[]).map((a) => minor(BigInt(a))),
      topupTranches: (r.topup_tranches as string[]).map((a) => minor(BigInt(a))),
      carriedTranches: (r.carried_tranches as string[]).map((a) => minor(BigInt(a))),
      carriedWalletTranches: (r.carried_wallet_tranches as string[]).map((a) => minor(BigInt(a))),
      keptAsReceivable: minor(BigInt((r.kept_as_receivable_minor as string | null) ?? '0')),
      driverSharePaid: minor(BigInt((r.driver_share_paid_minor as string | null) ?? '0')),
      mediaSlotsStart: r.media_start as string[],
      mediaSlotsEnd: r.media_end as string[],
      odoStart: r.odo_start === null ? null : Number(r.odo_start),
      odoEnd: r.odo_end === null ? null : Number(r.odo_end),
      batteryStart: r.battery_start === null ? null : Number(r.battery_start),
      batteryEnd: r.battery_end === null ? null : Number(r.battery_end),
      endCashDeclared: bigintOrNull(r.end_cash_declared_minor),
      endWalletDeclared: bigintOrNull(r.end_wallet_declared_minor),
      odoStartOcr: r.odo_start_ocr === null || r.odo_start_ocr === undefined ? null : Number(r.odo_start_ocr),
      odoEndOcr: r.odo_end_ocr === null || r.odo_end_ocr === undefined ? null : Number(r.odo_end_ocr),
      odoEndAnomalyConfirmedAt:
        r.odo_end_anomaly_confirmed_at === null
          ? null
          : (r.odo_end_anomaly_confirmed_at as Date).toISOString(),
      odoEndAnomalyConfirmedBy: (r.odo_end_anomaly_confirmed_by as string | null) ?? null,
      batteryStartOcr: r.battery_start_ocr === null ? null : Number(r.battery_start_ocr),
      endWalletDeclaredOcr: bigintOrNull(r.end_wallet_declared_ocr_minor),
      driverConfirmedAt: r.driver_confirmed_at === null ? null : (r.driver_confirmed_at as Date).toISOString(),
      openApprovedAt: r.open_approved_at === null ? null : (r.open_approved_at as Date).toISOString(),
      windowOpensAt: r.window_opens_at == null ? null : (r.window_opens_at as Date).toISOString(),
      openApprovedBy: (r.open_approved_by as string | null) ?? null,
      submittedAt: r.submitted_at === null ? null : (r.submitted_at as Date).toISOString(),
      equationDiff: bigintOrNull(r.equation_diff_minor),
      cashDiff: bigintOrNull(r.cash_diff_minor),
      walletDiff: bigintOrNull(r.wallet_diff_minor),
      ordersHash: (r.orders_hash as string | null) ?? null,
      approvedBy: (r.approved_by as string | null) ?? null,
      approvedAt: r.approved_at == null ? null : (r.approved_at as Date).toISOString(),
      managerCharge: minor(BigInt((r.manager_charge_minor as string | null) ?? '0')),
      managerChargeReason: (r.manager_charge_reason as string | null) ?? null,
    }))
  }
}

const sumOf = (amounts: readonly Minor[]): bigint => amounts.reduce((acc, a) => acc + a, 0n)

export class PgWeekLockRepo implements WeekLockRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async find(branchId: string, weekStartDate: CalendarDate): Promise<WeekLockRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM week_locks WHERE branch_id = $1 AND week_start_date = $2',
      [branchId, weekStartDate],
    )
    return rows[0] ? toLock(rows[0]) : null
  }

  async create(lock: Omit<WeekLockRecord, 'id'>): Promise<WeekLockRecord> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO week_locks (branch_id, week_start_date, week_end_date)
       VALUES ($1,$2,$3)
       ON CONFLICT (branch_id, week_start_date) DO UPDATE SET week_end_date = EXCLUDED.week_end_date
       RETURNING *`,
      [lock.branchId, lock.weekStartDate, lock.weekEndDate],
    )
    return toLock(rows[0]!)
  }

  /**
   * Seal via the SECURITY DEFINER function in migration 0006.
   *
   * `app_user` has no UPDATE on journal_entries — that REVOKE is what makes the ledger
   * append-only — so stamping `week_lock_id` has to go through a function the database owns.
   * It also stamps the entries BEFORE setting `closed_at`, which is the order the week-lock
   * trigger requires.
   */
  async seal(id: number, closedBy: string, closedAtMs: number): Promise<number> {
    return withTransaction(this.pool, { actorId: closedBy }, async (client) => {
      const { rows } = await client.query<{ sealed: number }>('SELECT fin_seal_week($1, $2) AS sealed', [
        id,
        closedBy,
      ])
      void closedAtMs // the function stamps now() itself, so the close time is the database's
      return Number(rows[0]?.sealed ?? 0)
    })
  }

  async listClosedStarts(branchId: string): Promise<CalendarDate[]> {
    const { rows } = await this.pool.query<{ week_start_date: unknown }>(
      'SELECT week_start_date FROM week_locks WHERE branch_id = $1 AND closed_at IS NOT NULL ORDER BY week_start_date',
      [branchId],
    )
    return rows.map((r) => isoDate(r.week_start_date))
  }
}

const toLock = (r: Record<string, unknown>): WeekLockRecord => ({
  id: Number(r.id),
  branchId: String(r.branch_id),
  weekStartDate: isoDate(r.week_start_date),
  weekEndDate: isoDate(r.week_end_date),
  closedAtMs: r.closed_at === null ? null : (r.closed_at as Date).getTime(),
  closedBy: (r.closed_by as string | null) ?? null,
})

export class PgDirectoryRepo implements DirectoryRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async listBranches(): Promise<BranchRecord[]> {
    // Operating branches only. The company (HQ) row (0066) is not a branch anyone picks.
    const { rows } = await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM branches WHERE kind = 'branch' ORDER BY code",
    )
    return rows.map(toBranch)
  }

  async companyBranch(): Promise<BranchRecord | null> {
    // `branches_single_company_uq` guarantees at most one.
    const { rows } = await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM branches WHERE kind = 'company'",
    )
    const r = rows[0]
    return r ? toBranch(r) : null
  }

  async branch(id: string): Promise<BranchRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM branches WHERE id = $1', [id])
    const r = rows[0]
    return r ? toBranch(r) : null
  }

  /** The geofence for «التفقّد». `branches_geo_ck` refuses half a coordinate; pair them here. */
  async setBranchLocation(
    id: string,
    location: { lat: number | null; lng: number | null; checkinRadiusM: number },
  ): Promise<BranchRecord | null> {
    const paired = location.lat === null || location.lng === null ? [null, null] : [location.lat, location.lng]
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'UPDATE branches SET lat = $2, lng = $3, checkin_radius_m = $4 WHERE id = $1 RETURNING *',
      [id, paired[0], paired[1], location.checkinRadiusM],
    )
    const r = rows[0]
    return r ? toBranch(r) : null
  }

  async driver(id: string): Promise<DriverRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM drivers WHERE id = $1', [id])
    const r = rows[0]
    return r ? toDriver(r) : null
  }

  async vehicle(id: string): Promise<VehicleRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM vehicles WHERE id = $1', [id])
    const r = rows[0]
    return r ? toVehicle(r) : null
  }

  /**
   * The permission matrix, read from `role_permissions` (SRS A-2 requires it be editable).
   * An empty table means "not seeded yet", and the caller falls back to DEFAULT_GRANTS rather
   * than denying everything — a half-migrated database should not lock every user out.
   */
  async grants(): Promise<RoleGrantRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT role_key, permission_key, scope FROM role_permissions',
    )
    return rows.map((r) => ({
      roleKey: r.role_key as RoleGrantRecord['roleKey'],
      permissionKey: r.permission_key as RoleGrantRecord['permissionKey'],
      scope: r.scope as RoleGrantRecord['scope'],
    }))
  }

  async setGrant(
    roleKey: RoleGrantRecord['roleKey'],
    permissionKey: RoleGrantRecord['permissionKey'],
    scope: RoleGrantRecord['scope'] | null,
  ): Promise<void> {
    if (scope === null) {
      await this.pool.query('DELETE FROM role_permissions WHERE role_key = $1 AND permission_key = $2', [
        roleKey,
        permissionKey,
      ])
      return
    }
    await this.pool.query(
      `INSERT INTO role_permissions (role_key, permission_key, scope) VALUES ($1,$2,$3)
       ON CONFLICT (role_key, permission_key) DO UPDATE SET scope = EXCLUDED.scope`,
      [roleKey, permissionKey, scope],
    )
  }

  // ── Fleet management (SRS B) ────────────────────────────────────────────────────────────

  async listDrivers(branchId: string): Promise<DriverRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM drivers WHERE branch_id = $1 ORDER BY code',
      [branchId],
    )
    return rows.map(toDriver)
  }

  async createDriver(driver: DriverRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO drivers (id, branch_id, user_id, code, full_name_ar, full_name_en, phone, national_id_enc, hired_on, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          driver.id,
          driver.branchId,
          driver.userId ?? null,
          driver.code,
          driver.fullNameAr,
          driver.fullNameEn ?? null,
          driver.phone ?? null,
          driver.nationalIdEnc ? Buffer.from(driver.nationalIdEnc) : null,
          driver.hiredOn ?? null,
          driver.active,
        ],
      )
    } catch (err) {
      // Same shape the memory adapter throws, so the route handles one case, not two.
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error(`duplicate driver code ${driver.code}`), { code: 'DUPLICATE_CODE' })
      }
      throw err
    }
  }

  async updateDriver(driver: DriverRecord): Promise<void> {
    // The route hands us the fully merged record, so every profile column is written from it.
    await this.pool.query(
      `UPDATE drivers
          SET full_name_ar = $2, full_name_en = $3, phone = $4, national_id_enc = $5, hired_on = $6, active = $7
        WHERE id = $1`,
      [
        driver.id,
        driver.fullNameAr,
        driver.fullNameEn ?? null,
        driver.phone ?? null,
        driver.nationalIdEnc ? Buffer.from(driver.nationalIdEnc) : null,
        driver.hiredOn ?? null,
        driver.active,
      ],
    )
  }

  async listVehicles(branchId: string): Promise<VehicleRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM vehicles WHERE branch_id = $1 ORDER BY code',
      [branchId],
    )
    return rows.map(toVehicle)
  }

  async createVehicle(vehicle: VehicleRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no, plate_no, ground_no, state, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          vehicle.id,
          vehicle.branchId,
          vehicle.vehicleTypeId,
          vehicle.code,
          vehicle.machineNo,
          vehicle.plateNo,
          vehicle.groundNo,
          vehicle.state,
          vehicle.active,
        ],
      )
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error(`duplicate vehicle code ${vehicle.code}`), { code: 'DUPLICATE_CODE' })
      }
      throw err
    }
  }

  /**
   * Delete a vehicle, or refuse because something real points at it.
   *
   * The FK check is the authority, not a pre-count: `shifts`, `expenses` and the vehicle life log
   * all reference this row without a cascade, and a pre-count race could still hit the constraint.
   * Catching 23503 means the refusal is exactly as strict as the database is.
   */
  async deleteVehicle(id: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM vehicles WHERE id = $1', [id])
    } catch (err) {
      if (isPgError(err, PG.FOREIGN_KEY_VIOLATION)) {
        throw Object.assign(new Error(`vehicle ${id} has history`), { code: 'HAS_HISTORY' })
      }
      throw err
    }
  }

  async deleteBattery(id: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM batteries WHERE id = $1', [id])
    } catch (err) {
      if (isPgError(err, PG.FOREIGN_KEY_VIOLATION)) {
        throw Object.assign(new Error(`battery ${id} has history`), { code: 'HAS_HISTORY' })
      }
      throw err
    }
  }

  async updateVehicle(vehicle: VehicleRecord): Promise<void> {
    // `code` is here because it was NOT, and nothing noticed. `restateBranchVehicleCodes` recomputes
    // every bike's number when a branch moves governorate or changes its number and calls this — and
    // the column was never in the statement, so Postgres kept the stale number while the in-memory
    // adapter (a whole-record replace) updated it. The suite therefore passed on a write that did
    // not happen. The conformance suite now asserts it against both adapters.
    await this.pool.query(
      'UPDATE vehicles SET code = $2, state = $3, active = $4, ground_no = $5 WHERE id = $1',
      [vehicle.id, vehicle.code, vehicle.state, vehicle.active, vehicle.groundNo],
    )
  }

  // -- Geography and the vehicle-numbering scheme -----------------------------------------

  async listGovernorates(): Promise<GovernorateRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM governorates ORDER BY no')
    return rows.map(toGovernorate)
  }

  async createGovernorate(g: GovernorateRecord): Promise<void> {
    await this.uniqueOr(
      () =>
        this.pool.query('INSERT INTO governorates (id, no, name_ar, name_en, active) VALUES ($1,$2,$3,$4,$5)', [
          g.id, g.no, g.nameAr, g.nameEn, g.active,
        ]),
      `governorate number ${g.no} is taken`,
    )
  }

  async updateGovernorate(g: GovernorateRecord): Promise<void> {
    await this.uniqueOr(
      () =>
        this.pool.query('UPDATE governorates SET no = $2, name_ar = $3, name_en = $4, active = $5 WHERE id = $1', [
          g.id, g.no, g.nameAr, g.nameEn, g.active,
        ]),
      `governorate number ${g.no} is taken`,
    )
  }

  async createBranch(b: BranchRecord): Promise<void> {
    await this.uniqueOr(
      () =>
        this.pool.query(
          `INSERT INTO branches (id, code, name_ar, name_en, timezone, governorate_id, branch_no, kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [b.id, b.code, b.nameAr, b.nameEn, b.timezone, b.governorateId, b.branchNo, b.kind],
        ),
      `branch ${b.code} or number ${b.branchNo} is taken`,
    )
  }

  async updateBranch(b: BranchRecord): Promise<void> {
    await this.uniqueOr(
      () =>
        this.pool.query(
          `UPDATE branches
              SET name_ar = $2, name_en = $3, timezone = $4, governorate_id = $5, branch_no = $6
            WHERE id = $1`,
          [b.id, b.nameAr, b.nameEn, b.timezone, b.governorateId, b.branchNo],
        ),
      `branch number ${b.branchNo} is taken in that governorate`,
    )
  }

  async listVehicleTypes(): Promise<VehicleTypeRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM vehicle_types ORDER BY type_no')
    return rows.map(toVehicleType)
  }

  async createVehicleType(t: VehicleTypeRecord): Promise<void> {
    await this.uniqueOr(
      () =>
        this.pool.query(
          'INSERT INTO vehicle_types (id, code, name_ar, name_en, type_no, battery_slots, active) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [t.id, t.code, t.nameAr, t.nameEn, t.typeNo, t.batterySlots, t.active],
        ),
      `vehicle type ${t.code} or number ${t.typeNo} is taken`,
    )
  }

  /**
   * Update a type and restate its vehicles' codes IN ONE TRANSACTION.
   *
   * The type number is the third segment of every one of its vehicles' printed numbers. Writing
   * the new number without restating them would leave `vehicles.code` quietly disagreeing with
   * the scheme that produced it -- and `code` is what gets typed into a search box and read
   * aloud over a phone. The formatter is passed in rather than imported so the one true spelling
   * stays in the pure domain and never leaks into SQL string concatenation.
   */
  async updateVehicleType(
    t: VehicleTypeRecord,
    format: (v: { governorateNo: number; branchNo: number; typeNo: number; machineNo: number }) => string,
  ): Promise<void> {
    await withTransaction(this.pool, {}, async (client) => {
      try {
        await client.query(
          'UPDATE vehicle_types SET code = $2, name_ar = $3, name_en = $4, type_no = $5, battery_slots = $6, active = $7 WHERE id = $1',
          [t.id, t.code, t.nameAr, t.nameEn, t.typeNo, t.batterySlots, t.active],
        )
      } catch (err) {
        if (isPgError(err, PG.UNIQUE_VIOLATION)) {
          throw Object.assign(new Error(`vehicle type number ${t.typeNo} is taken`), { code: 'DUPLICATE_CODE' })
        }
        throw err
      }

      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT v.id, v.machine_no, b.branch_no, g.no AS governorate_no
           FROM vehicles v
           JOIN branches b     ON b.id = v.branch_id
           JOIN governorates g ON g.id = b.governorate_id
          WHERE v.vehicle_type_id = $1`,
        [t.id],
      )
      for (const r of rows) {
        await client.query('UPDATE vehicles SET code = $2 WHERE id = $1', [
          String(r.id),
          format({
            governorateNo: Number(r.governorate_no),
            branchNo: Number(r.branch_no),
            typeNo: t.typeNo,
            machineNo: Number(r.machine_no),
          }),
        ])
      }
    })
  }

  // -- Batteries (SRS section L seam) ------------------------------------------------------

  async listBatteries(branchId: string): Promise<BatteryRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM batteries WHERE branch_id = $1 ORDER BY vehicle_id NULLS LAST, slot_no, serial_no',
      [branchId],
    )
    return rows.map(toBattery)
  }

  /** The packs fitted to one bike, in slot order. Its LENGTH is that bike's battery count. */
  async listBatteriesForVehicle(vehicleId: string): Promise<BatteryRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM batteries WHERE vehicle_id = $1 AND active ORDER BY slot_no',
      [vehicleId],
    )
    return rows.map(toBattery)
  }

  async battery(id: string): Promise<BatteryRecord | null> {
    // A swap calls this through the transaction-bound directory repo. Holding the candidate row
    // until commit prevents two shifts from both validating the same ready spare and then moving it
    // to different bikes. Outside a surrounding transaction the lock naturally lasts one statement.
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM batteries WHERE id = $1 FOR UPDATE',
      [id],
    )
    const r = rows[0]
    return r ? toBattery(r) : null
  }

  async createBattery(b: BatteryRecord): Promise<void> {
    await this.batteryUniqueOr(() =>
      this.pool.query(
        `INSERT INTO batteries (id, branch_id, serial_no, bms_mac, capacity_ah, vehicle_id, slot_no, state, active, bms_profile, ground_no)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [b.id, b.branchId, b.serialNo, b.bmsMac, b.capacityAh, b.vehicleId, b.slotNo, b.state, b.active, b.bmsProfile, b.groundNo],
      ),
    )
  }

  async updateBattery(b: BatteryRecord): Promise<void> {
    await this.batteryUniqueOr(() =>
      this.pool.query(
        `UPDATE batteries SET serial_no = $2, bms_mac = $3, capacity_ah = $4,
                                vehicle_id = $5, slot_no = $6, state = $7, active = $8, bms_profile = $9,
                                ground_no = $10
            WHERE id = $1`,
        [b.id, b.serialNo, b.bmsMac, b.capacityAh, b.vehicleId, b.slotNo, b.state, b.active, b.bmsProfile, b.groundNo],
      ),
    )
  }

  /**
   * A UNIQUE violation on a battery is one of two very different things. The partial index on
   * `(vehicle_id, slot_no)` is a SLOT clash — fitting a second pack where one already sits — while
   * the serial UNIQUE is a genuine duplicate pack. Reporting both as "duplicate battery" is what made
   * fitting a second pack read as "duplicate_battery" in the console; keep them apart by constraint.
   */
  private async batteryUniqueOr(run: () => Promise<unknown>): Promise<void> {
    try {
      await run()
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        const constraint = (err as { constraint?: string }).constraint
        const code = constraint === 'batteries_slot_uq' ? 'BATTERY_SLOT_TAKEN' : 'DUPLICATE_CODE'
        throw Object.assign(new Error(constraint ?? 'battery unique violation'), { code })
      }
      throw err
    }
  }

  /** Turns the schema's UNIQUE violations into the one code every route already handles. */
  private async uniqueOr(run: () => Promise<unknown>, message: string): Promise<void> {
    try {
      await run()
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error(message), { code: 'DUPLICATE_CODE' })
      }
      throw err
    }
  }

  async createDocument(doc: DocumentRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO documents (id, branch_id, owner_kind, driver_id, vehicle_id, kind, issued_on, expires_on, media_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [doc.id, doc.branchId, doc.ownerKind, doc.driverId, doc.vehicleId, doc.kind, doc.issuedOn, doc.expiresOn, doc.mediaId],
    )
  }

  async listDocuments(owner: { driverId?: string; vehicleId?: string }): Promise<DocumentRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM documents
        WHERE superseded_by IS NULL
          AND (($1::uuid IS NOT NULL AND driver_id = $1) OR ($2::uuid IS NOT NULL AND vehicle_id = $2))
        ORDER BY kind`,
      [owner.driverId ?? null, owner.vehicleId ?? null],
    )
    return rows.map(toDocument)
  }

  async listExpiringDocuments(branchId: string, through: CalendarDate): Promise<DocumentRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM documents
        WHERE branch_id = $1 AND superseded_by IS NULL
          AND expires_on IS NOT NULL AND expires_on <= $2
        ORDER BY expires_on`,
      [branchId, through],
    )
    return rows.map(toDocument)
  }
}

const toDriver = (r: Record<string, unknown>): DriverRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  code: String(r.code),
  fullNameAr: String(r.full_name_ar),
  active: Boolean(r.active),
  userId: (r.user_id as string | null) ?? null,
  fullNameEn: (r.full_name_en as string | null) ?? null,
  phone: (r.phone as string | null) ?? null,
  hiredOn: r.hired_on == null ? null : isoDate(r.hired_on),
  nationalIdEnc: (r.national_id_enc as Buffer | null) ?? null,
})

const toVehicle = (r: Record<string, unknown>): VehicleRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  vehicleTypeId: String(r.vehicle_type_id),
  code: String(r.code),
  machineNo: Number(r.machine_no),
  plateNo: (r.plate_no as string | null) ?? null,
  groundNo: (r.ground_no as string | null) ?? null,
  state: r.state as VehicleRecord['state'],
  active: Boolean(r.active),
})

const toBranch = (r: Record<string, unknown>): BranchRecord => ({
  id: String(r.id),
  code: String(r.code),
  nameAr: String(r.name_ar),
  nameEn: String(r.name_en),
  timezone: String(r.timezone),
  governorateId: String(r.governorate_id),
  branchNo: Number(r.branch_no),
  lat: r.lat === null || r.lat === undefined ? null : Number(r.lat),
  lng: r.lng === null || r.lng === undefined ? null : Number(r.lng),
  checkinRadiusM: r.checkin_radius_m === undefined ? 150 : Number(r.checkin_radius_m),
  kind: r.kind === 'company' ? 'company' : 'branch',
})

const toGovernorate = (r: Record<string, unknown>): GovernorateRecord => ({
  id: String(r.id),
  no: Number(r.no),
  nameAr: String(r.name_ar),
  nameEn: String(r.name_en),
  active: Boolean(r.active),
})

const toVehicleType = (r: Record<string, unknown>): VehicleTypeRecord => ({
  id: String(r.id),
  code: String(r.code),
  nameAr: String(r.name_ar),
  nameEn: String(r.name_en),
  typeNo: Number(r.type_no),
  batterySlots: Number(r.battery_slots),
  active: Boolean(r.active),
})

const toBattery = (r: Record<string, unknown>): BatteryRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  serialNo: (r.serial_no as string | null) ?? null,
  bmsMac: (r.bms_mac as string | null) ?? null,
  capacityAh: Number(r.capacity_ah),
  vehicleId: (r.vehicle_id as string | null) ?? null,
  slotNo: r.slot_no === null || r.slot_no === undefined ? null : Number(r.slot_no),
  state: r.state as BatteryRecord['state'],
  active: Boolean(r.active),
  bmsProfile: (r.bms_profile as string | null) ?? null,
  groundNo: (r.ground_no as string | null) ?? null,
})

const toDocument = (r: Record<string, unknown>): DocumentRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  ownerKind: r.owner_kind as DocumentRecord['ownerKind'],
  driverId: (r.driver_id as string | null) ?? null,
  vehicleId: (r.vehicle_id as string | null) ?? null,
  kind: String(r.kind),
  issuedOn: r.issued_on === null ? null : isoDate(r.issued_on),
  expiresOn: r.expires_on === null ? null : isoDate(r.expires_on),
  mediaId: (r.media_id as string | null) ?? null,
  supersededBy: (r.superseded_by as string | null) ?? null,
})

// ── Evidence (SRS C-6) ───────────────────────────────────────────────────────────────────

export class PgMediaRepo implements MediaRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  /** Content-addressed: `UNIQUE (branch_id, sha256)` makes a retried upload a no-op. */
  async put(record: MediaRecord): Promise<MediaRecord> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO media (id, branch_id, sha256, byte_size, mime_type, storage_key,
                          client_taken_at, received_at, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,
               CASE WHEN $7::bigint IS NULL THEN NULL ELSE to_timestamp($7::double precision/1000) END,
               to_timestamp($8::double precision/1000), $9)
       ON CONFLICT (branch_id, sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
       RETURNING *`,
      [
        record.id,
        record.branchId,
        record.sha256,
        record.byteSize,
        record.mimeType,
        record.storageKey,
        record.clientTakenAtMs,
        record.receivedAtMs,
        record.uploadedBy,
      ],
    )
    return toMedia(rows[0]!)
  }

  async findBySha(branchId: string, sha256: string): Promise<MediaRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM media WHERE branch_id = $1 AND sha256 = $2',
      [branchId, sha256],
    )
    return rows[0] ? toMedia(rows[0]) : null
  }

  async findById(id: string): Promise<MediaRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM media WHERE id = $1', [id])
    return rows[0] ? toMedia(rows[0]) : null
  }

  /** One photo per slot: a re-shoot REPLACES, so the manager never sees two odometer photos. */
  async attach(
    shiftId: string,
    pkg: EvidencePackage,
    slot: string,
    mediaId: string,
    metadata: {
      actorId: string | null
      attachedAtMs?: number
      reusedFromShiftId?: string | null
      expectedAttachmentToken?: string | null
    },
  ): Promise<void> {
    await withTransaction(this.pool, { actorId: metadata.actorId }, async (client) => {
      await assertMediaPackageEditable(client, shiftId, pkg)
      // One immutable-media lock serializes attachments of identical bytes, even when they target
      // different shifts/slots. The second transaction then sees the first one's history row.
      const lockedMedia = await client.query(
        `SELECT m.id
           FROM media m
           JOIN shifts s ON s.id = $1 AND s.branch_id = m.branch_id
          WHERE m.id = $2
          FOR UPDATE OF m`,
        [shiftId, mediaId],
      )
      if (lockedMedia.rowCount !== 1) {
        throw Object.assign(new Error(`media ${mediaId} does not belong to shift ${shiftId}'s branch`), {
          code: 'MEDIA_BRANCH_MISMATCH',
        })
      }
      const duplicate = await client.query<{ package: string; slot: string }>(
        `SELECT package, slot
           FROM shift_media
          WHERE shift_id = $1 AND media_id = $2
            AND (package, slot) <> ($3::text, $4::text)
          ORDER BY package, slot
          LIMIT 1
          FOR UPDATE`,
        [shiftId, mediaId, pkg, slot],
      )
      if (duplicate.rows[0]) {
        throw Object.assign(new Error('the same evidence is already active in another slot'), {
          code: 'MEDIA_ALREADY_ATTACHED',
          sourcePackage: duplicate.rows[0].package,
          sourceSlot: duplicate.rows[0].slot,
        })
      }
      const current = await client.query<{ media_id: string; attachment_token: string }>(
        `SELECT media_id, attachment_token
           FROM shift_media
          WHERE shift_id = $1 AND package = $2 AND slot = $3
          FOR UPDATE`,
        [shiftId, pkg, slot],
      )
      if (
        metadata.expectedAttachmentToken !== undefined &&
        (current.rows[0]?.attachment_token ?? null) !== metadata.expectedAttachmentToken
      ) {
        throw Object.assign(new Error('evidence attachment changed before replacement'), {
          code: 'MEDIA_ATTACHMENT_CHANGED',
        })
      }
      // The content is already the current generation. A network retry is a true no-op: it must
      // neither rotate the token nor reinterpret the current history row as self-reuse.
      if (current.rows[0]?.media_id === mediaId) {
        return
      }
      const { rows: priorRows } = await client.query<{ shift_id: string }>(
        `SELECT shift_id
           FROM shift_media_attachment_history
          WHERE media_id = $1
          ORDER BY id DESC
          LIMIT 1`,
        [mediaId],
      )
      const priorShiftId = priorRows[0]?.shift_id ?? null
      if (
        metadata.reusedFromShiftId !== undefined &&
        metadata.reusedFromShiftId !== priorShiftId
      ) {
        throw Object.assign(new Error(`media ${mediaId} reuse provenance does not match attachment history`), {
          code: 'MEDIA_REUSE_PROVENANCE_MISMATCH',
        })
      }
      await client.query(
        `WITH candidate AS (
           SELECT $1::uuid AS shift_id, $2::uuid AS media_id, $3::text AS package,
                  $4::text AS slot,
                  CASE
                    WHEN $5::double precision IS NULL THEN now()
                    ELSE to_timestamp($5::double precision / 1000)
                  END AS created_at,
                  $6::uuid AS reused_from_shift_id,
                  gen_random_uuid() AS attachment_token
         )
         INSERT INTO shift_media
           (shift_id, media_id, package, slot, created_at, reused_from_shift_id, attachment_token)
         SELECT shift_id, media_id, package, slot, created_at, reused_from_shift_id, attachment_token
           FROM candidate
         ON CONFLICT (shift_id, package, slot) DO UPDATE
           SET media_id                 = EXCLUDED.media_id,
               created_at               = EXCLUDED.created_at,
               reused_from_shift_id     = EXCLUDED.reused_from_shift_id,
               attachment_token         = EXCLUDED.attachment_token,
               stale_acknowledged_at    = NULL,
               stale_acknowledged_by    = NULL
         -- An exact network retry is not another attachment and must not create self-reuse.
         WHERE shift_media.media_id <> EXCLUDED.media_id`,
        [shiftId, mediaId, pkg, slot, metadata.attachedAtMs ?? null, priorShiftId],
      )
    })
  }

  async acknowledgeStale(
    shiftId: string,
    pkg: EvidencePackage,
    slot: string,
    expectedMediaId: string,
    expectedAttachmentToken: string,
    acknowledgedBy: string,
    acknowledgedAtMs: number,
  ): Promise<void> {
    await withTransaction(this.pool, { actorId: acknowledgedBy }, async (client) => {
      await assertMediaPackageEditable(client, shiftId, pkg)
      const acknowledged = await client.query(
        `UPDATE shift_media
            SET stale_acknowledged_at = to_timestamp($6::double precision / 1000),
                stale_acknowledged_by = $7
          WHERE shift_id = $1 AND package = $2 AND slot = $3
            AND media_id = $4 AND attachment_token = $5`,
        [shiftId, pkg, slot, expectedMediaId, expectedAttachmentToken, acknowledgedAtMs, acknowledgedBy],
      )
      if (acknowledged.rowCount !== 1) {
        throw Object.assign(new Error(`evidence attachment ${shiftId}/${pkg}/${slot} changed before acknowledgment`), {
          code: 'MEDIA_ATTACHMENT_CHANGED',
        })
      }
    })
  }

  /** Unhooks the slot only. The content-addressed `media` row survives — see the port's note. */
  async detach(
    shiftId: string,
    pkg: EvidencePackage,
    slot: string,
    actorId: string | null,
    expectedAttachmentToken?: string,
  ): Promise<void> {
    await withTransaction(this.pool, { actorId }, async (client) => {
      await assertMediaPackageEditable(client, shiftId, pkg)
      const deleted = await client.query(
        `DELETE FROM shift_media
          WHERE shift_id = $1 AND package = $2 AND slot = $3
            AND ($4::uuid IS NULL OR attachment_token = $4)`,
        [shiftId, pkg, slot, expectedAttachmentToken ?? null],
      )
      if (expectedAttachmentToken !== undefined && deleted.rowCount !== 1) {
        throw Object.assign(new Error('evidence attachment changed before delete'), { code: 'MEDIA_ATTACHMENT_CHANGED' })
      }
    })
  }

  async listSlots(shiftId: string): Promise<AttachedSlot[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT package, slot, media_id, attachment_token, created_at, reused_from_shift_id,
              stale_acknowledged_at, stale_acknowledged_by
         FROM shift_media WHERE shift_id = $1 ORDER BY package, slot`,
      [shiftId],
    )
    return rows.map((r) => ({
      package: r.package as EvidencePackage,
      slot: String(r.slot),
      mediaId: String(r.media_id),
      attachmentToken: String(r.attachment_token),
      attachedAtMs: (r.created_at as Date).getTime(),
      reusedFromShiftId: (r.reused_from_shift_id as string | null) ?? null,
      staleAcknowledgedAtMs:
        r.stale_acknowledged_at === null ? null : (r.stale_acknowledged_at as Date).getTime(),
      staleAcknowledgedBy: (r.stale_acknowledged_by as string | null) ?? null,
    }))
  }

  async listAttachmentHistory(shiftId: string): Promise<AttachmentHistoryRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT id, shift_id, package, slot, media_id, attachment_token, attached_at, reused_from_shift_id
         FROM shift_media_attachment_history
        WHERE shift_id = $1
        ORDER BY id DESC`,
      [shiftId],
    )
    return rows.map((row) => ({
      id: String(row.id),
      shiftId: String(row.shift_id),
      package: row.package as EvidencePackage,
      slot: String(row.slot),
      mediaId: String(row.media_id),
      attachmentToken: String(row.attachment_token),
      attachedAtMs: (row.attached_at as Date).getTime(),
      reusedFromShiftId: (row.reused_from_shift_id as string | null) ?? null,
    }))
  }

  async latestAttachmentForMedia(
    mediaId: string,
    options?: { lock?: boolean },
  ): Promise<AttachmentHistoryRecord | null> {
    if (options?.lock) {
      /*
       * Lock the CONTENT row, and never the history table.
       *
       * `shift_media_attachment_history` is append-only on purpose: `0028` REVOKEs UPDATE from
       * `app_user`, and the runtime logs in as `ash_runtime`, which inherits it. Postgres requires
       * UPDATE for `SELECT ... FOR UPDATE`, so locking THAT table here is `42501 permission denied`
       * — an unhandled 500 the driver reads as a bare «فشل الرفع». Because this call sits between
       * the media write and the attach, it took every evidence upload in the fleet down for three
       * days without leaving a single diagnosable trace.
       *
       * Nothing is lost: the media row IS the serializer. A competing shift must lock the same
       * content row before it can append a generation, so locking the log of what already
       * happened only ever duplicated that guarantee.
       *
       * `end` reaches this inside the close unit of work. `start` does NOT run in a transaction at
       * all — `uploadEvidence` passes `runCommit` only when a draft revision is present — so there
       * the lock is released as the statement returns. Start slots are single-writer, so that is
       * tolerable, but it is not the serialization this comment used to claim.
       */
      await this.pool.query('SELECT id FROM media WHERE id = $1 FOR UPDATE', [mediaId])
    }
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT id, shift_id, package, slot, media_id, attachment_token, attached_at, reused_from_shift_id
         FROM shift_media_attachment_history
        WHERE media_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [mediaId],
    )
    const row = rows[0]
    return row ? {
      id: String(row.id),
      shiftId: String(row.shift_id),
      package: row.package as EvidencePackage,
      slot: String(row.slot),
      mediaId: String(row.media_id),
      attachmentToken: String(row.attachment_token),
      attachedAtMs: (row.attached_at as Date).getTime(),
      reusedFromShiftId: (row.reused_from_shift_id as string | null) ?? null,
    } : null
  }

  async restoreAttachment(input: {
    shiftId: string
    historyId: string
    expectedCurrentAttachmentToken: string | null
    actorId: string
    reason: string
    attachedAtMs: number
  }): Promise<AttachedSlot> {
    return withTransaction(this.pool, { actorId: input.actorId }, async (client) => {
      const { rows: historyRows } = await client.query<Record<string, unknown>>(
        `SELECT id, shift_id, package, slot, media_id
           FROM shift_media_attachment_history
          WHERE id = $1 AND shift_id = $2`,
        [input.historyId, input.shiftId],
      )
      const history = historyRows[0]
      if (!history) throw Object.assign(new Error('attachment history not found'), { code: 'MEDIA_HISTORY_NOT_FOUND' })
      const pkg = history.package as EvidencePackage
      const slot = String(history.slot)
      await assertMediaPackageEditable(client, input.shiftId, pkg)
      const lockedMedia = await client.query(
        `SELECT m.id
           FROM media m
           JOIN shifts s ON s.id = $1 AND s.branch_id = m.branch_id
          WHERE m.id = $2
          FOR UPDATE OF m`,
        [input.shiftId, history.media_id],
      )
      if (lockedMedia.rowCount !== 1) {
        throw Object.assign(new Error('historical media does not belong to this shift branch'), {
          code: 'MEDIA_BRANCH_MISMATCH',
        })
      }
      const duplicate = await client.query<{ package: string; slot: string }>(
        `SELECT package, slot
           FROM shift_media
          WHERE shift_id = $1 AND media_id = $2
            AND (package, slot) <> ($3::text, $4::text)
          ORDER BY package, slot
          LIMIT 1
          FOR UPDATE`,
        [input.shiftId, history.media_id, pkg, slot],
      )
      if (duplicate.rows[0]) {
        throw Object.assign(new Error('the same evidence is already active in another slot'), {
          code: 'MEDIA_ALREADY_ATTACHED',
          sourcePackage: duplicate.rows[0].package,
          sourceSlot: duplicate.rows[0].slot,
        })
      }
      const { rows: currentRows } = await client.query<Record<string, unknown>>(
        `SELECT media_id, attachment_token
           FROM shift_media
          WHERE shift_id = $1 AND package = $2 AND slot = $3
          FOR UPDATE`,
        [input.shiftId, pkg, slot],
      )
      const current = currentRows[0]
      if (((current?.attachment_token as string | undefined) ?? null) !== input.expectedCurrentAttachmentToken) {
        throw Object.assign(new Error('attachment changed before restore'), { code: 'MEDIA_ATTACHMENT_CHANGED' })
      }
      if (current && String(current.media_id) === String(history.media_id)) {
        throw Object.assign(new Error('attachment history generation is already current'), { code: 'MEDIA_HISTORY_CURRENT' })
      }
      await client.query(
        `INSERT INTO shift_media
           (shift_id, media_id, package, slot, created_at, attachment_token,
            stale_acknowledged_at, stale_acknowledged_by)
         VALUES ($1,$2,$3,$4,to_timestamp($5::double precision / 1000),gen_random_uuid(),NULL,NULL)
         ON CONFLICT (shift_id, package, slot) DO UPDATE
           SET media_id = EXCLUDED.media_id,
               created_at = EXCLUDED.created_at,
               attachment_token = EXCLUDED.attachment_token,
               stale_acknowledged_at = NULL,
               stale_acknowledged_by = NULL`,
        [input.shiftId, history.media_id, pkg, slot, input.attachedAtMs],
      )
      // A reasoned restore is itself the explicit reuse/staleness acknowledgement. Keep the
      // generation auditable and immediately usable instead of forcing a second acknowledgement.
      await client.query(
        `UPDATE shift_media
            SET stale_acknowledged_at = to_timestamp($4::double precision / 1000),
                stale_acknowledged_by = $5
          WHERE shift_id = $1 AND package = $2 AND slot = $3`,
        [input.shiftId, pkg, slot, input.attachedAtMs, input.actorId],
      )
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT package, slot, media_id, attachment_token, created_at, reused_from_shift_id,
                stale_acknowledged_at, stale_acknowledged_by
           FROM shift_media
          WHERE shift_id = $1 AND package = $2 AND slot = $3`,
        [input.shiftId, pkg, slot],
      )
      const row = rows[0]!
      await client.query(
        `INSERT INTO shift_media_restore_decisions
           (shift_id, attachment_history_id, package, slot, media_id,
            from_attachment_token, to_attachment_token, reason, restored_by, restored_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10::double precision / 1000))`,
        [
          input.shiftId,
          input.historyId,
          pkg,
          slot,
          history.media_id,
          (current?.attachment_token as string | undefined) ?? null,
          row.attachment_token,
          input.reason,
          input.actorId,
          input.attachedAtMs,
        ],
      )
      return {
        package: row.package as EvidencePackage,
        slot: String(row.slot),
        mediaId: String(row.media_id),
        attachmentToken: String(row.attachment_token),
        attachedAtMs: (row.created_at as Date).getTime(),
        reusedFromShiftId: (row.reused_from_shift_id as string | null) ?? null,
        staleAcknowledgedAtMs: row.stale_acknowledged_at === null ? null : (row.stale_acknowledged_at as Date).getTime(),
        staleAcknowledgedBy: (row.stale_acknowledged_by as string | null) ?? null,
      }
    })
  }
}

/**
 * Lock the shift before changing evidence so a concurrent state transition cannot close the package
 * between the authorization check and the attachment mutation.
 */
const assertMediaPackageEditable = async (
  client: PoolClient,
  shiftId: string,
  pkg: EvidencePackage,
): Promise<void> => {
  const { rows } = await client.query<{ state: string }>('SELECT state FROM shifts WHERE id = $1 FOR UPDATE', [shiftId])
  const state = rows[0]?.state
  const editable = pkg === 'start' ? state === 'draft' : state === 'open' || state === 'suspended'
  if (!editable) {
    throw Object.assign(new Error(`${pkg} evidence is not editable while shift ${shiftId} is ${state ?? 'missing'}`), {
      code: 'MEDIA_PACKAGE_NOT_EDITABLE',
    })
  }
}

const toMedia = (r: Record<string, unknown>): MediaRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  sha256: String(r.sha256),
  byteSize: Number(r.byte_size),
  mimeType: String(r.mime_type),
  storageKey: String(r.storage_key),
  clientTakenAtMs: r.client_taken_at === null ? null : (r.client_taken_at as Date).getTime(),
  receivedAtMs: (r.received_at as Date).getTime(),
  uploadedBy: String(r.uploaded_by ?? ''),
})

// ── The cloud reader's receipts (0027) ───────────────────────────────────────────────────

/**
 * The dedupe cache, the per-shift cap counter and the cost meter, in one table.
 *
 * Every paid logical read is claimed before the adapter starts. The content advisory lock
 * serializes identical screenshots; the requesting-shift lock serializes its spend cap. One
 * logical read can contain multiple internal model passes, whose telemetry is stored in aggregate.
 */
export class PgOcrReadRepo implements OcrReadRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async findBySha(
    branchId: string,
    sha256: string,
    field: OcrField,
    cacheSignature: string,
  ): Promise<OcrReadRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ocr_reads
        WHERE branch_id = $1 AND sha256 = $2 AND field = $3 AND cache_signature = $4`,
      [branchId, sha256, field, cacheSignature],
    )
    return rows[0] ? toOcrRead(rows[0]) : null
  }

  async claimReadAttempt(input: OcrReadClaimInput): Promise<OcrReadClaim> {
    return withTransaction(this.pool, { actorId: input.createdBy, requestId: input.reservationId }, async (client) => {
      const identity = `${input.branchId}:${input.field}:${input.sha256}:${input.cacheSignature}`
      // Every caller locks content identity first and the requesting shift's budget second.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [identity])

      let existing = await this.findLocked(client, input)
      if (existing?.state === 'running') {
        // Leases are database infrastructure state. Comparing with the database wall clock avoids
        // expiring a paid call because another function replica has clock skew, or because this
        // transaction waited for a pool connection/advisory lock before reaching the row.
        const { rows: clockRows } = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        const databaseNowMs = clockRows[0]!.now.getTime()
        const expiresAt = (existing.reservedAt ?? 0) + input.leaseMs
        if (databaseNowMs < expiresAt) {
          return {
            kind: 'running',
            record: existing,
            used: await this.billedForShift(client, input.requestingShiftId),
            leaseRemainingMs: expiresAt - databaseNowMs,
          }
        }

        const { rows } = await client.query<Record<string, unknown>>(
          `UPDATE ocr_reads
              SET read_state = 'complete',
                  result = jsonb_build_object(
                    'ok', false,
                    'reason', 'timeout',
                    'attemptCount', COALESCE(reserved_attempt, 1)
                  ),
                  reservation_id = NULL,
                  reserved_at = NULL,
                  reserved_attempt = NULL
            WHERE id = $1
          RETURNING *`,
          [existing.id],
        )
        existing = toOcrRead(rows[0]!)
      }

      let attempt: 1 | 2
      if (existing) {
        const attempts = existing.result.attemptCount ?? 1
        const retryable = !existing.result.ok || existing.result.retryable === true
        if (!retryable || !input.retryFailed || attempts >= 2) {
          return {
            kind: 'cached',
            record: existing,
            used: await this.billedForShift(client, input.requestingShiftId),
          }
        }
        attempt = 2
      } else {
        attempt = 1
      }

      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [input.requestingShiftId])
      const used = await this.billedForShift(client, input.requestingShiftId)
      if (input.maxReadsPerShift > 0 && used >= input.maxReadsPerShift) {
        return { kind: 'capped', record: existing ?? null, used }
      }

      let claimed: OcrReadRecord
      if (attempt === 1) {
        const { rows } = await client.query<Record<string, unknown>>(
          `INSERT INTO ocr_reads (
             id, branch_id, shift_id, field, sha256, byte_size, model, cache_signature,
             read_state, result, reservation_id, reserved_at, reserved_attempt, retry_shift_id,
             tokens_in, tokens_out, latency_ms, created_at, created_by
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,
             'running',$9::jsonb,$10,clock_timestamp(),1,NULL,
             0,0,0,to_timestamp($11::double precision/1000),$12
           )
           RETURNING *`,
          [
            input.id,
            input.branchId,
            input.requestingShiftId,
            input.field,
            input.sha256,
            input.byteSize,
            input.model,
            input.cacheSignature,
            JSON.stringify({ ok: false, reason: 'timeout', attemptCount: 1 }),
            input.reservationId,
            input.createdAt,
            input.createdBy,
          ],
        )
        claimed = toOcrRead(rows[0]!)
      } else {
        const { rows } = await client.query<Record<string, unknown>>(
          `UPDATE ocr_reads
              SET read_state = 'running',
                  result = jsonb_set(result, '{attemptCount}', '2'::jsonb, true),
                  reservation_id = $2,
                  reserved_at = clock_timestamp(),
                  reserved_attempt = 2,
                  retry_shift_id = $3,
                  retry_created_at = clock_timestamp(),
                  retry_created_by = $4
            WHERE id = $1
          RETURNING *`,
          [existing!.id, input.reservationId, input.requestingShiftId, input.createdBy],
        )
        claimed = toOcrRead(rows[0]!)
      }

      return { kind: 'call', record: claimed, attempt, used: used + 1 }
    })
  }

  async completeReadAttempt(input: OcrReadCompletion): Promise<OcrReadRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `UPDATE ocr_reads
          SET read_state = 'complete',
              result = ($6::jsonb - 'attemptCount')
                       || jsonb_build_object('attemptCount', reserved_attempt),
              reservation_id = NULL,
              reserved_at = NULL,
              reserved_attempt = NULL,
              tokens_in = tokens_in + $7,
              tokens_out = tokens_out + $8,
              latency_ms = latency_ms + $9
        WHERE branch_id = $1
          AND sha256 = $2
          AND field = $3
          AND cache_signature = $4
          AND read_state = 'running'
          AND reservation_id = $5
      RETURNING *`,
      [
        input.branchId,
        input.sha256,
        input.field,
        input.cacheSignature,
        input.reservationId,
        JSON.stringify(input.result),
        input.usage.tokensIn,
        input.usage.tokensOut,
        input.usage.latencyMs,
      ],
    )
    return rows[0] ? toOcrRead(rows[0]) : null
  }

  async countBilledForShift(shiftId: string): Promise<number> {
    return this.billedForShift(this.pool, shiftId)
  }

  private async findLocked(client: PoolClient, input: OcrReadClaimInput): Promise<OcrReadRecord | null> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT * FROM ocr_reads
        WHERE branch_id = $1 AND sha256 = $2 AND field = $3 AND cache_signature = $4
        FOR UPDATE`,
      [input.branchId, input.sha256, input.field, input.cacheSignature],
    )
    return rows[0] ? toOcrRead(rows[0]) : null
  }

  private async billedForShift(db: Pool | PoolClient, shiftId: string): Promise<number> {
    const { rows } = await db.query<{ n: string }>(
      `SELECT COALESCE(SUM(
          CASE WHEN shift_id = $1 THEN 1 ELSE 0 END
          + CASE WHEN retry_shift_id = $1 THEN 1 ELSE 0 END
        ), 0)::text AS n
         FROM ocr_reads
        WHERE shift_id = $1 OR retry_shift_id = $1`,
      [shiftId],
    )
    return Number(rows[0]?.n ?? '0')
  }
}

const toOcrRead = (r: Record<string, unknown>): OcrReadRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  shiftId: (r.shift_id as string | null) ?? null,
  field: r.field as OcrField,
  sha256: String(r.sha256),
  byteSize: Number(r.byte_size),
  model: String(r.model),
  cacheSignature: String(r.cache_signature),
  state: r.read_state as OcrReadRecord['state'],
  // `jsonb` comes back already parsed by node-postgres; it is the reader's own answer, stored whole.
  result: r.result as OcrReadRecord['result'],
  reservationId: (r.reservation_id as string | null) ?? null,
  reservedAt: r.reserved_at === null ? null : (r.reserved_at as Date).getTime(),
  reservedAttempt: r.reserved_attempt === null ? null : (Number(r.reserved_attempt) as 1 | 2),
  retryShiftId: (r.retry_shift_id as string | null) ?? null,
  retryCreatedAt: r.retry_created_at === null ? null : (r.retry_created_at as Date).getTime(),
  retryCreatedBy: (r.retry_created_by as string | null) ?? null,
  tokensIn: Number(r.tokens_in),
  tokensOut: Number(r.tokens_out),
  latencyMs: Number(r.latency_ms),
  createdAt: (r.created_at as Date).getTime(),
  createdBy: String(r.created_by),
})

// ── Expenses and settings (SRS G, A-4) ───────────────────────────────────────────────────

export class PgExpenseRepo implements ExpenseRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async listCategories(): Promise<ExpenseCategoryRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT id, code, name_ar, active FROM expense_categories WHERE active ORDER BY code',
    )
    return rows.map((r) => ({
      id: String(r.id),
      code: String(r.code),
      nameAr: String(r.name_ar),
      active: Boolean(r.active),
    }))
  }

  async createCategory(category: ExpenseCategoryRecord): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO expense_categories (id, code, name_ar, active) VALUES ($1,$2,$3,$4)',
        [category.id, category.code, category.nameAr, category.active],
      )
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error(`duplicate category ${category.code}`), { code: 'DUPLICATE_CODE' })
      }
      throw err
    }
  }

  async get(id: string): Promise<ExpenseRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT *, amount_minor::text AS amount
         FROM expenses
        WHERE id = $1`,
      [id],
    )
    const row = rows[0]
    return row ? expenseRecord(row) : null
  }

  async create(expense: ExpenseRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO expenses (id, branch_id, category_id, cost_center_kind, vehicle_id, amount_minor,
                             business_date, description, receipt_media_id, journal_entry_id,
                             advance_id, channel, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        expense.id,
        expense.branchId,
        expense.categoryId,
        expense.costCenterKind,
        expense.vehicleId,
        expense.amount.toString(),
        expense.businessDate,
        expense.description,
        expense.receiptMediaId,
        expense.journalEntryId,
        expense.advanceId,
        expense.channel,
        expense.createdBy,
      ],
    )
  }

  async listByBranchAndDate(branchId: string, from: CalendarDate, to: CalendarDate): Promise<ExpenseRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT *, amount_minor::text AS amount FROM expenses
        WHERE branch_id = $1 AND business_date BETWEEN $2 AND $3
        ORDER BY business_date, id`,
      [branchId, from, to],
    )
    return rows.map(expenseRecord)
  }

  /** Aggregated in the database: G-1's per-axis profitability over a year of rows is not a JS loop. */
  async totalsByCostCenter(
    branchId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<Array<{ costCenterKind: string; vehicleId: string | null; total: Minor }>> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT cost_center_kind, vehicle_id, SUM(amount_minor)::text AS total
         FROM expenses
        WHERE branch_id = $1 AND business_date BETWEEN $2 AND $3
        GROUP BY cost_center_kind, vehicle_id
        ORDER BY cost_center_kind`,
      [branchId, from, to],
    )
    return rows.map((r) => ({
      costCenterKind: String(r.cost_center_kind),
      vehicleId: (r.vehicle_id as string | null) ?? null,
      total: minor(BigInt(String(r.total))),
    }))
  }
}

const expenseRecord = (row: Record<string, unknown>): ExpenseRecord => ({
  id: String(row.id),
  branchId: String(row.branch_id),
  categoryId: String(row.category_id),
  costCenterKind: row.cost_center_kind as ExpenseRecord['costCenterKind'],
  vehicleId: (row.vehicle_id as string | null) ?? null,
  channel: (row.channel as ExpenseRecord['channel'] | undefined) ?? 'office_cash',
  amount: minor(BigInt(String(row.amount))),
  businessDate: isoDate(row.business_date),
  description: String(row.description),
  receiptMediaId: (row.receipt_media_id as string | null) ?? null,
  journalEntryId: row.journal_entry_id === null ? null : Number(row.journal_entry_id),
  advanceId: (row.advance_id as string | null) ?? null,
  createdBy: String(row.created_by),
})

/**
 * «المدخول المباشر» — direct income. Deliberately a near-copy of `PgExpenseRepo`: the two are the
 * same shape of fact in opposite directions, and a reader who knows one should recognise the other.
 */
export class PgIncomeRepo implements IncomeRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async listCategories(): Promise<IncomeCategoryRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT id, code, name_ar, active FROM income_categories WHERE active ORDER BY code',
    )
    return rows.map((r) => ({
      id: String(r.id),
      code: String(r.code),
      nameAr: String(r.name_ar),
      active: Boolean(r.active),
    }))
  }

  async createCategory(category: IncomeCategoryRecord): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO income_categories (id, code, name_ar, active) VALUES ($1,$2,$3,$4)',
        [category.id, category.code, category.nameAr, category.active],
      )
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error(`duplicate category ${category.code}`), { code: 'DUPLICATE_CODE' })
      }
      throw err
    }
  }

  async get(id: string): Promise<IncomeRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT *, amount_minor::text AS amount FROM incomes WHERE id = $1',
      [id],
    )
    const row = rows[0]
    return row ? incomeRecord(row) : null
  }

  async create(income: IncomeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO incomes (id, branch_id, category_id, channel, amount_minor,
                            business_date, description, evidence_media_id, journal_entry_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        income.id,
        income.branchId,
        income.categoryId,
        income.channel,
        income.amount.toString(),
        income.businessDate,
        income.description,
        income.evidenceMediaId,
        income.journalEntryId,
        income.createdBy,
      ],
    )
  }

  async listByBranchAndDate(branchId: string, from: CalendarDate, to: CalendarDate): Promise<IncomeRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT *, amount_minor::text AS amount FROM incomes
        WHERE branch_id = $1 AND business_date BETWEEN $2 AND $3
        ORDER BY business_date, id`,
      [branchId, from, to],
    )
    return rows.map(incomeRecord)
  }
}

const incomeRecord = (row: Record<string, unknown>): IncomeRecord => ({
  id: String(row.id),
  branchId: String(row.branch_id),
  categoryId: String(row.category_id),
  channel: row.channel as IncomeRecord['channel'],
  amount: minor(BigInt(String(row.amount))),
  businessDate: isoDate(row.business_date),
  description: String(row.description),
  evidenceMediaId: (row.evidence_media_id as string | null) ?? null,
  // NOT NULL in the schema, unlike an expense's — an income without its journal cannot exist.
  journalEntryId: Number(row.journal_entry_id),
  createdBy: String(row.created_by),
})

/**
 * «السلفة» — an expense that must come back (owner decision 17).
 *
 * `listOutstanding` reads what is still owed from the advance's OWN LEDGER FUND, never by
 * subtracting the event rows. The fund IS the record — the same rule `listReceivables` states in
 * its own header — and a second arithmetic would be one more thing to keep in step with it.
 */
export class PgAdvanceRepo implements AdvanceRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async get(id: string): Promise<AdvanceRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT *, amount_minor::text AS amount FROM advances WHERE id = $1',
      [id],
    )
    const row = rows[0]
    return row ? advanceRecord(row) : null
  }

  async create(advance: AdvanceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO advances (id, branch_id, party_name, party_key, category_id, cost_center_kind,
                             vehicle_id, channel, amount_minor, business_date, description,
                             receipt_media_id, journal_entry_id, source_driver_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        advance.id,
        advance.branchId,
        advance.partyName,
        advance.partyKey,
        advance.categoryId,
        advance.costCenterKind,
        advance.vehicleId,
        advance.channel,
        advance.amount.toString(),
        advance.businessDate,
        advance.description,
        advance.receiptMediaId,
        advance.journalEntryId,
        advance.sourceDriverId,
        advance.createdBy,
      ],
    )
  }

  async listByBranchAndDate(branchId: string, from: CalendarDate, to: CalendarDate): Promise<AdvanceRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT *, amount_minor::text AS amount FROM advances
        WHERE branch_id = $1 AND business_date BETWEEN $2 AND $3
        ORDER BY business_date, id`,
      [branchId, from, to],
    )
    return rows.map(advanceRecord)
  }

  async listOutstanding(branchId: string): Promise<AdvanceOutstandingRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT a.*, a.amount_minor::text AS amount,
              COALESCE(bal.balance, 0)::text AS outstanding,
              COALESCE(ev.repaid, 0)::text   AS repaid,
              COALESCE(ev.converted, 0)::text AS converted
         FROM advances a
         LEFT JOIN LATERAL (
           SELECT SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END) AS balance
             FROM journal_lines jl
             JOIN funds f ON f.id = jl.fund_id
            WHERE f.branch_id = a.branch_id
              AND f.code = 'advance_receivable_'
                          || CASE a.channel WHEN 'office_cash' THEN 'cash' ELSE 'wallet' END
                          || ':' || a.id::text
         ) bal ON true
         LEFT JOIN LATERAL (
           SELECT SUM(amount_minor) FILTER (WHERE kind = 'repayment')  AS repaid,
                  SUM(amount_minor) FILTER (WHERE kind = 'conversion') AS converted
             FROM advance_events ae WHERE ae.advance_id = a.id
         ) ev ON true
        WHERE a.branch_id = $1
          AND COALESCE(bal.balance, 0) <> 0
        ORDER BY a.business_date DESC, a.created_at DESC`,
      [branchId],
    )
    return rows.map((row) => ({
      advance: advanceRecord(row),
      outstanding: minor(BigInt(String(row.outstanding))),
      repaid: minor(BigInt(String(row.repaid))),
      converted: minor(BigInt(String(row.converted))),
    }))
  }

  async listParties(branchId: string): Promise<Array<{ partyName: string; partyKey: string }>> {
    // DISTINCT ON keeps the FIRST spelling anyone used, so the suggestion list shows a real name
    // rather than a normalised key nobody typed.
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (party_key) party_key, party_name
         FROM advances WHERE branch_id = $1
        ORDER BY party_key, created_at`,
      [branchId],
    )
    return rows.map((r) => ({ partyKey: String(r.party_key), partyName: String(r.party_name) }))
  }

  async getEvent(id: string): Promise<AdvanceEventRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT *, amount_minor::text AS amount FROM advance_events WHERE id = $1',
      [id],
    )
    const row = rows[0]
    return row ? advanceEventRecord(row) : null
  }

  async createEvent(event: AdvanceEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO advance_events (id, advance_id, branch_id, kind, amount_minor, business_date,
                                   reason, expense_id, journal_entry_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        event.id,
        event.advanceId,
        event.branchId,
        event.kind,
        event.amount.toString(),
        event.businessDate,
        event.reason,
        event.expenseId,
        event.journalEntryId,
        event.createdBy,
      ],
    )
  }

  async listEvents(advanceId: string): Promise<AdvanceEventRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT *, amount_minor::text AS amount FROM advance_events
        WHERE advance_id = $1 ORDER BY business_date, created_at`,
      [advanceId],
    )
    return rows.map(advanceEventRecord)
  }
}

const advanceRecord = (row: Record<string, unknown>): AdvanceRecord => ({
  id: String(row.id),
  branchId: String(row.branch_id),
  partyName: String(row.party_name),
  partyKey: String(row.party_key),
  categoryId: String(row.category_id),
  costCenterKind: row.cost_center_kind as AdvanceRecord['costCenterKind'],
  vehicleId: (row.vehicle_id as string | null) ?? null,
  channel: row.channel as AdvanceRecord['channel'],
  amount: minor(BigInt(String(row.amount))),
  businessDate: isoDate(row.business_date),
  description: String(row.description),
  receiptMediaId: (row.receipt_media_id as string | null) ?? null,
  sourceDriverId: (row.source_driver_id as string | null) ?? null,
  // NOT NULL in the schema, unlike an expense's: an advance without its journal cannot exist.
  journalEntryId: Number(row.journal_entry_id),
  createdBy: String(row.created_by),
})

const advanceEventRecord = (row: Record<string, unknown>): AdvanceEventRecord => ({
  id: String(row.id),
  advanceId: String(row.advance_id),
  branchId: String(row.branch_id),
  kind: row.kind as AdvanceEventRecord['kind'],
  amount: minor(BigInt(String(row.amount))),
  businessDate: isoDate(row.business_date),
  reason: String(row.reason),
  expenseId: (row.expense_id as string | null) ?? null,
  journalEntryId: Number(row.journal_entry_id),
  createdBy: String(row.created_by),
})

export class PgSettingsRepo implements SettingsRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  private async money(key: string): Promise<Minor | null> {
    const raw = await this.get(key)
    if (raw === null || raw === undefined) return null
    // Settings are jsonb; a money setting is stored as a STRING of minor units so a large
    // ceiling cannot lose precision passing through JSON.
    return minor(BigInt(String(raw)))
  }

  async receiptRequiredAbove(_branchId: string): Promise<Minor | null> {
    return this.money('expense.receipt_required_above_minor')
  }

  async kwhPriceMinor(): Promise<Minor | null> {
    return this.money('vehicle.kwh_price_minor')
  }

  async get(key: string): Promise<unknown> {
    const { rows } = await this.pool.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [key])
    return rows[0]?.value ?? null
  }

  async set(key: string, value: unknown, actorId: string): Promise<void> {
    // A money setting arrives as a string of minor units (see money() above); any other string is
    // a plain scalar — a calendar date, for one. Label it so the column's value_type stays honest
    // rather than filing every non-money string as 'json'.
    const valueType =
      typeof value === 'string' ? (/^-?\d+$/.test(value) ? 'money_minor' : 'string') : 'json'
    await this.pool.query(
      `INSERT INTO settings (key, value, value_type, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, value_type = EXCLUDED.value_type,
                                       updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), valueType, actorId],
    )
  }
}

// ── Daily cash count (SRS E-5 / س51) ─────────────────────────────────────────────────────

export class PgCashCountRepo implements CashCountRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async create(count: CashCountRecord): Promise<CashCountRecord> {
    try {
      const persistedId = await withTransaction(this.pool, { actorId: count.countedBy }, async (client) =>
        await insertCashCount(client, count))
      return { ...count, id: persistedId }
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error(`cash count already exists for ${count.businessDate}`), {
          code: 'DUPLICATE_COUNT',
        })
      }
      throw err
    }
  }

  async find(branchId: string, businessDate: CalendarDate): Promise<CashCountRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT c.*,
              COALESCE(json_agg(json_build_object(
                'fundCode', f.code,
                'counted',  l.counted_minor::text,
                'computed', l.computed_minor::text,
                'variance', l.variance_minor::text,
                'resolution', l.resolution
              ) ORDER BY f.code) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
         FROM cash_counts c
         LEFT JOIN cash_count_lines l ON l.cash_count_id = c.id
         LEFT JOIN funds f ON f.id = l.fund_id
        WHERE c.branch_id = $1 AND c.business_date = $2 AND c.status = 'active'
        GROUP BY c.id`,
      [branchId, businessDate],
    )
    const r = rows[0]
    if (!r) return null
    return rowToCashCount(r)
  }

  async listDatesInRange(branchId: string, from: CalendarDate, to: CalendarDate): Promise<CalendarDate[]> {
    // `status = 'active'` is load-bearing, not tidiness: without it a financial week could seal on
    // a count its own author withdrew, and BR7 makes that seal immutable.
    const { rows } = await this.pool.query<{ business_date: unknown }>(
      `SELECT business_date FROM cash_counts
        WHERE branch_id = $1 AND business_date BETWEEN $2 AND $3 AND status = 'active'
        ORDER BY business_date`,
      [branchId, from, to],
    )
    return rows.map((r) => isoDate(r.business_date))
  }

  /**
   * Close the active count and insert its replacement inside ONE transaction.
   *
   * Splitting them would leave the day with two active counts — which the partial unique index
   * refuses, aborting halfway — or with none, stranding the restoration behind
   * `cash_count_required` with no way back.
   */
  async supersede(input: {
    priorId: string
    replacement: CashCountRecord
    closedBy: string
    closedAtMs: number
    reason: string
  }): Promise<CashCountRecord> {
    const id = await withTransaction(this.pool, { actorId: input.closedBy }, async (client) => {
      const inserted = await insertCashCount(client, input.replacement)
      const closed = await client.query(
        `UPDATE cash_counts
            SET status = 'superseded', superseded_by_id = $2,
                closed_at = to_timestamp($3::double precision/1000), closed_by = $4, closed_reason = $5
          WHERE id = $1 AND status = 'active'`,
        [input.priorId, inserted, input.closedAtMs, input.closedBy, input.reason],
      )
      // The prior count moved under us — another recount, or a withdrawal. Roll the whole thing
      // back rather than leave a replacement whose predecessor is still live somewhere else.
      if (closed.rowCount !== 1) throw Object.assign(new Error('prior count not active'), { code: 'COUNT_NOT_ACTIVE' })
      return inserted
    })
    return { ...input.replacement, id: String(id) }
  }

  async cancel(input: {
    id: string
    closedBy: string
    closedAtMs: number
    reason: string
  }): Promise<CashCountRecord | null> {
    const { rowCount } = await this.pool.query(
      `UPDATE cash_counts
          SET status = 'cancelled',
              closed_at = to_timestamp($2::double precision/1000), closed_by = $3, closed_reason = $4
        WHERE id = $1 AND status = 'active'`,
      [input.id, input.closedAtMs, input.closedBy, input.reason],
    )
    if (rowCount !== 1) return null
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT c.*,
              COALESCE(json_agg(json_build_object(
                'fundCode', f.code,
                'counted',  l.counted_minor::text,
                'computed', l.computed_minor::text,
                'variance', l.variance_minor::text,
                'resolution', l.resolution
              ) ORDER BY f.code) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
         FROM cash_counts c
         LEFT JOIN cash_count_lines l ON l.cash_count_id = c.id
         LEFT JOIN funds f ON f.id = l.fund_id
        WHERE c.id = $1
        GROUP BY c.id`,
      [input.id],
    )
    return rows[0] ? rowToCashCount(rows[0]) : null
  }
}

/**
 * Insert a count and its lines. Shared by `create` and `supersede` so a recount cannot drift from
 * a first count — they must produce byte-identical rows or the proof stops being comparable.
 *
 * `cash_counts.id` is BIGINT GENERATED ALWAYS, and the API's id generator emits UUIDs, so the
 * database owns the identity and returns the exact string audit and restoration must reference.
 */
async function insertCashCount(
  client: { query: PoolClient['query'] },
  count: CashCountRecord,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO cash_counts (branch_id, business_date, counted_by, counted_at, proof_sha256, sealed_at, notes)
     VALUES ($1,$2,$3, to_timestamp($4::double precision/1000), $5,
             CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6::double precision/1000) END, $7)
     RETURNING id::text AS id`,
    [
      count.branchId,
      count.businessDate,
      count.countedBy,
      count.countedAtMs,
      count.proofSha256,
      count.sealedAtMs,
      count.notes,
    ],
  )
  const storedId = inserted.rows[0]!.id
  for (const line of count.lines) {
    // Resolve the fund by code; a count line naming a fund that does not exist is a bug worth
    // failing on rather than silently dropping.
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM funds WHERE branch_id = $1 AND code = $2',
      [count.branchId, line.fundCode],
    )
    const fundId = rows[0]?.id
    if (!fundId) throw new Error(`cash count names an unknown fund: ${line.fundCode}`)

    await client.query(
      `INSERT INTO cash_count_lines (cash_count_id, fund_id, counted_minor, computed_minor, variance_minor, resolution)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        storedId,
        fundId,
        line.counted.toString(),
        line.computed.toString(),
        line.variance.toString(),
        line.resolution,
      ],
    )
  }
  return storedId
}

/** One shape for every read, so a new column cannot be mapped in one place and forgotten in another. */
function rowToCashCount(r: Record<string, unknown>): CashCountRecord {
  return {
    id: String(r.id),
    branchId: String(r.branch_id),
    businessDate: isoDate(r.business_date),
    countedBy: String(r.counted_by),
    countedAtMs: (r.counted_at as Date).getTime(),
    proofSha256: (r.proof_sha256 as string | null) ?? null,
    sealedAtMs: r.sealed_at === null ? null : (r.sealed_at as Date).getTime(),
    notes: (r.notes as string | null) ?? null,
    status: (r.status as CashCountRecord['status'] | undefined) ?? 'active',
    supersededById: r.superseded_by_id === null || r.superseded_by_id === undefined ? null : String(r.superseded_by_id),
    closedAtMs: r.closed_at === null || r.closed_at === undefined ? null : (r.closed_at as Date).getTime(),
    closedBy: (r.closed_by as string | null) ?? null,
    closedReason: (r.closed_reason as string | null) ?? null,
    lines: (r.lines as Array<Record<string, string | null>>).map((l) => ({
      fundCode: String(l.fundCode),
      counted: minor(BigInt(String(l.counted))),
      computed: minor(BigInt(String(l.computed))),
      variance: minor(BigInt(String(l.variance))),
      resolution: l.resolution ?? null,
    })),
  }
}

// ── Tier rules (SRS F) and notifications (SRS A-6) ───────────────────────────────────────

export class PgTierRepo implements TierRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async list(): Promise<TierRuleRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT id, basis, mode, vehicle_type_id, bands, effective_from, status, created_by FROM tier_rules ORDER BY effective_from DESC, id DESC',
    )
    return rows.map(toTierRule)
  }

  async publish(rule: Omit<TierRuleRecord, 'id' | 'status'>): Promise<TierRuleRecord> {
    return withTransaction(this.pool, { actorId: rule.createdBy }, async (client) => {
      // Supersede the incumbent for this vehicle type, never delete it — a past day must still
      // resolve to the rate that actually applied. Resolution reads 'active' AND 'superseded'.
      await client.query(
        `UPDATE tier_rules SET status = 'superseded'
          WHERE status = 'active'
            AND (vehicle_type_id IS NOT DISTINCT FROM $1)`,
        [rule.vehicleTypeId],
      )
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO tier_rules (basis, mode, vehicle_type_id, bands, effective_from, status, created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,'active',$6)
         RETURNING id, basis, mode, vehicle_type_id, bands, effective_from, status, created_by`,
        [rule.basis, rule.mode, rule.vehicleTypeId, JSON.stringify(rule.bands), rule.effectiveFrom, rule.createdBy],
      )
      return toTierRule(rows[0]!)
    })
  }

  async withdraw(id: number, actorId: string): Promise<void> {
    await withTransaction(this.pool, { actorId }, async (client) => {
      await client.query("UPDATE tier_rules SET status = 'withdrawn' WHERE id = $1", [id])
    })
  }
}

const toTierRule = (r: Record<string, unknown>): TierRuleRecord => ({
  id: Number(r.id),
  basis: r.basis as TierRuleRecord['basis'],
  mode: r.mode as TierRuleRecord['mode'],
  vehicleTypeId: (r.vehicle_type_id as string | null) ?? null,
  // jsonb comes back parsed; the band shape is validated by the domain before insert.
  bands: r.bands as TierRuleRecord['bands'],
  effectiveFrom: isoDate(r.effective_from),
  status: r.status as TierRuleRecord['status'],
  createdBy: String(r.created_by),
})

export class PgNotificationRepo implements NotificationRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async push(record: Omit<NotificationRecord, 'id'>): Promise<void> {
    // ON CONFLICT DO NOTHING against the partial unique index on (recipient_id, dedupe_key):
    // the same real-world event must not ring the bell twice.
    await this.pool.query(
      `INSERT INTO notifications (recipient_id, branch_id, kind, payload, dedupe_key, read_at, created_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,
               CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6::double precision/1000) END,
               to_timestamp($7::double precision/1000))
       ON CONFLICT (recipient_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        record.recipientId,
        record.branchId,
        record.kind,
        JSON.stringify(record.payload),
        record.dedupeKey,
        record.readAtMs,
        record.createdAtMs,
      ],
    )
  }

  async listForRecipient(recipientId: string, unreadOnly: boolean): Promise<NotificationRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM notifications
        WHERE recipient_id = $1 AND ($2 = false OR read_at IS NULL)
        ORDER BY created_at DESC`,
      [recipientId, unreadOnly],
    )
    return rows.map(toNotification)
  }

  async markRead(id: number, recipientId: string, atMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE notifications SET read_at = to_timestamp($3::double precision/1000)
        WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL`,
      [id, recipientId, atMs],
    )
  }

  async unreadCount(recipientId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM notifications WHERE recipient_id = $1 AND read_at IS NULL',
      [recipientId],
    )
    return Number(rows[0]?.count ?? '0')
  }
}

/** The manager's decision log on a shift (SRS C-7). Append-only; read newest-first. */
export class PgShiftDecisionRepo implements ShiftDecisionRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async record(decision: Omit<ShiftDecisionRecord, 'id'>): Promise<ShiftDecisionRecord> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO shift_decisions (shift_id, gate, decision, notes, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,$5, to_timestamp($6::double precision / 1000))
       RETURNING id`,
      [decision.shiftId, decision.gate, decision.decision, decision.notes, decision.decidedBy, decision.decidedAtMs],
    )
    return { ...decision, id: Number(rows[0]!.id) }
  }

  async listByShift(shiftId: string): Promise<ShiftDecisionRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM shift_decisions WHERE shift_id = $1 ORDER BY decided_at DESC, id DESC',
      [shiftId],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      shiftId: String(r.shift_id),
      gate: r.gate as ShiftDecisionRecord['gate'],
      decision: r.decision as ShiftDecisionRecord['decision'],
      notes: (r.notes as string | null) ?? null,
      decidedBy: String(r.decided_by),
      decidedAtMs: (r.decided_at as Date).getTime(),
    }))
  }
}

/**
 * The register the system admin reads: every row a manager declared was never a delivery.
 *
 * Append-only in the database (`REVOKE UPDATE, DELETE` plus a trigger), so there is no `update` and
 * no `delete` here to write. A restore is a second row, never an edit of the first — «removed, then
 * put back» is two acts by two people for two reasons, and one row could only ever tell half of it.
 */
export class PgOperationRemovalRepo implements OperationRemovalRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async append(
    entry: Omit<OperationRemovalRecord, 'id' | 'actedAtMs'> & { actedAtMs: number },
  ): Promise<OperationRemovalRecord> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO operation_removals
         (kind, operation_kind, operation_id, operation_ref, shift_id, branch_id, business_date,
          driver_id, amount_minor, reason, evidence_slot, evidence_media_id, acted_by, acted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,
               to_timestamp($14::double precision / 1000))
       RETURNING id`,
      [
        entry.kind,
        entry.operationKind,
        entry.operationId,
        entry.operationRef,
        entry.shiftId,
        entry.branchId,
        entry.businessDate,
        entry.driverId,
        entry.amount.toString(),
        entry.reason,
        entry.evidenceSlot,
        entry.evidenceMediaId,
        entry.actedBy,
        entry.actedAtMs,
      ],
    )
    return { ...entry, id: String(rows[0]!.id) }
  }

  async list(filter: { branchId?: string | undefined; limit: number }): Promise<OperationRemovalRecord[]> {
    // Newest first, and bounded by the caller. An unbounded register is a screen that stops loading
    // in the month the fleet reaches a hundred bikes.
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT id, kind, operation_kind, operation_id, operation_ref, shift_id, branch_id,
              to_char(business_date, 'YYYY-MM-DD') AS business_date, driver_id,
              amount_minor::text AS amount, reason, evidence_slot, evidence_media_id,
              acted_by, acted_at
         FROM operation_removals
        WHERE ($1::uuid IS NULL OR branch_id = $1::uuid)
        ORDER BY acted_at DESC, id DESC
        LIMIT $2`,
      [filter.branchId ?? null, filter.limit],
    )
    return rows.map((r) => ({
      id: String(r.id),
      kind: r.kind as OperationRemovalRecord['kind'],
      operationKind: r.operation_kind as OperationRemovalRecord['operationKind'],
      operationId: String(r.operation_id),
      operationRef: String(r.operation_ref),
      shiftId: String(r.shift_id),
      branchId: String(r.branch_id),
      businessDate: String(r.business_date),
      driverId: (r.driver_id as string | null) ?? null,
      amount: minor(BigInt(String(r.amount))),
      reason: String(r.reason),
      evidenceSlot: (r.evidence_slot as string | null) ?? null,
      evidenceMediaId: (r.evidence_media_id as string | null) ?? null,
      actedBy: String(r.acted_by),
      actedAtMs: (r.acted_at as Date).getTime(),
    }))
  }
}

/** Live GPS pings (SRS K): append-only telemetry; the live map reads the latest fix per driver. */
export class PgGpsPingRepo implements GpsPingRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async append(ping: Omit<GpsPingRecord, 'id'>): Promise<void> {
    await this.appendMany([ping])
  }

  /**
   * One statement for a whole buffered run, and a replay costs nothing.
   *
   * `ON CONFLICT DO NOTHING` against the natural key `(shift_id, captured_at)` is what makes the
   * client's retry safe: a batch that was stored but whose 202 never arrived can be sent again
   * verbatim. `rowCount` then tells the caller how many were genuinely new.
   */
  async appendMany(pings: readonly Omit<GpsPingRecord, 'id'>[]): Promise<{ inserted: number }> {
    if (pings.length === 0) return { inserted: 0 }
    const params: unknown[] = []
    const tuples = pings.map((ping, index) => {
      const base = index * 9
      params.push(
        ping.shiftId, ping.driverId, ping.branchId, ping.lat, ping.lng,
        ping.accuracyM, ping.capturedAtMs, ping.receivedAtMs, ping.source,
      )
      return (
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},` +
        `to_timestamp($${base + 7}::double precision / 1000),` +
        `to_timestamp($${base + 8}::double precision / 1000),$${base + 9})`
      )
    })
    const { rowCount } = await this.pool.query(
      `INSERT INTO gps_pings
         (shift_id, driver_id, branch_id, lat, lng, accuracy_m, captured_at, received_at, source)
       VALUES ${tuples.join(',')}
       ON CONFLICT (shift_id, captured_at) DO NOTHING`,
      params,
    )
    return { inserted: rowCount ?? 0 }
  }

  /**
   * One index seek per live driver — flat forever, whatever the history.
   *
   * Its predecessor was `SELECT DISTINCT ON (driver_id) ... WHERE branch_id = $1`, which reads
   * EVERY tuple the branch has ever written: `DISTINCT ON` does not skip ahead, so the cost of
   * drawing ten dots grew with every ping ever stored. The lateral turns it into one seek per
   * driver against `(branch_id, driver_id, received_at DESC)`.
   */
  async latestForDriversInBranch(
    branchId: string,
    driverIds: readonly string[],
    sinceMs: number,
  ): Promise<GpsPingRecord[]> {
    if (driverIds.length === 0) return []
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT p.* FROM unnest($2::uuid[]) AS d(driver_id)
         CROSS JOIN LATERAL (
           SELECT * FROM gps_pings g
            WHERE g.branch_id = $1
              AND g.driver_id = d.driver_id
              AND g.received_at >= to_timestamp($3::double precision / 1000)
            ORDER BY g.received_at DESC, g.id DESC
            LIMIT 1
         ) p`,
      [branchId, [...driverIds], sinceMs],
    )
    return rows.map(toGpsPing)
  }

  async listForShift(shiftId: string): Promise<GpsPingRecord[]> {
    // CAPTURE order. See the port's note: receive order corrupts a buffered trail.
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM gps_pings WHERE shift_id = $1 ORDER BY captured_at ASC, id ASC',
      [shiftId],
    )
    return rows.map(toGpsPing)
  }

  async countForShift(shiftId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM gps_pings WHERE shift_id = $1',
      [shiftId],
    )
    return Number(rows[0]?.n ?? 0)
  }
}

const toGpsPing = (r: Record<string, unknown>): GpsPingRecord => ({
  // Older rows predate the column and default to the foreground beacon, which is what they were.
  source: (r.source as GpsPingRecord['source'] | null) ?? 'phone_fg',
  id: Number(r.id),
  shiftId: String(r.shift_id),
  driverId: String(r.driver_id),
  branchId: String(r.branch_id),
  lat: Number(r.lat),
  lng: Number(r.lng),
  accuracyM: r.accuracy_m === null ? null : Number(r.accuracy_m),
  capturedAtMs: (r.captured_at as Date).getTime(),
  receivedAtMs: (r.received_at as Date).getTime(),
})

/** The vehicle life log (SRS B-2 / س66). Append-only; the timeline reads newest-first. */
export class PgVehicleEventRepo implements VehicleEventRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async create(event: Omit<VehicleEventRecord, 'id'>): Promise<VehicleEventRecord> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO vehicle_events
         (vehicle_id, branch_id, kind, occurred_at, business_date, odometer_km, cost_minor, expense_id, shift_id, notes, created_by)
       VALUES ($1,$2,$3, to_timestamp($4::double precision / 1000), $5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        event.vehicleId,
        event.branchId,
        event.kind,
        event.occurredAtMs,
        event.businessDate,
        event.odometerKm,
        // Money is written as a decimal string, never a float — same rule as every other amount.
        event.costMinor === null ? null : event.costMinor.toString(),
        event.expenseId,
        event.shiftId,
        event.notes,
        event.createdBy,
      ],
    )
    return { ...event, id: Number(rows[0]!.id) }
  }

  async listByVehicle(vehicleId: string, limit = 100): Promise<VehicleEventRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM vehicle_events WHERE vehicle_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2',
      [vehicleId, limit],
    )
    return rows.map(toVehicleEvent)
  }
}

/** Admin-staff attendance (SRS B-4 / س41): the daily login, upserted once per user per day. */
export class PgAttendanceRepo implements AttendanceRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async touch(userId: string, branchId: string, businessDate: CalendarDate, atMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO attendance_days (user_id, branch_id, business_date, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3, to_timestamp($4::double precision / 1000), to_timestamp($4::double precision / 1000))
       ON CONFLICT (user_id, business_date)
       DO UPDATE SET last_seen_at = to_timestamp($4::double precision / 1000)`,
      [userId, branchId, businessDate, atMs],
    )
  }

  async listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<AttendanceRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM attendance_days WHERE branch_id = $1 AND business_date = $2 ORDER BY first_seen_at',
      [branchId, businessDate],
    )
    return rows.map(toAttendance)
  }
}

const toAttendance = (r: Record<string, unknown>): AttendanceRecord => ({
  userId: String(r.user_id),
  branchId: String(r.branch_id),
  businessDate: isoDate(r.business_date),
  firstSeenAtMs: (r.first_seen_at as Date).getTime(),
  lastSeenAtMs: (r.last_seen_at as Date).getTime(),
})

const toVehicleEvent = (r: Record<string, unknown>): VehicleEventRecord => ({
  id: Number(r.id),
  vehicleId: String(r.vehicle_id),
  branchId: String(r.branch_id),
  kind: r.kind as VehicleEventRecord['kind'],
  occurredAtMs: (r.occurred_at as Date).getTime(),
  businessDate: isoDate(r.business_date),
  odometerKm: r.odometer_km == null ? null : Number(r.odometer_km),
  // ::text-then-BigInt, never Number() — a float would silently lose minor units.
  costMinor: r.cost_minor == null ? null : minor(BigInt(r.cost_minor as string)),
  expenseId: (r.expense_id as string | null) ?? null,
  shiftId: (r.shift_id as string | null) ?? null,
  notes: (r.notes as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null,
})

const toNotification = (r: Record<string, unknown>): NotificationRecord => ({
  id: Number(r.id),
  recipientId: String(r.recipient_id),
  branchId: (r.branch_id as string | null) ?? null,
  kind: String(r.kind),
  payload: (r.payload as Record<string, unknown>) ?? {},
  dedupeKey: (r.dedupe_key as string | null) ?? null,
  readAtMs: r.read_at === null ? null : (r.read_at as Date).getTime(),
  createdAtMs: (r.created_at as Date).getTime(),
})

/**
 * Driver↔vehicle assignments (SRS B-3). The manager binds a bike to a driver for a business date;
 * the driver app then shows him that bike rather than a free choice. The table's two UNIQUE
 * constraints (per driver, per vehicle, per date+shift) are what stop double-booking either side.
 */
export class PgAssignmentRepo implements AssignmentRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async create(a: AssignmentRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO assignments (id, branch_id, driver_id, vehicle_id, business_date, shift_no, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [a.id, a.branchId, a.driverId, a.vehicleId, a.businessDate, a.shiftNo, a.createdBy],
      )
    } catch (err) {
      // Same shape the memory adapter throws, so the route handles one case, not two.
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error('already assigned'), { code: 'DUPLICATE_ASSIGNMENT' })
      }
      throw err
    }
  }

  async listByDate(branchId: string, businessDate: CalendarDate): Promise<AssignmentRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM assignments WHERE branch_id = $1 AND business_date = $2 ORDER BY shift_no`,
      [branchId, businessDate],
    )
    return rows.map(toAssignment)
  }

  async findForDriver(driverId: string, businessDate: CalendarDate): Promise<AssignmentRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM assignments WHERE driver_id = $1 AND business_date = $2 ORDER BY shift_no`,
      [driverId, businessDate],
    )
    return rows.map(toAssignment)
  }

  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM assignments WHERE id = $1', [id])
  }
}

const toAssignment = (r: Record<string, unknown>): AssignmentRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  driverId: String(r.driver_id),
  vehicleId: String(r.vehicle_id),
  businessDate: isoDate(r.business_date),
  shiftNo: Number(r.shift_no),
  createdBy: (r.created_by as string | null) ?? null,
})

/** Custom-date advance approvals, consumed inside the same transaction that opens the shift. */
export class PgPreapprovedShiftRuleRepo implements PreapprovedShiftRuleRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async createMany(rules: readonly PreapprovedShiftRuleRecord[]): Promise<void> {
    if (rules.length === 0) return
    const params: unknown[] = []
    const tuples = rules.map((rule, index) => {
      const base = index * 12
      params.push(
        rule.id,
        rule.branchId,
        rule.driverId,
        rule.businessDate,
        rule.windowStartMinute,
        rule.windowEndMinute,
        rule.cashFloat.toString(),
        rule.walletTopup.toString(),
        rule.authorizedBy,
        rule.authorizedByRole,
        rule.authorizedByBranchId,
        rule.createdAtMs,
      )
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},` +
        `$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},` +
        `to_timestamp($${base + 12}::double precision/1000))`
    })
    try {
      // One statement makes a multi-date manager command atomic: an overlap on any date rolls all
      // dates back. The database trigger serializes concurrent publishers for each driver/date.
      await withTransaction(this.pool, { actorId: rules[0]!.authorizedBy }, async (client) => {
        await client.query(
          `INSERT INTO preapproved_shift_rules
             (id, branch_id, driver_id, business_date, window_start_minute, window_end_minute,
              cash_float_minor, wallet_topup_minor, authorized_by, authorized_by_role,
              authorized_by_branch_id, created_at)
           VALUES ${tuples.join(',')}`,
          params,
        )
      })
    } catch (err) {
      if (isPgError(err, PG.EXCLUSION_VIOLATION)) {
        throw Object.assign(new Error('overlapping pre-approved shift rule'), {
          code: 'PREAPPROVED_SHIFT_RULE_OVERLAP',
        })
      }
      throw err
    }
  }

  async listByBranch(branchId: string): Promise<PreapprovedShiftRuleRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM preapproved_shift_rules
        WHERE branch_id = $1
        ORDER BY business_date, window_start_minute, created_at, id`,
      [branchId],
    )
    return rows.map(toPreapprovedShiftRule)
  }

  async findById(id: string): Promise<PreapprovedShiftRuleRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM preapproved_shift_rules WHERE id = $1',
      [id],
    )
    return rows[0] ? toPreapprovedShiftRule(rows[0]) : null
  }

  async findMatching(input: {
    branchId: string
    driverId: string
    businessDate: CalendarDate
    localMinute: number
  }): Promise<PreapprovedShiftRuleRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT *
         FROM preapproved_shift_rules
        WHERE branch_id = $1
          AND driver_id = $2
          AND business_date = $3
          AND active
          AND consumed_by_shift_id IS NULL
          AND window_start_minute <= $4
          AND window_end_minute >= $4
        ORDER BY window_start_minute, created_at, id
        LIMIT 1`,
      [input.branchId, input.driverId, input.businessDate, input.localMinute],
    )
    return rows[0] ? toPreapprovedShiftRule(rows[0]) : null
  }

  async consume(id: string, shiftId: string, consumedAtMs: number): Promise<PreapprovedShiftRuleRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `UPDATE preapproved_shift_rules
          SET consumed_by_shift_id = $2,
              consumed_at = to_timestamp($3::double precision/1000)
        WHERE id = $1 AND active AND consumed_by_shift_id IS NULL
        RETURNING *`,
      [id, shiftId, consumedAtMs],
    )
    return rows[0] ? toPreapprovedShiftRule(rows[0]) : null
  }

  async deactivate(id: string, actorId: string): Promise<PreapprovedShiftRuleRecord | null> {
    return withTransaction(this.pool, { actorId }, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE preapproved_shift_rules
            SET active = false
          WHERE id = $1 AND active AND consumed_by_shift_id IS NULL
          RETURNING *`,
        [id],
      )
      return rows[0] ? toPreapprovedShiftRule(rows[0]) : null
    })
  }
}

const toPreapprovedShiftRule = (r: Record<string, unknown>): PreapprovedShiftRuleRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  driverId: String(r.driver_id),
  businessDate: isoDate(r.business_date),
  windowStartMinute: Number(r.window_start_minute),
  windowEndMinute: Number(r.window_end_minute),
  cashFloat: minor(BigInt(String(r.cash_float_minor))),
  walletTopup: minor(BigInt(String(r.wallet_topup_minor))),
  active: Boolean(r.active),
  authorizedBy: String(r.authorized_by),
  authorizedByRole: r.authorized_by_role as PreapprovedShiftRuleRecord['authorizedByRole'],
  authorizedByBranchId: (r.authorized_by_branch_id as string | null) ?? null,
  createdAtMs: (r.created_at as Date).getTime(),
  consumedByShiftId: (r.consumed_by_shift_id as string | null) ?? null,
  consumedAtMs: r.consumed_at === null ? null : (r.consumed_at as Date).getTime(),
})


/**
 * Per-pack BMS readings (SRS section L seam).
 *
 * Keyed on the table's UNIQUE (shift, battery, package): a retake CORRECTS the reading in place
 * rather than adding a second one, so a driver cannot stack readings until one of them looks
 * right. The submitted row is one evidence generation: values, photo, source, and OCR baseline
 * are replaced together. Retaining an earlier photo's OCR while replacing the other fields would
 * manufacture a correction delta that never occurred; an explicit null therefore clears it.
 */
export class PgBatteryReadingRepo implements BatteryReadingRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async upsert(r: BatteryReadingRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO shift_battery_readings
         (shift_id, battery_id, package, percent, pack_millivolts, cycle_count,
          remain_capacity_dah, full_capacity_dah, mos_temp_dc, t1_dc, t2_dc, media_id, source, ocr_raw,
          battery_swap_id, unavailable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (shift_id, battery_id, package) DO UPDATE SET
         percent = EXCLUDED.percent,
         pack_millivolts = EXCLUDED.pack_millivolts,
         cycle_count = EXCLUDED.cycle_count,
         remain_capacity_dah = EXCLUDED.remain_capacity_dah,
         full_capacity_dah = EXCLUDED.full_capacity_dah,
         mos_temp_dc = EXCLUDED.mos_temp_dc,
         t1_dc = EXCLUDED.t1_dc,
         t2_dc = EXCLUDED.t2_dc,
         media_id = EXCLUDED.media_id,
         source = EXCLUDED.source,
         ocr_raw = EXCLUDED.ocr_raw,
         battery_swap_id = COALESCE(EXCLUDED.battery_swap_id, shift_battery_readings.battery_swap_id),
         unavailable = EXCLUDED.unavailable`,
      [
        r.shiftId, r.batteryId, r.package, r.percent, r.packMillivolts, r.cycleCount,
        r.remainCapacityDah, r.fullCapacityDah, r.mosTempDc, r.t1Dc, r.t2Dc, r.mediaId, r.source,
        r.ocrRaw === null || r.ocrRaw === undefined ? null : JSON.stringify(r.ocrRaw),
        r.batterySwapId,
        r.unavailable,
      ],
    )
  }

  async listByShift(shiftId: string): Promise<BatteryReadingRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT r.*, b.slot_no
         FROM shift_battery_readings r
         JOIN batteries b ON b.id = r.battery_id
        WHERE r.shift_id = $1
        ORDER BY r.package, b.slot_no`,
      [shiftId],
    )
    return rows.map((r) => ({
      shiftId: String(r.shift_id),
      batteryId: String(r.battery_id),
      package: r.package as BatteryReadingRecord['package'],
      slotNo: Number(r.slot_no ?? 1),
      percent: numOrNull(r.percent),
      packMillivolts: numOrNull(r.pack_millivolts),
      cycleCount: numOrNull(r.cycle_count),
      remainCapacityDah: numOrNull(r.remain_capacity_dah),
      fullCapacityDah: numOrNull(r.full_capacity_dah),
      mosTempDc: numOrNull(r.mos_temp_dc),
      t1Dc: numOrNull(r.t1_dc),
      t2Dc: numOrNull(r.t2_dc),
      mediaId: (r.media_id as string | null) ?? null,
      source: r.source as BatteryReadingRecord['source'],
      unavailable: Boolean(r.unavailable),
      ocrRaw: r.ocr_raw ?? null,
      batterySwapId: (r.battery_swap_id as string | null) ?? null,
    }))
  }

  async existsForBattery(batteryId: string): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT 1 FROM shift_battery_readings WHERE battery_id = $1 LIMIT 1', [
      batteryId,
    ])
    return rows.length > 0
  }
}

/** The mid-shift battery-swap event log (SRS §L seam). Append-only, one row per swap per shift. */
export class PgBatterySwapRepo implements BatterySwapRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async create(s: BatterySwapRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO battery_swaps (id, shift_id, seq_no, slot_no, out_battery_id, in_battery_id, occurred_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7 / 1000.0),$8)`,
      [s.id, s.shiftId, s.seqNo, s.slotNo, s.outBatteryId, s.inBatteryId, s.occurredAtMs, s.createdBy],
    )
  }

  async existsForBattery(batteryId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM battery_swaps WHERE out_battery_id = $1 OR in_battery_id = $1 LIMIT 1',
      [batteryId],
    )
    return rows.length > 0
  }

  async listByShift(shiftId: string): Promise<BatterySwapRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM battery_swaps WHERE shift_id = $1 ORDER BY seq_no',
      [shiftId],
    )
    return rows.map((r) => ({
      id: String(r.id),
      shiftId: String(r.shift_id),
      seqNo: Number(r.seq_no),
      slotNo: Number(r.slot_no),
      outBatteryId: String(r.out_battery_id),
      inBatteryId: String(r.in_battery_id),
      occurredAtMs: new Date(r.occurred_at as string).getTime(),
      createdBy: (r.created_by as string | null) ?? null,
    }))
  }
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

// ── «التفقّد» — manager check-in rounds ────────────────────────────────────────────────────

export class PgCheckInRepo implements CheckInRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async listWindows(branchId: string, userId?: string): Promise<CheckInWindowRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM checkin_windows
        WHERE branch_id = $1 AND active AND ($2::uuid IS NULL OR user_id = $2)
        ORDER BY at_minute`,
      [branchId, userId ?? null],
    )
    return rows.map(toCheckInWindow)
  }

  async createWindow(w: CheckInWindowRecord): Promise<CheckInWindowRecord> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO checkin_windows (id, branch_id, user_id, at_minute, tolerance_minutes, active, label, created_by)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING *`,
      [w.id, w.branchId, w.userId, w.atMinute, w.toleranceMinutes, w.label, w.createdBy],
    )
    return toCheckInWindow(rows[0]!)
  }

  /** Retiring a round keeps its history: the row stays, only `active` moves. */
  async deactivateWindow(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE checkin_windows SET active = false WHERE id = $1 AND active',
      [id],
    )
    return rowCount === 1
  }

  async record(c: CheckInRecord): Promise<CheckInRecord> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO checkins (id, branch_id, user_id, business_date, captured_at, lat, lng, accuracy_m,
                             window_id, distance_m, inside_area, minutes_from_target, verdict, note)
       VALUES ($1,$2,$3,$4, to_timestamp($5::double precision/1000), $6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        c.id, c.branchId, c.userId, c.businessDate, c.capturedAtMs, c.lat, c.lng, c.accuracyM,
        c.windowId, c.distanceM, c.insideArea, c.minutesFromTarget, c.verdict, c.note,
      ],
    )
    return toCheckIn(rows[0]!)
  }

  async listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<CheckInRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM checkins WHERE branch_id = $1 AND business_date = $2 ORDER BY captured_at',
      [branchId, businessDate],
    )
    return rows.map(toCheckIn)
  }

  async listByUserAndDate(userId: string, businessDate: CalendarDate): Promise<CheckInRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM checkins WHERE user_id = $1 AND business_date = $2 ORDER BY captured_at',
      [userId, businessDate],
    )
    return rows.map(toCheckIn)
  }
}

const toCheckInWindow = (r: Record<string, unknown>): CheckInWindowRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  userId: String(r.user_id),
  atMinute: Number(r.at_minute),
  toleranceMinutes: Number(r.tolerance_minutes),
  active: Boolean(r.active),
  label: (r.label as string | null) ?? null,
  createdBy: String(r.created_by),
})

const toCheckIn = (r: Record<string, unknown>): CheckInRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  userId: String(r.user_id),
  businessDate: isoDate(r.business_date),
  capturedAtMs: (r.captured_at as Date).getTime(),
  lat: Number(r.lat),
  lng: Number(r.lng),
  accuracyM: r.accuracy_m === null || r.accuracy_m === undefined ? null : Number(r.accuracy_m),
  windowId: (r.window_id as string | null) ?? null,
  distanceM: Number(r.distance_m),
  insideArea: Boolean(r.inside_area),
  minutesFromTarget: r.minutes_from_target === null || r.minutes_from_target === undefined ? null : Number(r.minutes_from_target),
  verdict: r.verdict as CheckInRecord['verdict'],
  note: (r.note as string | null) ?? null,
})
