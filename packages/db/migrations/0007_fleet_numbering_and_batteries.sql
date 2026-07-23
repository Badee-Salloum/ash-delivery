-- ── 0007: the fleet as it actually is ────────────────────────────────────────────────────
--
-- Three changes, all driven by the same discovery: the schema described a "vehicle" but not a
-- MACHINE. It could not say where a bike sits in the organisation, it could not say that a bike
-- carries two battery packs, and it had nowhere to put what the driver reads off the pack.
--
--  1. GEOGRAPHY AND NUMBERING. A vehicle is identified by
--         <governorate no>-<branch no>-<vehicle type no>-<machine no>
--     e.g. the first motorbike of the first branch in Damascus is «1-1-1-1». Governorate did not
--     exist at all; branches had a text code but no number; vehicle types had neither.
--
--  2. BATTERIES AS ASSETS. The packs are the expensive consumable and they move between bikes,
--     so they are rows, not columns. How many packs a bike carries is COUNT(*) of the packs
--     fitted to it — never a number somebody typed, which could disagree with reality.
--
--  3. PER-PACK BMS READINGS. `shifts.battery_start/end` were two smallints for a whole bike.
--     A two-pack bike could not record its second pack at all, and pack voltage, cycle count,
--     capacity and temperature had nowhere to go.
--
-- Migrations are checksum-locked (packages/db/src/migrate.ts), so 0003/0005 cannot be edited in
-- place; every change here is additive.

-- ── Governorates ─────────────────────────────────────────────────────────────────────────
-- Seeded with Syria's fourteen in the conventional official order. `no` is EDITABLE by the
-- system admin — the client's own numbering wins over ours, which is why this is data.
CREATE TABLE governorates (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no       smallint NOT NULL UNIQUE CHECK (no BETWEEN 1 AND 99),
  name_ar  text NOT NULL,
  name_en  text NOT NULL,
  active   boolean NOT NULL DEFAULT true
);

INSERT INTO governorates (no, name_ar, name_en) VALUES
  (1,  'دمشق',      'Damascus'),
  (2,  'ريف دمشق',  'Rif Dimashq'),
  (3,  'القنيطرة',  'Quneitra'),
  (4,  'درعا',      'Daraa'),
  (5,  'السويداء',  'As-Suwayda'),
  (6,  'حمص',       'Homs'),
  (7,  'طرطوس',     'Tartus'),
  (8,  'اللاذقية',  'Latakia'),
  (9,  'حماة',      'Hama'),
  (10, 'إدلب',      'Idlib'),
  (11, 'حلب',       'Aleppo'),
  (12, 'الرقة',     'Raqqa'),
  (13, 'دير الزور', 'Deir ez-Zor'),
  (14, 'الحسكة',    'Al-Hasakah');

-- ── Branches gain a governorate and a number ─────────────────────────────────────────────
ALTER TABLE branches
  ADD COLUMN governorate_id uuid REFERENCES governorates(id),
  ADD COLUMN branch_no      smallint CHECK (branch_no BETWEEN 1 AND 99);

-- Backfill before the NOT NULL: every existing branch is Damascus branch 1. There is exactly one
-- (code 'DAM'), created by seedReferenceData; ordering by created_at keeps this deterministic if
-- a second was added by hand before this migration ran.
UPDATE branches b
   SET governorate_id = (SELECT id FROM governorates WHERE no = 1),
       branch_no      = sub.rn
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, code) AS rn FROM branches) sub
 WHERE b.id = sub.id;

ALTER TABLE branches
  ALTER COLUMN governorate_id SET NOT NULL,
  ALTER COLUMN branch_no      SET NOT NULL,
  ADD CONSTRAINT branches_number_uq UNIQUE (governorate_id, branch_no);

-- ── Vehicle types gain the third segment ─────────────────────────────────────────────────
-- Editable, which is why vehicle_types moves from AUDIT_EXEMPT to audited in check-sql.mjs:
-- its exemption reason ("reference data") stops being true the moment a UI renumbers it, and a
-- renumber restates the printed code of every vehicle of that type.
ALTER TABLE vehicle_types
  ADD COLUMN type_no smallint CHECK (type_no BETWEEN 1 AND 99);

UPDATE vehicle_types t
   SET type_no = sub.rn
  FROM (SELECT id, row_number() OVER (ORDER BY code) AS rn FROM vehicle_types) sub
 WHERE t.id = sub.id;

-- A production database has NO vehicle type at all: seedReferenceData never created one and the
-- insert lives in the demo-only seed. vehicles.vehicle_type_id is NOT NULL, so until this row
-- exists no vehicle can be created — the console's "add vehicle" button could not work.
INSERT INTO vehicle_types (code, name_ar, name_en, type_no)
VALUES ('e_motorbike', 'دراجة كهربائية', 'Electric Motorbike', 1)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE vehicle_types
  ALTER COLUMN type_no SET NOT NULL,
  ADD CONSTRAINT vehicle_types_no_uq UNIQUE (type_no);

-- ── Vehicles gain the fourth segment ─────────────────────────────────────────────────────
-- `code` stays the written display number ("1-1-1-1"), fed by the pure formatVehicleNumber().
-- Deliberately not a generated column: it depends on branches and governorates, which a
-- generated expression cannot reach — the same reason business_date is written, not generated.
ALTER TABLE vehicles
  ADD COLUMN machine_no smallint CHECK (machine_no BETWEEN 1 AND 999);

