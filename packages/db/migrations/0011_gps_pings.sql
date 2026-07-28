-- ── 0011: live GPS pings (SRS K) ────────────────────────────────────────────────────────────
--
-- While a shift is open the driver's phone streams its location (foreground-only — a PWA cannot
-- track in the background). One row per ping, cascade-deleted with the shift. This is telemetry,
-- not money and not a gate input: the branch manager watches it on the live map, and later phases
-- cross-check the GPS distance against the photographed odometer (K-3).
--
-- lat/lng are `double precision` (WGS-84 degrees), accuracy in metres. `captured_at` is the phone's
-- own clock; `received_at` is stamped by the server (deps.clock), so a skewed phone can't rewrite
-- when the office actually saw the driver. Auto-granted to app_user by the default privileges in
-- 0001. Exempt from audit in scripts/check-sql.mjs — high-volume append-only telemetry.
CREATE TABLE gps_pings (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id    uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  driver_id   uuid NOT NULL REFERENCES drivers(id),
  branch_id   uuid NOT NULL REFERENCES branches(id),
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  accuracy_m  real,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL
);

CREATE INDEX gps_pings_shift_idx ON gps_pings (shift_id);
CREATE INDEX gps_pings_branch_recent_idx ON gps_pings (branch_id, received_at DESC);
