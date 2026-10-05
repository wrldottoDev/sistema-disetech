-- Runtime privilege grants for the non-owner application role `disetech_app`
-- (A4 "owner-context model" / A5 DB-34).
--
-- THIS IS A DEPLOYMENT SCRIPT, NOT A DRIZZLE MIGRATION. Roles are cluster-level objects,
-- not schema objects, and must never be created by the schema-owning migrator.
--
-- Prerequisite (run once, outside this file, by a cluster admin — LOGIN and password are
-- managed outside git, e.g. via the hosting provider's secret store):
--   CREATE ROLE disetech_app LOGIN PASSWORD '<managed secret, never committed>';
--
-- When to run this script: AS THE SCHEMA OWNER (the role that ran `drizzle-kit migrate`
-- and owns every table/view/function in `public`) after the initial migration, and again
-- after every later migration that adds a table, view, sequence, or function — new objects
-- get no default privileges for disetech_app until this script runs again.
--
-- Safe to re-run: every GRANT/REVOKE below is idempotent in PostgreSQL (re-granting an
-- already-held privilege, or revoking one not held, is a no-op, not an error).
--
-- Boundary this script exists to enforce (A4/A5):
--   * disetech_app gets USAGE on schema public and NOTHING ELSE at the schema level —
--     in particular it never has CREATE, so it can never shadow an operator/function
--     inside a SECURITY DEFINER call.
--   * disetech_app must NEVER be granted TEMPORARY or CREATE at the database level either
--     (interim review F1): an app role holding TEMP could create TEMP tables/views that
--     shadow an unqualified relation name a SECURITY DEFINER function resolves via its
--     search_path, spoofing catalog/lookup reads from inside owner-context code. Revoked
--     from PUBLIC too, since PostgreSQL grants both by default on every database.
--   * No TRUNCATE grant anywhere, on any table.
--   * quotation_folio_counters: SELECT only. Folio allocation happens exclusively inside
--     the SECURITY DEFINER function `issue_quotation_revision`, which runs as the schema
--     owner — fn_is_owner_context() (0001) is what the folio/issuance triggers check.
--   * Append-only tables (audit_logs, exchange_rates, generated_documents,
--     quotation_status_history, quotation_reviews) get SELECT + INSERT only — no UPDATE,
--     no DELETE; immutability is enforced by fn_prevent_mutation (0001) as a second layer.
--   * role_permissions and the two draft-mutation tables (quotation_revisions,
--     quotation_items) are the only tables where disetech_app may DELETE (A2 G2).
--   * EXECUTE on claim_quotation_revision/issue_quotation_revision only — the four
--     owner-context-only writes (A4) are otherwise unreachable from this role.

BEGIN;

-- Converge: drop every object-level privilege first so a stale/manual grant can never survive a re-run,
-- then re-grant the explicit allowlist below.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM disetech_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM disetech_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM disetech_app;

-- Never CREATE in public. Reset first so a stale/manual grant can't linger, then grant
-- back only what's needed.
REVOKE ALL ON SCHEMA public FROM disetech_app;
GRANT USAGE ON SCHEMA public TO disetech_app;

-- Never TEMPORARY or CREATE at the database level either (F1): TEMPORARY would let
-- disetech_app create TEMP tables that shadow an unqualified name and spoof a catalog
-- lookup inside a SECURITY DEFINER function's search_path. current_database() is
-- interpolated because REVOKE ... ON DATABASE takes a name, not a parameter.
DO $$ BEGIN
  EXECUTE format('REVOKE TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC, disetech_app', current_database());
END $$;

-- Regular mutable domain tables: full CRUD except DELETE (soft-delete/status-transition
-- is the app's deletion path; hard DELETE stays owner-only via triggers anyway, G2).
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.users,
  public.companies,
  public.payment_accounts,
  public.customers,
  public.customer_contacts,
  public.categories,
  public.catalog_items,
  public.providers,
  public.quotations,
  public.quotation_revisions,
  public.quotation_items,
  public.system_settings,
  public.activation_invitations,
  public.email_change_requests
TO disetech_app;

-- Better Auth runtime models. DELETE is required for session/credential revocation
-- and one-use verification cleanup; users themselves remain protected from DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.sessions,
  public.accounts,
  public.verifications,
  public.passkeys,
  public.two_factors,
  public.rate_limits
TO disetech_app;

-- Append-only tables (A2 G2): SELECT + INSERT, never UPDATE/DELETE.
GRANT SELECT, INSERT ON TABLE
  public.audit_logs,
  public.exchange_rates,
  public.generated_documents,
  public.quotation_status_history,
  public.quotation_reviews,
  public.provider_costs
TO disetech_app;

-- Read-only tables/views: RBAC catalog (app checks permissions, never edits them at
-- runtime — role/permission provisioning is an owner-run admin task), the folio counter
-- (allocation is owner-context-only, see header), and the two public projections.
GRANT SELECT ON TABLE
  public.roles,
  public.permissions,
  public.role_permissions,
  public.quotation_folio_counters,
  public.catalog_items_public,
  public.providers_public
TO disetech_app;

-- Draft-only DELETE paths (A2 G2): a DRAFT revision (revision_number > 1) and its items.
-- Enforced further by fn_quotation_revisions_guard / fn_quotation_items_guard (0003).
GRANT DELETE ON TABLE public.quotation_revisions, public.quotation_items TO disetech_app;

-- Identity sequence backing quotation_status_history.seq — needed for INSERT to work.
GRANT USAGE ON SEQUENCE public.quotation_status_history_seq_seq TO disetech_app;

-- The two functions that reach into owner-context-only operations. issue_quotation_revision
-- is SECURITY DEFINER (owned by the schema owner) with EXECUTE revoked from PUBLIC in its
-- defining migration (A5 DB-34) — this is the only grant that restores it, to this role.
GRANT EXECUTE ON FUNCTION public.claim_quotation_revision(uuid, integer) TO disetech_app;
GRANT EXECUTE ON FUNCTION public.issue_quotation_revision(uuid, uuid, integer, integer, uuid) TO disetech_app;

COMMIT;
