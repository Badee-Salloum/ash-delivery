-- A fixed one-pack motorbike may show its charge on the odometer display. Existing types keep
-- their per-pack BMS evidence rule.
ALTER TABLE vehicle_types
  ADD COLUMN charge_reading_source text NOT NULL DEFAULT 'bms'
    CHECK (charge_reading_source IN ('bms', 'odometer'));

ALTER TABLE vehicle_types
  ADD CONSTRAINT vehicle_types_odometer_charge_one_pack
    CHECK (charge_reading_source <> 'odometer' OR battery_slots = 1);

-- The original guard assumes every driver charge reading comes from bms_N. For the new type,
-- the very same odometer attachment is the evidence for both distance and charge.
CREATE OR REPLACE FUNCTION guard_shift_battery_reading_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_shift_state shift_state;
  current_vehicle_id uuid;
  current_slot_no smallint;
  current_media_id uuid;
  charge_source text;
  state_is_editable boolean;
BEGIN
  IF NEW.package NOT IN ('start', 'end') THEN
    RETURN NEW;
  END IF;

  SELECT s.state, s.vehicle_id, vt.charge_reading_source
    INTO current_shift_state, current_vehicle_id, charge_source
    FROM shifts s
    JOIN vehicles v ON v.id = s.vehicle_id
    JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
   WHERE s.id = NEW.shift_id
   FOR UPDATE OF s;

  IF NEW.source = 'manager' THEN
    state_is_editable :=
      (NEW.package = 'start' AND current_shift_state = 'awaiting_open_approval')
      OR (NEW.package = 'end' AND current_shift_state = 'pending_review');
  ELSE
    state_is_editable :=
      (NEW.package = 'start' AND current_shift_state = 'draft')
      OR (NEW.package = 'end' AND current_shift_state IN ('open', 'suspended'));
  END IF;

  IF current_shift_state IS NULL OR NOT state_is_editable THEN
    RAISE EXCEPTION 'battery reading package % is not editable in shift state % for source %',
      NEW.package, COALESCE(current_shift_state::text, 'missing'), NEW.source
      USING ERRCODE = '23514', CONSTRAINT = 'shift_battery_readings_write_guard';
  END IF;

  SELECT b.slot_no INTO current_slot_no
    FROM batteries b
   WHERE b.id = NEW.battery_id AND b.vehicle_id = current_vehicle_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'battery % is not fitted to shift % vehicle', NEW.battery_id, NEW.shift_id
      USING ERRCODE = '23514', CONSTRAINT = 'shift_battery_readings_write_guard';
  END IF;

  IF charge_source = 'odometer' AND NEW.source <> 'manager' AND NEW.unavailable THEN
    RAISE EXCEPTION 'dashboard charge must be read or entered by the driver'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_battery_readings_write_guard';
  END IF;

  IF NEW.source <> 'manager' AND NOT NEW.unavailable THEN
    SELECT sm.media_id INTO current_media_id
      FROM shift_media sm
     WHERE sm.shift_id = NEW.shift_id
       AND sm.package = NEW.package
       AND sm.slot = CASE WHEN charge_source = 'odometer' THEN 'odometer'
                          ELSE 'bms_' || current_slot_no::text END;

    IF current_slot_no IS NULL THEN
      RAISE EXCEPTION 'battery % is not fitted to a numbered slot', NEW.battery_id
        USING ERRCODE = '23514', CONSTRAINT = 'shift_battery_readings_write_guard';
    END IF;
    IF NEW.media_id IS NULL THEN
      IF charge_source = 'odometer' THEN
        RAISE EXCEPTION 'dashboard charge reading requires the odometer attachment'
          USING ERRCODE = '23514', CONSTRAINT = 'shift_battery_readings_write_guard';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.media_id IS DISTINCT FROM current_media_id THEN
      RAISE EXCEPTION 'battery reading media does not match current % attachment', charge_source
        USING ERRCODE = '23514', CONSTRAINT = 'shift_battery_readings_write_guard';
    END IF;
  END IF;

  RETURN NEW;
END
$$;
