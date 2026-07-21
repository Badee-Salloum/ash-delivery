import type {
  AttachedSlot,
  BranchRecord,
  EvidencePackage,
  MediaRecord,
  MediaRepo,
  DirectoryRepo,
  DocumentRecord,
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
        'INSERT INTO drivers (id, branch_id, code, full_name_ar, active) VALUES ($1,$2,$3,$4,$5)',
        [driver.id, driver.branchId, driver.code, driver.fullNameAr, driver.active],
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
