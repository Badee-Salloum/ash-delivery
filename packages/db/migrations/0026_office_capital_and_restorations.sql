-- ── 0026: «رأس مال المكتب» and «الترميم» — the owner's daily restoration ────────────────────
--
-- «راس مال المكتب رقم ثابت لكل من المحفظة و كاش المكتب. في نهاية كل يوم عمل يتم عملية اسمها ترميم،
-- الهدف منها سحب الارباح و ترميم النقص و اعادة راس المال على وضعه السابق مع مراعة توزع الذمم.»
--
-- Seeded from his own book: كاش المكتب 4,000,000 · محفظة المكتب 1,000,000 (المبلغ الكامل 5,000,000).

-- ── The capital target, EFFECTIVE-DATED ─────────────────────────────────────────────────────
--
-- Versioned like `tier_rules` rather than a mutable settings row, and for the same reason: raising
-- the target next month must not silently restate what every previous ترميم should have swept.
--
-- Resolution MUST filter `status IN ('active','superseded')`, never 'active' alone — publishing a
-- successor would otherwise make every historical day resolve to nothing. That is the exact trap
-- CLAUDE.md records for tier resolution, and it applies here for identical reasons.
CREATE TABLE office_capital_targets (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id      uuid NOT NULL REFERENCES branches(id),
  fund_code      text NOT NULL CHECK (fund_code IN ('office_cash', 'office_wallet')),
  target_minor   bigint NOT NULL CHECK (target_minor >= 0),
  effective_from date NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  note           text,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_capital_targets_uq UNIQUE (branch_id, fund_code, effective_from)
);
-- No partial predicate: BOTH statuses resolve (see above), so filtering the index would be a lie
-- that happens to be free — and the day a third status appears it would silently stop matching.
CREATE INDEX office_capital_targets_lookup_idx
  ON office_capital_targets (branch_id, fund_code, effective_from DESC);

-- ── The restoration itself ──────────────────────────────────────────────────────────────────
--
-- ONE PER BRANCH PER WORKING DAY, enforced by the unique index rather than by a check somebody has
-- to remember to write. A replayed POST returns 409 off this constraint.
--
-- `plan` freezes what was computed at the moment it ran — counted, receivables, target and delta
-- per box. The ledger records what MOVED; this records WHY, and the two must be readable together a
-- year later when the counted figure behind a sweep is the thing in question.
CREATE TABLE restorations (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id            uuid NOT NULL REFERENCES branches(id),
  business_date        date NOT NULL,
  cash_count_id        bigint REFERENCES cash_counts(id),
  plan                 jsonb NOT NULL,
  -- SIGNED: positive is «كييش» (profit taken), negative is «شحن من الصندوق» (capital restored).
  net_to_company_minor bigint NOT NULL,
  reason               text NOT NULL,
  performed_by         uuid NOT NULL REFERENCES users(id),
  performed_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restorations_once_per_day UNIQUE (branch_id, business_date)
);
CREATE INDEX restorations_branch_date_idx ON restorations (branch_id, business_date DESC);

-- Both tables move money or decide how much moves, so both are audited (scripts/check-sql.mjs
-- enforces this list; a new financial table without a trigger fails the build).
CREATE TRIGGER audit_office_capital_targets AFTER INSERT OR UPDATE OR DELETE ON office_capital_targets
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_restorations AFTER INSERT OR UPDATE OR DELETE ON restorations
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ── Seed the owner's own figures ────────────────────────────────────────────────────────────
--
-- Effective from the epoch so every historical day resolves to them; a later change is a NEW row
-- with a later `effective_from`, leaving the past exactly as it was settled.
INSERT INTO office_capital_targets (branch_id, fund_code, target_minor, effective_from, created_by, note)
SELECT b.id, v.fund_code, v.target_minor, DATE '2000-01-01', u.id, 'من دفتر المالك — 2026-08-12'
  FROM branches b
 CROSS JOIN (VALUES ('office_cash', 400000000::bigint), ('office_wallet', 100000000::bigint))
        AS v(fund_code, target_minor)
 CROSS JOIN LATERAL (SELECT id FROM users WHERE role_key = 'system_admin' ORDER BY created_at LIMIT 1) u
ON CONFLICT (branch_id, fund_code, effective_from) DO NOTHING;
