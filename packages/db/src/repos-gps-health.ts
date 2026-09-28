import type { GpsTrackerHealth, GpsTrackerHealthRepo, GpsTrackerReadiness } from '@ash/contracts'
import { type Pool, withTransaction } from './pool.ts'

const instant = (ms: number | null): Date | null => ms === null ? null : new Date(ms)

const fromRow = (row: Record<string, unknown>): GpsTrackerHealth => ({
  shiftId: String(row.shift_id),
  readinessAtMs: row.readiness_at == null ? null : (row.readiness_at as Date).getTime(),
  readinessCapturedAtMs: row.readiness_captured_at == null ? null : (row.readiness_captured_at as Date).getTime(),
  readinessAccuracyM: row.readiness_accuracy_m == null ? null : Number(row.readiness_accuracy_m),
  readinessPrecise: (row.readiness_precise as boolean | null) ?? null,
  readinessLocationEnabled: (row.readiness_location_enabled as boolean | null) ?? null,
  readinessBackgroundPermission: (row.readiness_background_permission as boolean | null) ?? null,
  readinessNotificationPermission: (row.readiness_notification_permission as boolean | null) ?? null,
  readinessBatteryOptimizationExempt: (row.readiness_battery_optimization_exempt as boolean | null) ?? null,
  readinessAutostartAcknowledged: (row.readiness_autostart_acknowledged as boolean | null) ?? null,
  readinessQueueAvailable: (row.readiness_queue_available as boolean | null) ?? null,
  appBuild: row.app_build == null ? null : Number(row.app_build),
  heartbeatAtMs: row.heartbeat_at == null ? null : (row.heartbeat_at as Date).getTime(),
  service: (row.service as GpsTrackerHealth['service']) ?? null,
  permission: (row.permission as GpsTrackerHealth['permission']) ?? null,
  locationEnabled: (row.location_enabled as boolean | null) ?? null,
  backgroundPermission: (row.background_permission as boolean | null) ?? null,
  notificationPermission: (row.notification_permission as boolean | null) ?? null,
  batteryOptimizationExempt: (row.battery_optimization_exempt as boolean | null) ?? null,
  autostartAcknowledged: (row.autostart_acknowledged as boolean | null) ?? null,
  network: (row.network as GpsTrackerHealth['network']) ?? null,
  pendingCount: row.pending_count == null ? null : Number(row.pending_count),
  lastCapturedAtMs: row.last_captured_at == null ? null : (row.last_captured_at as Date).getTime(),
  lastUploadedAtMs: row.last_uploaded_at == null ? null : (row.last_uploaded_at as Date).getTime(),
  droppedExpired: Number(row.dropped_expired ?? 0),
  droppedCapacity: Number(row.dropped_capacity ?? 0),
  droppedStorage: Number(row.dropped_storage ?? 0),
  rejectionReasons: (row.rejection_reasons as Record<string, number> | null) ?? {},
})

export class PgGpsTrackerHealthRepo implements GpsTrackerHealthRepo {
  private readonly pool: Pool
  constructor(pool: Pool) { this.pool = pool }

  async recordReadiness(input: GpsTrackerReadiness): Promise<void> {
    await this.pool.query(
      `INSERT INTO gps_tracker_health
         (shift_id, readiness_at, readiness_captured_at, readiness_accuracy_m, app_build,
          readiness_precise, readiness_location_enabled, readiness_background_permission,
          readiness_notification_permission, readiness_battery_optimization_exempt,
          readiness_autostart_acknowledged, readiness_queue_available)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (shift_id) DO UPDATE SET
         readiness_at = EXCLUDED.readiness_at,
         readiness_captured_at = EXCLUDED.readiness_captured_at,
         readiness_accuracy_m = EXCLUDED.readiness_accuracy_m,
         app_build = EXCLUDED.app_build,
         readiness_precise = EXCLUDED.readiness_precise,
         readiness_location_enabled = EXCLUDED.readiness_location_enabled,
         readiness_background_permission = EXCLUDED.readiness_background_permission,
         readiness_notification_permission = EXCLUDED.readiness_notification_permission,
         readiness_battery_optimization_exempt = EXCLUDED.readiness_battery_optimization_exempt,
         readiness_autostart_acknowledged = EXCLUDED.readiness_autostart_acknowledged,
         readiness_queue_available = EXCLUDED.readiness_queue_available`,
      [input.shiftId, new Date(input.atMs), new Date(input.capturedAtMs), input.accuracyM, input.appBuild,
        input.precise, input.locationEnabled, input.backgroundPermission,
        input.notificationPermission, input.batteryOptimizationExempt,
        input.autostartAcknowledged, input.queueAvailable],
    )
  }

