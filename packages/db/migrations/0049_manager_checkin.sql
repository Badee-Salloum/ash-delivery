-- 0049 - «التفقّد»: a branch manager proving he was at the branch when he is expected there
--
-- The owner's rule (2026-08-29): several rounds a day — say 01:00, 05:00 and 10:00 — each within a
-- tolerance, and each from inside the branch's own patch of ground. DRIVERS ARE EXCLUDED by design:
-- they are out on the road all day and are already tracked by their shift and its GPS pings. This is
-- for the people who are supposed to BE somewhere.
--
-- Nothing here blocks anyone. A manager whose phone refuses location, or who is genuinely away,
-- still gets a recorded row saying exactly that, with the distance and the minutes. The report is
-- for a human to read — the same stance the operation-window hint takes on the driver's screen.

-- ── Where the branch actually is ────────────────────────────────────────────────────────────
-- `branches` carried no coordinates at all, so there was nothing to measure a check-in against.
-- Nullable on purpose: a branch with no fence configured simply has no check-in to fail, rather
-- than every round failing against a default of (0,0) in the Gulf of Guinea.
ALTER TABLE branches
  ADD COLUMN lat                double precision,
  ADD COLUMN lng                double precision,
  ADD COLUMN checkin_radius_m   integer NOT NULL DEFAULT 150
    CHECK (checkin_radius_m BETWEEN 10 AND 20000),
  ADD CONSTRAINT branches_geo_ck CHECK (
    (lat IS NULL AND lng IS NULL)
    OR (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)
  );

-- ── The rounds a user is expected to answer ─────────────────────────────────────────────────
CREATE TABLE checkin_windows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  -- Per USER, not per role: the owner asked for this on the branch-manager account, and naming the
  -- account keeps a second manager, or a stand-in during leave, from silently inheriting the rota.
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Minutes past branch-local midnight. 60 = 01:00, 600 = 10:00.
  at_minute         integer NOT NULL CHECK (at_minute BETWEEN 0 AND 1439),
  -- Symmetric: "be there at one" means around one, not "any time after one".
  tolerance_minutes integer NOT NULL DEFAULT 30 CHECK (tolerance_minutes BETWEEN 1 AND 720),
  active            boolean NOT NULL DEFAULT true,
  label             text CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 60),
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- One live round per user per time of day. A duplicate would make the roll-call show the same
-- 01:00 twice and let one check-in answer only one of them.
CREATE UNIQUE INDEX checkin_windows_user_minute_uq
  ON checkin_windows (user_id, at_minute) WHERE active;

CREATE INDEX checkin_windows_branch_idx ON checkin_windows (branch_id) WHERE active;

-- ── What actually happened ──────────────────────────────────────────────────────────────────
CREATE TABLE checkins (
  id                uuid PRIMARY KEY,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  business_date     date NOT NULL,
  captured_at       timestamptz NOT NULL,
  lat               double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng               double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  -- What the phone said about its own confidence. Kept as evidence, never as a gate: refusing a
  -- low-accuracy fix would punish a manager for standing under a roof.
  accuracy_m        real,
  -- The window this answers, decided by the pure `windowFor`. NULL means no round was open.
  window_id         uuid REFERENCES checkin_windows(id) ON DELETE SET NULL,
  distance_m        integer NOT NULL CHECK (distance_m >= 0),
  inside_area       boolean NOT NULL,
  minutes_from_target integer,
  verdict           text NOT NULL
    CHECK (verdict IN ('on_time', 'outside_window', 'outside_area', 'outside_both')),
  note              text CHECK (note IS NULL OR char_length(note) <= 500),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX checkins_branch_date_idx ON checkins (branch_id, business_date, captured_at);
CREATE INDEX checkins_user_date_idx   ON checkins (user_id, business_date);

-- A check-in is a recorded observation about where somebody was. Correct the RECORD by adding
-- another one; never edit a person's whereabouts after the fact.
REVOKE UPDATE, DELETE, TRUNCATE ON checkins FROM app_user;
GRANT  SELECT, INSERT ON checkins TO app_user;

CREATE TRIGGER audit_checkins
  AFTER INSERT OR UPDATE OR DELETE ON checkins
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

COMMENT ON TABLE checkins IS
  'Manager attendance rounds («التفقّد»). Append-only: a check-in states where somebody was at a '
  'moment, so it is never edited — a later check-in can redeem an earlier one, and the roll-call '
  'takes the best answer per window. Drivers are excluded by design; their whereabouts ride on '
  'their shift and gps_pings.';
