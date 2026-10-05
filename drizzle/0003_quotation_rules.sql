-- D — Quotation-domain business rules: header/folio/revision/item guards, append-only
-- history/review guards, A3 DB-32 deferred re-check triggers, the DRAFT-claim function and
-- the canonical issuance function. Error codes per SQL-brief: DTI01 immutable/append-only/
-- privileged-only, DTQ01 not found, DTQ02 stale/not draft, DTQ03 invalid state, DTQ04 not
-- owner, DTQ05 revision not claimed, DTV01 business validation. Depends on
-- public.fn_is_owner_context() (created in 0001).
-- Interim-review fix round (F1/F2/F4/F6/F7/F8/F9/F12): every function below pins
-- search_path and qualifies fn_is_owner_context() (F1); the claim-first lock order now
-- matches DB-33 (F2/F4); revision numbering is sequential and terminal quotations are frozen
-- against new/edited/deleted DRAFT revisions (F2/F6); status_history rows are chained and
-- never target DRAFT (F7); quotations.created_at and, once terminal, owner_user_id/
-- customer_id are immutable (F8); issuance requires an ACTIVE actor and a seller snapshot
-- matching the current owner (F9/F12).

-- A2 Q1 (folio/status CHECK amendments) + Q11 (insert-path lockdown) + A3/A4 DB-34 (first
-- folio assignment is owner-context-only and must equal the allocated counter value).
CREATE FUNCTION fn_quotations_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'quotations must be created with status = DRAFT' USING ERRCODE = 'DTV01';
    END IF;
    IF NEW.folio_year IS NOT NULL OR NEW.folio_number IS NOT NULL OR NEW.sold_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'quotations must be created without folio_year/folio_number/sold_revision_id' USING ERRCODE = 'DTV01';
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.created_by_user_id <> OLD.created_by_user_id THEN
    RAISE EXCEPTION 'quotations.created_by_user_id is immutable' USING ERRCODE = 'DTI01';
  END IF;

  -- F8 — created_at is a historical fact, never editable.
  IF NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'quotations.created_at is immutable' USING ERRCODE = 'DTI01';
  END IF;

  IF OLD.folio_year IS NOT NULL AND (
       NEW.folio_year IS DISTINCT FROM OLD.folio_year OR NEW.folio_number IS DISTINCT FROM OLD.folio_number
     ) THEN
    RAISE EXCEPTION 'quotations.folio_year/folio_number are immutable once assigned' USING ERRCODE = 'DTI01';
  END IF;

  IF OLD.folio_year IS NULL AND NEW.folio_year IS NOT NULL THEN
    IF NOT public.fn_is_owner_context() THEN
      RAISE EXCEPTION 'first folio assignment is owner-context only (issue_quotation_revision)' USING ERRCODE = 'DTI01';
    END IF;
    IF OLD.status <> 'DRAFT' OR NEW.status <> 'ISSUED' THEN
      RAISE EXCEPTION 'first folio assignment must accompany a DRAFT -> ISSUED transition' USING ERRCODE = 'DTV01';
    END IF;
    IF NEW.folio_number IS DISTINCT FROM (SELECT last_number FROM public.quotation_folio_counters WHERE folio_year = NEW.folio_year) THEN
      RAISE EXCEPTION 'folio_number must equal the value just allocated from quotation_folio_counters' USING ERRCODE = 'DTV01';
    END IF;
  END IF;

  IF OLD.status <> 'DRAFT' AND NEW.status = 'DRAFT' THEN
    RAISE EXCEPTION 'quotations cannot transition back to DRAFT' USING ERRCODE = 'DTQ03';
  END IF;

  IF OLD.status <> 'DRAFT' AND NEW.customer_id <> OLD.customer_id THEN
    RAISE EXCEPTION 'quotations.customer_id is immutable once the quotation has left DRAFT' USING ERRCODE = 'DTI01';
  END IF;

  -- F8 — a closed quotation keeps its historical owner and customer (A2 C4/A3); status and
  -- sold_revision_id were already frozen here, owner_user_id/customer_id join them.
  IF OLD.status IN ('WON', 'LOST', 'CANCELLED')
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.sold_revision_id IS DISTINCT FROM OLD.sold_revision_id
          OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
          OR NEW.customer_id IS DISTINCT FROM OLD.customer_id) THEN
    RAISE EXCEPTION 'quotations in a terminal status cannot change status, sold_revision_id, owner_user_id or customer_id' USING ERRCODE = 'DTQ03';
  END IF;

  IF NEW.sold_revision_id IS NOT NULL AND NEW.sold_revision_id IS DISTINCT FROM OLD.sold_revision_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.quotation_revisions
      WHERE id = NEW.sold_revision_id AND quotation_id = NEW.id AND state = 'ISSUED'
    ) THEN
      RAISE EXCEPTION 'sold_revision_id must reference an ISSUED revision of this quotation' USING ERRCODE = 'DTV01';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_quotations_guard
