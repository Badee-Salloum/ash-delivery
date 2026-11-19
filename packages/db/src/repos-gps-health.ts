import type { GpsTrackerHealth, GpsTrackerHealthRepo, GpsTrackerReadiness, GpsReadinessTimingRejection, GpsPermissionEvent } from '@ash/contracts'
import { trackingPermissionStates } from '@ash/domain'
import { type Pool, withTransaction } from './pool.ts'

const instant = (ms: number | null): Date | null => ms === null ? null : new Date(ms)

const fromRow = (row: Record<string, unknown>): GpsTrackerHealth => ({
  readinessClient: row.readiness_client === 'browser' ? 'browser' : 'android',
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

  async recordBrowserClient(shiftId: string): Promise<void> {
    await withTransaction(this.pool,{actorId:null},async client => {
      await client.query("SET LOCAL lock_timeout = '300ms'")
      await client.query("SET LOCAL statement_timeout = '2s'")
      await client.query(`INSERT INTO gps_tracker_health(shift_id,readiness_client)
        VALUES ($1,'browser') ON CONFLICT (shift_id) DO UPDATE SET readiness_client='browser'`,[shiftId])
    })
  }

  async permissionEvents(shiftId: string): Promise<GpsPermissionEvent[]> {
    const { rows } = await this.pool.query<{
      id: string; permission: GpsPermissionEvent['permission']; opened_at: Date;
      observed_at: Date | null; recovered_at: Date | null; app_build: number | null;
    }>('SELECT id, permission, opened_at, observed_at, recovered_at, app_build FROM shift_permission_events WHERE shift_id = $1 ORDER BY id', [shiftId])
    return rows.map(row => ({ id: String(row.id), shiftId, permission: row.permission,
      openedAt: row.opened_at.toISOString(), observedAt: row.observed_at?.toISOString() ?? null,
      recoveredAt: row.recovered_at?.toISOString() ?? null, appBuild: row.app_build }))
  }

  async recordReadinessTimingRejection(input: GpsReadinessTimingRejection): Promise<void> {
    // Isolated diagnostic event: do not overwrite the last readiness or touch shift/ledger rows.
    await withTransaction(this.pool, { actorId: null }, async client => {
      await client.query("SET LOCAL lock_timeout = '100ms'")
      await client.query("SET LOCAL statement_timeout = '1s'")
      await client.query(
        `INSERT INTO gps_tracker_health_events (shift_id, recorded_at, kind, detail)
         VALUES ($1,$2,'readiness_timing_rejected',$3::jsonb)`,
        [input.shiftId, new Date(input.atMs), JSON.stringify({
          reason: input.reason, serverTimeMs: input.atMs, capturedAtMs: input.capturedAtMs,
          ageMs: input.ageMs, appBuild: input.appBuild, maxAgeMs: 30_000, maxFutureSkewMs: 5_000,
        })],
      )
    })
  }

  async recordReadiness(input: GpsTrackerReadiness): Promise<void> {
    await this.pool.query(
      `INSERT INTO gps_tracker_health
         (shift_id, readiness_at, readiness_captured_at, readiness_accuracy_m, app_build,
          readiness_precise, readiness_location_enabled, readiness_background_permission,
          readiness_notification_permission, readiness_battery_optimization_exempt,
          readiness_autostart_acknowledged, readiness_queue_available, readiness_client)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
         readiness_queue_available = EXCLUDED.readiness_queue_available,
         readiness_client = EXCLUDED.readiness_client`,
      [input.shiftId, new Date(input.atMs), new Date(input.capturedAtMs), input.accuracyM, input.appBuild,
        input.precise, input.locationEnabled, input.backgroundPermission,
        input.notificationPermission, input.batteryOptimizationExempt,
        input.autostartAcknowledged, input.queueAvailable, input.client ?? 'android'],
    )
  }

  async recordHeartbeat(input: GpsTrackerHealth): Promise<void> {
    await withTransaction(this.pool, { actorId: null }, async (client) => {
      await client.query("SET LOCAL lock_timeout = '300ms'")
      await client.query("SET LOCAL statement_timeout = '3s'")
      // One tracker lock covers first insert as well as updates, independently of financial locks.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 104))', [input.shiftId])
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
      const live = await client.query<{ branch_id: string; driver_id: string; driver_name: string }>(
        "SELECT s.branch_id, s.driver_id, d.full_name_ar AS driver_name FROM shifts s JOIN drivers d ON d.id = s.driver_id WHERE s.id = $1 AND s.state IN ('open','suspended','awaiting_open_approval','pending_review')", [input.shiftId],
      )
      if (live.rows[0]) {
        const now = instant(input.heartbeatAtMs)
        const states = trackingPermissionStates(input)
        for (const [permission, granted] of Object.entries(states)) {
          if (granted === null) continue
          const event = granted ? await client.query<{ id: string }>(
            'UPDATE shift_permission_events SET recovered_at = $3 WHERE shift_id = $1 AND permission = $2 AND recovered_at IS NULL RETURNING id',
            [input.shiftId, permission, now],
          ) : await client.query<{ id: string }>(
            `INSERT INTO shift_permission_events (shift_id, permission, opened_at, observed_at, app_build)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT (shift_id, permission) WHERE recovered_at IS NULL DO NOTHING RETURNING id`,
            [input.shiftId, permission, now, instant(input.observedAtMs ?? null), input.appBuild],
          )
          if (event.rows[0]) {
            const kind = granted ? 'tracking_permission_restored' : 'tracking_permission_revoked'
            // Incident and recipient notifications commit together, so a retry cannot lose an alert.
            await client.query(
              `INSERT INTO notifications (recipient_id, branch_id, kind, payload, dedupe_key, created_at)
               SELECT id, $1::uuid, $2, $3::jsonb, $4, $5 FROM users
               WHERE active AND (role_key IN ('general_manager','system_admin') OR (role_key = 'branch_manager' AND branch_id = $1::uuid))
               ON CONFLICT (recipient_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
              [live.rows[0].branch_id, kind, JSON.stringify({ shiftId: input.shiftId,
                driverId: live.rows[0].driver_id, driverName: live.rows[0].driver_name, permission, incidentId: String(event.rows[0].id),
                observedAtMs: input.observedAtMs ?? null, receivedAtMs: input.heartbeatAtMs }),
                `${kind}:${event.rows[0].id}`, now],
            )
          }
        }
      }
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
