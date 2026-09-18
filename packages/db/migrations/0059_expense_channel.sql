-- 0059 - a «صرفية» may be paid from the wallet, not only from the cash box
--
-- Owner, 2026-09-01: «سجل نقص المحفظة كصرفية تحت اسم طلبيات ابراهيم خليل». The wallet was 63.81
-- short of the books and the money was spent, not moved — but there was no way to say so: the
-- expense recipe credited `office_cash` and nothing else.
--
-- The asymmetry was already visible from the other side. `income(channel, …)` takes the box that
-- received the money, and its own doc comment explains why: «The wallet channel is not decoration.
-- An office wallet can also be the side that FALLS on a correction.» The same is true of an expense
-- and it simply had not come up yet. Yallago's cut leaves the wallet, so wallet-side costs are
-- ordinary in this business, not exotic.
--
-- WITHOUT THIS COLUMN the only honest ways to record a wallet cost were a raw manual journal entry,
-- which never appears in «الصرفيات» and so silently understates every cost report, or an
-- office transfer paired with a cash expense — which would claim money moved between two boxes
-- when nothing of the kind happened.
--
-- THE DEFAULT IS PROVABLY RIGHT, not merely convenient: `expense()` could credit `office_cash` and
-- nothing else, so every row already in this table was paid in cash by construction.

ALTER TABLE expenses
  ADD COLUMN channel text NOT NULL DEFAULT 'office_cash'
    CHECK (channel IN ('office_cash', 'office_wallet'));

COMMENT ON COLUMN expenses.channel IS
  'WHICH BOX paid — a physical fact the recorder knows. Never a ledger fund code: `fundRefFromCode` '
  'turns an unrecognised string into cost_center:<code>, a look-alike account no cost report sums. '
  'Every row predating 0059 is office_cash by construction, because the recipe had no alternative.';
