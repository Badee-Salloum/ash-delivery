import type {
  AssignmentRecord,
  AssignmentRepo,
  AttachedSlot,
  AttendanceRecord,
  AttendanceRepo,
  BatteryReadingRecord,
  BatteryReadingRepo,
  BatteryRecord,
  BranchRecord,
  EvidencePackage,
  GovernorateRecord,
  VehicleTypeRecord,
  MediaRecord,
  MediaRepo,
  CashCountRecord,
  CashCountRepo,
  DirectoryRepo,
  DocumentRecord,
  ExpenseCategoryRecord,
  ExpenseRecord,
  ExpenseRepo,
  NotificationRecord,
  NotificationRepo,
  SettingsRepo,
  TierRepo,
  TierRuleRecord,
  DriverRecord,
  RoleGrantRecord,
  ShiftDecisionRecord,
  ShiftDecisionRepo,
  ShiftRecord,
  ShiftRepo,
  VehicleEventRecord,
  VehicleEventRepo,
  VehicleRecord,
  WeekLockRecord,
  WeekLockRepo,
} from '@ash/contracts'
import { type CalendarDate, LIVE_STATES, type Minor, minor } from '@ash/domain'
import type { Pool } from './pool.ts'
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

  async create(shift: ShiftRecord): Promise<void> {
    await this.persist(shift, true)
  }

  async update(shift: ShiftRecord): Promise<void> {
    await this.persist(shift, false)
  }

  private async persist(shift: ShiftRecord, insert: boolean): Promise<void> {
    await withTransaction(this.pool, { actorId: shift.approvedBy }, async (client) => {
      if (insert) {
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
           approved_by = $16
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
          shift.approvedBy,
        ],
      )

      // Tranches are replaced wholesale rather than diffed: the list is short, and a diff is
      // where an off-by-one silently drops a cash handover.
      await client.query('DELETE FROM float_tranches WHERE shift_id = $1', [shift.id])
      const writeTranches = async (kind: 'cash_float' | 'wallet_topup', amounts: readonly Minor[]) => {
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

      // shift_media is deliberately NOT written here. Evidence slots exist only because a photo
      // was uploaded, and PgMediaRepo owns that. Writing a caller-supplied slot list would let
      // the driver's app assert a photo that never arrived — and the BR5 gates read this field.
    })
  }

  async findById(id: string): Promise<ShiftRecord | null> {
    const rows = await this.load('s.id = $1', [id])
    return rows[0] ?? null
  }

  async listLiveForDriver(driverId: string): Promise<ShiftRecord[]> {
    return this.load('s.driver_id = $1 AND s.state = ANY($2::shift_state[])', [driverId, LIVE_STATES])
  }

  async listLiveForVehicle(vehicleId: string): Promise<ShiftRecord[]> {
    return this.load('s.vehicle_id = $1 AND s.state = ANY($2::shift_state[])', [vehicleId, LIVE_STATES])
  }

  async listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<ShiftRecord[]> {
    return this.load('s.branch_id = $1 AND s.business_date = $2', [branchId, businessDate])
  }

  /** Only ever called for a shift that never opened; the route enforces that. */
  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM shifts WHERE id = $1', [id])
  }

  async listApprovedForDriverOnDate(driverId: string, businessDate: CalendarDate): Promise<ShiftRecord[]> {
    return this.load(
      "s.driver_id = $1 AND s.business_date = $2 AND s.state IN ('approved','week_locked')",
      [driverId, businessDate],
    )
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
      mediaSlotsStart: r.media_start as string[],
      mediaSlotsEnd: r.media_end as string[],
      odoStart: r.odo_start === null ? null : Number(r.odo_start),
      odoEnd: r.odo_end === null ? null : Number(r.odo_end),
      batteryStart: r.battery_start === null ? null : Number(r.battery_start),
      batteryEnd: r.battery_end === null ? null : Number(r.battery_end),
      endCashDeclared: bigintOrNull(r.end_cash_declared_minor),
      endWalletDeclared: bigintOrNull(r.end_wallet_declared_minor),
      driverConfirmedAt: r.driver_confirmed_at === null ? null : (r.driver_confirmed_at as Date).toISOString(),
      equationDiff: bigintOrNull(r.equation_diff_minor),
      cashDiff: bigintOrNull(r.cash_diff_minor),
      walletDiff: bigintOrNull(r.wallet_diff_minor),
      ordersHash: (r.orders_hash as string | null) ?? null,
      approvedBy: (r.approved_by as string | null) ?? null,
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
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM branches ORDER BY code')
    return rows.map(toBranch)
  }

  async branch(id: string): Promise<BranchRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM branches WHERE id = $1', [id])
    const r = rows[0]
    return r ? toBranch(r) : null
  }

  async driver(id: string): Promise<DriverRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM drivers WHERE id = $1', [id])
    const r = rows[0]
    return r
      ? {
          id: String(r.id),
          branchId: String(r.branch_id),
          code: String(r.code),
          fullNameAr: String(r.full_name_ar),
          active: Boolean(r.active),
        }
      : null
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
        `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no, plate_no, state, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          vehicle.id,
          vehicle.branchId,
          vehicle.vehicleTypeId,
          vehicle.code,
          vehicle.machineNo,
          vehicle.plateNo,
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

  async updateVehicle(vehicle: VehicleRecord): Promise<void> {
    await this.pool.query('UPDATE vehicles SET state = $2, active = $3 WHERE id = $1', [
      vehicle.id,
      vehicle.state,
      vehicle.active,
    ])
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
          'INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no) VALUES ($1,$2,$3,$4,$5,$6)',
          [b.id, b.code, b.nameAr, b.nameEn, b.governorateId, b.branchNo],
        ),
      `branch ${b.code} or number ${b.branchNo} is taken`,
    )
  }

  async updateBranch(b: BranchRecord): Promise<void> {
    await this.uniqueOr(
      () =>
        this.pool.query(
          'UPDATE branches SET name_ar = $2, name_en = $3, governorate_id = $4, branch_no = $5 WHERE id = $1',
          [b.id, b.nameAr, b.nameEn, b.governorateId, b.branchNo],
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
          'INSERT INTO vehicle_types (id, code, name_ar, name_en, type_no, active) VALUES ($1,$2,$3,$4,$5,$6)',
          [t.id, t.code, t.nameAr, t.nameEn, t.typeNo, t.active],
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
          'UPDATE vehicle_types SET code = $2, name_ar = $3, name_en = $4, type_no = $5, active = $6 WHERE id = $1',
          [t.id, t.code, t.nameAr, t.nameEn, t.typeNo, t.active],
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
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM batteries WHERE id = $1', [id])
    const r = rows[0]
    return r ? toBattery(r) : null
  }

  async createBattery(b: BatteryRecord): Promise<void> {
    await this.uniqueOr(
      () =>
        this.pool.query(
          `INSERT INTO batteries (id, branch_id, serial_no, bms_mac, capacity_ah, vehicle_id, slot_no, state, active, bms_profile)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [b.id, b.branchId, b.serialNo, b.bmsMac, b.capacityAh, b.vehicleId, b.slotNo, b.state, b.active, b.bmsProfile],
        ),
      'that battery serial, or that slot on that bike, is already taken',
    )
  }

  async updateBattery(b: BatteryRecord): Promise<void> {
    await this.uniqueOr(
      () =>
        this.pool.query(
          `UPDATE batteries SET serial_no = $2, bms_mac = $3, capacity_ah = $4,
                                vehicle_id = $5, slot_no = $6, state = $7, active = $8, bms_profile = $9
            WHERE id = $1`,
          [b.id, b.serialNo, b.bmsMac, b.capacityAh, b.vehicleId, b.slotNo, b.state, b.active, b.bmsProfile],
        ),
      'that battery serial, or that slot on that bike, is already taken',
    )
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
  state: r.state as VehicleRecord['state'],
  active: Boolean(r.active),
})

