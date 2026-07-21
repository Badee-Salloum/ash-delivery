-- 0003 — drivers, vehicles, documents, life log, attendance
-- SRS §B. ⚠ NOT YET EXECUTED — see 0001.

CREATE TABLE vehicle_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,        -- 'e_motorbike'
  name_ar       text NOT NULL,
  name_en       text NOT NULL,
  -- SRS F-4 allows a different tier table per vehicle type; the current fleet is one type.
  active        boolean NOT NULL DEFAULT true
);

-- ── Drivers (B-1) ────────────────────────────────────────────────────────────────────────
-- The relationship is «نسبة فقط» — share only. No salaries, no advances, no penalties
-- (س35, س38–س40). Recorded in ASSUMPTIONS A-16 so nobody "helpfully" adds them later.
CREATE TABLE drivers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  user_id        uuid UNIQUE REFERENCES users(id),   -- the login this driver uses
  code           text NOT NULL UNIQUE,
  full_name_ar   text NOT NULL,
  full_name_en   text,
  phone          text,
  national_id_enc bytea,                              -- AES-256-GCM, app-side
  hired_on       date,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drivers_branch_idx ON drivers (branch_id) WHERE active;

-- ── Vehicles (B-2) ───────────────────────────────────────────────────────────────────────
CREATE TABLE vehicles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  vehicle_type_id  uuid NOT NULL REFERENCES vehicle_types(id),
  code             text NOT NULL UNIQUE,
  plate_no         text,
  -- «جاهزة/تشحن/صيانة/متوقفة»
  state            text NOT NULL DEFAULT 'ready'
                     CHECK (state IN ('ready', 'charging', 'maintenance', 'stopped')),
  owned            boolean NOT NULL DEFAULT true,     -- fleet is company-owned (س61)
  odometer_km      integer NOT NULL DEFAULT 0,        -- double precision would be wrong here too:
                                                      -- odometers are whole kilometres, and money
                                                      -- rules aside, integers say what we mean.
  acquired_on      date,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicles_branch_idx ON vehicles (branch_id) WHERE active;
CREATE INDEX vehicles_state_idx  ON vehicles (branch_id, state) WHERE active;

-- ── Documents with expiry alerting (B-1, B-2, س37) ───────────────────────────────────────
-- Polymorphic owner, guarded so exactly one FK is populated.
CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  owner_kind    text NOT NULL CHECK (owner_kind IN ('driver', 'vehicle')),
  driver_id     uuid REFERENCES drivers(id) ON DELETE CASCADE,
  vehicle_id    uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  kind          text NOT NULL,        -- driving_licence | national_id | criminal_record | registration | insurance
  document_no_enc bytea,
  issued_on     date,
  expires_on    date,
  media_id      uuid,                 -- FK added in 0005 once media exists
  superseded_by uuid REFERENCES documents(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_owner_ck CHECK (
    (owner_kind = 'driver'  AND driver_id IS NOT NULL AND vehicle_id IS NULL) OR
    (owner_kind = 'vehicle' AND vehicle_id IS NOT NULL AND driver_id IS NULL)
  )
);
-- The expiry sweep runs off this every morning: T-30 / T-14 / T-7 / T-0.
CREATE INDEX documents_expiry_idx ON documents (expires_on)
  WHERE expires_on IS NOT NULL AND superseded_by IS NULL;

-- ── Vehicle life log (B-2 / س66) ─────────────────────────────────────────────────────────
-- «سجل حياة يجمع كل الأحداث والكلف» — every event and cost against a vehicle, in one place.
CREATE TABLE vehicle_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL REFERENCES branches(id),
  kind          text NOT NULL,        -- state_change | maintenance | incident | charge | odometer_reading
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  business_date date NOT NULL,
  odometer_km   integer,
  cost_minor    bigint CHECK (cost_minor IS NULL OR cost_minor >= 0),
  expense_id    uuid,                 -- FK added in 0004 once expenses exists
  shift_id      uuid,                 -- FK added in 0005
  notes         text,
  created_by    uuid REFERENCES users(id)
);
CREATE INDEX vehicle_events_vehicle_idx ON vehicle_events (vehicle_id, occurred_at DESC);

-- ── Driver ↔ vehicle ↔ shift assignment (B-3 / س34, س23) ────────────────────────────────
-- A shift binds exactly one driver to exactly one vehicle. A vehicle may be shared BETWEEN
-- drivers across shifts; the "one live shift per vehicle" guard lives on `shifts` in 0005.
CREATE TABLE assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  driver_id      uuid NOT NULL REFERENCES drivers(id),
  vehicle_id     uuid NOT NULL REFERENCES vehicles(id),
  business_date  date NOT NULL,
  shift_no       smallint NOT NULL CHECK (shift_no >= 1),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, business_date, shift_no),
  UNIQUE (vehicle_id, business_date, shift_no)
);

-- ── Admin staff attendance (B-4 / س41) ───────────────────────────────────────────────────
-- «نفس تسجيل الدخول اليومي للموظفين الإداريين» — the same daily login doubles as attendance.
CREATE TABLE attendance_days (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id      uuid NOT NULL REFERENCES branches(id),
  business_date  date NOT NULL,
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  UNIQUE (user_id, business_date)
);
CREATE INDEX attendance_month_idx ON attendance_days (branch_id, business_date);
