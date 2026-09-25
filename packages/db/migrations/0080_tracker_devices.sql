-- 0080 — hardware GPS tracker registry (finance/fleet redesign — hardware infrastructure)
--
-- Infrastructure only. No hardware exists yet; this is the seam a future bike-mounted GPS unit
-- plugs into. A device measures a BIKE (a phone measures a driver), so it is fitted to a vehicle at
-- a branch and identified by its IMEI. The ingest route (a later migration/route, shipped disabled)
-- authenticates a device by a hashed secret and resolves its vehicle's currently-live shift, then
-- writes fixes into `gps_pings` with source='tracker' — the column 0063 already provided. Nothing
-- here moves money or writes a ping; it only records which device is fitted to which bike.
--
-- Registration, binding and deactivation are authority decisions (a device gains the right to write
-- a bike's telemetry), so they are audited. `last_seen_at` is high-frequency liveness like the pings
-- themselves, so an update that only touches it is deliberately kept out of the audit trigger.

CREATE TABLE tracker_devices (
  id            uuid PRIMARY KEY,
  branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  -- A GT06-style unit identifies by IMEI. Digits only; a real unit is 15, but vendors vary.
  imei          text NOT NULL UNIQUE CHECK (imei ~ '^[0-9]{10,20}$'),
  -- The bike it is fitted to. Nullable so a device can be registered before it is mounted.
  vehicle_id    uuid REFERENCES vehicles(id) ON DELETE RESTRICT,
  -- Only the hash is stored, like a session secret. The gateway proves the device; this verifies it.
  secret_hash   text NOT NULL CHECK (char_length(secret_hash) BETWEEN 20 AND 200),
  label         text NOT NULL CHECK (ash_has_visible_text(label) AND char_length(label) <= 120),
  active        boolean NOT NULL DEFAULT true,
  last_seen_at  timestamptz,
  created_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One ACTIVE device per bike. A deactivated device keeps its vehicle for history, so a replacement
-- unit can take the same bike without colliding with the retired row.
CREATE UNIQUE INDEX tracker_devices_active_vehicle_uidx
  ON tracker_devices (vehicle_id) WHERE active AND vehicle_id IS NOT NULL;
CREATE INDEX tracker_devices_branch_idx ON tracker_devices (branch_id);

-- A device belongs to an ordinary branch, never the company HQ row (0066).
CREATE TRIGGER tracker_devices_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON tracker_devices
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');

-- Audit registration/binding/deactivation, but NOT a bare last-seen touch (liveness, not authority).
CREATE TRIGGER audit_tracker_devices
  AFTER INSERT OR DELETE OR UPDATE OF imei, vehicle_id, active, label, secret_hash, branch_id
  ON tracker_devices
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- A device is never deleted (its telemetry authority is history); it is deactivated. Updates are
-- allowed for bind / deactivate / last-seen.
REVOKE DELETE, TRUNCATE ON tracker_devices FROM app_user;
GRANT SELECT, INSERT, UPDATE ON tracker_devices TO app_user;
