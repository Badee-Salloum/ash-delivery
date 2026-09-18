-- P6: bounded vehicle timelines must not scan every shift/expense in a branch.
CREATE INDEX IF NOT EXISTS shifts_vehicle_business_date_idx
  ON shifts (vehicle_id, business_date);

CREATE INDEX IF NOT EXISTS expenses_vehicle_business_date_idx
  ON expenses (vehicle_id, business_date)
  WHERE vehicle_id IS NOT NULL;
