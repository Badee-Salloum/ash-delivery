import type { TrackerDeviceRecord, TrackerDeviceRepo } from '@ash/contracts'
import { type Pool, withTransaction } from './pool.ts'

/** The hardware tracker registry (SRS K-1 infrastructure). Registration is audited; last-seen is not. */
export class PgTrackerDeviceRepo implements TrackerDeviceRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async register(device: TrackerDeviceRecord): Promise<void> {
    await withTransaction(this.pool, { actorId: device.createdBy }, async (client) => {
      await client.query(
        `INSERT INTO tracker_devices
           (id, branch_id, imei, vehicle_id, secret_hash, label, active, last_seen_at, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          device.id,
          device.branchId,
          device.imei,
          device.vehicleId,
          device.secretHash,
          device.label,
          device.active,
          device.lastSeenAtMs === null ? null : new Date(device.lastSeenAtMs),
          device.createdBy,
          new Date(device.createdAtMs),
          new Date(device.updatedAtMs),
        ],
      )
    })
  }

  async findByImei(imei: string): Promise<TrackerDeviceRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM tracker_devices WHERE imei = $1', [imei])
    return rows[0] ? toDevice(rows[0]) : null
  }

  async findActiveByImei(imei: string): Promise<TrackerDeviceRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM tracker_devices WHERE imei = $1 AND active',
      [imei],
    )
    return rows[0] ? toDevice(rows[0]) : null
  }

  async bindToVehicle(id: string, vehicleId: string | null, actorId: string): Promise<void> {
    await withTransaction(this.pool, { actorId }, async (client) => {
      await client.query('UPDATE tracker_devices SET vehicle_id = $2, updated_at = now() WHERE id = $1', [id, vehicleId])
    })
  }

  async deactivate(id: string, actorId: string): Promise<void> {
    await withTransaction(this.pool, { actorId }, async (client) => {
      await client.query('UPDATE tracker_devices SET active = false, updated_at = now() WHERE id = $1', [id])
    })
  }

  async touchLastSeen(id: string, atMs: number): Promise<void> {
    // Deliberately no actor and no transaction: this touches only last_seen_at, which the audit
    // trigger's column list excludes, so it is liveness, not an authority decision.
    await this.pool.query('UPDATE tracker_devices SET last_seen_at = $2, updated_at = now() WHERE id = $1', [
      id,
      new Date(atMs),
    ])
  }

  async listByBranch(branchId: string): Promise<TrackerDeviceRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM tracker_devices WHERE branch_id = $1 ORDER BY created_at DESC, id',
      [branchId],
    )
    return rows.map(toDevice)
  }
}

const toDevice = (r: Record<string, unknown>): TrackerDeviceRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  imei: String(r.imei),
  vehicleId: r.vehicle_id === null ? null : String(r.vehicle_id),
  secretHash: String(r.secret_hash),
  label: String(r.label),
  active: Boolean(r.active),
  lastSeenAtMs: r.last_seen_at === null ? null : (r.last_seen_at as Date).getTime(),
  createdBy: String(r.created_by),
  createdAtMs: (r.created_at as Date).getTime(),
  updatedAtMs: (r.updated_at as Date).getTime(),
})
