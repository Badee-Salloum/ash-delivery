-- Administrative allocations and reminders only. Linking never posts cash, debt or asset cost.
CREATE TABLE company_existing_asset_payment_events (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES company_existing_assets(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK(version>0),
  kind text NOT NULL CHECK(kind IN('link','unlink','schedule','cancel_schedule')),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK(ash_has_visible_text(reason) AND length(reason)<=500),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  UNIQUE(asset_id,version)
);
CREATE INDEX existing_asset_payments_source_idx ON company_existing_asset_payment_events((data->>'sourceKey')) WHERE kind='link';
CREATE INDEX existing_asset_payments_branch_idx ON company_existing_asset_payment_events(branch_id,asset_id,version);
CREATE FUNCTION guard_existing_asset_payment_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_card public.company_existing_assets%ROWTYPE; v_actor uuid:=public.ash_current_actor();
  v_amount bigint; v_source_amount bigint; v_currency text; v_date text; v_paid_from text;
  v_values jsonb; v_source uuid; v_entry bigint; v_allocated bigint; v_paid bigint; v_plan jsonb;
BEGIN
  IF NEW.created_by IS DISTINCT FROM v_actor OR NOT public.ash_actor_holds_all(v_actor,'company_fund.manage')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=v_actor AND active AND role_key IN('general_manager','system_admin'))
  THEN RAISE EXCEPTION 'asset payment tracking requires attributed company reviewer' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ash:financial:receivables:'||NEW.branch_id::text,0));
  SELECT * INTO v_card FROM public.company_existing_assets WHERE id=NEW.asset_id FOR UPDATE;
  IF v_card.id IS NULL OR v_card.branch_id IS DISTINCT FROM NEW.branch_id
    OR NEW.version<>(SELECT COALESCE(max(version),0)+1 FROM public.company_existing_asset_payment_events WHERE asset_id=NEW.asset_id)
  THEN RAISE EXCEPTION 'asset payment version or branch conflict' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum(replace(e.data->>'amount','.','')::bigint),0) INTO v_paid
    FROM public.company_existing_asset_payment_events e WHERE e.asset_id=NEW.asset_id AND e.kind='link'
    AND NOT EXISTS(SELECT 1 FROM public.company_existing_asset_payment_events u WHERE u.kind='unlink' AND u.data->>'paymentId'=e.id::text);
  IF NEW.kind IN('link','schedule') AND (v_card.price_minor IS NULL OR v_card.status='sold'
    OR COALESCE(v_card.snapshot->'pendingEdit','null'::jsonb)<>'null'::jsonb)
  THEN RAISE EXCEPTION 'asset payment requires effective priced unsold card' USING ERRCODE='23514'; END IF;
  IF NEW.kind='link' THEN
    IF NOT COALESCE(NEW.data->>'amount' ~ '^[0-9]+\.[0-9]{2}$',false)
      OR NOT COALESCE(NEW.data->>'sourceHash' ~ '^[0-9a-f]{64}$',false)
    THEN RAISE EXCEPTION 'invalid payment allocation' USING ERRCODE='23514'; END IF;
    v_amount:=replace(NEW.data->>'amount','.','')::bigint;
    IF NEW.data->>'sourceKey' LIKE 'command:%' THEN
      v_source:=substring(NEW.data->>'sourceKey' from 9)::uuid;
      SELECT amount_minor,currency,occurred_on::text,paid_from,journal_entry_id INTO v_source_amount,v_currency,v_date,v_paid_from,v_entry
        FROM public.company_expenses WHERE id=v_source AND branch_id=NEW.branch_id;
      SELECT payload->'values' INTO v_values FROM public.company_movement_correction_versions
        WHERE target_id=v_source AND branch_id=NEW.branch_id AND status='confirmed' ORDER BY target_version DESC LIMIT 1;
      IF v_values IS NOT NULL THEN
        v_source_amount:=replace(v_values->>'amount','.','')::bigint; v_currency:=v_values->>'currency';
        v_date:=v_values->>'occurredOn'; v_paid_from:=v_values->>'paidFrom';
        SELECT COALESCE((SELECT replacement_entry_id FROM public.company_movement_correction_versions
          WHERE target_id=v_source AND status='confirmed' AND replacement_entry_id IS NOT NULL ORDER BY target_version DESC LIMIT 1),v_entry) INTO v_entry;
      END IF;
      IF EXISTS(SELECT 1 FROM public.company_reversals WHERE target_entry_id=v_entry)
      THEN RAISE EXCEPTION 'reversed expense is not a payment' USING ERRCODE='23514'; END IF;
      IF COALESCE(NEW.data->>'newExpense','false')='true' AND (NEW.id<>v_source OR v_values IS NOT NULL)
      THEN RAISE EXCEPTION 'new expense linkage must share its original atomic receipt' USING ERRCODE='23514'; END IF;
    ELSIF NEW.data->>'sourceKey' LIKE 'historical:%' THEN
      SELECT r.original_evidence->'payload',r.occurred_on::text,r.paid_from INTO v_values,v_date,v_paid_from
        FROM public.company_historical_import_receipts r JOIN public.company_historical_import_batches b ON b.id=r.batch_id
        WHERE r.source_reference=substring(NEW.data->>'sourceKey' from 12) AND b.branch_id=NEW.branch_id
        AND r.journal_entry_id IS NULL AND r.paid_from='owner_outside' AND r.movement_type IN('expense','asset_payment');
      IF v_values IS NOT NULL THEN
        SELECT COALESCE((SELECT payload->'values' FROM public.company_historical_source_corrections
          WHERE source_reference=substring(NEW.data->>'sourceKey' from 12) ORDER BY version DESC LIMIT 1),v_values) INTO v_values;
        IF COALESCE(v_values->>'excluded','false')='true' THEN RAISE EXCEPTION 'excluded evidence is not a payment' USING ERRCODE='23514'; END IF;
        v_source_amount:=((v_values->>'amount')::numeric*100)::bigint; v_currency:=v_values->>'currency';
        v_date:=COALESCE(v_values->>'occurredOn',v_date);
      END IF;
      IF COALESCE(NEW.data->>'newExpense','false')='true' THEN RAISE EXCEPTION 'historical evidence never creates a new expense' USING ERRCODE='23514'; END IF;
    END IF;
    SELECT COALESCE(sum(replace(e.data->>'amount','.','')::bigint),0) INTO v_allocated
      FROM public.company_existing_asset_payment_events e WHERE e.branch_id=NEW.branch_id AND e.kind='link'
      AND e.data->>'sourceKey'=NEW.data->>'sourceKey'
      AND NOT EXISTS(SELECT 1 FROM public.company_existing_asset_payment_events u WHERE u.kind='unlink' AND u.data->>'paymentId'=e.id::text);
    IF v_source_amount IS NULL OR v_amount<=0 OR v_amount+v_allocated>v_source_amount OR v_amount+v_paid>v_card.price_minor
      OR v_currency IS DISTINCT FROM v_card.currency OR NEW.data->>'currency' IS DISTINCT FROM v_currency
      OR NEW.data->>'occurredOn' IS DISTINCT FROM v_date OR NEW.data->>'paidFrom' IS DISTINCT FROM v_paid_from
      OR NEW.data->>'sourceHash' IS DISTINCT FROM encode(public.digest(convert_to(replace(jsonb_build_array(
        NEW.data->>'sourceKey',to_char(v_source_amount::numeric/100,'FM9999999999999999990.00'),v_currency,v_date,v_paid_from)::text,', ',','),'UTF8'),'sha256'),'hex')
    THEN RAISE EXCEPTION 'payment source mismatch or over-allocation' USING ERRCODE='23514'; END IF;
  ELSIF NEW.kind='unlink' THEN
    IF NOT EXISTS(SELECT 1 FROM public.company_existing_asset_payment_events p WHERE p.asset_id=NEW.asset_id
      AND p.kind='link' AND p.id::text=NEW.data->>'paymentId'
      AND NOT EXISTS(SELECT 1 FROM public.company_existing_asset_payment_events u WHERE u.kind='unlink' AND u.data->>'paymentId'=p.id::text))
    THEN RAISE EXCEPTION 'unlink requires one active payment allocation' USING ERRCODE='23514'; END IF;
  ELSIF NEW.kind='schedule' THEN
    IF jsonb_typeof(NEW.data->'installments') IS DISTINCT FROM 'array' OR NOT public.ash_has_visible_text(NEW.data->>'supplier')
      OR (NEW.data->>'reminderDays')::integer NOT BETWEEN 0 AND 30
      OR NEW.data->>'priceSnapshot' IS DISTINCT FROM v_card.price_minor::text
      OR replace(NEW.data->>'baselinePaid','.','')::bigint IS DISTINCT FROM v_paid
    THEN RAISE EXCEPTION 'invalid administrative installment schedule' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(NEW.data->'installments') NOT BETWEEN 1 AND 600
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.data->'installments') r WHERE NOT COALESCE(r->>'amount' ~ '^[0-9]+\.[0-9]{2}$',false)
        OR replace(r->>'amount','.','')::bigint<=0 OR (r->>'dueOn')::date<DATE '2000-01-01')
      OR (SELECT sum(replace(r->>'amount','.','')::bigint) FROM jsonb_array_elements(NEW.data->'installments') r) IS DISTINCT FROM v_card.price_minor-v_paid
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.data->'installments') WITH ORDINALITY a(row,n)
        JOIN jsonb_array_elements(NEW.data->'installments') WITH ORDINALITY b(row,n) ON b.n=a.n+1
        WHERE b.row->>'dueOn'<=a.row->>'dueOn')
    THEN RAISE EXCEPTION 'installments must allocate exact remaining price, without a debt journal' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT data INTO v_plan FROM public.company_existing_asset_payment_events WHERE asset_id=NEW.asset_id
      AND kind IN('schedule','cancel_schedule') ORDER BY version DESC LIMIT 1;
    IF v_plan IS NULL OR NOT(v_plan ? 'installments') THEN RAISE EXCEPTION 'no active schedule to cancel' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER existing_asset_payment_guard BEFORE INSERT ON company_existing_asset_payment_events
