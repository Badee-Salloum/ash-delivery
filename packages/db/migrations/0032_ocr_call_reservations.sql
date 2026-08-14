-- Every paid logical OCR read is reserved before it leaves the API process. One logical read may
-- contain several internal provider passes; its stored telemetry is their aggregate.
--
-- The original cache row was inserted only AFTER the provider answered. Two replicas could both
-- miss it and both spend, and the per-shift cap was a separate COUNT followed by a read. This
-- migration gives the row an explicit running/complete state and enough ownership to serialize
-- both the content identity and the requesting shift's budget.

ALTER TABLE ocr_reads
  ADD COLUMN cache_signature text NOT NULL DEFAULT 'legacy-v1',
  ADD COLUMN read_state text NOT NULL DEFAULT 'complete'
    CHECK (read_state IN ('running', 'complete')),
  ADD COLUMN reservation_id uuid,
  ADD COLUMN reserved_at timestamptz,
  ADD COLUMN reserved_attempt smallint CHECK (reserved_attempt IN (1, 2)),
  ADD COLUMN retry_shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  ADD COLUMN retry_created_at timestamptz,
  ADD COLUMN retry_created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT ocr_reads_reservation_shape_ck CHECK (
    (read_state = 'complete'
      AND reservation_id IS NULL
      AND reserved_at IS NULL
      AND reserved_attempt IS NULL)
    OR
    (read_state = 'running'
      AND reservation_id IS NOT NULL
      AND reserved_at IS NOT NULL
      AND reserved_attempt IS NOT NULL)
  ),
  ADD CONSTRAINT ocr_reads_cache_signature_ck CHECK (length(btrim(cache_signature)) > 0);

-- A cache receipt must outlive either owning shift. In particular, deleting the shift that paid
-- attempt one must not delete a retry currently owned by another shift, and SET NULL must remain
-- valid even while that retry's bounded lease is live.
ALTER TABLE ocr_reads
  DROP CONSTRAINT ocr_reads_shift_id_fkey,
  ADD CONSTRAINT ocr_reads_shift_id_fkey
    FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL;

-- A prompt/schema/validation change is a different reader even when the bytes and model name are
-- unchanged. Existing rows intentionally keep `legacy-v1`, so no newly versioned reader can serve
-- an answer produced before this deployment.
DROP INDEX ocr_reads_sha_uq;
CREATE UNIQUE INDEX ocr_reads_sha_uq
  ON ocr_reads (branch_id, sha256, field, cache_signature);

CREATE INDEX ocr_reads_retry_shift_idx
  ON ocr_reads (retry_shift_id)
  WHERE retry_shift_id IS NOT NULL;

COMMENT ON COLUMN ocr_reads.cache_signature IS
  'Model/config plus field-specific prompt/schema/validation version; part of cache identity.';
COMMENT ON COLUMN ocr_reads.read_state IS
  'running while one reservation owns the logical OCR attempt; complete only after answer or lease expiry.';
COMMENT ON COLUMN ocr_reads.retry_shift_id IS
  'Shift whose OCR budget owns attempt two; attempt one remains owned by shift_id.';
COMMENT ON COLUMN ocr_reads.retry_created_at IS
  'When attempt two was reserved; retained after completion as immutable retry telemetry.';
COMMENT ON COLUMN ocr_reads.retry_created_by IS
  'Actor who explicitly requested attempt two; retained after completion when the actor still exists.';
COMMENT ON TABLE ocr_reads IS
  'One cache receipt per image/field/reader signature; up to two billed logical OCR attempts, each of which may aggregate several internal model passes.';