-- Existing codes are 'VEH-001'…'VEH-010'. Take the trailing digits where they are there, and
-- fall back to a per-(branch,type) sequence so the UNIQUE below can never fail on old data.
UPDATE vehicles v
   SET machine_no = sub.n
  FROM (
    SELECT id,
           COALESCE(
             NULLIF(regexp_replace(code, '^\D*', '', 'g'), '')::int,
             row_number() OVER (PARTITION BY branch_id, vehicle_type_id ORDER BY created_at, code)::int
           ) AS n
      FROM vehicles
  ) sub
 WHERE v.id = sub.id;

ALTER TABLE vehicles
  ALTER COLUMN machine_no SET NOT NULL,
  ADD CONSTRAINT vehicles_machine_uq UNIQUE (branch_id, vehicle_type_id, machine_no);

-- Restate every existing code into the new scheme.
UPDATE vehicles v
   SET code = g.no || '-' || b.branch_no || '-' || t.type_no || '-' || v.machine_no
  FROM branches b, governorates g, vehicle_types t
 WHERE v.branch_id = b.id AND b.governorate_id = g.id AND v.vehicle_type_id = t.id;

-- ── Batteries (SRS §L seam) ──────────────────────────────────────────────────────────────
-- A pack is an asset, not an attribute. It is fitted to a slot on a bike, or it is a spare on the
-- shelf — the CHECK makes "half-fitted" unrepresentable rather than merely discouraged.
-- serial_no and bms_mac come straight off the BMS app, which is what lets a reading be tied to
-- the pack that was actually photographed.
CREATE TABLE batteries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  serial_no    text UNIQUE,
  bms_mac      text,
  capacity_ah  smallint NOT NULL CHECK (capacity_ah BETWEEN 1 AND 999),   -- today 30 or 50
  vehicle_id   uuid REFERENCES vehicles(id),
  slot_no      smallint CHECK (slot_no BETWEEN 1 AND 2),
  state        text NOT NULL DEFAULT 'ready'
                 CHECK (state IN ('ready', 'charging', 'maintenance', 'retired')),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batteries_fitted_ck CHECK ((vehicle_id IS NULL) = (slot_no IS NULL))
);
-- One pack per slot. Partial, so any number of spares may sit unfitted.
CREATE UNIQUE INDEX batteries_slot_uq ON batteries (vehicle_id, slot_no) WHERE vehicle_id IS NOT NULL;
CREATE INDEX batteries_branch_idx ON batteries (branch_id) WHERE active;

-- ── What the driver reads off each pack, at both ends of the shift ───────────────────────
-- Every physical quantity is a SCALED INTEGER, never a float — millivolts, deci-amp-hours,
-- deci-Celsius. Money's bigint rule exists because floats lose cents; the same reasoning applies
-- to a voltage that gates whether a bike is fit to ride.
--
-- `ocr_raw` holds what the OCR actually read, before the driver corrected anything. SRS D-3
-- requires every manual edit to be recorded WITH its difference from the OCR reading, as raw
-- material for the M-2 anomaly rule; storing the original is what makes that difference
-- computable at any time instead of only at the moment of typing.
CREATE TABLE shift_battery_readings (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id             uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  battery_id           uuid NOT NULL REFERENCES batteries(id),
  package              text NOT NULL CHECK (package IN ('start', 'end')),
  percent              smallint CHECK (percent BETWEEN 0 AND 100),
  pack_millivolts      integer  CHECK (pack_millivolts >= 0),
  cycle_count          integer  CHECK (cycle_count >= 0),
  remain_capacity_dah  integer  CHECK (remain_capacity_dah >= 0),   -- 50.0 Ah → 500
  full_capacity_dah    integer  CHECK (full_capacity_dah >= 0),
  mos_temp_dc          smallint,                                    -- 33.9 °C → 339
  t1_dc                smallint,
  t2_dc                smallint,
  media_id             uuid REFERENCES media(id),                   -- the screenshot it came from
  source               text NOT NULL DEFAULT 'manual' CHECK (source IN ('ocr', 'manual')),
  ocr_raw              jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, battery_id, package)
);
CREATE INDEX sbr_shift_idx   ON shift_battery_readings (shift_id);
-- Pack health over time: "how many cycles has serial DB24SA08… actually done".
CREATE INDEX sbr_battery_idx ON shift_battery_readings (battery_id, created_at);

-- ── Audit ────────────────────────────────────────────────────────────────────────────────
-- governorates and branches stay exempt as near-static reference data. The other three are not:
-- a renumbered vehicle type silently restates printed vehicle codes, a battery moving between
-- bikes is an asset transfer, and a corrected battery reading changes evidence a manager approved
-- against.
CREATE TRIGGER audit_vehicle_types           AFTER INSERT OR UPDATE OR DELETE ON vehicle_types           FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_batteries               AFTER INSERT OR UPDATE OR DELETE ON batteries               FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_shift_battery_readings  AFTER INSERT OR UPDATE OR DELETE ON shift_battery_readings  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
