-- Keep calculation histories and approval receipts immutable outside the explicit review command.
CREATE FUNCTION guard_existing_asset_calculation_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_prior jsonb;
BEGIN
  SELECT snapshot INTO v_prior FROM public.company_existing_assets WHERE id=NEW.asset_id FOR UPDATE;
  IF NEW.kind<>'edit_confirm' AND (
    COALESCE(NEW.snapshot->'depreciationSchedule','null'::jsonb) IS DISTINCT FROM COALESCE(v_prior->'depreciationSchedule','null'::jsonb)
    OR COALESCE(NEW.snapshot->'lastEditReview','null'::jsonb) IS DISTINCT FROM COALESCE(v_prior->'lastEditReview','null'::jsonb))
  THEN RAISE EXCEPTION 'calculation history changes require exact reviewed edit' USING ERRCODE='23514'; END IF;
  IF NEW.kind='edit' AND (COALESCE(v_prior->'depreciation','null'::jsonb)<>'null'::jsonb
    OR COALESCE(v_prior->'recognition','null'::jsonb)<>'null'::jsonb OR v_prior->>'status'='sold')
    AND EXISTS(SELECT 1 FROM unnest(ARRAY['price','currency','vehicleId','useStartedOn','purchasedOn']) k
      WHERE NEW.snapshot->k IS DISTINCT FROM v_prior->k)
  THEN RAISE EXCEPTION 'protected asset facts remain a proposal until reviewed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_existing_asset_history_guard BEFORE INSERT ON company_existing_asset_events
FOR EACH ROW EXECUTE FUNCTION guard_existing_asset_calculation_history();

-- A key spent on historical linking cannot be spent again as an ordinary HQ command.
CREATE FUNCTION guard_company_historical_link_command_key() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF TG_TABLE_NAME='company_historical_branch_links' THEN
    IF EXISTS(SELECT 1 FROM public.company_moves WHERE id=NEW.id)
      OR EXISTS(SELECT 1 FROM public.company_expenses WHERE id=NEW.id)
      OR EXISTS(SELECT 1 FROM public.company_incomes WHERE id=NEW.id)
      OR EXISTS(SELECT 1 FROM public.company_fx_exchanges WHERE id=NEW.id)
      OR EXISTS(SELECT 1 FROM public.company_reversals WHERE id=NEW.id)
    THEN RAISE EXCEPTION 'historical linking key already belongs to a company command' USING ERRCODE='23514'; END IF;
  ELSE
    v_id:=NEW.id;
    IF EXISTS(SELECT 1 FROM public.company_historical_branch_links WHERE id=v_id)
    THEN RAISE EXCEPTION 'company command key already belongs to historical linking' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_historical_link_key_guard BEFORE INSERT ON company_historical_branch_links FOR EACH ROW EXECUTE FUNCTION guard_company_historical_link_command_key();
CREATE TRIGGER company_moves_historical_link_key_guard BEFORE INSERT ON company_moves FOR EACH ROW EXECUTE FUNCTION guard_company_historical_link_command_key();
CREATE TRIGGER company_expenses_historical_link_key_guard BEFORE INSERT ON company_expenses FOR EACH ROW EXECUTE FUNCTION guard_company_historical_link_command_key();
CREATE TRIGGER company_incomes_historical_link_key_guard BEFORE INSERT ON company_incomes FOR EACH ROW EXECUTE FUNCTION guard_company_historical_link_command_key();
CREATE TRIGGER company_fx_historical_link_key_guard BEFORE INSERT ON company_fx_exchanges FOR EACH ROW EXECUTE FUNCTION guard_company_historical_link_command_key();
CREATE TRIGGER company_reversals_historical_link_key_guard BEFORE INSERT ON company_reversals FOR EACH ROW EXECUTE FUNCTION guard_company_historical_link_command_key();
