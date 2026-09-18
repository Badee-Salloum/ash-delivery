-- 0048 - a cash count can be superseded by a recount, or withdrawn until the error is fixed
--
-- THE TRAP THIS CLOSES. `UNIQUE (branch_id, business_date)` (0004:164) allowed exactly one count
-- per branch per day, for ever. So when a posting landed after a sealed count — a late expense, an
-- income, a shift closing — the restoration refused it with `cash_count_stale` and told the manager
-- to "recount instead", while `POST /cash-counts` refused that with `already_counted_today`. The
-- day became permanently unrestorable, with no way out and no error naming the deadlock.
--
-- The owner asked for the three answers a variance actually deserves: proceed and record an
-- operation that accounts for it, recount, or withdraw the count until the error is fixed. Two of
-- those need a count to stop being the only one its day may ever have.
--
-- NOTHING IS EVER DELETED OR RESTATED. A superseded or withdrawn count keeps its rows, its
-- resolutions and its SHA-256 proof, and gains only the record of what happened to it. The proof
-- still certifies exactly what it always certified: the figures as counted at that moment.

ALTER TABLE cash_counts
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'cancelled')),
  -- Which count replaced this one. Set only on 'superseded', so the chain of recounts for a day is
  -- walkable in either direction.
  ADD COLUMN superseded_by_id bigint REFERENCES cash_counts(id) ON DELETE RESTRICT,
  ADD COLUMN closed_at        timestamptz,
  ADD COLUMN closed_by        uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN closed_reason    text;

-- The constraint that made a recount impossible. Replaced, not merely dropped: a day still may not
-- have two LIVE counts, or the restoration would have to choose between them.
ALTER TABLE cash_counts DROP CONSTRAINT cash_counts_branch_id_business_date_key;

CREATE UNIQUE INDEX cash_counts_active_day_uq
  ON cash_counts (branch_id, business_date)
  WHERE status = 'active';

-- Leaving a count is an audited act, so it carries who did it, when, and why. An active count has
-- none of those; a closed one has all three. Enforced here rather than trusted to the service,
-- because a withdrawn count with no reason is indistinguishable from a bug.
ALTER TABLE cash_counts
  ADD CONSTRAINT cash_counts_closed_ck CHECK (
    (status = 'active' AND closed_at IS NULL AND closed_by IS NULL AND closed_reason IS NULL)
    OR
    (status <> 'active' AND closed_at IS NOT NULL AND closed_by IS NOT NULL
     AND ash_has_visible_text(closed_reason))
  ),
  -- Only a superseded count names a successor, and it must name one.
  ADD CONSTRAINT cash_counts_superseded_ck CHECK (
    (status = 'superseded') = (superseded_by_id IS NOT NULL)
  ),
  -- A count cannot supersede itself into a cycle of one.
  ADD CONSTRAINT cash_counts_supersede_self_ck CHECK (superseded_by_id IS DISTINCT FROM id);

CREATE INDEX cash_counts_day_history_idx
  ON cash_counts (branch_id, business_date, counted_at DESC);

COMMENT ON COLUMN cash_counts.status IS
  'active | superseded | cancelled. Exactly one active count per branch per business date '
  '(cash_counts_active_day_uq). `find` and `listDatesInRange` MUST return only active counts: a '
  'superseded one would let the restoration reconcile against figures nobody stands behind, and a '
  'cancelled one would let a financial week seal on a count its author withdrew.';
