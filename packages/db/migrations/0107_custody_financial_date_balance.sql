-- Ending balance alone is not enough: no historical custody spending may use a later handover.
CREATE OR REPLACE FUNCTION assert_company_custody_not_negative() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_fund uuid;
BEGIN
  SELECT id INTO v_fund FROM public.funds WHERE id=NEW.fund_id AND type::text='company_custody';
  IF v_fund IS NULL THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM (
    SELECT sum(v.net) OVER(ORDER BY v.business_date,v.entry_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS held
    FROM (SELECT j.business_date,j.id AS entry_id,sum(CASE l.side WHEN 'D' THEN l.amount_minor ELSE -l.amount_minor END) AS net
      FROM public.journal_lines l JOIN public.journal_entries j ON j.id=l.entry_id
      WHERE l.fund_id=v_fund GROUP BY j.business_date,j.id) v
    ) timeline WHERE held<0)
  THEN RAISE EXCEPTION 'custody cannot spend money before its actual financial-date handover'
    USING ERRCODE='23514',CONSTRAINT='company_custody_negative_guard'; END IF;
  RETURN NULL;
END $$;
