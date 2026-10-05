-- 0001_integrity_generic: generic integrity plumbing (owner: E). Order: schema
-- hardening, owner-context helper, prevent-mutation guards (G2), version/touch
-- trigger (G4), audit_logs secret-key scan (A2 I2), exchange-rate chain guard
-- (A4 DB-38 / A5 DB-40).

-- A5 DB-34: close operator/function shadowing inside SECURITY DEFINER code;
-- runtime role only ever gets USAGE on public (see db/sql/runtime-grants.sql).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint

-- F1 fix: PUBLIC has TEMPORARY on the database by default, which otherwise lets
-- the runtime role shadow catalog relations (e.g. a temp table named pg_class)
-- to spoof owner-context checks below.
DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC', current_database()); END $$;
--> statement-breakpoint

-- A4 owner-context model: true only when current_user is the actual owner of
-- the schema (or code running inside an owner-owned SECURITY DEFINER function).
-- F1 fix: pg_catalog-qualify every catalog reference and pin search_path so a
-- shadowing temp/schema object (e.g. a fake pg_class) cannot be resolved first.
CREATE FUNCTION public.fn_is_owner_context() RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT current_user = pg_catalog.pg_get_userbyid(c.relowner)
  FROM pg_catalog.pg_class c
  WHERE c.oid = 'public.quotations'::pg_catalog.regclass;
$$;
--> statement-breakpoint

-- A2 G2: generic append-only/immutable/privileged-only guard. Never touches
-- NEW/OLD so the same function works for both row-level (DELETE/UPDATE) and
-- statement-level (TRUNCATE) triggers.
CREATE FUNCTION public.fn_prevent_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'DTI01';
END;
$$;
--> statement-breakpoint

-- G2: BEFORE TRUNCATE (FOR EACH STATEMENT) on all 19 tables.
CREATE TRIGGER trg_permissions_no_truncate BEFORE TRUNCATE ON public.permissions
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_role_permissions_no_truncate BEFORE TRUNCATE ON public.role_permissions
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_roles_no_truncate BEFORE TRUNCATE ON public.roles
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_users_no_truncate BEFORE TRUNCATE ON public.users
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_catalog_items_no_truncate BEFORE TRUNCATE ON public.catalog_items
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_categories_no_truncate BEFORE TRUNCATE ON public.categories
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_customer_contacts_no_truncate BEFORE TRUNCATE ON public.customer_contacts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_customers_no_truncate BEFORE TRUNCATE ON public.customers
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_providers_no_truncate BEFORE TRUNCATE ON public.providers
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_exchange_rates_no_truncate BEFORE TRUNCATE ON public.exchange_rates
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotation_folio_counters_no_truncate BEFORE TRUNCATE ON public.quotation_folio_counters
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotation_items_no_truncate BEFORE TRUNCATE ON public.quotation_items
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotation_reviews_no_truncate BEFORE TRUNCATE ON public.quotation_reviews
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotation_revisions_no_truncate BEFORE TRUNCATE ON public.quotation_revisions
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotation_status_history_no_truncate BEFORE TRUNCATE ON public.quotation_status_history
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotations_no_truncate BEFORE TRUNCATE ON public.quotations
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_audit_logs_no_truncate BEFORE TRUNCATE ON public.audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_generated_documents_no_truncate BEFORE TRUNCATE ON public.generated_documents
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_system_settings_no_truncate BEFORE TRUNCATE ON public.system_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint

-- G2: BEFORE DELETE (row) blocked; deactivation replaces deletion for these
-- tables. role_permissions, quotation_revisions, quotation_items keep DELETE
-- (guarded separately in 0002/0003), so they are NOT in this list.
CREATE TRIGGER trg_users_no_delete BEFORE DELETE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_roles_no_delete BEFORE DELETE ON public.roles
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_permissions_no_delete BEFORE DELETE ON public.permissions
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_customers_no_delete BEFORE DELETE ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_customer_contacts_no_delete BEFORE DELETE ON public.customer_contacts
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_categories_no_delete BEFORE DELETE ON public.categories
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_catalog_items_no_delete BEFORE DELETE ON public.catalog_items
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_providers_no_delete BEFORE DELETE ON public.providers
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotations_no_delete BEFORE DELETE ON public.quotations
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotation_folio_counters_no_delete BEFORE DELETE ON public.quotation_folio_counters
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotation_status_history_no_delete BEFORE DELETE ON public.quotation_status_history
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotation_reviews_no_delete BEFORE DELETE ON public.quotation_reviews
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_exchange_rates_no_delete BEFORE DELETE ON public.exchange_rates
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_audit_logs_no_delete BEFORE DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_generated_documents_no_delete BEFORE DELETE ON public.generated_documents
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_system_settings_no_delete BEFORE DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint

-- G2: BEFORE UPDATE (row) blocked on the append-only/immutable-record tables.
CREATE TRIGGER trg_exchange_rates_no_update BEFORE UPDATE ON public.exchange_rates
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotation_reviews_no_update BEFORE UPDATE ON public.quotation_reviews
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_quotation_status_history_no_update BEFORE UPDATE ON public.quotation_status_history
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_audit_logs_no_update BEFORE UPDATE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_generated_documents_no_update BEFORE UPDATE ON public.generated_documents
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint

-- A2 G4: DB-maintained optimistic-concurrency version + display updated_at.
-- App still does WHERE id=$id AND version=$expected; 0 rows affected = conflict.
CREATE FUNCTION public.fn_touch_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_users_touch_version BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_version();
--> statement-breakpoint
CREATE TRIGGER trg_catalog_items_touch_version BEFORE UPDATE ON public.catalog_items
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_version();
--> statement-breakpoint
CREATE TRIGGER trg_categories_touch_version BEFORE UPDATE ON public.categories
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_version();
--> statement-breakpoint
CREATE TRIGGER trg_customer_contacts_touch_version BEFORE UPDATE ON public.customer_contacts
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_version();
--> statement-breakpoint
CREATE TRIGGER trg_customers_touch_version BEFORE UPDATE ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_version();
--> statement-breakpoint
CREATE TRIGGER trg_providers_touch_version BEFORE UPDATE ON public.providers
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_version();
--> statement-breakpoint
CREATE TRIGGER trg_quotation_revisions_touch_version BEFORE UPDATE ON public.quotation_revisions
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_version();
--> statement-breakpoint
CREATE TRIGGER trg_quotations_touch_version BEFORE UPDATE ON public.quotations
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_version();
--> statement-breakpoint
CREATE TRIGGER trg_system_settings_touch_version BEFORE UPDATE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_version();
--> statement-breakpoint

-- A2 I2: recursive secret-key scan of audit_logs.metadata. STRICT: NULL input
-- (not a jsonb 'null' scalar) returns NULL, never reached because the CHECK
-- below short-circuits on "metadata IS NULL OR ...".
-- CR-09: token matching instead of an unbounded substring regex (which false-
-- positived on e.g. "hashtag"/"passport_number" and missed "jwt"/"bearer").
-- Key is camelCase->snake normalized, lowercased, then split into alnum
-- tokens; forbidden on an exact single-token match (this set also folds in
-- the spec's separate "single token" concatenated forms: apikey, accesskey,
-- privatekey, backupcode, backupcodes) or an exact adjacent-token-pair match.
CREATE FUNCTION public.fn_jsonb_has_forbidden_keys(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_key text;
  v_value jsonb;
  v_elem jsonb;
  v_norm text;
  v_tokens text[];
  v_i int;
  v_forbidden_tokens CONSTANT text[] := ARRAY[
    'pass','passwd','password','pwd','secret','secrets','token','tokens','otp','totp',
    'credential','credentials','cookie','cookies','authorization','jwt','bearer','recovery',
    'hash','hashes','apikey','accesskey','privatekey','backupcode','backupcodes'
  ];
  v_forbidden_pairs CONSTANT text[] := ARRAY[
    'api key','private key','access key','backup code','backup codes','recovery code','recovery codes'
  ];
BEGIN
  IF jsonb_typeof(p) = 'object' THEN
    FOR v_key, v_value IN SELECT key, value FROM jsonb_each(p) LOOP
      -- CR-09 follow-up: split acronym boundaries (JWTToken -> JWT_Token) before
      -- the lower->Upper split, else an all-caps run + word collapses to one token.
      v_norm := regexp_replace(v_key, '([A-Z]+)([A-Z][a-z])', '\1_\2', 'g');
      v_norm := lower(regexp_replace(v_norm, '([a-z0-9])([A-Z])', '\1_\2', 'g'));
      v_tokens := array_remove(regexp_split_to_array(v_norm, '[^a-z0-9]+'), '');
      FOR v_i IN 1 .. COALESCE(array_length(v_tokens, 1), 0) LOOP
        IF v_tokens[v_i] = ANY (v_forbidden_tokens) THEN
          RETURN true;
        END IF;
        IF v_i < array_length(v_tokens, 1)
           AND (v_tokens[v_i] || ' ' || v_tokens[v_i + 1]) = ANY (v_forbidden_pairs) THEN
          RETURN true;
        END IF;
      END LOOP;
      IF public.fn_jsonb_has_forbidden_keys(v_value) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  ELSIF jsonb_typeof(p) = 'array' THEN
    FOR v_elem IN SELECT value FROM jsonb_array_elements(p) LOOP
      IF public.fn_jsonb_has_forbidden_keys(v_elem) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  ELSE
    RETURN false;
  END IF;
END;
$$;
--> statement-breakpoint

ALTER TABLE public.audit_logs ADD CONSTRAINT ck_audit_logs_metadata_no_secrets
  CHECK (metadata IS NULL OR NOT public.fn_jsonb_has_forbidden_keys(metadata));
--> statement-breakpoint

-- A4 DB-38 / A5 DB-40: predecessor must already exist (immutable rows -> every
-- edge points strictly earlier, no cycles) and share the same rate_date. No
-- FOR UPDATE per A5: immutability + composite FK + UNIQUE(supersedes_id) +
-- root-per-date uniqueness arbitrate concurrent appends (loser gets 23505).
CREATE FUNCTION public.fn_exchange_rates_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_predecessor_date date;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT rate_date INTO v_predecessor_date
    FROM public.exchange_rates
    WHERE id = NEW.supersedes_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'exchange_rates.supersedes_id % does not reference an existing row', NEW.supersedes_id
        USING ERRCODE = 'DTV01';
    END IF;

    IF v_predecessor_date <> NEW.rate_date THEN
      RAISE EXCEPTION 'exchange_rates.supersedes_id % has rate_date % but NEW.rate_date is %', NEW.supersedes_id, v_predecessor_date, NEW.rate_date
        USING ERRCODE = 'DTV01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_exchange_rates_guard BEFORE INSERT ON public.exchange_rates
FOR EACH ROW EXECUTE FUNCTION public.fn_exchange_rates_guard();
