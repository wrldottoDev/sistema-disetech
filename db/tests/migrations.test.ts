// Check 20: the migration run itself already proves "reproducible from empty" (run.ts
// migrates disetech_test from a freshly created, empty database before any test file runs).
// This file additionally asserts the resulting catalog actually has everything: all
// tables, the two protocol functions with the exact signatures the other workstreams
// depend on, at least one trigger per table, and the two public views. Whether
// `drizzle-kit generate` reports no pending changes is the orchestrator's job, not this file's.
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import { newClient, withRollback } from "./helpers.ts";

let sql: postgres.Sql;
test.before(async () => {
  sql = await newClient();
});
test.after(async () => {
  await sql.end({ timeout: 5 });
});

const EXPECTED_TABLES = [
  "permissions",
  "role_permissions",
  "roles",
  "users",
  "catalog_items",
  "categories",
  "customer_contacts",
  "customers",
  "providers",
  "exchange_rates",
  "quotation_folio_counters",
  "quotation_items",
  "quotation_reviews",
  "quotation_revisions",
  "quotation_status_history",
  "quotations",
  "audit_logs",
  "generated_documents",
  "system_settings",
  "sessions",
  "accounts",
  "verifications",
  "passkeys",
  "two_factors",
  "rate_limits",
  "activation_invitations",
  "email_change_requests",
  "companies",
  "payment_accounts",
  "provider_costs",
];

test("check 20a: all 30 tables exist", async () => {
  await withRollback(sql, async (tx) => {
    const rows = await tx<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    const actual = new Set(rows.map((r) => r.table_name));
    assert.equal(actual.size, EXPECTED_TABLES.length, JSON.stringify([...actual]));
    for (const t of EXPECTED_TABLES) {
      assert.ok(actual.has(t), `missing table ${t}`);
    }
  });
});

test("check 20b: claim_quotation_revision and issue_quotation_revision exist with the agreed signatures", async () => {
  await withRollback(sql, async (tx) => {
    const rows = await tx<{ name: string; args: string; result: string }[]>`
      SELECT p.proname AS name,
             pg_get_function_identity_arguments(p.oid) AS args,
             pg_get_function_result(p.oid) AS result
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('claim_quotation_revision', 'issue_quotation_revision')`;
    const byName = new Map(rows.map((r) => [r.name, r]));

    const claim = byName.get("claim_quotation_revision");
    assert.ok(claim, "claim_quotation_revision not found");
    assert.equal(claim!.args, "p_revision_id uuid, p_expected_version integer");
    assert.equal(claim!.result, "integer");

    const issue = byName.get("issue_quotation_revision");
    assert.ok(issue, "issue_quotation_revision not found");
    assert.equal(
      issue!.args,
      "p_quotation_id uuid, p_revision_id uuid, p_expected_quotation_version integer, p_expected_revision_version integer, p_actor_user_id uuid",
    );
    assert.equal(issue!.result, "TABLE(folio text, revision_number integer, already_issued boolean)");
  });
});

