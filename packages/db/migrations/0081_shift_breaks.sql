-- An operational pause belongs to a shift, but does not close it. The recorded allowance is the
-- global setting at START, so later administrator edits cannot rewrite an earlier pause.
CREATE TABLE shift_breaks (
  id uuid PRIMARY KEY,
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN (
    'driver_resumed', 'manager_suspended', 'manager_voided', 'manager_force_closed'
  )),
  limit_minutes integer NOT NULL CHECK (limit_minutes BETWEEN 1 AND 1440),
  consumed_before_ms bigint NOT NULL CHECK (consumed_before_ms >= 0),
  over_limit_ms bigint NOT NULL DEFAULT 0 CHECK (over_limit_ms >= 0),
  started_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ended_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT shift_breaks_end_ck CHECK (
    (ended_at IS NULL AND end_reason IS NULL AND ended_by IS NULL AND over_limit_ms = 0)
    OR (ended_at IS NOT NULL AND ended_at >= started_at AND end_reason IS NOT NULL AND ended_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX shift_breaks_one_active_uq ON shift_breaks (shift_id) WHERE ended_at IS NULL;
CREATE INDEX shift_breaks_shift_time_idx ON shift_breaks (shift_id, started_at, id);

CREATE TRIGGER audit_shift_breaks
  AFTER INSERT OR UPDATE OR DELETE ON shift_breaks
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
REVOKE DELETE, TRUNCATE ON shift_breaks FROM app_user;
GRANT SELECT, INSERT, UPDATE ON shift_breaks TO app_user;

INSERT INTO settings (key, value, value_type, description)
VALUES ('shift.break_limit_minutes', '60'::jsonb, 'integer', 'Maximum cumulative break minutes per shift')
ON CONFLICT (key) DO NOTHING;
