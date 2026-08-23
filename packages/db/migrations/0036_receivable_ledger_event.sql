-- 0036 - dedicated ledger event for direct receivable creation and later collection
--
-- PostgreSQL enum values must be committed before a later migration can use them in indexes,
-- constraints or inserts. Keep the schema mutation in this migration enum-only; 0037 installs the
-- policy and immutable command records.

-- Until this release, every `driver_receivable_*` balance meant money that would be consumed at
-- the driver's next shift open. After this release those fund names mean an ordinary debt, while
-- the new `driver_shift_funding_*` names retain the old carry-at-open behaviour. Never silently
-- reinterpret an outstanding historical claim. The coordinated production preflight must either
-- prove these balances are zero or explicitly reclassify each one in an audited release prepared
-- for that data; this migration deliberately blocks the ambiguous case.
DO $$
DECLARE
  v_nonzero_legacy_balances bigint;
BEGIN
  SELECT COUNT(*)
    INTO v_nonzero_legacy_balances
    FROM (
      SELECT f.id
        FROM funds f
        LEFT JOIN journal_lines jl ON jl.fund_id = f.id
       WHERE f.type::text IN ('driver_receivable_cash', 'driver_receivable_wallet')
       GROUP BY f.id
      HAVING COALESCE(
        SUM(CASE jl.side
          WHEN 'D' THEN jl.amount_minor::numeric
          WHEN 'C' THEN -jl.amount_minor::numeric
          ELSE 0::numeric
        END),
        0::numeric
      ) <> 0::numeric
    ) legacy_balance;

  IF v_nonzero_legacy_balances <> 0 THEN
    RAISE EXCEPTION
      'receivable kind migration blocked: % legacy driver receivable balances require explicit classification',
      v_nonzero_legacy_balances
      USING ERRCODE = '55000',
            HINT = 'Classify and reclassify every legacy balance in an audited migration; do not retry by deleting ledger history.';
  END IF;
END
$$;

ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'receivable_adjustment';

-- Keep ordinary debts separate from money deliberately staged for the next shift. The proven-empty
-- `driver_receivable_cash/wallet` funds now hold ordinary debt; only these new funds are consumed
-- automatically at open approval.
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'driver_shift_funding_cash';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'driver_shift_funding_wallet';