BEFORE INSERT OR UPDATE ON public.quotations
FOR EACH ROW EXECUTE FUNCTION fn_quotations_guard();
--> statement-breakpoint

-- A4 DB-34 — counter writes are owner-context only; INSERT always seeds 1, UPDATE always
-- increments the same year by exactly 1 (no out-of-sequence folio, no counter DoS).
CREATE FUNCTION fn_folio_counter_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT public.fn_is_owner_context() THEN
    RAISE EXCEPTION 'quotation_folio_counters is owner-context only (issue_quotation_revision)' USING ERRCODE = 'DTI01';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.last_number <> 1 THEN
      RAISE EXCEPTION 'quotation_folio_counters must be seeded with last_number = 1' USING ERRCODE = 'DTV01';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.folio_year <> OLD.folio_year THEN
    RAISE EXCEPTION 'quotation_folio_counters.folio_year is immutable' USING ERRCODE = 'DTV01';
  END IF;
  IF NEW.last_number <> OLD.last_number + 1 THEN
    RAISE EXCEPTION 'quotation_folio_counters.last_number must increment by exactly 1' USING ERRCODE = 'DTV01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_quotation_folio_counters_guard
BEFORE INSERT OR UPDATE ON public.quotation_folio_counters
FOR EACH ROW EXECUTE FUNCTION fn_folio_counter_guard();
--> statement-breakpoint

