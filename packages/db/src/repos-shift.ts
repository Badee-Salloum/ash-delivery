import type {
  AssignmentRecord,
  AssignmentRepo,
  AttachedSlot,
  BranchRecord,
  EvidencePackage,
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
  ShiftRecord,
  ShiftRepo,
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
    return rows.map((r) => ({ id: String(r.id), code: String(r.code), nameAr: String(r.name_ar), nameEn: String(r.name_en) }))
  }

  async branch(id: string): Promise<BranchRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM branches WHERE id = $1', [id])
    const r = rows[0]
    return r
      ? { id: String(r.id), code: String(r.code), nameAr: String(r.name_ar), nameEn: String(r.name_en) }
      : null
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
    return r
      ? {
          id: String(r.id),
          branchId: String(r.branch_id),
          vehicleTypeId: String(r.vehicle_type_id),
          code: String(r.code),
          state: r.state as VehicleRecord['state'],
          active: Boolean(r.active),
        }
      : null
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
        'INSERT INTO drivers (id, branch_id, user_id, code, full_name_ar, active) VALUES ($1,$2,$3,$4,$5,$6)',
        [driver.id, driver.branchId, driver.userId ?? null, driver.code, driver.fullNameAr, driver.active],
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
    await this.pool.query('UPDATE drivers SET full_name_ar = $2, active = $3 WHERE id = $1', [
      driver.id,
      driver.fullNameAr,
      driver.active,
    ])
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
        'INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, state, active) VALUES ($1,$2,$3,$4,$5,$6)',
        [vehicle.id, vehicle.branchId, vehicle.vehicleTypeId, vehicle.code, vehicle.state, vehicle.active],
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
})

const toVehicle = (r: Record<string, unknown>): VehicleRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  vehicleTypeId: String(r.vehicle_type_id),
  code: String(r.code),
  state: r.state as VehicleRecord['state'],
  active: Boolean(r.active),
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
    await this.pool.query(
      `INSERT INTO settings (key, value, value_type, updated_by, updated_at)
       VALUES ($1, $2::jsonb, 'json', $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), actorId],
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
