-- ── 0017: the idempotency guard covers EVERY posting, not only a shift's ──────────────────
--
-- `je_idempotency_uq` was created in 0004 as a PARTIAL index:
--
--     CREATE UNIQUE INDEX je_idempotency_uq
--       ON journal_entries (shift_id, event_type, occurrence_key) WHERE shift_id IS NOT NULL;
--
-- Everything a shift posts is therefore protected — approvals, tranches, order fees — and
-- everything else is not. Four routes post with `shiftId: null` and none of them had any replay
-- guard whatsoever:
--
--   POST /treasury/deposit     a double-click puts the cash in twice
--   POST /journal/manual       likewise
--   POST /expenses             likewise
--   POST /journal/:id/reverse  the worst: its occurrence key is DETERMINISTIC
--                              («reversal-of-<id>»), written by someone who plainly expected this
--                              index to catch a replay. It did not, so the same entry could be
--                              reversed N times and move N × the amount.
--
-- COALESCE rather than a second partial index: `NULL` values are DISTINCT from one another in a
-- PostgreSQL unique index, so `(NULL, 'deposit', 'k')` never collides with itself and a partial
-- index on `shift_id IS NULL` would guard nothing at all. `NULLS NOT DISTINCT` (PG 15+) would also
-- work; COALESCE says the intent out loud and runs everywhere.
--
-- `branch_id` joins the key because a non-shift posting is only unique within its branch — two
-- branches may legitimately deposit under the same key on the same day. For shift-scoped rows the
-- shift already implies the branch, so this neither loosens nor tightens them.
--
-- Verified against production before writing this: zero duplicate groups under the new key, so it
-- applies cleanly to the existing ledger.

DROP INDEX je_idempotency_uq;

CREATE UNIQUE INDEX je_idempotency_uq
  ON journal_entries (branch_id, event_type, COALESCE(shift_id::text, ''), occurrence_key);

COMMENT ON INDEX je_idempotency_uq IS
  'replay guard for EVERY posting; COALESCE because NULL shift_id would otherwise never collide';
