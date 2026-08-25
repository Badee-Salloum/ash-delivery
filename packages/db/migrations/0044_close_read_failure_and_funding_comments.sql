-- 0044: make every terminal OCR failure durable and document legacy funding column names.
--
-- `read_budget_exhausted` became a distinct application failure after 0034 created this table.
-- Without widening the original value constraint, persisting that terminal result raises 23514;
-- the new close gate then sees no durable read and can never let the driver submit. This migration
-- keeps the database vocabulary aligned with the exhaustive OcrFailure contract.

ALTER TABLE shift_close_draft_reads
  DROP CONSTRAINT shift_close_draft_reads_failure_check;

ALTER TABLE shift_close_draft_reads
  ADD CONSTRAINT shift_close_draft_reads_failure_check CHECK (
    failure IN (
      'unavailable',
      'timeout',
      'no_fields',
      'refused',
      'wrong_screen',
      'read_budget_exhausted'
    )
  );

COMMENT ON COLUMN shift_close_draft_reads.failure IS
  'Terminal OCR failure. The allowed values mirror contracts OcrFailure, including read_budget_exhausted so a spent read budget remains a durable, reviewable terminal state.';
--
-- The columns keep their wire-compatible names, but a non-zero value is no longer posted to an
-- ordinary `driver_receivable_*` fund. Migration 0041 sends it to `driver_shift_funding_*`, whose
-- balance is consumed automatically as a carried tranche when the same driver opens the next
-- shift. Replacing these comments forward preserves applied-migration immutability for 0037/0041.

COMMENT ON COLUMN shift_settlements.cash_receivable_deferred_minor IS
  'Legacy column name: positive cash collection retained at close as driver_shift_funding_cash. It is consumed automatically as carried funding when the driver opens the next shift; it is not an ordinary receivable.';

COMMENT ON COLUMN shift_settlements.wallet_receivable_deferred_minor IS
  'Legacy column name: positive wallet collection retained at close as driver_shift_funding_wallet. It is consumed automatically as carried funding when the driver opens the next shift; it is not an ordinary receivable.';
