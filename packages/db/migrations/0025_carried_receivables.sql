-- ── 0025: «الذمم» — cash a driver keeps overnight, and the share he keeps at close ──────────
--
-- Owner decisions (c), (f) and (g), 2026-08-12:
--   • a ذمة belongs to a NAMED DRIVER and is «handled when he starts a new shift»
--   • حصة السائق is paid at the end of every shift, out of the cash already in his hands
--   • the MANAGER decides the ذمة at approval; the driver always declares every lira he holds
--
-- The funds themselves need no schema: `driver_receivable_cash` and `driver_receivable_wallet`
-- became `fund_type` values in 0023, and funds are created lazily on first posting.

-- ── A carried ذمة is a THIRD KIND OF TRANCHE, not a fourth column ───────────────────────────
--
-- `float_tranches.kind` is a text CHECK rather than an enum, so this needs no `ALTER TYPE` and can
-- live in one file with everything below it.
--
-- Why a tranche at all: the closing cash is «float + carried + what he collected», and BR1 reads
-- the same list. Modelling the carry as a tranche means the equation stays in its ABSOLUTE form
-- (CLAUDE.md decision 4) — no opening balance, no second code path, and `evaluateShift` needs one
-- extra `add` rather than a new concept.
--
-- The kinds are DISJOINT and must stay so. Both are summed into the closing cash, so an amount
-- recorded under both would be returned twice and leave the office over by exactly that much.
ALTER TABLE float_tranches DROP CONSTRAINT IF EXISTS float_tranches_kind_check;
ALTER TABLE float_tranches ADD CONSTRAINT float_tranches_kind_check
  CHECK (kind IN ('cash_float', 'wallet_topup', 'carried_receivable'));

-- ── What the manager decided to leave with him tonight ──────────────────────────────────────
--
-- On the shift rather than derived from the ledger, for the same reason `business_date` is a
-- written column: it is an INPUT to the posting, not a consequence of it. Deriving it back out of
-- journal lines would make the shift record unable to answer what was decided.
--
-- NOT NULL DEFAULT 0 so every shift ever closed keeps its meaning: nothing was kept.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS kept_as_receivable_minor bigint NOT NULL DEFAULT 0
  CHECK (kept_as_receivable_minor >= 0);

-- The share actually handed over at close, kept beside it for the same reason. Zero means the
-- company still owes him — `driver_share_payable` carries the balance either way.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS driver_share_paid_minor bigint NOT NULL DEFAULT 0
  CHECK (driver_share_paid_minor >= 0);

COMMENT ON COLUMN shifts.kept_as_receivable_minor IS
  'يبقى ذمة على السائق — cash left with the driver at close, the manager''s decision. Cleared when he opens his next shift.';
COMMENT ON COLUMN shifts.driver_share_paid_minor IS
  'يُعاد للسائق — the share he kept out of the cash in his hands, debiting driver_share_payable.';
