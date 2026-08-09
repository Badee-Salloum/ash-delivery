-- ── 0018: a sealed week refuses NEW postings, not only edits to old ones ──────────────────
--
-- 0006 guarded week immutability twice over — `REVOKE UPDATE, DELETE` and the
-- `assert_week_not_locked` trigger on both journal_entries and journal_lines. Both guards key off
-- `journal_entries.week_lock_id`, and that is the hole: only `fin_seal_week()` ever writes that
-- column, by UPDATE, at the moment of sealing. `PgLedgerRepo.post` never sets it (repos.ts:188
-- hard-codes `weekLockId: null`) and never looks up an existing lock. So for a brand-new row:
--
--     IF v_week_lock_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;   -- 0006:83-85
--
-- waves the INSERT straight through, even when its `week_start_date` names a week that was sealed
-- weeks ago. And it can never be repaired: `fin_seal_week` stamps only rows present at seal time,
-- and re-running it is impossible because `week_locks_no_reopen` refuses to re-stamp `closed_at`.
-- The row keeps `week_lock_id = NULL` for ever — inside a sealed week, exempt from the immutability
-- trigger, and counted by `listByWeek`, which keys on `week_start_date`.
--
-- Three routes reach it with a CLIENT-SUPPLIED date, no exotic path required:
--
--   POST /expenses           businessDate = body.businessDate ?? today   (expenses.routes.ts:83)
--   POST /journal/manual     businessDate = body.businessDate ?? today   (treasury.routes.ts:147)
--   POST /journal/:id/reverse  business/week dates copied from the original (treasury.routes.ts:199)
--
-- The reversal route is the sharpest of the three, because its own comment states the belief this
-- migration exists to make true: «A locked week is NEVER edited — the database refuses it twice
-- over». It did not. A manager back-dating Thursday's charging bill on Monday moved a week the
-- owner had already been given a printed report for, with no correction entry saying so.
--
-- The guard refuses on EITHER date. `week_start_date` is the week an entry is accounted into — what
-- `listByWeek` and `fin_seal_week` both key on — and `business_date` is the day it belongs to.
-- Today every writer derives one from the other so the two always agree, and this trigger is what
-- keeps that from being an assumption: a future caller cannot smuggle a posting into a sealed week
-- through whichever column the guard did not check.
--
-- It does NOT block the legitimate cases. Posting into the current open week finds either no
-- `week_locks` row or one with `closed_at IS NULL`. `fin_seal_week` only UPDATEs, and this trigger
-- is INSERT-only. Corrections against a sealed week are re-homed by the application into the
-- current open week (BR7's «قيد ظاهر مؤرَّخ» — a visible, dated correction entry), so they carry
-- open-week dates and pass.

CREATE OR REPLACE FUNCTION assert_posting_week_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_closed_at timestamptz;
  v_start     date;
BEGIN
  -- Only fin_seal_week() sets this, and only by UPDATE. A row arriving with it already set is not
  -- something any application path produces; leave it to the UPDATE/DELETE guard in 0006.
  IF NEW.week_lock_id IS NOT NULL THEN RETURN NEW; END IF;

  -- (1) The week the entry is ACCOUNTED INTO must still be open. This is BR7 exactly.
  SELECT closed_at INTO v_closed_at
    FROM week_locks
   WHERE branch_id = NEW.branch_id AND week_start_date = NEW.week_start_date;
  IF v_closed_at IS NOT NULL THEN
    -- 25006 = read_only_sql_transaction, the same code 0006 uses; the API maps it to a 409.
    RAISE EXCEPTION
      'week % is closed (%): post a dated correction into the open week instead',
      NEW.week_start_date, v_closed_at
      USING ERRCODE = '25006';
  END IF;

  -- (2) And the day it BELONGS TO must not sit inside some other sealed week — otherwise the same
  --     money re-enters a sealed period through the business_date every report groups by.
  SELECT week_start_date, closed_at INTO v_start, v_closed_at
    FROM week_locks
   WHERE branch_id = NEW.branch_id
     AND NEW.business_date BETWEEN week_start_date AND week_end_date
     AND closed_at IS NOT NULL;
  IF FOUND THEN
    RAISE EXCEPTION
      'business date % falls inside sealed week % (%): post a dated correction instead',
      NEW.business_date, v_start, v_closed_at
      USING ERRCODE = '25006';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER journal_entries_target_week_open
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_posting_week_open();

COMMENT ON FUNCTION assert_posting_week_open() IS
  'BR7: a sealed week takes no new postings. 0006 only guarded UPDATE/DELETE of already-stamped rows.';