// CR-07(b): the EXACT trigger name set per table, transcribed from every `CREATE TRIGGER` /
// `CREATE CONSTRAINT TRIGGER` in drizzle/0001-0003 (68 total, matching the audit's own count).
// "at least one trigger" would still pass if a required business trigger were dropped, as
// long as the generic TRUNCATE/touch triggers remained -- this pins the whole set instead.
const EXPECTED_TRIGGERS: Record<string, string[]> = {
  permissions: ["trg_permissions_no_truncate", "trg_permissions_no_delete"],
  role_permissions: ["trg_role_permissions_no_truncate"],
  roles: ["trg_roles_no_truncate", "trg_roles_no_delete"],
  users: ["trg_users_no_truncate", "trg_users_no_delete", "trg_users_touch_version", "trg_users_guard", "trg_users_preserve_last_admin", "trg_users_seller_requires_company"],
  companies: ["trg_companies_no_truncate", "trg_companies_no_delete", "trg_companies_touch_version"],
  payment_accounts: ["trg_payment_accounts_no_truncate", "trg_payment_accounts_no_delete", "trg_payment_accounts_touch_version"],
  provider_costs: ["trg_provider_costs_no_truncate", "trg_provider_costs_no_delete", "trg_provider_costs_no_update"],
  catalog_items: [
    "trg_catalog_items_no_truncate",
    "trg_catalog_items_no_delete",
    "trg_catalog_items_touch_version",
    "trg_catalog_items_check_merge",
  ],
  categories: ["trg_categories_no_truncate", "trg_categories_no_delete", "trg_categories_touch_version"],
  customer_contacts: [
    "trg_customer_contacts_no_truncate",
    "trg_customer_contacts_no_delete",
    "trg_customer_contacts_touch_version",
  ],
  customers: [
    "trg_customers_no_truncate",
    "trg_customers_no_delete",
    "trg_customers_touch_version",
    "trg_customers_protect_created_by",
    "trg_customers_check_owner_eligible_insert",
    "trg_customers_check_owner_eligible_update",
    "trg_customers_deferred_check",
  ],
  providers: [
    "trg_providers_no_truncate",
    "trg_providers_no_delete",
    "trg_providers_touch_version",
    "trg_providers_check_merge",
  ],
  exchange_rates: [
    "trg_exchange_rates_no_truncate",
    "trg_exchange_rates_no_delete",
    "trg_exchange_rates_no_update",
    "trg_exchange_rates_guard",
  ],
  quotation_folio_counters: [
    "trg_quotation_folio_counters_no_truncate",
    "trg_quotation_folio_counters_no_delete",
    "trg_quotation_folio_counters_guard",
  ],
  quotation_items: ["trg_quotation_items_no_truncate", "trg_quotation_items_guard"],
  quotation_reviews: [
    "trg_quotation_reviews_no_truncate",
    "trg_quotation_reviews_no_delete",
    "trg_quotation_reviews_no_update",
    "trg_quotation_reviews_guard",
  ],
  quotation_revisions: [
    "trg_quotation_revisions_no_truncate",
    "trg_quotation_revisions_touch_version",
    "trg_quotation_revisions_guard",
    "trg_revisions_deferred_check",
  ],
  quotation_status_history: [
    "trg_quotation_status_history_no_truncate",
    "trg_quotation_status_history_no_delete",
    "trg_quotation_status_history_no_update",
    "trg_quotation_status_history_guard",
  ],
  quotations: [
    "trg_quotations_no_truncate",
    "trg_quotations_no_delete",
    "trg_quotations_touch_version",
    "trg_quotations_guard",
    "trg_quotations_check_owner_eligible_insert",
    "trg_quotations_check_owner_eligible_update",
    "trg_quotations_deferred_check",
  ],
  audit_logs: ["trg_audit_logs_no_truncate", "trg_audit_logs_no_delete", "trg_audit_logs_no_update"],
  generated_documents: [
    "trg_generated_documents_no_truncate",
    "trg_generated_documents_no_delete",
    "trg_generated_documents_no_update",
    "trg_generated_documents_guard",
  ],
  system_settings: ["trg_system_settings_no_truncate", "trg_system_settings_no_delete", "trg_system_settings_touch_version"],
};

test("check 20c: the exact trigger set per table matches the migration history (79 total)", async () => {
  await withRollback(sql, async (tx) => {
    const rows = await tx<{ table_name: string; tgname: string }[]>`
      SELECT c.relname AS table_name, t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal`;

    const byTable = new Map<string, string[]>();
    for (const r of rows) {
      byTable.set(r.table_name, [...(byTable.get(r.table_name) ?? []), r.tgname]);
    }

    let total = 0;
    for (const [table, expected] of Object.entries(EXPECTED_TRIGGERS)) {
      const actual = (byTable.get(table) ?? []).sort();
      assert.deepEqual(actual, [...expected].sort(), `trigger set mismatch on ${table}`);
      total += expected.length;
    }
    assert.equal(total, 79);
    assert.equal(rows.length, 79, "unexpected trigger(s) exist outside the tables listed above");
  });
});

// CR-07(b): every CREATE FUNCTION name transcribed from drizzle/0001-0003 (21 total).
const EXPECTED_FUNCTIONS = [
  "fn_is_owner_context",
  "fn_prevent_mutation",
  "fn_touch_version",
  "fn_jsonb_has_forbidden_keys",
  "fn_exchange_rates_guard",
  "fn_protect_created_by",
  "fn_check_merge",
  "fn_check_owner_eligible",
  "fn_users_guard",
  "fn_quotations_guard",
  "fn_folio_counter_guard",
  "fn_quotation_revisions_guard",
  "fn_quotation_items_guard",
  "fn_quotation_status_history_guard",
  "fn_quotation_reviews_guard",
  "fn_generated_documents_guard",
  "fn_quotations_deferred_check",
  "fn_customers_deferred_check",
  "fn_revisions_deferred_check",
  "claim_quotation_revision",
  "issue_quotation_revision",
  "fn_preserve_last_active_admin",
  "fn_seller_requires_company",
];

