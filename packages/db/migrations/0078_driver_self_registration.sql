-- 0078 — public driver self-registration
--
-- Attempts contain no address, username, password, or profile data: only a one-way address hash
-- and its time. Rows are append-only during their 24-hour retention window; opportunistic cleanup
-- is the only delete path.

CREATE TABLE driver_registration_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address_sha256 char(64) NOT NULL
    CHECK (address_sha256 ~ '^[0-9a-f]{64}$'),
  attempted_at timestamptz NOT NULL
);

CREATE INDEX driver_registration_attempts_address_time_idx
  ON driver_registration_attempts (address_sha256, attempted_at DESC);
CREATE INDEX driver_registration_attempts_retention_idx
  ON driver_registration_attempts (attempted_at);

REVOKE UPDATE, TRUNCATE ON driver_registration_attempts FROM app_user;
GRANT SELECT, INSERT, DELETE ON driver_registration_attempts TO app_user;
GRANT USAGE, SELECT ON SEQUENCE driver_registration_attempts_id_seq TO app_user;

-- Credential material does not belong in the generic JSON audit stream. This also repairs the
-- pre-existing user trigger, which recorded bcrypt hashes before public registration existed.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor   uuid;
  v_kind    text;
  v_request text;
  v_record  text;
  v_before  jsonb;
  v_after   jsonb;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN others THEN
    v_actor := NULL;
  END;
  v_request := NULLIF(current_setting('app.request_id', true), '');
  v_kind := CASE
              WHEN v_actor IS NOT NULL THEN 'user'
              WHEN v_request IS NOT NULL THEN 'anonymous'
              ELSE 'system'
            END;
  v_record := CASE TG_OP WHEN 'DELETE' THEN (to_jsonb(OLD) ->> 'id') ELSE (to_jsonb(NEW) ->> 'id') END;
  v_before := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) - 'password_hash' - 'mfa_secret_enc' END;
  v_after := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) - 'password_hash' - 'mfa_secret_enc' END;

  INSERT INTO public.audit_log (table_name, record_id, action, actor_id, actor_kind, request_id, before, after)
  VALUES (TG_TABLE_NAME, COALESCE(v_record, '<none>'), TG_OP, v_actor, v_kind, v_request, v_before, v_after);
  RETURN COALESCE(NEW, OLD);
END
$$;
