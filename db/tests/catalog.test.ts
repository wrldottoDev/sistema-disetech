// Check 7: catalog/provider public views leak nothing commercial. Check 8: item
// snapshots survive catalog mutation. Plus: merge rules (target APPROVED, frozen
// after MERGED, alias-of-alias rejected).
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import {
  createReadyToIssueQuotation,
  expectSqlStateIn,
  insertUser,
  newClient,
  withRollback,
} from "./helpers.ts";

let sql: postgres.Sql;
test.before(async () => {
  sql = await newClient();
});
test.after(async () => {
  await sql.end({ timeout: 5 });
});

async function approve(tx: postgres.TransactionSql, table: "catalog_items" | "providers", id: string, reviewer: string) {
  await tx.unsafe(
    `UPDATE ${table} SET status = 'APPROVED', reviewed_by_user_id = $1, reviewed_at = now() WHERE id = $2`,
    [reviewer, id],
  );
}

test("check 7a: public views expose exactly the documented columns", async () => {
  await withRollback(sql, async (tx) => {
    const catalogCols = await tx<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'catalog_items_public'
      ORDER BY ordinal_position`;
    assert.deepEqual(
      catalogCols.map((r) => r.column_name),
      ["id", "name", "description", "category_id", "cabys_code", "unit"],
    );

    const providerCols = await tx<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'providers_public'
      ORDER BY ordinal_position`;
    assert.deepEqual(
      providerCols.map((r) => r.column_name),
      [
        "id",
        "legal_name",
        "commercial_name",
        "identification_type",
        "identification_number",
        "phone",
        "email",
        "address",
        "contact_name",
      ],
    );
  });
});

test("check 7b: PENDING rows are absent from the public views; APPROVED rows appear", async () => {
  await withRollback(sql, async (tx) => {
    const reviewer = await insertUser(tx, { roleCode: "COMMERCIAL_MANAGER" });
    const proposer = await insertUser(tx, { roleCode: "SELLER" });

    const [pendingRow] = await tx<{ id: string }[]>`
      INSERT INTO catalog_items (name, proposed_by_user_id) VALUES ('Pending Item', ${proposer}) RETURNING id`;
    const [approvedRow] = await tx<{ id: string }[]>`
      INSERT INTO catalog_items (name, proposed_by_user_id) VALUES ('Approved Item', ${proposer}) RETURNING id`;
    await approve(tx, "catalog_items", approvedRow.id, reviewer);

    const pendingVisible = await tx`SELECT 1 FROM catalog_items_public WHERE id = ${pendingRow.id}`;
    assert.equal(pendingVisible.length, 0);
    const approvedVisible = await tx`SELECT 1 FROM catalog_items_public WHERE id = ${approvedRow.id}`;
    assert.equal(approvedVisible.length, 1);
  });
});

test("check 7c: catalog_items/providers have no commercial-context columns and no FK into quotations/customers", async () => {
  await withRollback(sql, async (tx) => {
    const leakyColumns = await tx<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('catalog_items', 'providers')
        AND column_name ~* 'quotation|cost|price|margin|utility|customer'`;
    assert.equal(leakyColumns.length, 0, JSON.stringify(leakyColumns));

    const leakyFks = await tx<{ conname: string }[]>`
      SELECT c.conname
      FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.conrelid::regclass::text IN ('catalog_items', 'providers')
        AND c.confrelid::regclass::text IN ('quotations', 'quotation_items', 'quotation_revisions', 'customers')`;
    assert.equal(leakyFks.length, 0, JSON.stringify(leakyFks));
  });
});

test("check 8: quotation_items snapshot survives a later catalog_items rename", async () => {
  await withRollback(sql, async (tx) => {
    const proposer = await insertUser(tx, { roleCode: "SELLER" });
    const [catalogItem] = await tx<{ id: string }[]>`
      INSERT INTO catalog_items (name, proposed_by_user_id) VALUES ('Router X', ${proposer}) RETURNING id`;

    const fixture = await createReadyToIssueQuotation(tx, { sellerUserId: proposer, itemCount: 0 });
    const [item] = await tx<{ id: string }[]>`
      INSERT INTO quotation_items (quotation_id, revision_id, line_number, item_name, catalog_item_id,
        quantity, unit_cost, cost_currency, margin_percent, unit_price)
      VALUES (${fixture.quotationId}, ${fixture.revisionId}, 1, 'Router X', ${catalogItem.id}, 1, 100, 'CRC', 20, 120)
      RETURNING id`;

    await tx`UPDATE catalog_items SET name = 'Router X Pro' WHERE id = ${catalogItem.id}`;

    const rows = await tx<{ item_name: string }[]>`SELECT item_name FROM quotation_items WHERE id = ${item.id}`;
    assert.equal(rows[0].item_name, "Router X");
  });
});

test("merge rules: target must be APPROVED", async () => {
  await withRollback(sql, async (tx) => {
    const proposer = await insertUser(tx, { roleCode: "SELLER" });
    const [source] = await tx<{ id: string }[]>`
      INSERT INTO catalog_items (name, proposed_by_user_id) VALUES ('Source', ${proposer}) RETURNING id`;
    const [pendingTarget] = await tx<{ id: string }[]>`
      INSERT INTO catalog_items (name, proposed_by_user_id) VALUES ('Pending Target', ${proposer}) RETURNING id`;

    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await sp`UPDATE catalog_items SET status = 'MERGED', merged_into_id = ${pendingTarget.id} WHERE id = ${source.id}`;
    });
  });
});

test("merge rules: frozen after MERGED, alias-of-alias rejected", async () => {
  await withRollback(sql, async (tx) => {
    const reviewer = await insertUser(tx, { roleCode: "COMMERCIAL_MANAGER" });
    const proposer = await insertUser(tx, { roleCode: "SELLER" });
    const [a] = await tx<{ id: string }[]>`INSERT INTO catalog_items (name, proposed_by_user_id) VALUES ('A', ${proposer}) RETURNING id`;
    const [b] = await tx<{ id: string }[]>`INSERT INTO catalog_items (name, proposed_by_user_id) VALUES ('B', ${proposer}) RETURNING id`;
    const [c] = await tx<{ id: string }[]>`INSERT INTO catalog_items (name, proposed_by_user_id) VALUES ('C', ${proposer}) RETURNING id`;
    await approve(tx, "catalog_items", a.id, reviewer);
    await approve(tx, "catalog_items", b.id, reviewer);
    await approve(tx, "catalog_items", c.id, reviewer);

    // A merges into B: succeeds.
    await tx`UPDATE catalog_items SET status = 'MERGED', merged_into_id = ${b.id} WHERE id = ${a.id}`;

    // Frozen: an unrelated field may still change...
    await tx`UPDATE catalog_items SET name = 'A renamed' WHERE id = ${a.id}`;
    // ...but status/merged_into_id cannot.
    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`UPDATE catalog_items SET merged_into_id = ${c.id} WHERE id = ${a.id}`;
    });

    // Alias-of-alias: C cannot merge into A, because A is no longer APPROVED (it's MERGED).
    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await sp`UPDATE catalog_items SET status = 'MERGED', merged_into_id = ${a.id} WHERE id = ${c.id}`;
    });
  });
});
