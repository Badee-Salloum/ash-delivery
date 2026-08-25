-- ── 0042: a pack declared unreadable may not also carry a charge figure ─────────────────────────
--
-- WHAT WAS WRONG. `unavailable` means «تطبيق البطارية لا يعمل على جهازي» — the driver has NO figure
-- for this pack, so the obligation moves to the branch manager. 0021 states that plainly: «The
-- declaration does not waive the evidence. It moves who owes it.»
--
-- The domain implemented that in two halves which disagreed. `requiredPhotoSlots` waived the
-- `bms_N` screenshot on `unavailable` alone, while `batteryGaps` raised the compensating
-- `awaiting_manager_reading` only while `percent` was still NULL. A row carrying BOTH satisfied
-- neither: no required photo, no gap, and both BR5 gates passed with no evidence at all for that
-- pack. A driver holds `shift.operate` and could PUT exactly that shape from his own phone.
--
-- 0021 already encodes the invariant, but only as the predicate of a partial index — an assumption,
-- not a constraint. This makes it enforceable.
--
-- THE EXCEPTION IS REAL AND MUST SURVIVE. `source = 'manager'` legitimately pairs a percent with
-- the declaration: the manager read the pack on his own device, so there is no driver screenshot,
-- and 0028's write guard already restricts that source to `awaiting_open_approval`/`pending_review`
-- with `shift.approve`. Measured on production 2026-08-25: 18 rows are exactly that shape and 0
-- rows violate the constraint below.
ALTER TABLE shift_battery_readings
  ADD CONSTRAINT shift_battery_readings_unavailable_ck CHECK (
    NOT unavailable OR percent IS NULL OR source = 'manager'
  );

COMMENT ON COLUMN shift_battery_readings.unavailable IS
  'الدرايفر لا يستطيع قراءة هذه البطارية. Moves the obligation to the branch manager (domain gap `awaiting_manager_reading`); never waives it. Since 0042 it may carry a percent only when source = ''manager'' — the person who actually read the pack.';
