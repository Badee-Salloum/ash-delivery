-- Stable point identities make a retry safe even after shift approval. Preserve
-- received_at separately from the handset's captured_at.
ALTER TABLE gps_pings ADD COLUMN client_point_id uuid;

-- Legacy PWA/tracker clients still deduplicate by capture time. Identified Android
-- fixes may legitimately share a millisecond and deduplicate by their own UUID.
DROP INDEX gps_pings_shift_captured_uidx;
CREATE UNIQUE INDEX gps_pings_legacy_capture_uidx
  ON gps_pings (shift_id, captured_at) WHERE client_point_id IS NULL;
CREATE UNIQUE INDEX gps_pings_client_point_uidx
  ON gps_pings (shift_id, client_point_id) WHERE client_point_id IS NOT NULL;
CREATE INDEX gps_pings_shift_capture_idx ON gps_pings (shift_id, captured_at, id);

-- Capture may continue while the close awaits manager approval. Record the real
-- end of tracking, including cancellation and rejection of an opening package.
ALTER TABLE shifts ADD COLUMN tracking_ended_at timestamptz;
CREATE FUNCTION set_shift_tracking_end() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'draft' AND NEW.state = 'awaiting_open_approval' THEN
    -- A rejected opening may be confirmed again. Its previous tracking window
    -- is closed, but the new attempt must have its own later end boundary.
    NEW.tracking_ended_at := NULL;
  ELSIF OLD.state IN ('awaiting_open_approval', 'open', 'suspended', 'pending_review')
     AND NEW.state IN ('draft', 'approved', 'cancelled')
     THEN
    NEW.tracking_ended_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shifts_tracking_end_before_update
  BEFORE UPDATE OF state ON shifts
  FOR EACH ROW EXECUTE FUNCTION set_shift_tracking_end();

-- Historic approved rows have an approval instant only in newer deployments.
-- Keep unknown bounds null rather than inventing a false close time.
UPDATE shifts SET tracking_ended_at = approved_at
  WHERE state = 'approved' AND approved_at IS NOT NULL;

-- Rejected opening packages can be confirmed again on the same shift. Keep each
-- server-observed capture interval so a late upload from the first attempt is
-- accepted without admitting locations from the time the shift was draft.
CREATE TABLE gps_tracking_windows (
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY (shift_id, started_at)
);
INSERT INTO gps_tracking_windows (shift_id, started_at, ended_at)
  SELECT id, driver_confirmed_at,
         CASE WHEN state IN ('awaiting_open_approval', 'open', 'suspended', 'pending_review')
              THEN NULL ELSE tracking_ended_at END
    FROM shifts
   WHERE driver_confirmed_at IS NOT NULL
     AND (state IN ('awaiting_open_approval', 'open', 'suspended', 'pending_review')
          OR tracking_ended_at IS NOT NULL);

CREATE FUNCTION maintain_gps_tracking_windows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'draft' AND NEW.state = 'awaiting_open_approval'
     AND NEW.driver_confirmed_at IS NOT NULL THEN
    INSERT INTO gps_tracking_windows (shift_id, started_at, ended_at)
      VALUES (NEW.id, NEW.driver_confirmed_at, NULL)
      ON CONFLICT (shift_id, started_at) DO UPDATE SET ended_at = NULL;
  ELSIF OLD.state IN ('awaiting_open_approval', 'open', 'suspended', 'pending_review')
     AND NEW.state IN ('draft', 'approved', 'cancelled') THEN
    UPDATE gps_tracking_windows SET ended_at = COALESCE(NEW.tracking_ended_at, clock_timestamp())
      WHERE shift_id = NEW.id AND ended_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shifts_gps_windows_after_update
  AFTER UPDATE OF state ON shifts
  FOR EACH ROW EXECUTE FUNCTION maintain_gps_tracking_windows();

-- Readiness and tracker health contain only timings and diagnostic categories.
-- Coordinates remain exclusively in gps_pings.
CREATE TABLE gps_tracker_health (
  shift_id uuid PRIMARY KEY REFERENCES shifts(id) ON DELETE CASCADE,
  readiness_at timestamptz,
  readiness_captured_at timestamptz,
  readiness_accuracy_m real,
  readiness_precise boolean,
  readiness_location_enabled boolean,
  readiness_background_permission boolean,
  readiness_notification_permission boolean,
  readiness_battery_optimization_exempt boolean,
  readiness_autostart_acknowledged boolean,
  readiness_queue_available boolean,
  app_build integer,
  heartbeat_at timestamptz,
  service text,
  permission text,
  location_enabled boolean,
  background_permission boolean,
  notification_permission boolean,
  battery_optimization_exempt boolean,
  autostart_acknowledged boolean,
  network text,
  pending_count integer,
  last_captured_at timestamptz,
  last_uploaded_at timestamptz,
  dropped_expired integer NOT NULL DEFAULT 0,
  dropped_capacity integer NOT NULL DEFAULT 0,
  dropped_storage integer NOT NULL DEFAULT 0,
  rejection_reasons jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE gps_tracker_health_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX gps_tracker_health_events_shift_recent_idx
  ON gps_tracker_health_events (shift_id, recorded_at DESC);
CREATE INDEX gps_tracker_health_events_retention_idx
  ON gps_tracker_health_events (recorded_at);
