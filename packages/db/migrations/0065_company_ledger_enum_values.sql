-- 0065 - enum values for «صندوق الشركة» as its own ledger (finance redesign, phase C1)
--
-- Enum-only, for the reason 0023, 0036, 0046 and 0055 each record: a PostgreSQL enum value must be
-- committed before a later migration can use it in an index, a constraint, a function body that is
-- executed, or an insert — and the migrator wraps each file in exactly one transaction. Everything
-- that USES these values is 0066.
--
-- ── fund_type ─────────────────────────────────────────────────────────────────────────────────
--
-- The company ledger lives in its own branch row (`branches.kind = 'company'`, added by 0066), so
-- every one of these types belongs to that row and to no branch. Each is a real account the owner
-- asked for by name (2026-09-17):
--   company_cash          the company's own cash pocket, one fund per currency (SYP_NEW, USD)
--   depreciation_reserve  «الاهتلاك» — money set aside month by month, per currency
--   company_fx_position   the transit account an exchange passes through, per currency
--   branch_clearing       «حساب الشركة لدى الفرع» — the mirror of one branch's `company_box`
--   company_payable       one debt the company owes (per debt, in the debt's currency)
--   company_receivable    one debt owed to the company (per debt, in the debt's currency)
--   fixed_asset           one purchased asset (per asset, in the purchase currency)
--   company_expense       company-level spending, by cost centre
--   company_income        company-level income that is not a delivery fee
--   company_equity        owner funding, owner drawings and opening balances
--
-- `company_box` is NOT touched: it stays a branch fund and becomes «حساب الشركة لدى الفرع».
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'company_cash';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'depreciation_reserve';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'company_fx_position';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'branch_clearing';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'company_payable';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'company_receivable';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'fixed_asset';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'company_expense';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'company_income';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'company_equity';

-- ── ledger_event ──────────────────────────────────────────────────────────────────────────────
--
-- Every one of these is a COMPANY event: 0066 refuses them in a branch ledger and refuses every
-- other event in the company ledger. Separate events rather than one generic «company» event for
-- the reason 0055 gives: a reader must tell the facts apart without reconstructing the lines.
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_opening_transfer';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_restoration_mirror';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_deposit';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_withdrawal';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_expense';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_income';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_fx_exchange';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_debt_open';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_debt_payment';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_debt_writeoff';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'asset_purchase';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'depreciation_transfer';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'depreciation_release';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_correction';
