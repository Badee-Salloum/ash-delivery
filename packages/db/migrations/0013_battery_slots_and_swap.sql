-- ── 0013: two-or-more battery packs per bike, and the mid-shift swap ──────────────────────
--
-- Three changes, all beyond the SRS's single «نسبة البطارية» (section L is deferred), built as the
-- clean seam the fleet actually needs. The owner asked for it while walking the live test.
--
--  1. PER-TYPE PACK CEILING. A bike could carry "1 or 2" packs by a hardcoded CHECK. The fleet
--     carries more, and machine types differ, so the maximum becomes a configurable column on
--     vehicle_types. The per-bike COUNT stays DERIVED (COUNT of the packs fitted to it) — this is
--     only the ceiling. The slot_no CHECK loosens to a generous hard backstop; the real per-type
--     limit is enforced app-side (fleet.routes.ts), where a CHECK cannot reach another table.
--
--  2. SWAP-PHASE READINGS. `shift_battery_readings.package` was ('start','end'). A pack swapped
--     mid-shift needs a final reading as it comes off and a first reading as its replacement goes
--     on, so 'swap_out'/'swap_in' join the set. Each swap reading ties to its swap event.
--
--  3. THE SWAP EVENT LOG. `battery_swaps` records each mid-shift swap (which slot, which pack off,
--     which pack on), mirroring `float_tranches`: one row per (shift, seq_no). The fitment change
--     itself lives on `batteries` and is audited by the existing audit_batteries trigger.

-- ── 1. Per-type pack ceiling ──────────────────────────────────────────────────────────────
ALTER TABLE vehicle_types
  ADD COLUMN battery_slots smallint NOT NULL DEFAULT 2 CHECK (battery_slots BETWEEN 1 AND 8);

-- The current fleet's e_motorbike carries up to three packs (owner, 2026-07). Config, not code.
UPDATE vehicle_types SET battery_slots = 3 WHERE code = 'e_motorbike';

-- Loosen the hard slot cap from 1..2 to a generous backstop; the per-type limit is enforced in
-- the app (fleet.routes.ts assertSlotWithinType), which can see the vehicle's type.
ALTER TABLE batteries
  DROP CONSTRAINT batteries_slot_no_check,
  ADD CONSTRAINT batteries_slot_no_check CHECK (slot_no BETWEEN 1 AND 8);

-- ── 2. Swap-phase readings ────────────────────────────────────────────────────────────────
ALTER TABLE shift_battery_readings
  DROP CONSTRAINT shift_battery_readings_package_check,
  ADD CONSTRAINT shift_battery_readings_package_check
    CHECK (package IN ('start', 'end', 'swap_out', 'swap_in'));

-- ── 3. The swap event log ─────────────────────────────────────────────────────────────────
-- One row per swap, discriminated per shift by seq_no (like float_tranches). The pack that came
-- off and the pack that went on are both recorded, so the bike's fitment change is fully traced.
CREATE TABLE battery_swaps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id       uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  seq_no         smallint NOT NULL CHECK (seq_no >= 1),
  slot_no        smallint NOT NULL CHECK (slot_no BETWEEN 1 AND 8),
  out_battery_id uuid NOT NULL REFERENCES batteries(id),
  in_battery_id  uuid NOT NULL REFERENCES batteries(id),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT battery_swaps_distinct_ck CHECK (out_battery_id <> in_battery_id),
  UNIQUE (shift_id, seq_no)
);
CREATE INDEX battery_swaps_shift_idx ON battery_swaps (shift_id, seq_no);

-- Tie each swap reading to its event; NULL for the ordinary start/end readings.
ALTER TABLE shift_battery_readings
  ADD COLUMN battery_swap_id uuid REFERENCES battery_swaps(id);
