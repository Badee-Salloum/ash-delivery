-- Called after the same HQ advisory lock as all company writers. A first historical batch must
-- start from an empty HQ book, never from a cutover or an earlier manual import.
CREATE FUNCTION ash_assert_company_historical_import_ready(
  p_branch_id uuid, p_cutoff date, p_source_sha256 text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_actor uuid:=public.ash_current_actor(); v_syp bigint; v_usd bigint;
BEGIN
  IF v_actor IS NULL OR NOT public.ash_actor_holds_all(v_actor,'company_fund.manage')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=v_actor AND active
      AND role_key IN('general_manager','system_admin'))
    OR NOT EXISTS(SELECT 1 FROM public.branches WHERE id=p_branch_id AND kind='company') THEN
    RAISE EXCEPTION 'historical import requires an attributed HQ manager'
      USING ERRCODE='23514',CONSTRAINT='historical_import_preflight_actor_guard';
  END IF;
  IF EXISTS(SELECT 1 FROM public.company_historical_import_batches WHERE branch_id=p_branch_id)
    OR EXISTS(SELECT 1 FROM public.company_historical_import_batches WHERE source_sha256=p_source_sha256)
    OR EXISTS(SELECT 1 FROM public.company_ledger_cutovers WHERE company_branch_id=p_branch_id)
    OR EXISTS(SELECT 1 FROM public.journal_entries WHERE branch_id=p_branch_id
      AND (business_date<=p_cutoff OR external_reference LIKE 'HQ-SRC-%')) THEN
    RAISE EXCEPTION 'historical import requires reconciliation with existing HQ entries'
      USING ERRCODE='23514',CONSTRAINT='historical_import_preflight_existing_guard';
  END IF;
  SELECT COALESCE(sum(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END),0)::bigint
    INTO v_syp FROM public.journal_lines jl JOIN public.funds f ON f.id=jl.fund_id
    WHERE f.branch_id=p_branch_id AND f.code='company_cash:SYP_NEW';
  SELECT COALESCE(sum(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END),0)::bigint
    INTO v_usd FROM public.journal_lines jl JOIN public.funds f ON f.id=jl.fund_id
    WHERE f.branch_id=p_branch_id AND f.code='company_cash:USD';
  IF v_syp<>0 OR v_usd<>0 THEN
    RAISE EXCEPTION 'historical opening balance must be zero: % SYP minor and % USD cents',v_syp,v_usd
      USING ERRCODE='23514',CONSTRAINT='historical_import_preflight_balance_guard';
  END IF;
END $$;
REVOKE ALL ON FUNCTION ash_assert_company_historical_import_ready(uuid,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ash_assert_company_historical_import_ready(uuid,date,text) TO app_user;
