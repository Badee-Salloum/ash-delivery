-- ── 0016: the DAY an order happened, as the screenshot itself says ─────────────────────────
--
-- «الطلبات الحديثة» scrolls back into previous days, and it announces each one with a header:
-- «الخميس, ٦ أغسطس». Until now the reader threw that away — every scanned order was implicitly
-- the shift's own day — so a driver photographing his list at close captured yesterday's orders
-- with nothing on screen or in the database to say they were yesterday's. The only defence was
-- the driver noticing and unchecking them.
--
-- `occurred_minute` (0015) has the same shape and the same discipline, and this is its other half:
-- the two together are the order's identity, because the screen carries NO ORDER NUMBER at all.
--
-- NULLABLE, and that is the point. The day number is Arabic-Indic — the recogniser garbles it, so
-- it is cut out of the pixels and checked against the weekday word printed beside it. A header
-- whose weekday disagrees with its number yields NULL, never a plausible wrong date. A date this
-- system stores is one two independent readings agreed on.
--
-- `date`, not `timestamptz`: this is the day PRINTED on the screen in Damascus, already local. A
-- timestamp would invite a UTC conversion that moves a late-evening order to the next day — the
-- same off-by-one-day class of bug `week_start_date` exists to avoid.
--
-- No business rule reads it yet. BR1 is a shift-scoped equation and the checkbox still decides
-- what counts; this column is what makes the checkbox an INFORMED decision, and what a later
-- anomaly check («this shift contains orders from three different days») will read.

ALTER TABLE shift_orders
  ADD COLUMN occurred_date date;

COMMENT ON COLUMN shift_orders.occurred_date IS
  'the day the order screen says it happened, read from the day header; NULL when unreadable or unchecked';
