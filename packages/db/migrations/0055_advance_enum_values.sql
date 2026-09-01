-- 0055 - enum values for «السلفة»: an expense that must come back (owner decision 17)
--
-- Enum-only, for the reason 0023, 0036 and 0046 each record: a PostgreSQL enum value must be
-- committed before a later migration can use it in an index, a constraint or an insert, and the
-- migrator wraps each file in exactly one transaction. Everything that USES these values is in 0056.
--
-- TWO fund_type VALUES ARE ADDED HERE, unlike 0046, and the difference is the whole point of the
-- instrument. `other_income` gained no fund_type because it is a profit-and-loss account and not a
-- box anyone counts. An outstanding سلفة is the opposite: it is money the company still owns, out
-- on loan rather than spent, and الترميم must count it toward رأس مال المكتب exactly as it counts a
-- ذمة — otherwise every night reads the emptier box as a shortfall and «شحن» real money out of
-- صندوق الشركة to refill it. So these are counted assets, filed like driver_receivable_*.
--
-- Cash and wallet are separate for the same reason the ذمم are: each box is restored against its
-- own capital target, so the ledger has to know which target an outstanding advance counts toward.
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'advance_receivable_cash';
ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'advance_receivable_wallet';

-- Three events, not one, because they are three different facts about the same money and a reader
-- must tell them apart without reconstructing the lines: it went out, some came back, or the
-- company gave up and finally spent it. Only the third moves office capital.
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'advance';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'advance_repayment';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'advance_conversion';
