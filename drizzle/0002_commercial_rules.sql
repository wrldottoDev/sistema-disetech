-- 0002_commercial_rules: owner C. Customer/catalog/provider business rules (A-er-model §2, A2 C3/Q11, A3 DB-08, A4 DB-08).
-- Error codes per A3 "Error codes" table: DTI01 immutable/frozen violation, DTV01 business validation failure.

-- customers.created_by_user_id is immutable after insert (A-er-model §2 row 7).
CREATE FUNCTION fn_protect_created_by() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
    RAISE EXCEPTION '%.created_by_user_id is immutable (row %)', TG_TABLE_NAME, OLD.id USING ERRCODE = 'DTI01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_customers_protect_created_by
BEFORE UPDATE ON public.customers
FOR EACH ROW EXECUTE FUNCTION fn_protect_created_by();
--> statement-breakpoint

-- Merge rules for catalog_items/providers (A2 C3, A2 Q11 insert-path bypass).
-- INSERT: cannot arrive pre-merged. UPDATE: MERGED rows are frozen; repointing merged_into_id
-- requires the target to exist, be APPROVED (locked FOR SHARE), and this row to have no
-- incoming aliases (max one hop, no chains/cycles). Shared body via dynamic SQL (schema-qualified).
CREATE FUNCTION fn_check_merge() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_target_status public.catalog_review_status;
  v_has_incoming boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'MERGED' OR NEW.merged_into_id IS NOT NULL THEN
      RAISE EXCEPTION '%: cannot insert a row already MERGED / with merged_into_id set', TG_TABLE_NAME USING ERRCODE = 'DTV01';
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE' from here.
  IF OLD.status = 'MERGED' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id) THEN
    RAISE EXCEPTION '%: row % is MERGED and frozen; status/merged_into_id cannot change', TG_TABLE_NAME, OLD.id USING ERRCODE = 'DTI01';
  END IF;

  -- A merge target cannot be demoted out of APPROVED while other rows still point at it (F3).
  IF OLD.status = 'APPROVED' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('PENDING_REVIEW', 'REJECTED') THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE merged_into_id = $1)', TG_TABLE_SCHEMA, TG_TABLE_NAME)
      INTO v_has_incoming
      USING NEW.id;

    IF v_has_incoming THEN
      RAISE EXCEPTION '%: row % cannot leave APPROVED while other rows are merged into it', TG_TABLE_NAME, NEW.id USING ERRCODE = 'DTV01';
    END IF;
  END IF;

  IF NEW.merged_into_id IS NOT NULL AND NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    EXECUTE format('SELECT status FROM %I.%I WHERE id = $1 FOR SHARE', TG_TABLE_SCHEMA, TG_TABLE_NAME)
      INTO v_target_status
      USING NEW.merged_into_id;

    IF v_target_status IS NULL THEN
      RAISE EXCEPTION '%.merged_into_id % does not exist', TG_TABLE_NAME, NEW.merged_into_id USING ERRCODE = 'DTV01';
    END IF;
    IF v_target_status <> 'APPROVED' THEN
      RAISE EXCEPTION '%.merged_into_id % must be APPROVED (is %)', TG_TABLE_NAME, NEW.merged_into_id, v_target_status USING ERRCODE = 'DTV01';
    END IF;

    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE merged_into_id = $1)', TG_TABLE_SCHEMA, TG_TABLE_NAME)
      INTO v_has_incoming
      USING NEW.id;

    IF v_has_incoming THEN
      RAISE EXCEPTION '%: row % has rows merged into it; repoint those aliases first (no chains)', TG_TABLE_NAME, NEW.id USING ERRCODE = 'DTV01';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_catalog_items_check_merge
BEFORE INSERT OR UPDATE ON public.catalog_items
FOR EACH ROW EXECUTE FUNCTION fn_check_merge();
--> statement-breakpoint

CREATE TRIGGER trg_providers_check_merge
BEFORE INSERT OR UPDATE ON public.providers
FOR EACH ROW EXECUTE FUNCTION fn_check_merge();
--> statement-breakpoint

