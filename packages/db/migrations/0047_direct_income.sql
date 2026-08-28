-- 0047 - «المدخول المباشر»: money arriving at the branch that is not a delivery fee
--
-- The owner asked for one convenient place where a branch manager records expenses, receivables
-- and direct income. Expenses and receivables already existed; income was being recorded as an
-- uncategorised manual journal entry, which is how a scrap sale ends up indistinguishable from a
-- correction.
--
-- MODELLED ON receivable_events (0037), NOT ON expenses (0004). `expenses.journal_entry_id` is
-- nullable, which is why the expense route carries a runtime `assertCompleteExpense` guard that
-- raises a 500 for a row that should never have been storable. Here the column is NOT NULL and
-- UNIQUE, so an income without its journal cannot exist and the guard has no counterpart to need.

CREATE TABLE income_categories (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code     text NOT NULL UNIQUE CHECK (char_length(btrim(code)) BETWEEN 1 AND 32),
  name_ar  text NOT NULL CHECK (char_length(btrim(name_ar)) BETWEEN 1 AND 120),
  active   boolean NOT NULL DEFAULT true
);

CREATE TABLE incomes (
  -- The client-owned UUID is the identity AND the idempotency key, exactly as for expenses: one
  -- durable retry key, and no second mutable mapping table to keep in step with it.
  id                uuid PRIMARY KEY,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  category_id       uuid NOT NULL REFERENCES income_categories(id) ON DELETE RESTRICT,
  -- The operator states only WHICH BOX received the money — a physical fact he knows. He never
  -- names a ledger fund, so `fundRefFromCode`'s cost-centre default cannot silently mint a
  -- look-alike account that no profit reader sums.
  channel           text NOT NULL CHECK (channel IN ('office_cash', 'office_wallet')),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  business_date     date NOT NULL,
  description       text NOT NULL
                      CHECK (ash_has_visible_text(description) AND char_length(description) <= 500),
  evidence_media_id uuid REFERENCES media(id),
  journal_entry_id  bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incomes_branch_date_idx ON incomes (branch_id, business_date, created_at);

-- Defence in depth for a non-shift journal command, mirroring je_receivable_command_uq (0037).
CREATE UNIQUE INDEX je_income_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'income';

-- An income is a posted accounting fact. Correct it with a visible dated reversal (E-6), never by
-- editing the row — the same rule the ledger itself lives under.
REVOKE UPDATE, DELETE, TRUNCATE ON incomes FROM app_user;
GRANT  SELECT, INSERT ON incomes TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON income_categories FROM app_user;
GRANT  SELECT, INSERT, UPDATE ON income_categories TO app_user;

CREATE TRIGGER audit_incomes
  AFTER INSERT OR UPDATE OR DELETE ON incomes
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

INSERT INTO income_categories (code, name_ar) VALUES
  ('other',           'دخل آخر'),
  ('asset_sale',      'بيع أصل أو خردة'),
  ('damage_recovery', 'تعويض عن ضرر'),
  ('sponsorship',     'رعاية أو إعلان');
