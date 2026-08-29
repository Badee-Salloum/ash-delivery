-- 0050 - correcting a recorded receivable
--
-- Owner request: «اضف القدرة على تعديل الذمم المسجلة».
--
-- WHY THIS IS A BALANCE RESTATEMENT AND NOT AN EDIT OF AN EVENT.
--
-- A driver's receivable balance is a LEDGER FUND BALANCE, not the sum of `receivable_events`. Seven
-- places emit receivable fund lines — the direct command in `treasury.routes.ts`, the shift close's
-- deferral, the shift-funding carry consumed at the next open, the cash-deduction overflow, and so
-- on — and only ONE of them writes an event row. So a correction that points at an event is
-- arithmetically incapable of touching the commonest wrong number of all, a `shift_funding` carry,
-- which has no event to point at.
--
-- The correction therefore names the balance: "it reads X, it should be Y". The delta becomes an
-- ordinary `receivable_adjustment` posting through the UNCHANGED recipe, so the ledger keeps one
-- way of moving a receivable and this adds no second arithmetic to keep in step. Every guard 0037
-- installed — the actor check against the live RBAC matrix, the journal-identity check, the exact
-- two-line recipe check, the over-collection row lock — applies to a correction untouched, because
-- a correction IS one of those postings.
--
-- WHY `intent` EXISTS. Without it the driver's history reads «تحصيل ٥٠٠» — money came back. It did
-- not: nothing moved, a number was restated. A ledger that says money changed hands when it did not
-- is telling the exact lie this system exists to prevent, so the row records which it was.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. 0037's driver guard refuses `create` for an INACTIVE driver
-- — «never hand a disabled driver a new advance». A correction extends no credit, so an argument
-- exists for exempting it, and a driver who left owing money recorded too low is a real case. It is
-- not done here: the exemption would mean rewriting a 200-line security trigger to change one
-- clause, and a hand-copied guard that drifts from the original is a worse risk than the workflow
-- it saves. The operator reactivates the driver, corrects, and deactivates again — three audited
-- steps. The API names this in `receivable_correction_needs_active_driver` rather than failing with
-- a database constraint nobody can read.

ALTER TABLE receivable_events
  ADD COLUMN intent text NOT NULL DEFAULT 'command'
    CHECK (intent IN ('command', 'correction'));

-- What the balance read when the operator decided, and what he says it should be. Stored rather
-- than derived: a year later, "why is this here" is answered by the row itself, and re-deriving the
-- prior balance from a ledger that has moved since would answer a different question.
ALTER TABLE receivable_events ADD COLUMN prior_balance_minor bigint;
ALTER TABLE receivable_events ADD COLUMN target_balance_minor bigint;

-- A command carries no balances; a correction carries both, and its posted amount must be exactly
-- the distance between them. Pure column arithmetic, so it holds against direct SQL too — the
-- amount and the restatement cannot drift apart even for a writer that bypasses the API.
ALTER TABLE receivable_events
  ADD CONSTRAINT receivable_events_intent_ck CHECK (
    CASE intent
      WHEN 'command' THEN prior_balance_minor IS NULL AND target_balance_minor IS NULL
      -- `check-sql.mjs` reads any line that BEGINS with a `*_minor` identifier as a column
      -- definition, so no line here may start with one. That heuristic is why every money column in
      -- this schema is provably bigint; it is not worth loosening for one constraint's indentation.
      ELSE prior_balance_minor IS NOT NULL
        AND target_balance_minor IS NOT NULL
        AND prior_balance_minor >= 0
        AND target_balance_minor >= 0
        AND CASE direction
          WHEN 'create' THEN target_balance_minor = prior_balance_minor + amount_minor
          ELSE target_balance_minor = prior_balance_minor - amount_minor
        END
    END
  );

CREATE INDEX receivable_events_correction_idx
  ON receivable_events (branch_id, driver_id, created_at)
  WHERE intent = 'correction';