const toBranch = (r: Record<string, unknown>): BranchRecord => ({
  id: String(r.id),
  code: String(r.code),
  nameAr: String(r.name_ar),
  nameEn: String(r.name_en),
  governorateId: String(r.governorate_id),
  branchNo: Number(r.branch_no),
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
  async attach(shiftId: string, pkg: EvidencePackage, slot: string, mediaId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO shift_media (shift_id, media_id, package, slot)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (shift_id, package, slot) DO UPDATE SET media_id = EXCLUDED.media_id`,
      [shiftId, mediaId, pkg, slot],
    )
  }

  async listSlots(shiftId: string): Promise<AttachedSlot[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT package, slot, media_id FROM shift_media WHERE shift_id = $1 ORDER BY package, slot',
      [shiftId],
    )
    return rows.map((r) => ({
      package: r.package as EvidencePackage,
      slot: String(r.slot),
      mediaId: String(r.media_id),
    }))
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

  async create(expense: ExpenseRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO expenses (id, branch_id, category_id, cost_center_kind, vehicle_id, amount_minor,
                             business_date, description, receipt_media_id, journal_entry_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
    return rows.map((r) => ({
      id: String(r.id),
      branchId: String(r.branch_id),
      categoryId: String(r.category_id),
      costCenterKind: r.cost_center_kind as ExpenseRecord['costCenterKind'],
      vehicleId: (r.vehicle_id as string | null) ?? null,
      amount: minor(BigInt(String(r.amount))),
      businessDate: isoDate(r.business_date),
      description: String(r.description),
      receiptMediaId: (r.receipt_media_id as string | null) ?? null,
      journalEntryId: r.journal_entry_id === null ? null : Number(r.journal_entry_id),
      createdBy: String(r.created_by),
    }))
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
    // A money setting arrives as a string of minor units (see money() above); anything else is a
    // plain scalar. Label it so the column's value_type stays honest rather than always 'json'.
    const valueType = typeof value === 'string' && /^-?\d+$/.test(value) ? 'money_minor' : 'json'
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

  async create(count: CashCountRecord): Promise<void> {
    try {
      await withTransaction(this.pool, { actorId: count.countedBy }, async (client) => {
        await client.query(
          `INSERT INTO cash_counts (id, branch_id, business_date, counted_by, counted_at, proof_sha256, sealed_at, notes)
           VALUES ($1,$2,$3,$4, to_timestamp($5::double precision/1000), $6,
                   CASE WHEN $7::bigint IS NULL THEN NULL ELSE to_timestamp($7::double precision/1000) END, $8)`,
          [
            count.id,
            count.branchId,
            count.businessDate,
            count.countedBy,
            count.countedAtMs,
            count.proofSha256,
            count.sealedAtMs,
            count.notes,
          ],
        )
        for (const line of count.lines) {
          // Resolve the fund by code; a count line naming a fund that does not exist is a bug
          // worth failing on rather than silently dropping.
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
              count.id,
              fundId,
              line.counted.toString(),
              line.computed.toString(),
              line.variance.toString(),
              line.resolution,
            ],
          )
        }
      })
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
        WHERE c.branch_id = $1 AND c.business_date = $2
        GROUP BY c.id`,
      [branchId, businessDate],
    )
    const r = rows[0]
    if (!r) return null
    return {
      id: String(r.id),
      branchId: String(r.branch_id),
      businessDate: isoDate(r.business_date),
      countedBy: String(r.counted_by),
      countedAtMs: (r.counted_at as Date).getTime(),
      proofSha256: (r.proof_sha256 as string | null) ?? null,
      sealedAtMs: r.sealed_at === null ? null : (r.sealed_at as Date).getTime(),
      notes: (r.notes as string | null) ?? null,
      lines: (r.lines as Array<Record<string, string | null>>).map((l) => ({
        fundCode: String(l.fundCode),
        counted: minor(BigInt(String(l.counted))),
        computed: minor(BigInt(String(l.computed))),
        variance: minor(BigInt(String(l.variance))),
        resolution: l.resolution ?? null,
      })),
    }
  }

  async listDatesInRange(branchId: string, from: CalendarDate, to: CalendarDate): Promise<CalendarDate[]> {
    const { rows } = await this.pool.query<{ business_date: unknown }>(
      'SELECT business_date FROM cash_counts WHERE branch_id = $1 AND business_date BETWEEN $2 AND $3 ORDER BY business_date',
      [branchId, from, to],
    )
    return rows.map((r) => isoDate(r.business_date))
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


/**
 * Per-pack BMS readings (SRS section L seam).
 *
 * Keyed on the table's UNIQUE (shift, battery, package): a retake CORRECTS the reading in place
 * rather than adding a second one, so a driver cannot stack readings until one of them looks
 * right. The first OCR reading is preserved on conflict, because it is the baseline a manual
 * correction is measured against -- overwriting it would erase the very delta SRS D-3 asks for.
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
          remain_capacity_dah, full_capacity_dah, mos_temp_dc, t1_dc, t2_dc, media_id, source, ocr_raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
         ocr_raw = COALESCE(shift_battery_readings.ocr_raw, EXCLUDED.ocr_raw)`,
      [
        r.shiftId, r.batteryId, r.package, r.percent, r.packMillivolts, r.cycleCount,
        r.remainCapacityDah, r.fullCapacityDah, r.mosTempDc, r.t1Dc, r.t2Dc, r.mediaId, r.source,
        r.ocrRaw === null || r.ocrRaw === undefined ? null : JSON.stringify(r.ocrRaw),
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
      ocrRaw: r.ocr_raw ?? null,
    }))
  }
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
