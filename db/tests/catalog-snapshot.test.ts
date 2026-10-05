// CR-07 (final audit): the migrated catalog must match the reviewed snapshot exactly —
// trigger definitions (timing, events, UPDATE OF columns, row/statement, deferrable,
// bound function) and enabled state, every constraint and index definition, function
// security/config/volatility and body hash, and view definitions. Renaming-preserving
// changes (e.g. a trigger narrowed to INSERT only) fail here.
//
// After an intentional, reviewed schema change regenerate the fixture with:
//   UPDATE_CATALOG_SNAPSHOT=1 npm run test:db
// and review the fixture diff before committing.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import { newClient } from "./helpers.ts";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "catalog-snapshot.json");

let sql: postgres.Sql;
test.before(async () => {
  sql = await newClient();
});
test.after(async () => {
  await sql.end({ timeout: 5 });
});

async function snapshot(db: postgres.Sql) {
  const triggers = await db<{ table: string; name: string; def: string; enabled: string }[]>`
    SELECT c.relname AS table, t.tgname AS name, pg_get_triggerdef(t.oid) AS def, t.tgenabled AS enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY 1, 2`;
  const constraints = await db<{ table: string; name: string; def: string }[]>`
    SELECT c.relname AS table, k.conname AS name, pg_get_constraintdef(k.oid) AS def
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' ORDER BY 1, 2`;
  const indexes = await db<{ table: string; name: string; def: string }[]>`
    SELECT tablename AS table, indexname AS name, indexdef AS def
    FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`;
  const functions = await db<
    { name: string; args: string; securityDefiner: boolean; volatility: string; config: string[] | null; bodyMd5: string }[]
  >`
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
           p.prosecdef AS "securityDefiner", p.provolatile AS volatility,
           p.proconfig AS config, md5(p.prosrc) AS "bodyMd5"
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' ORDER BY 1, 2`;
  const views = await db<{ name: string; def: string }[]>`
    SELECT viewname AS name, definition AS def FROM pg_views WHERE schemaname = 'public' ORDER BY 1`;
  // Plain JSON round-trip drops postgres.js result metadata.
  return JSON.parse(JSON.stringify({ triggers, constraints, indexes, functions, views }));
}

test("CR-07: migrated catalog matches the reviewed snapshot exactly", async () => {
  const actual = await snapshot(sql);
  if (process.env.UPDATE_CATALOG_SNAPSHOT === "1") {
    writeFileSync(fixturePath, JSON.stringify(actual, null, 2) + "\n");
    return;
  }
  const expected = JSON.parse(readFileSync(fixturePath, "utf8"));
  for (const key of ["triggers", "constraints", "indexes", "functions", "views"] as const) {
    assert.deepEqual(actual[key], expected[key], `catalog ${key} differ from db/tests/fixtures/catalog-snapshot.json`);
  }
});

test("CR-07: every trigger is enabled and business triggers carry the agreed events", async () => {
  const actual = await snapshot(sql);
  for (const t of actual.triggers as { name: string; def: string; enabled: string }[]) {
    assert.equal(t.enabled, "O", `${t.name} is not enabled`);
  }
  const def = (name: string) => (actual.triggers as { name: string; def: string }[]).find((t) => t.name === name)?.def ?? "";
  // Spot checks independent of the fixture (a regenerated fixture can't silently weaken these).
  assert.match(def("trg_providers_check_merge"), /BEFORE INSERT OR UPDATE ON public\.providers FOR EACH ROW/);
  assert.match(def("trg_catalog_items_check_merge"), /BEFORE INSERT OR UPDATE ON public\.catalog_items FOR EACH ROW/);
  assert.match(def("trg_quotation_items_guard"), /BEFORE INSERT OR DELETE OR UPDATE ON public\.quotation_items FOR EACH ROW/);
  assert.match(def("trg_quotation_revisions_guard"), /BEFORE INSERT OR DELETE OR UPDATE ON public\.quotation_revisions FOR EACH ROW/);
  assert.match(def("trg_quotations_guard"), /BEFORE INSERT OR UPDATE ON public\.quotations FOR EACH ROW/);
  assert.match(def("trg_quotations_deferred_check"), /AFTER INSERT OR UPDATE ON public\.quotations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW/);
  assert.match(def("trg_customers_deferred_check"), /AFTER UPDATE OF owner_user_id ON public\.customers DEFERRABLE INITIALLY DEFERRED/);
  assert.match(def("trg_revisions_deferred_check"), /AFTER UPDATE OF state ON public\.quotation_revisions DEFERRABLE INITIALLY DEFERRED/);
  assert.match(def("trg_audit_logs_no_truncate"), /BEFORE TRUNCATE ON public\.audit_logs FOR EACH STATEMENT/);
  const fns = actual.functions as { name: string; securityDefiner: boolean; config: string[] | null }[];
  for (const f of fns) {
    assert.equal(f.securityDefiner, f.name === "issue_quotation_revision", `${f.name} SECURITY DEFINER mismatch`);
    assert.ok(f.config?.some((c) => c.startsWith("search_path=pg_catalog")), `${f.name} lacks pinned search_path`);
  }
});
