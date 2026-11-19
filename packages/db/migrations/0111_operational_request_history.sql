-- Aggregated operational diagnostics only. No users, tokens, payloads, images or GPS coordinates.
-- Expiration never removes accounting history or audit records.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE operational_request_batches (
  id uuid PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  buckets jsonb NOT NULL CHECK (jsonb_typeof(buckets) = 'array' AND jsonb_array_length(buckets) BETWEEN 1 AND 200)
);
CREATE INDEX operational_request_batches_retention_idx ON operational_request_batches (recorded_at);
GRANT SELECT, INSERT, DELETE ON operational_request_batches TO app_user;
REVOKE UPDATE, TRUNCATE ON operational_request_batches FROM app_user;
