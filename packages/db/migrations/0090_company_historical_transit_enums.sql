-- Distinct HQ-only transit account for pre-platform branch transfers. It does not touch the
-- live branch company_box / branch_clearing cutover invariant.
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'historical_branch_transit';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_historical_transfer';
