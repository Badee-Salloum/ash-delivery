-- ── 0023: enum values ONLY — nothing may USE them in this file ──────────────────────────────
--
-- WHY THIS FILE CONTAINS NOTHING ELSE. `ALTER TYPE … ADD VALUE` is allowed inside a transaction
-- since PG12 *only because the value is not used until after the commit*, and `migrate.ts:68-72`
-- wraps every migration file in exactly one transaction. Put a CHECK constraint or an INSERT
-- naming one of these literals below, and Postgres casts it to the enum at statement time and
-- refuses: «unsafe use of new value of enum type». 0012 records the same rule for `shift_state`.
-- Everything that USES these values is migration 0024.
--
-- ── ledger_event ────────────────────────────────────────────────────────────────────────────
--
-- `wallet_adjustment` IS A BUG FIX, NOT A FEATURE. The domain has declared it since the wallet
-- log landed (`recipes.ts:41`), `walletAdjustment()` emits it, `postingsForApproval` pushes it and
-- `approveClose` feeds it real data from the payments-log scan — but it was never added to the
-- database's enum. `repos.ts` casts `$2::ledger_event`, so the first close approval carrying an
-- unexplained wallet movement would raise 22P02 and abort the whole approval transaction: a 500
-- in the branch manager's face, with the money unposted.
--
-- It has never fired because the memory adapter has no enum and no shift has ever been approved in
-- production — every fund row is still at zero. The very first real approval is the one at risk,
-- which is precisely the worst time to discover it.
--
-- `restoration` — «الترميم». The daily sweep of profit to صندوق الشركة («كييش») and the
-- replenishment of the office capital from it («شحن من الصندوق»).
-- `driver_payout` — the driver taking his share. `driver_share_payable` has been credited by
-- `share_split` since the beginning and debited by nothing, so the liability could only ever grow.
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'wallet_adjustment';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'restoration';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'driver_payout';

-- ── fund_type ───────────────────────────────────────────────────────────────────────────────
--
-- These are ASSETS the owner names himself, in his own book, in the same column as محفظة المكتب
-- and كاش المكتب — not P&L accounts the SRS implies but never names. That is the difference
-- between them and `company_revenue`/`yalago_income`/`fee_earned`, which `repos.ts:51-61`
-- deliberately files under `cost_center` while keeping their true code.
--
-- Filing a cash asset under `cost_center` would also make `funds_branch_type_idx (branch_id, type)`
-- useless for finding them, and would route a `{kind:'driver_receivable_cash', driverId}` through
-- `ensureFund`'s driver branch into `funds_owner_type_uq (branch_id, 'cost_center', driverId)` —
-- colliding with any future driver-owned cost centre.
--
-- `company_box` is BRANCH-SCOPED on purpose. `funds.branch_id` is NOT NULL and both unique
-- constraints key on it; making it nullable would turn `funds_code_uq` into two partial indexes
-- (Postgres treats NULLs as distinct, so the constraint would stop preventing duplicates), split
-- `ensureFund`'s ON CONFLICT target, and force `OR branch_id IS NULL` into the query behind every
-- treasury balance. A wide, irreversible change to a live ledger for zero benefit at one branch.
-- The aggregate across branches IS صندوق الشركة, and it records which branch each sweep came from.
--
-- TWO receivable kinds, not one, because the owner's sheet has two: الذمم sit against كاش المكتب
-- (400,000) AND against محفظة المكتب (30,000), and الترميم must know which capital target each one
-- counts toward. Both take a `:<driverId>` suffix — a ذمة always belongs to a named driver.
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'company_box';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'driver_receivable_cash';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'driver_receivable_wallet';