FOR EACH ROW EXECUTE FUNCTION guard_existing_asset_payment_event();
CREATE TRIGGER existing_asset_payment_immutable BEFORE UPDATE OR DELETE ON company_existing_asset_payment_events
FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER audit_company_existing_asset_payment_events AFTER INSERT OR UPDATE OR DELETE ON company_existing_asset_payment_events
FOR EACH ROW EXECUTE FUNCTION audit_row_change();
REVOKE UPDATE,DELETE,TRUNCATE ON company_existing_asset_payment_events FROM app_user;
GRANT SELECT,INSERT ON company_existing_asset_payment_events TO app_user;

CREATE FUNCTION guard_existing_asset_payment_price() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_paid bigint;
BEGIN
  SELECT sum(replace(p.data->>'amount','.','')::bigint) INTO v_paid FROM public.company_existing_asset_payment_events p
    WHERE p.asset_id=NEW.id AND p.kind='link' AND NOT EXISTS(SELECT 1 FROM public.company_existing_asset_payment_events u WHERE u.kind='unlink' AND u.data->>'paymentId'=p.id::text);
  IF v_paid IS NOT NULL AND (NEW.currency<>OLD.currency OR NEW.price_minor IS NULL OR NEW.price_minor<v_paid)
  THEN RAISE EXCEPTION 'price or currency edit requires payment allocation review first' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER existing_asset_payment_price_guard BEFORE UPDATE ON company_existing_assets
FOR EACH ROW EXECUTE FUNCTION guard_existing_asset_payment_price();