-- Owner eligibility: an owner_user_id must be an ACTIVE SELLER (A3/A4 DB-08).
-- Checked on customers INSERT, customers UPDATE OF owner_user_id/status (only when owner
-- actually changes or status transitions into ACTIVE = reactivation), quotations INSERT,
-- quotations UPDATE OF owner_user_id (only when it actually changes). One function, branches
-- on TG_TABLE_NAME/TG_OP to decide whether the check applies to this particular row event.
CREATE FUNCTION fn_check_owner_eligible() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_role_id uuid;
  v_role_code public.role_code;
  v_status public.user_status;
BEGIN
  IF TG_TABLE_NAME = 'customers' AND TG_OP = 'UPDATE' THEN
    IF NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id
       AND NOT (NEW.status = 'ACTIVE' AND OLD.status IS DISTINCT FROM 'ACTIVE') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'quotations' AND TG_OP = 'UPDATE' THEN
    IF NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Lock/read the user row alone first (CR-08): joining users+roles under one FOR SHARE
  -- lets EvalPlanQual drop the row entirely on a concurrent role_id update, misreporting
  -- an existing (now possibly ineligible) owner as "does not exist". Resolve role separately.
  SELECT role_id, status INTO v_role_id, v_status
  FROM public.users
  WHERE id = NEW.owner_user_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '%.owner_user_id % does not exist', TG_TABLE_NAME, NEW.owner_user_id USING ERRCODE = 'DTV01';
  END IF;

  SELECT code INTO v_role_code FROM public.roles WHERE id = v_role_id;

  IF v_role_code <> 'SELLER' OR v_status <> 'ACTIVE' THEN
    RAISE EXCEPTION '%.owner_user_id % must be an ACTIVE SELLER (role=%, status=%)', TG_TABLE_NAME, NEW.owner_user_id, v_role_code, v_status USING ERRCODE = 'DTV01';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_customers_check_owner_eligible_insert
BEFORE INSERT ON public.customers
FOR EACH ROW EXECUTE FUNCTION fn_check_owner_eligible();
--> statement-breakpoint

CREATE TRIGGER trg_customers_check_owner_eligible_update
BEFORE UPDATE OF owner_user_id, status ON public.customers
FOR EACH ROW EXECUTE FUNCTION fn_check_owner_eligible();
--> statement-breakpoint

CREATE TRIGGER trg_quotations_check_owner_eligible_insert
BEFORE INSERT ON public.quotations
FOR EACH ROW EXECUTE FUNCTION fn_check_owner_eligible();
--> statement-breakpoint

CREATE TRIGGER trg_quotations_check_owner_eligible_update
BEFORE UPDATE OF owner_user_id ON public.quotations
FOR EACH ROW EXECUTE FUNCTION fn_check_owner_eligible();
--> statement-breakpoint

-- A role change away from SELLER is blocked while the user still owns customers (any status)
-- or open quotations (DRAFT/ISSUED/SENT) — reassign ownership first (A3/A4 DB-08).
-- Deactivation (status change) is not restricted here; only role_id changes are.
CREATE FUNCTION fn_users_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_new_role_code public.role_code;
BEGIN
  IF NEW.role_id IS DISTINCT FROM OLD.role_id THEN
    SELECT code INTO v_new_role_code FROM public.roles WHERE id = NEW.role_id;

    IF v_new_role_code <> 'SELLER' THEN
      IF EXISTS (SELECT 1 FROM public.customers WHERE owner_user_id = NEW.id)
         OR EXISTS (SELECT 1 FROM public.quotations WHERE owner_user_id = NEW.id AND status IN ('DRAFT', 'ISSUED', 'SENT')) THEN
        RAISE EXCEPTION 'users: row % still owns customers or open quotations; reassign before changing role', NEW.id USING ERRCODE = 'DTV01';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_users_guard
BEFORE UPDATE OF role_id ON public.users
FOR EACH ROW EXECUTE FUNCTION fn_users_guard();
