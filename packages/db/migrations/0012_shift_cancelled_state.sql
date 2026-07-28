-- ── 0012: the 'cancelled' shift state ───────────────────────────────────────────────────────
--
-- An upper-level account (shift.approve) can VOID a stuck shift the driver can't finish — the
-- float/top-up are returned to the office and the orders discarded, so the ledger nets to zero and
-- the bike is released. That end state is `cancelled`: terminal, never live, never counted toward a
-- tier day or a week. (Force-CLOSE goes to the existing `approved` state, so it needs no new value.)
--
-- ADD VALUE runs inside the migration's transaction (allowed since PG12, since the value isn't USED
-- until after commit) and is idempotent.
ALTER TYPE shift_state ADD VALUE IF NOT EXISTS 'cancelled';
