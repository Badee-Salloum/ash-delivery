-- The live map reads positions by capture time. Buffered uploads may arrive after a newer fix;
-- receive time must not make an old position appear current.
CREATE INDEX gps_pings_branch_driver_captured_idx
  ON gps_pings (branch_id, driver_id, captured_at DESC, id DESC);