test("check 20e: the exact function set matches the migration history (23 total)", async () => {
  await withRollback(sql, async (tx) => {
    const rows = await tx<{ proname: string }[]>`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'`;
    const actual = rows.map((r) => r.proname).sort();
    assert.deepEqual(actual, [...EXPECTED_FUNCTIONS].sort());
  });
});

// CR-07(b): the exact role -> permission grid seeded by 0004 (A2 U2 final grid, 24 grants).
const EXPECTED_GRANTS: Array<[string, string]> = [
  ["ADMIN", "users.manage"],
  ["ADMIN", "customers.view_all"],
  ["ADMIN", "customers.manage_all"],
  ["ADMIN", "customers.reassign"],
  ["ADMIN", "catalog.review"],
  ["ADMIN", "providers.review"],
  ["ADMIN", "quotations.view_all"],
  ["ADMIN", "audit.view"],
  ["ADMIN", "settings.manage"],
  ["SELLER", "customers.view_own"],
  ["SELLER", "customers.manage_own"],
  ["SELLER", "catalog.propose"],
  ["SELLER", "providers.propose"],
  ["SELLER", "quotations.manage_own"],
  ["COMMERCIAL_MANAGER", "customers.view_all"],
  ["COMMERCIAL_MANAGER", "catalog.review"],
  ["COMMERCIAL_MANAGER", "providers.review"],
  ["COMMERCIAL_MANAGER", "quotations.view_all"],
  ["COMMERCIAL_MANAGER", "quotations.review"],
  ["ADMINISTRATIVE_MANAGER", "customers.view_all"],
  ["ADMINISTRATIVE_MANAGER", "catalog.review"],
  ["ADMINISTRATIVE_MANAGER", "providers.review"],
  ["ADMINISTRATIVE_MANAGER", "quotations.view_all"],
  ["ADMINISTRATIVE_MANAGER", "quotations.review"],
];

test("check 20f: the seeded role -> permission grid matches A2 U2 exactly (24 grants)", async () => {
  await withRollback(sql, async (tx) => {
    const rows = await tx<{ role_code: string; permission_code: string }[]>`
      SELECT r.code AS role_code, p.code AS permission_code
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id`;
    const actual = rows.map((r): [string, string] => [r.role_code, r.permission_code]).sort();
    const expected = [...EXPECTED_GRANTS].sort();
    assert.deepEqual(actual, expected);
  });
});

test("check 20d: catalog_items_public and providers_public views exist with the agreed definition", async () => {
  await withRollback(sql, async (tx) => {
    const rows = await tx<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.views
      WHERE table_schema = 'public' AND table_name IN ('catalog_items_public', 'providers_public')`;
    assert.equal(rows.length, 2, JSON.stringify(rows));

    const defs = await tx<{ viewname: string; definition: string }[]>`
      SELECT viewname, definition FROM pg_views
      WHERE schemaname = 'public' AND viewname IN ('catalog_items_public', 'providers_public')`;
    const byName = new Map(defs.map((d) => [d.viewname, d.definition.replace(/\s+/g, " ")]));

    const catalogDef = byName.get("catalog_items_public") ?? "";
    assert.match(catalogDef, /FROM catalog_items/);
    assert.match(catalogDef, /status = 'APPROVED'::catalog_review_status/);

    const providersDef = byName.get("providers_public") ?? "";
    assert.match(providersDef, /FROM providers/);
    assert.match(providersDef, /status = 'APPROVED'::catalog_review_status/);
    // C2: no proposer/review/notes columns in the projection.
    assert.doesNotMatch(providersDef, /proposed_by_user_id|reviewed_by_user_id|reviewed_at|\bnotes\b/);
    assert.doesNotMatch(catalogDef, /proposed_by_user_id|reviewed_by_user_id|reviewed_at/);
  });
});