-- A2 Q2/Q11, A3 DB-06/17/37, A4 owner-context on totals writes and DRAFT->ISSUED. F2/F6: a
-- terminal quotation is locked FOR NO KEY UPDATE and rejected on INSERT/UPDATE/DELETE of its
-- revisions, and new revisions must number sequentially.
CREATE FUNCTION fn_quotation_revisions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_quotation_status text;
  v_expected_revision_number integer;
  v_item_count integer;
  v_sum_subtotal numeric;
  v_sum_tax numeric;
  v_sum_total numeric;
  v_needs_fx boolean;
  v_rate record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state = 'ISSUED' THEN
      RAISE EXCEPTION 'quotation_revisions % is ISSUED and immutable', OLD.id USING ERRCODE = 'DTI01';
    END IF;
    IF OLD.revision_number <= 1 THEN
      RAISE EXCEPTION 'revision 1 of a quotation cannot be deleted; cancel the quotation instead' USING ERRCODE = 'DTQ03';
    END IF;

    -- F2 — lock serializes with a concurrent terminal transition on the parent.
    SELECT status INTO v_quotation_status FROM public.quotations WHERE id = OLD.quotation_id FOR NO KEY UPDATE;
    IF v_quotation_status IN ('WON', 'LOST', 'CANCELLED') THEN
      RAISE EXCEPTION 'cannot delete a revision of a quotation in a terminal status' USING ERRCODE = 'DTQ03';
    END IF;

    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'quotation_revisions must be created with state = DRAFT' USING ERRCODE = 'DTV01';
    END IF;
    IF NEW.subtotal IS NOT NULL OR NEW.tax_total IS NOT NULL OR NEW.total IS NOT NULL
       OR NEW.issued_at IS NOT NULL OR NEW.issued_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'quotation_revisions must be created without totals or issuance fields' USING ERRCODE = 'DTV01';
    END IF;

    -- F2 — lock (not a bare read) so this serializes with a concurrent terminal transition.
    SELECT status INTO v_quotation_status
      FROM public.quotations
      WHERE id = NEW.quotation_id
      FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'quotation % not found', NEW.quotation_id USING ERRCODE = 'DTQ01';
    END IF;
    IF v_quotation_status IN ('WON', 'LOST', 'CANCELLED') THEN
      RAISE EXCEPTION 'cannot add a revision to a quotation in a terminal status' USING ERRCODE = 'DTQ03';
    END IF;

    -- F6 — revision numbers are sequential per quotation, read under the lock just taken.
    SELECT coalesce(max(revision_number), 0) + 1 INTO v_expected_revision_number
      FROM public.quotation_revisions
      WHERE quotation_id = NEW.quotation_id;
    IF NEW.revision_number <> v_expected_revision_number THEN
      RAISE EXCEPTION 'quotation_revisions.revision_number must be % for quotation %', v_expected_revision_number, NEW.quotation_id USING ERRCODE = 'DTV01';
    END IF;

    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.state = 'ISSUED' THEN
    RAISE EXCEPTION 'quotation_revisions % is ISSUED and immutable', OLD.id USING ERRCODE = 'DTI01';
  END IF;

  -- F2 — any write to a DRAFT revision (including the DRAFT->ISSUED transition itself, which
  -- issuance performs only after it has already moved the header off a terminal status) is
  -- rejected while the parent quotation is terminal; the lock serializes with that transition.
  SELECT status INTO v_quotation_status FROM public.quotations WHERE id = OLD.quotation_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quotation % not found', OLD.quotation_id USING ERRCODE = 'DTQ01';
  END IF;
  IF v_quotation_status IN ('WON', 'LOST', 'CANCELLED') THEN
    RAISE EXCEPTION 'cannot modify a revision of a quotation in a terminal status' USING ERRCODE = 'DTQ03';
  END IF;

  IF NEW.quotation_id <> OLD.quotation_id
     OR NEW.revision_number <> OLD.revision_number
     OR NEW.created_by_user_id <> OLD.created_by_user_id THEN
    RAISE EXCEPTION 'quotation_id, revision_number and created_by_user_id are immutable on quotation_revisions' USING ERRCODE = 'DTI01';
  END IF;

  IF NEW.subtotal IS DISTINCT FROM OLD.subtotal
     OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
     OR NEW.total IS DISTINCT FROM OLD.total
     OR (OLD.state = 'DRAFT' AND NEW.state = 'ISSUED') THEN
    IF NOT public.fn_is_owner_context() THEN
      RAISE EXCEPTION 'writing quotation_revisions totals, or issuing, is owner-context only (issue_quotation_revision)' USING ERRCODE = 'DTI01';
    END IF;
  END IF;

  IF OLD.state = 'DRAFT' AND NEW.state = 'ISSUED' THEN
    IF v_quotation_status = 'DRAFT' THEN
      RAISE EXCEPTION 'the parent quotation must have a folio before a revision can be issued' USING ERRCODE = 'DTV01';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.quotations WHERE id = NEW.quotation_id AND customer_id = NEW.customer_id) THEN
      RAISE EXCEPTION 'quotation_revisions.customer_id must match the parent quotation at issuance' USING ERRCODE = 'DTV01';
    END IF;

    SELECT count(*), coalesce(sum(subtotal), 0), coalesce(sum(tax_amount), 0), coalesce(sum(total), 0),
           bool_or(cost_currency <> NEW.currency)
      INTO v_item_count, v_sum_subtotal, v_sum_tax, v_sum_total, v_needs_fx
      FROM public.quotation_items
      WHERE revision_id = NEW.id;

    IF v_item_count = 0 THEN
      RAISE EXCEPTION 'a revision must have at least one item to be issued' USING ERRCODE = 'DTV01';
    END IF;

    IF NEW.subtotal IS DISTINCT FROM v_sum_subtotal
       OR NEW.tax_total IS DISTINCT FROM v_sum_tax
       OR NEW.total IS DISTINCT FROM v_sum_total THEN
      RAISE EXCEPTION 'quotation_revisions totals must equal the sum of its items' USING ERRCODE = 'DTV01';
    END IF;

    IF v_needs_fx THEN
      IF NEW.exchange_rate_id IS NULL OR NEW.fx_buy IS NULL OR NEW.fx_sell IS NULL
         OR NEW.fx_rate_date IS NULL OR NEW.fx_source IS NULL OR NEW.fx_applied_rate IS NULL THEN
        RAISE EXCEPTION 'a revision with an item in a foreign cost_currency requires a complete FX snapshot' USING ERRCODE = 'DTV01';
      END IF;
    END IF;

    IF NEW.exchange_rate_id IS NOT NULL THEN
      SELECT buy_rate, sell_rate, rate_date, source INTO v_rate
        FROM public.exchange_rates WHERE id = NEW.exchange_rate_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'exchange_rate_id does not reference an existing exchange_rates row' USING ERRCODE = 'DTQ01';
      END IF;
      IF NEW.fx_buy IS DISTINCT FROM v_rate.buy_rate OR NEW.fx_sell IS DISTINCT FROM v_rate.sell_rate
         OR NEW.fx_rate_date IS DISTINCT FROM v_rate.rate_date OR NEW.fx_source IS DISTINCT FROM v_rate.source THEN
        RAISE EXCEPTION 'fx_buy/fx_sell/fx_rate_date/fx_source must equal the referenced exchange_rates row' USING ERRCODE = 'DTV01';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_quotation_revisions_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.quotation_revisions
