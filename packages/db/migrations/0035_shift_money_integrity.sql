-- 0035 - settlement reason integrity and lightweight open-shift counting
--
-- PostgreSQL accepts a CHECK expression when it is TRUE *or UNKNOWN*. The 0031 expression used
-- char_length(variance_reason) directly, so a non-zero variance with SQL NULL produced UNKNOWN
-- and slipped through. Make both the length and required-reason branches explicitly boolean.

-- PostgreSQL's POSIX `[:space:]` does not consider Unicode format controls such as U+200B ZERO
-- WIDTH SPACE blank. Keep the database boundary aligned with the request schema by removing every
-- Unicode Cf range (Unicode 16 / Node 24) plus whitespace and requiring something visible to remain.
CREATE FUNCTION ash_has_visible_text(value text) RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  RETURN value IS NOT NULL AND regexp_replace(
    value,
    U&'[[:space:]\00AD\0600-\0605\061C\06DD\070F\0890-\0891\08E2\180E\200B-\200F\202A-\202E\2060-\2064\2066-\206F\FEFF\FFF9-\FFFB\+0110BD\+0110CD\+013430-\+01343F\+01BCA0-\+01BCA3\+01D173-\+01D17A\+0E0001\+0E0020-\+0E007F]',
    '',
    'g'
  ) <> '';

ALTER TABLE shift_settlements
  DROP CONSTRAINT shift_settlements_variance_reason_ck;

ALTER TABLE shift_settlements
  ADD CONSTRAINT shift_settlements_variance_reason_ck CHECK (
    char_length(COALESCE(variance_reason, '')) <= 500
    AND (
      variance_minor = 0
      OR ash_has_visible_text(variance_reason)
    )
  );

-- A force-cancel reason is settlement evidence too. Store it in the append-only decision log in
-- the same transaction as the terminal shift and its return journals; an HTTP audit appended after
-- commit cannot be the only proof because a lost response can strand the shift without that row.
ALTER TABLE shift_decisions
  DROP CONSTRAINT shift_decisions_decision_check;

ALTER TABLE shift_decisions
  ADD CONSTRAINT shift_decisions_decision_check CHECK (
    decision IN ('approved', 'rejected', 'rephoto_requested', 'force_close_prepared', 'force_cancelled')
    AND (
      decision <> 'force_cancelled'
      OR (gate = 'close' AND ash_has_visible_text(notes))
    )
  );

-- The dashboard polls only shifts that are exactly open. INCLUDE keeps both DISTINCT actor counts
-- available from this small partial index without widening the predicate to suspended/review rows.
CREATE INDEX shifts_branch_open_idx
  ON shifts (branch_id) INCLUDE (driver_id, vehicle_id)
  WHERE state = 'open';
