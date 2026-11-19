-- The service records ShiftRecord.driverId (drivers.id), not a login account (users.id).
-- Migration0060 pointed at users by mistake, so normal removals failed with23503 and rolled back.
-- Correct only the reference. Never rewrite/delete existing audit rows or disable their guards.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM operation_removals r
    WHERE r.driver_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM drivers d WHERE d.id = r.driver_id)
  ) THEN
    RAISE EXCEPTION 'operation removal history contains an unresolved driver identity; review it explicitly'
      USING ERRCODE = '23503';
  END IF;
END $$;

ALTER TABLE operation_removals
  DROP CONSTRAINT operation_removals_driver_id_fkey,
  ADD CONSTRAINT operation_removals_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE RESTRICT;