FOR EACH ROW EXECUTE FUNCTION fn_quotation_revisions_guard();
--> statement-breakpoint

-- A4 DB-03 — parent lock closes the item-write/issuance race; the claim GUC guards against
-- accidental unclaimed/stale writes by the trusted app (not an authorization boundary).
-- CR-03: a claimed DRAFT revision of a terminal quotation is still frozen — lock the
-- quotation (via the revision's quotation_id, read unlocked first) BEFORE the revision, same
-- order as claim_quotation_revision/fn_quotation_revisions_guard, and reject terminal status.
CREATE FUNCTION fn_quotation_items_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_parent_id uuid;
  v_quotation_id uuid;
  v_quotation_status text;
  v_state public.quotation_revision_state;
  v_claimed text;
BEGIN
  v_parent_id := COALESCE(NEW.revision_id, OLD.revision_id);

  SELECT quotation_id INTO v_quotation_id FROM public.quotation_revisions WHERE id = v_parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quotation_revisions % not found', v_parent_id USING ERRCODE = 'DTQ01';
  END IF;

  SELECT status INTO v_quotation_status
    FROM public.quotations
    WHERE id = v_quotation_id
    FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quotation % not found', v_quotation_id USING ERRCODE = 'DTQ01';
  END IF;

  IF v_quotation_status IN ('WON', 'LOST', 'CANCELLED') THEN
    RAISE EXCEPTION 'cannot write quotation_items while the parent quotation is in a terminal status' USING ERRCODE = 'DTQ03';
  END IF;

  SELECT state INTO v_state
    FROM public.quotation_revisions
    WHERE id = v_parent_id
    FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quotation_revisions % not found', v_parent_id USING ERRCODE = 'DTQ01';
  END IF;

  IF v_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'quotation_items can only be written while the parent revision is DRAFT' USING ERRCODE = 'DTI01';
  END IF;

  v_claimed := current_setting('disetech.claimed_revision_id', true);
  IF v_claimed IS NULL OR v_claimed = '' OR v_claimed <> v_parent_id::text THEN
    RAISE EXCEPTION 'quotation_revisions % is not claimed in this transaction (claim_quotation_revision)', v_parent_id USING ERRCODE = 'DTQ05';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.quotation_id <> OLD.quotation_id OR NEW.revision_id <> OLD.revision_id THEN
      RAISE EXCEPTION 'quotation_items.quotation_id/revision_id are immutable' USING ERRCODE = 'DTI01';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_quotation_items_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.quotation_items
FOR EACH ROW EXECUTE FUNCTION fn_quotation_items_guard();
--> statement-breakpoint

-- A2 Q8, A4 DB-39 (lock quotation to serialize with other header writers), A4 owner-context
-- for to_status = 'ISSUED'. F7: to_status is never DRAFT, and from_status must chain onto
-- the previous row (or DRAFT for the first row of a quotation).
CREATE FUNCTION fn_quotation_status_history_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_status text;
  v_sold_revision_id uuid;
  v_revision_state public.quotation_revision_state;
  v_latest_to_status text;
BEGIN
  SELECT status, sold_revision_id INTO v_status, v_sold_revision_id
    FROM public.quotations
    WHERE id = NEW.quotation_id
    FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quotation % not found', NEW.quotation_id USING ERRCODE = 'DTQ01';
  END IF;

  IF NEW.to_status <> v_status THEN
    RAISE EXCEPTION 'quotation_status_history.to_status must equal the quotation''s current status' USING ERRCODE = 'DTV01';
  END IF;

  IF NEW.to_status = 'DRAFT' THEN
    RAISE EXCEPTION 'quotation_status_history.to_status cannot be DRAFT' USING ERRCODE = 'DTV01';
  END IF;

  SELECT to_status INTO v_latest_to_status
    FROM public.quotation_status_history
    WHERE quotation_id = NEW.quotation_id
    ORDER BY seq DESC
    LIMIT 1;

  IF NEW.from_status IS DISTINCT FROM COALESCE(v_latest_to_status, 'DRAFT') THEN
    RAISE EXCEPTION 'quotation_status_history.from_status must equal the previous to_status (or DRAFT for the first row)' USING ERRCODE = 'DTV01';
  END IF;

  IF NEW.revision_id IS NOT NULL THEN
    SELECT state INTO v_revision_state FROM public.quotation_revisions WHERE id = NEW.revision_id;
    IF NOT FOUND OR v_revision_state <> 'ISSUED' THEN
      RAISE EXCEPTION 'quotation_status_history.revision_id must reference an ISSUED revision' USING ERRCODE = 'DTV01';
    END IF;
  END IF;

  IF NEW.to_status = 'WON' AND NEW.revision_id IS DISTINCT FROM v_sold_revision_id THEN
    RAISE EXCEPTION 'a WON history row must carry the quotation''s sold_revision_id' USING ERRCODE = 'DTV01';
  END IF;

  IF NEW.to_status = 'ISSUED' AND NOT public.fn_is_owner_context() THEN
    RAISE EXCEPTION 'writing an ISSUED status_history row is owner-context only (issue_quotation_revision)' USING ERRCODE = 'DTI01';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_quotation_status_history_guard
BEFORE INSERT ON public.quotation_status_history
FOR EACH ROW EXECUTE FUNCTION fn_quotation_status_history_guard();
--> statement-breakpoint

-- A2 Q7 — a review binds to exact revision content; a later draft edit bumps
-- quotation_revisions.version, so a stale review becomes visibly outdated.
CREATE FUNCTION fn_quotation_reviews_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_version integer;
BEGIN
  SELECT version INTO v_version FROM public.quotation_revisions WHERE id = NEW.revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quotation_revisions % not found', NEW.revision_id USING ERRCODE = 'DTQ01';
  END IF;
  IF NEW.revision_version <> v_version THEN
    RAISE EXCEPTION 'quotation_reviews.revision_version must equal the current quotation_revisions.version' USING ERRCODE = 'DTV01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_quotation_reviews_guard
BEFORE INSERT ON public.quotation_reviews
FOR EACH ROW EXECUTE FUNCTION fn_quotation_reviews_guard();
--> statement-breakpoint

-- A2 Q10 — a document can only be registered for an already-ISSUED revision.
CREATE FUNCTION fn_generated_documents_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_state public.quotation_revision_state;
BEGIN
  SELECT state INTO v_state FROM public.quotation_revisions WHERE id = NEW.revision_id;
  IF NOT FOUND OR v_state <> 'ISSUED' THEN
    RAISE EXCEPTION 'generated_documents.revision_id must reference an ISSUED revision' USING ERRCODE = 'DTV01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_generated_documents_guard
BEFORE INSERT ON public.generated_documents
FOR EACH ROW EXECUTE FUNCTION fn_generated_documents_guard();
--> statement-breakpoint

-- A3 DB-32 — deferred checks reread current committed rows by id at COMMIT (or SET
-- CONSTRAINTS ... IMMEDIATE), ignoring the queued row image otherwise.
CREATE FUNCTION fn_quotations_deferred_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_status text;
  v_customer_id uuid;
  v_owner_user_id uuid;
  v_customer_owner_id uuid;
  v_latest_to_status text;
BEGIN
  v_id := NEW.id;

  SELECT status, customer_id, owner_user_id INTO v_status, v_customer_id, v_owner_user_id
    FROM public.quotations WHERE id = v_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_status IN ('DRAFT', 'ISSUED', 'SENT') THEN
    SELECT owner_user_id INTO v_customer_owner_id FROM public.customers WHERE id = v_customer_id FOR SHARE;
    IF v_customer_owner_id IS DISTINCT FROM v_owner_user_id THEN
      RAISE EXCEPTION 'quotation % owner must match its customer''s current owner', v_id USING ERRCODE = 'DTV01';
    END IF;
  END IF;

  IF v_status <> 'DRAFT' THEN
    SELECT to_status INTO v_latest_to_status
      FROM public.quotation_status_history
      WHERE quotation_id = v_id
      ORDER BY seq DESC
      LIMIT 1;
    IF v_latest_to_status IS DISTINCT FROM v_status THEN
      RAISE EXCEPTION 'quotation % has no matching latest status_history row for status %', v_id, v_status USING ERRCODE = 'DTV01';
    END IF;
  END IF;

  IF v_status IN ('ISSUED', 'SENT', 'WON', 'LOST') THEN
    IF NOT EXISTS (SELECT 1 FROM public.quotation_revisions WHERE quotation_id = v_id AND state = 'ISSUED') THEN
      RAISE EXCEPTION 'quotation % in status % must have at least one ISSUED revision', v_id, v_status USING ERRCODE = 'DTV01';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER trg_quotations_deferred_check
AFTER INSERT OR UPDATE ON public.quotations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION fn_quotations_deferred_check();
--> statement-breakpoint

CREATE FUNCTION fn_customers_deferred_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_owner_user_id uuid;
BEGIN
  SELECT owner_user_id INTO v_owner_user_id FROM public.customers WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.quotations
    WHERE customer_id = NEW.id
      AND status IN ('DRAFT', 'ISSUED', 'SENT')
      AND owner_user_id <> v_owner_user_id
  ) THEN
    RAISE EXCEPTION 'customer % has an open quotation owned by someone else', NEW.id USING ERRCODE = 'DTV01';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER trg_customers_deferred_check
