// Check 19: optimistic concurrency -- stale WHERE version=... affects 0 rows, version
// auto-increments by trigger, claim with a stale version is DTQ02, item write without a
// claim is DTQ05.
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import {
  claimRevision,
  expectSqlStateIn,
  insertCustomer,
  insertItem,
  insertQuotation,
  insertRevision,
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

test("check 19a: version auto-increments by trigger regardless of the SET clause", async () => {
  await withRollback(sql, async (tx) => {
    const seller = await insertUser(tx, { roleCode: "SELLER" });
    const customerId = await insertCustomer(tx, { ownerUserId: seller });
    const rows = await tx<{ version: number }[]>`
      UPDATE customers SET full_name = 'Renamed' WHERE id = ${customerId} RETURNING version`;
    assert.equal(rows[0].version, 2);

    const rows2 = await tx<{ version: number }[]>`
      UPDATE customers SET full_name = 'Renamed Again', version = 999 WHERE id = ${customerId} RETURNING version`;
    // The trigger always sets NEW.version := OLD.version + 1, overriding any client-supplied
    // value -- so it stays 3, not 999 or 1000.
    assert.equal(rows2[0].version, 3);
  });
});

test("check 19b: UPDATE ... WHERE version = stale affects 0 rows (no error)", async () => {
  await withRollback(sql, async (tx) => {
    const seller = await insertUser(tx, { roleCode: "SELLER" });
    const customerId = await insertCustomer(tx, { ownerUserId: seller });

    const first = await tx`UPDATE customers SET full_name = 'A' WHERE id = ${customerId} AND version = 1`;
    assert.equal(first.count, 1);

    const stale = await tx`UPDATE customers SET full_name = 'B' WHERE id = ${customerId} AND version = 1`;
    assert.equal(stale.count, 0);
  });
});

test("check 19c: claim_quotation_revision with a stale expected version raises DTQ02", async () => {
  await withRollback(sql, async (tx) => {
    const seller = await insertUser(tx, { roleCode: "SELLER" });
    const customerId = await insertCustomer(tx, { ownerUserId: seller });
    const quotation = await insertQuotation(tx, { customerId, ownerUserId: seller });
    const revision = await insertRevision(tx, { quotationId: quotation.id, customerId, sellerUserId: seller });

    await expectSqlStateIn(tx, "DTQ02", (sp) => claimRevision(sp, revision.id, revision.version + 1));

    // Now claim it for real, then a second claim attempt with the OLD (pre-claim) version
    // is also stale.
    await claimRevision(tx, revision.id, revision.version);
    await expectSqlStateIn(tx, "DTQ02", (sp) => claimRevision(sp, revision.id, revision.version));
  });
});

test("check 19d: an item write without a prior claim in this transaction raises DTQ05", async () => {
  await withRollback(sql, async (tx) => {
    const seller = await insertUser(tx, { roleCode: "SELLER" });
    const customerId = await insertCustomer(tx, { ownerUserId: seller });
    const quotation = await insertQuotation(tx, { customerId, ownerUserId: seller });
    const revision = await insertRevision(tx, { quotationId: quotation.id, customerId, sellerUserId: seller });

    await expectSqlStateIn(tx, "DTQ05", async (sp) => {
      await insertItem(sp, { quotationId: quotation.id, revisionId: revision.id });
    });
  });
});
