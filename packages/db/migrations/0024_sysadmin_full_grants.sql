-- ── 0024: the system admin gets everything, and two events learn to demand a reason ─────────
--
-- Uses the enum values added by 0023. It cannot be merged into that file: a CHECK constraint
-- naming 'restoration' would cast the literal to `ledger_event` inside the same transaction that
-- created it, which Postgres refuses. See 0023's header and 0012:8-9.
--
-- ── OWNER DECISION 9 (2026-08-12) ───────────────────────────────────────────────────────────
--
-- «اعطي صلاحية وصول لكل شيء لمدير النظام و صلاحية لفعل كل شيء» — give the system admin access to
-- everything and permission to do everything. Given twice, in writing, after the narrower rule was
-- explained. It supersedes ASSUMPTIONS D-5 (manual entries and expenses: BM ✓ GM ✓ sysadmin ✗) and
-- AMENDS BR8, whose «رؤية الأرباح والحصص الإجمالية: المدير العام فقط» made `profit.view_total`
-- General-Manager-only.
--
-- This is legitimate rather than a violation: SRS §3 / A-2 make the permission matrix explicitly
-- customisable BY THE SYSTEM ADMIN with every change logged, and `Permissions.tsx` already edits
-- it as data. One row reverses it.
--
-- WHY A DATA MIGRATION IS MANDATORY, not just editing DEFAULT_GRANTS: the constant seeds a fresh
-- database and nothing else. Production's `role_permissions` was seeded long ago — measured before
-- writing this, it holds 32 rows and `system_admin` has 11 of the 16 permissions. The five it lacks
-- are exactly the ones the owner is asking for: cash_count.perform, expense.write,
-- journal.manual.write, profit.view_total, shift.operate. Editing the constant alone would change
-- the tests and leave the live system exactly as it was.
--
-- The `role_permissions` audit trigger fires with no actor GUC set, recording actor_kind='system'.
-- That is truthful: a migration made this change, not a person clicking a screen.
INSERT INTO role_permissions (role_key, permission_key, scope)
SELECT 'system_admin', p.key, 'all'
  FROM permissions p
ON CONFLICT (role_key, permission_key) DO UPDATE SET scope = 'all';

-- ── A reason is not optional for money that moves by decision ────────────────────────────────
--
-- 0004:128 forced a reason on 'manual' and 'correction' — the two events that existed then whose
-- amount is chosen by a human rather than derived from a shift. `restoration` and `driver_payout`
-- are the same kind of thing: الترميم is the manager saying "sweep this much profit", and a payout
-- is a decision about someone's money. Both must be answerable a month later.
--
-- DROP then ADD rather than a second constraint, so there is exactly one rule to read.
ALTER TABLE journal_entries DROP CONSTRAINT je_reason_ck;
ALTER TABLE journal_entries ADD CONSTRAINT je_reason_ck
  CHECK (event_type NOT IN ('manual', 'correction', 'restoration', 'driver_payout') OR reason IS NOT NULL);