  async recordHeartbeat(input: GpsTrackerHealth): Promise<void> {
    await withTransaction(this.pool, { actorId: null }, async (client) => {
      const previous = await client.query<Record<string, unknown>>(
        'SELECT * FROM gps_tracker_health WHERE shift_id = $1 FOR UPDATE', [input.shiftId],
      )
      await client.query(
        `INSERT INTO gps_tracker_health
           (shift_id, app_build, heartbeat_at, service, permission, location_enabled,
            network, pending_count, last_captured_at, last_uploaded_at,
            dropped_expired, dropped_capacity, dropped_storage, rejection_reasons,
            background_permission, notification_permission, battery_optimization_exempt,
            autostart_acknowledged)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18)
         ON CONFLICT (shift_id) DO UPDATE SET
           app_build = COALESCE(EXCLUDED.app_build, gps_tracker_health.app_build),
           heartbeat_at = EXCLUDED.heartbeat_at,
           service = EXCLUDED.service,
           permission = EXCLUDED.permission,
           location_enabled = EXCLUDED.location_enabled,
           background_permission = EXCLUDED.background_permission,
           notification_permission = EXCLUDED.notification_permission,
           battery_optimization_exempt = EXCLUDED.battery_optimization_exempt,
           autostart_acknowledged = EXCLUDED.autostart_acknowledged,
           network = EXCLUDED.network,
           pending_count = EXCLUDED.pending_count,
           last_captured_at = EXCLUDED.last_captured_at,
           last_uploaded_at = EXCLUDED.last_uploaded_at,
           dropped_expired = GREATEST(gps_tracker_health.dropped_expired, EXCLUDED.dropped_expired),
           dropped_capacity = GREATEST(gps_tracker_health.dropped_capacity, EXCLUDED.dropped_capacity),
           dropped_storage = GREATEST(gps_tracker_health.dropped_storage, EXCLUDED.dropped_storage),
           rejection_reasons = EXCLUDED.rejection_reasons`,
        [input.shiftId, input.appBuild, instant(input.heartbeatAtMs), input.service, input.permission,
          input.locationEnabled, input.network, input.pendingCount, instant(input.lastCapturedAtMs),
          instant(input.lastUploadedAtMs), input.droppedExpired, input.droppedCapacity,
          input.droppedStorage,
          JSON.stringify(input.rejectionReasons), input.backgroundPermission,
          input.notificationPermission, input.batteryOptimizationExempt,
          input.autostartAcknowledged],
      )
      const old = previous.rows[0] ? fromRow(previous.rows[0]) : null
      const droppedExpired = Math.max(old?.droppedExpired ?? 0, input.droppedExpired)
      const droppedCapacity = Math.max(old?.droppedCapacity ?? 0, input.droppedCapacity)
      const droppedStorage = Math.max(old?.droppedStorage ?? 0, input.droppedStorage)
      const changed = old === null || old.service !== input.service || old.permission !== input.permission ||
        old.locationEnabled !== input.locationEnabled || old.network !== input.network ||
        old.backgroundPermission !== input.backgroundPermission ||
        old.notificationPermission !== input.notificationPermission ||
        old.batteryOptimizationExempt !== input.batteryOptimizationExempt ||
        old.autostartAcknowledged !== input.autostartAcknowledged ||
        old.droppedExpired !== droppedExpired || old.droppedCapacity !== droppedCapacity ||
        old.droppedStorage !== droppedStorage ||
        JSON.stringify(old.rejectionReasons) !== JSON.stringify(input.rejectionReasons)
      if (changed) {
        await client.query(
          `INSERT INTO gps_tracker_health_events (shift_id, recorded_at, kind, detail)
           VALUES ($1,$2,'status_changed',$3::jsonb)`,
          [input.shiftId, instant(input.heartbeatAtMs), JSON.stringify({
            service: input.service, permission: input.permission, locationEnabled: input.locationEnabled,
            backgroundPermission: input.backgroundPermission,
            notificationPermission: input.notificationPermission,
            batteryOptimizationExempt: input.batteryOptimizationExempt,
            autostartAcknowledged: input.autostartAcknowledged,
            network: input.network, droppedExpired,
            droppedCapacity, droppedStorage,
            rejectionReasons: input.rejectionReasons,
          })],
        )
      }
      await client.query(`DELETE FROM gps_tracker_health_events WHERE recorded_at < now() - interval '30 days'`)
    })
  }

  async findByShift(shiftId: string): Promise<GpsTrackerHealth | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM gps_tracker_health WHERE shift_id = $1', [shiftId],
    )
    return rows[0] ? fromRow(rows[0]) : null
  }

  async listByShiftIds(shiftIds: readonly string[]): Promise<GpsTrackerHealth[]> {
    if (shiftIds.length === 0) return []
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM gps_tracker_health WHERE shift_id = ANY($1::uuid[])', [[...new Set(shiftIds)]],
    )
    return rows.map(fromRow)
  }
}
