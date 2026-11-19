-- Optional daily evidence, percentage charge policy and durable permission incidents.
ALTER TABLE ocr_reads DROP CONSTRAINT ocr_reads_field_check;
ALTER TABLE ocr_reads ADD CONSTRAINT ocr_reads_field_check
  CHECK (field IN ('orders','payments_log','wallet','odometer','bms','daily_summary'));
ALTER TABLE shift_close_draft_reads DROP CONSTRAINT shift_close_draft_reads_field_check;
ALTER TABLE shift_close_draft_reads ADD CONSTRAINT shift_close_draft_reads_field_check
  CHECK (field IN ('orders','payments_log','wallet','odometer','bms','daily_summary'));
ALTER TABLE shifts ADD COLUMN manager_charge_bps integer
  CHECK (manager_charge_bps BETWEEN 1 AND 10000);

CREATE TABLE shift_permission_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id uuid NOT NULL REFERENCES shifts(id),
  permission text NOT NULL CHECK (permission IN
    ('location','location_enabled','background','notifications','battery','autostart')),
  opened_at timestamptz NOT NULL,
  observed_at timestamptz,
  recovered_at timestamptz,
  app_build integer
);
CREATE UNIQUE INDEX shift_permission_events_open_idx
  ON shift_permission_events (shift_id, permission) WHERE recovered_at IS NULL;
CREATE INDEX shift_permission_events_shift_idx ON shift_permission_events (shift_id, id);
