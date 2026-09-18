-- 0045: at most one COMPLETE close-draft read per page, and the index that makes checking it cheap.
--
-- On 2026-08-25 a driver's dashboard photo was read twice, three seconds apart. The OCR layer
-- correctly refused to pay twice — identical bytes hit the ocr_reads content-hash cache — but
-- readCloseDraftAttachment appended a second read row and a second full set of observations, so
-- five scanned rows became ten stored sightings of one page. Nothing double-counted, because
-- mergeLinkedRows collapses on the page-scoped close_draft_client_key, but the provenance now
-- reads as two pages where there was one, which is exactly the signal a manager needs to be able
-- to trust when deciding whether two overlapping scans share rows.
--
-- The invariant is enforced in PgCloseDraftRepo.saveRead, inside the `SELECT ... FROM shifts
-- FOR UPDATE` it already takes, so two concurrent reads serialise rather than race. It is
-- DELIBERATELY NOT a UNIQUE index and DELIBERATELY NOT a raising trigger:
--
--   * A partial UNIQUE index cannot be created. Production already holds the violating pair on
--     shift 4f40640e-e8dd-4966-b547-d20656136fde, so CREATE UNIQUE INDEX would abort this
--     migration, and the only way to make it pass would be deleting append-only OCR evidence that
--     0034 revoked UPDATE and DELETE on precisely so that it could never be rewritten.
--   * A BEFORE INSERT trigger that raises would abort the driver's close transaction. A duplicate
--     read is a harmless no-op, not a reason to strand someone at the end of a shift.

CREATE INDEX shift_close_draft_reads_attachment_field_idx
  ON shift_close_draft_reads (shift_id, media_id, attachment_token, field)
  WHERE status = 'complete';

COMMENT ON TABLE shift_close_draft_reads IS
  'Append-only provenance: one row per attempted close-draft read. At most one row per (shift_id, media_id, attachment_token, field) may have status = complete; enforced in PgCloseDraftRepo.saveRead under the shift row lock, not by a constraint, because pre-0045 rows may already violate it and the evidence is immutable. A retaken photo rotates attachment_token and is therefore a new page, and a failed read leaves no complete row and stays retryable.';
