-- «تطبيق البطارية لا يعمل على جهازي» — and the manager who then owes the reading.
--
-- Some drivers' phones cannot run the BMS app at all: an old Android, a device the manufacturer's
-- app refuses, Bluetooth that will not pair. The start gate demands a `bms_N` screenshot and a
-- charge figure for every fitted pack, so such a driver could not open a shift AT ALL. There was no
-- path except uploading a picture of something else to get past it — which is the worst possible
-- outcome, because it converts a hardware problem into false evidence.
--
-- The declaration does not waive the evidence. It moves who owes it:
--   • the DRIVER stops being blocked — he is no longer asked for a screenshot he cannot take;
--   • the BRANCH MANAGER cannot approve the shift until he has read that pack on a working device.
-- The domain expresses this as a gap of its own, `awaiting_manager_reading`, which the driver's own
-- gates ignore and the manager's gates enforce.

ALTER TABLE shift_battery_readings
  ADD COLUMN unavailable boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN shift_battery_readings.unavailable IS
  'The driver declared he cannot read this pack on his own phone. Moves the obligation to the branch manager (domain gap `awaiting_manager_reading`); never waives it.';

-- `manager` joins the existing sources so the reading says WHO produced it. It is not `manual`:
-- a value the manager took on his own device after the driver could not is a materially different
-- fact from one the driver typed, and the two must not be told apart only by reading the audit log.
ALTER TABLE shift_battery_readings
  DROP CONSTRAINT IF EXISTS shift_battery_readings_source_check;

ALTER TABLE shift_battery_readings
  ADD CONSTRAINT shift_battery_readings_source_check
  CHECK (source IN ('ocr', 'manual', 'manager'));

-- A pack still waiting on the manager, for the approval screen's own query. Partial: the common
-- case is zero rows, and this index is only ever asked about the exceptions.
CREATE INDEX shift_battery_readings_awaiting_idx
  ON shift_battery_readings (shift_id)
  WHERE unavailable AND percent IS NULL;