AFTER UPDATE OF owner_user_id ON public.customers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION fn_customers_deferred_check();
--> statement-breakpoint

CREATE FUNCTION fn_revisions_deferred_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_state public.quotation_revision_state;
BEGIN
  SELECT state INTO v_state FROM public.quotation_revisions WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_state = 'ISSUED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.quotation_status_history
      WHERE revision_id = NEW.id AND to_status = 'ISSUED'
    ) THEN
      RAISE EXCEPTION 'quotation_revisions % is ISSUED but has no matching ISSUED status_history row', NEW.id USING ERRCODE = 'DTV01';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER trg_revisions_deferred_check
AFTER UPDATE OF state ON public.quotation_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION fn_revisions_deferred_check();
--> statement-breakpoint

-- A3 DB-03 — aggregate claim before any item mutation. F2/F4: locks the parent quotation
-- FOR NO KEY UPDATE first (DB-33 order — matches issue_quotation_revision and avoids the
-- claim-then-header-update deadlock), rejects a terminal quotation, then does the CAS UPDATE
-- which holds the revision row lock until commit (concurrent claims/issuance on that
-- revision serialize; the loser's expected version is stale -> DTQ02). GUC is
-- transaction-local (set_config(..., true)).
CREATE FUNCTION claim_quotation_revision(p_revision_id uuid, p_expected_version integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_quotation_id uuid;
  v_quotation_status text;
  v_version integer;
BEGIN
  SELECT quotation_id INTO v_quotation_id FROM public.quotation_revisions WHERE id = p_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quotation_revisions % not found', p_revision_id USING ERRCODE = 'DTQ01';
  END IF;

  SELECT status INTO v_quotation_status
    FROM public.quotations
    WHERE id = v_quotation_id
    FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quotation % not found', v_quotation_id USING ERRCODE = 'DTQ01';
  END IF;

  IF v_quotation_status IN ('WON', 'LOST', 'CANCELLED') THEN
    RAISE EXCEPTION 'quotation % is in a terminal status', v_quotation_id USING ERRCODE = 'DTQ03';
  END IF;

  UPDATE public.quotation_revisions
    SET updated_at = now()
    WHERE id = p_revision_id
      AND version = p_expected_version
      AND state = 'DRAFT'
    RETURNING version INTO v_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quotation_revisions % is stale or not DRAFT', p_revision_id USING ERRCODE = 'DTQ02';
  END IF;

  PERFORM set_config('disetech.claimed_revision_id', p_revision_id::text, true);

  RETURN v_version;
END;
$$;
--> statement-breakpoint

-- A2 Q3, amended by A3 DB-33/DB-37 (lock order, customer-change retry, owner check before
-- idempotent branch) and A4 (SECURITY DEFINER is the only owner-context path for the first
-- folio assignment, the DRAFT->ISSUED transition and the ISSUED status_history row).
-- F9/F12: the actor must be an ACTIVE user (checked alongside the owner check, before the
-- idempotent branch), and a real issuance requires the revision's seller_user_id snapshot to
-- still match the quotation's current owner (checked only past the idempotent branch, since
-- an idempotent re-issue neither reads nor needs it).
-- #variable_conflict use_column avoids ambiguity between the RETURNS TABLE output columns
-- (folio, revision_number) and the identically-named columns on quotations/quotation_revisions;
-- every SQL query below uses v_-prefixed locals instead, and the OUT columns are only ever
-- targets of plain assignment at the end.
CREATE FUNCTION issue_quotation_revision(
  p_quotation_id uuid,
  p_revision_id uuid,
  p_expected_quotation_version integer,
  p_expected_revision_version integer,
  p_actor_user_id uuid
) RETURNS TABLE (folio text, revision_number integer, already_issued boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_customer_id_before uuid;
  v_customer_id uuid;
  v_quotation_status text;
  v_quotation_folio_year smallint;
  v_quotation_version integer;
  v_quotation_owner_id uuid;
  v_revision_quotation_id uuid;
  v_revision_state public.quotation_revision_state;
  v_revision_number integer;
  v_revision_version integer;
  v_revision_seller_user_id uuid;
  v_actor_status text;
  v_now timestamptz;
  v_year smallint;
  v_folio_number integer;
  v_folio text;
  v_sum_subtotal numeric;
  v_sum_tax numeric;
  v_sum_total numeric;
BEGIN
  -- A3 DB-33 lock order: customer (FOR SHARE) -> quotation (FOR UPDATE) -> retry check ->
  -- revision (FOR UPDATE) -> counter.
  SELECT customer_id INTO v_customer_id_before FROM public.quotations WHERE id = p_quotation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quotation % not found', p_quotation_id USING ERRCODE = 'DTQ01';
  END IF;

  PERFORM 1 FROM public.customers WHERE id = v_customer_id_before FOR SHARE;

  SELECT customer_id, status, folio_year, version, owner_user_id
    INTO v_customer_id, v_quotation_status, v_quotation_folio_year, v_quotation_version, v_quotation_owner_id
    FROM public.quotations
    WHERE id = p_quotation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quotation % not found', p_quotation_id USING ERRCODE = 'DTQ01';
  END IF;

  IF v_customer_id IS DISTINCT FROM v_customer_id_before THEN
    RAISE EXCEPTION 'quotation % customer_id changed while acquiring locks, retry the transaction', p_quotation_id USING ERRCODE = '40001';
  END IF;

  SELECT quotation_id, state, revision_number, version, seller_user_id
    INTO v_revision_quotation_id, v_revision_state, v_revision_number, v_revision_version, v_revision_seller_user_id
    FROM public.quotation_revisions
    WHERE id = p_revision_id
    FOR UPDATE;

  IF NOT FOUND OR v_revision_quotation_id IS DISTINCT FROM p_quotation_id THEN
    RAISE EXCEPTION 'revision % not found for quotation %', p_revision_id, p_quotation_id USING ERRCODE = 'DTQ01';
  END IF;

  -- A3 DB-37 — owner check before the idempotent branch too.
  IF v_quotation_owner_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'actor % is not the owner of quotation %', p_actor_user_id, p_quotation_id USING ERRCODE = 'DTQ04';
  END IF;

  -- F12 — actor eligibility is checked here (not just at authorization time) so a seller
  -- deactivated after opening the transaction cannot slip an issuance through.
  SELECT status INTO v_actor_status FROM public.users WHERE id = p_actor_user_id;
  IF NOT FOUND OR v_actor_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'actor % is not an ACTIVE user', p_actor_user_id USING ERRCODE = 'DTQ04';
  END IF;

  IF v_revision_state = 'ISSUED' THEN
    SELECT q.folio INTO v_folio FROM public.quotations q WHERE q.id = p_quotation_id;
    folio := v_folio;
    revision_number := v_revision_number;
    already_issued := true;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_quotation_version IS DISTINCT FROM p_expected_quotation_version
     OR v_revision_version IS DISTINCT FROM p_expected_revision_version THEN
    RAISE EXCEPTION 'quotation % or revision % is stale', p_quotation_id, p_revision_id USING ERRCODE = 'DTQ02';
  END IF;

  IF v_quotation_status IN ('WON', 'LOST', 'CANCELLED') THEN
    RAISE EXCEPTION 'quotation % is in a terminal status', p_quotation_id USING ERRCODE = 'DTQ03';
  END IF;

  -- F9 — only a real issuance needs a fresh seller snapshot; the idempotent branch above
  -- already returned without looking at it.
  IF v_revision_seller_user_id IS DISTINCT FROM v_quotation_owner_id THEN
    RAISE EXCEPTION 'revision %.seller_user_id must match the quotation''s current owner_user_id', p_revision_id USING ERRCODE = 'DTV01';
  END IF;

  -- Linearization instant, captured after both row locks (A2 Q3).
  v_now := clock_timestamp();

  IF v_quotation_folio_year IS NULL THEN
    v_year := EXTRACT(YEAR FROM v_now AT TIME ZONE 'America/Costa_Rica');

    INSERT INTO public.quotation_folio_counters (folio_year, last_number)
      VALUES (v_year, 1)
      ON CONFLICT (folio_year) DO UPDATE SET last_number = public.quotation_folio_counters.last_number + 1
      RETURNING last_number INTO v_folio_number;

    UPDATE public.quotations
      SET status = 'ISSUED', folio_year = v_year, folio_number = v_folio_number
      WHERE id = p_quotation_id;
  ELSE
    UPDATE public.quotations
      SET status = 'ISSUED'
      WHERE id = p_quotation_id;
  END IF;

  SELECT coalesce(sum(subtotal), 0), coalesce(sum(tax_amount), 0), coalesce(sum(total), 0)
    INTO v_sum_subtotal, v_sum_tax, v_sum_total
    FROM public.quotation_items
    WHERE revision_id = p_revision_id;

  UPDATE public.quotation_revisions
    SET state = 'ISSUED',
        issued_at = v_now,
        issued_by_user_id = p_actor_user_id,
        subtotal = v_sum_subtotal,
        tax_total = v_sum_tax,
        total = v_sum_total
    WHERE id = p_revision_id;

  INSERT INTO public.quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id, changed_at)
  VALUES (p_quotation_id, p_revision_id, v_quotation_status, 'ISSUED', p_actor_user_id, v_now);

  SELECT q.folio INTO v_folio FROM public.quotations q WHERE q.id = p_quotation_id;

  folio := v_folio;
  revision_number := v_revision_number;
  already_issued := false;
  RETURN NEXT;
  RETURN;
END;
$$;
--> statement-breakpoint

-- A3 DB-33/A4 DB-34 — EXECUTE is granted to the runtime role only in runtime-grants.sql (B).
REVOKE ALL ON FUNCTION public.issue_quotation_revision(uuid, uuid, integer, integer, uuid) FROM PUBLIC;
