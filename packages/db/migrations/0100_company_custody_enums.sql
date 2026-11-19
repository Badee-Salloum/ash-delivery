-- Real company cash held by the owner, distinct from owner's personal funding/drawings.
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'company_custody';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_custody_transfer';
