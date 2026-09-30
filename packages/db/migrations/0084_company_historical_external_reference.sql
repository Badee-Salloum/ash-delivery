-- 0084 — a human audit reference for historical «صندوق الشركة» entries
--
-- The client UUID / occurrence_key remains the retry idempotency key. This separate reference is
-- the number written on an older receipt, ledger sheet, or bank slip while importing history. It
-- is deliberately nullable so every existing entry keeps its exact meaning.

ALTER TABLE journal_entries
  ADD COLUMN external_reference text;

ALTER TABLE journal_entries
  ADD CONSTRAINT je_external_reference_visible_ck CHECK (
    external_reference IS NULL OR ash_has_visible_text(external_reference)
  );

-- One source document must identify one entry in the HQ book. `branch_id` is retained in the key
-- even though the guard below admits non-null values only for HQ: it keeps the index's scope
-- explicit and lets the database reject a future second company ledger rather than silently blend
-- its history with this one's.
CREATE UNIQUE INDEX je_external_reference_hq_uq
  ON journal_entries (branch_id, external_reference)
  WHERE external_reference IS NOT NULL;

-- A CHECK cannot inspect branches.kind. Reuse the established row-kind guard and run it only when
-- a caller actually supplies an external reference; old and ordinary journal rows remain valid.
CREATE TRIGGER journal_entries_00_external_reference_hq_guard
  BEFORE INSERT OR UPDATE OF branch_id, external_reference ON journal_entries
  FOR EACH ROW
  WHEN (NEW.external_reference IS NOT NULL)
  EXECUTE FUNCTION assert_branch_kind('company');

COMMENT ON COLUMN journal_entries.external_reference IS
  'Unique human audit reference for one historical HQ/company-fund movement; null for ordinary entries.';
