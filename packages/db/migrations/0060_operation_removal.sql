-- 0060 — a manager may REMOVE a row that is not a delivery, and the system admin is told.
--
-- Owner, 2026-09-01: «add the possibility for the manager to remove an order but this should be
-- reported to the system admin in a clear place and way».
--
-- WHY THIS IS NOT `included = false`. The two mean different things and the owner chose to keep
-- both. «مستبعَد» is an accounting decision about a real delivery: it happened, and it is not being
-- counted on this shift. «محذوف» says the row is not a delivery at all — a reading that never
-- corresponded to anything, like the phantom 230 on shift a3728815, where a page seam faded the top
-- off a ٣ and one delivery was counted twice. Reporting them together would bury a reader fault
-- inside ordinary bookkeeping, and they are exactly the two things a general manager needs told
-- apart.
--
-- WHY NOTHING IS DELETED. A row that is gone cannot be reported, reviewed, or restored, and every
-- financial mutation in this system is auditable by construction. Removal marks; it never erases.
-- `audit_shift_orders` (0006) already captures the whole row before and after with the actor, so
-- the audit trail comes free — this migration adds the *register*, which is the part a human can
-- actually find.
--
-- THE SAFETY PROPERTY THAT MATTERS MOST: a removed row must also be `included = false`, enforced
-- below. Every money path in this codebase already filters on `included`, so removal moves money
-- through the one door that is already tested rather than opening a second one beside it. Not a
-- single line of settlement arithmetic changes.
--
-- Deliberately NO `REVOKE DELETE ON shift_orders`: `voidShiftLocked` deletes a whole shift's rows
-- as one aggregate, and `shift_wallet_movements.order_id` is `ON DELETE SET NULL` precisely for it.

ALTER TABLE shift_orders
  ADD COLUMN removed_at      timestamptz,
  ADD COLUMN removed_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN removal_reason  text;

ALTER TABLE cash_deductions
  ADD COLUMN removed_at      timestamptz,
  ADD COLUMN removed_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN removal_reason  text;

-- All three together or none, the reason visibly non-blank, and never counted. `ash_has_visible_text`
-- rather than a trim: an Arabic-first UI carries invisible bidi marks through copy-paste, and
-- `'‏'.trim()` is truthy — so a reason nobody can read used to satisfy an audit trail.
ALTER TABLE shift_orders
  ADD CONSTRAINT shift_orders_removal_ck CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND removal_reason IS NULL)
    OR
    (removed_at IS NOT NULL AND removed_by IS NOT NULL
      AND removal_reason IS NOT NULL AND ash_has_visible_text(removal_reason)
      AND included = false)
  );

ALTER TABLE cash_deductions
  ADD CONSTRAINT cash_deductions_removal_ck CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND removal_reason IS NULL)
    OR
    (removed_at IS NOT NULL AND removed_by IS NOT NULL
      AND removal_reason IS NOT NULL AND ash_has_visible_text(removal_reason)
      AND included = false)
  );

-- Partial: only removed rows are ever looked up this way, and they are a handful against every
-- order the fleet has ever delivered.
CREATE INDEX shift_orders_removed_idx
  ON shift_orders (removed_at DESC) WHERE removed_at IS NOT NULL;
CREATE INDEX cash_deductions_removed_idx
  ON cash_deductions (removed_at DESC) WHERE removed_at IS NOT NULL;

-- ── The register the system admin reads ──────────────────────────────────────────────────────────
--
-- Append-only, on the `shift_decisions` template (0031) and with `receivable_events.intent`'s idea
-- of one immutable row per exceptional act. A restore is its own row, not an update: «this was
-- removed and then put back» is two facts with two actors and two reasons, and collapsing them
-- would let the second quietly overwrite the first.
--
-- Denormalised on purpose — branch, business date, amount and the driver are copied in. The screen
-- must answer «what was removed, from whose shift, for how much» without joining four tables, and
-- the register has to keep saying so even after a shift is voided and its rows are gone.
CREATE TABLE operation_removals (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('removed', 'restored')),
  operation_kind  text NOT NULL CHECK (operation_kind IN ('order', 'cash_deduction')),
  /* No FK: the register outlives the row it describes, which is the whole point of a register. */
  operation_id    uuid NOT NULL,
  /* The provider order number for an order, the deduction id for a deduction — what a human reads. */
  operation_ref   text NOT NULL,
  shift_id        uuid NOT NULL,
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  business_date   date NOT NULL,
  driver_id       uuid REFERENCES users(id) ON DELETE RESTRICT,
  amount_minor    bigint NOT NULL,
  reason          text NOT NULL CHECK (ash_has_visible_text(reason) AND length(reason) <= 500),
  /* Which stored screenshot the row was read from, so the register can show the evidence. */
  evidence_slot   text,
  evidence_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  acted_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  acted_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operation_removals_recent_idx ON operation_removals (acted_at DESC);
CREATE INDEX operation_removals_branch_idx ON operation_removals (branch_id, acted_at DESC);
CREATE INDEX operation_removals_operation_idx ON operation_removals (operation_id, acted_at DESC);

REVOKE UPDATE, DELETE, TRUNCATE ON operation_removals FROM app_user;
GRANT SELECT, INSERT ON operation_removals TO app_user;

CREATE FUNCTION reject_operation_removal_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'operation removals are append-only'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER operation_removals_append_only
  BEFORE UPDATE OR DELETE ON operation_removals
  FOR EACH ROW EXECUTE FUNCTION reject_operation_removal_mutation();

CREATE TRIGGER audit_operation_removals
  AFTER INSERT OR UPDATE OR DELETE ON operation_removals
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
