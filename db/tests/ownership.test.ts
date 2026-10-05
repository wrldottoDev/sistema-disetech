// Checks 4-6: FK orphan rejection, seller/customer ownership coherence, created_by immutability.
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import {
  expectDeferredSqlState,
  expectSqlStateIn,
  insertCustomer,
  insertQuotation,
  insertUser,
  newClient,
  roleId,
  withRollback,
} from "./helpers.ts";

let sql: postgres.Sql;
test.before(async () => {
  sql = await newClient();
});
test.after(async () => {
  await sql.end({ timeout: 5 });
});

test("check 4: orphan FKs rejected (23503)", async () => {
  await withRollback(sql, async (tx) => {
    const seller = await insertUser(tx, { roleCode: "SELLER" });

    await expectSqlStateIn(tx, "23503", async (sp) => {
      await sp`INSERT INTO customers (full_name, email, created_by_user_id, owner_user_id)
               VALUES ('Ghost creator', 'ghost1@example.test', gen_random_uuid(), ${seller})`;
    });

    await expectSqlStateIn(tx, "23503", async (sp) => {
      await sp`INSERT INTO customer_contacts (customer_id, full_name) VALUES (gen_random_uuid(), 'Ghost contact')`;
    });

    await expectSqlStateIn(tx, "23503", async (sp) => {
      await sp`INSERT INTO catalog_items (name, category_id, proposed_by_user_id) VALUES ('Ghost cat item', gen_random_uuid(), ${seller})`;
    });

    // owner_user_id pointing nowhere is intercepted by fn_check_owner_eligible (BEFORE
    // ROW, runs ahead of FK validation) and reported as DTV01, not 23503 — documented
    // divergence, not a bug: a more specific business error masks the raw FK error.
    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await sp`INSERT INTO customers (full_name, email, created_by_user_id, owner_user_id)
               VALUES ('Ghost owner', 'ghost2@example.test', ${seller}, gen_random_uuid())`;
    });
  });
});

test("check 5a: customer owner must be an ACTIVE SELLER (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const admin = await insertUser(tx, { roleCode: "ADMIN" });
    const inactiveSeller = await insertUser(tx, { roleCode: "SELLER", status: "INACTIVE" });

    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await insertCustomer(sp, { ownerUserId: admin });
    });
    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await insertCustomer(sp, { ownerUserId: inactiveSeller });
    });
  });
});

test("check 5b: quotation owner must match customer owner at commit (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const s1 = await insertUser(tx, { roleCode: "SELLER" });
    const s2 = await insertUser(tx, { roleCode: "SELLER" });
    const customerId = await insertCustomer(tx, { ownerUserId: s1 });

    await expectDeferredSqlState(tx, "DTV01", async (sp) => {
      await insertQuotation(sp, { customerId, ownerUserId: s2 });
    });
  });
});

test("check 5c: reassigning customer + its open quotations in one tx succeeds", async () => {
  await withRollback(sql, async (tx) => {
    const s1 = await insertUser(tx, { roleCode: "SELLER" });
    const s2 = await insertUser(tx, { roleCode: "SELLER" });
    const customerId = await insertCustomer(tx, { ownerUserId: s1 });
    const quotation = await insertQuotation(tx, { customerId, ownerUserId: s1 });

    await tx`UPDATE customers SET owner_user_id = ${s2} WHERE id = ${customerId}`;
    await tx`UPDATE quotations SET owner_user_id = ${s2} WHERE id = ${quotation.id}`;
    await tx`SET CONSTRAINTS ALL IMMEDIATE`;

    const rows = await tx<{ owner_user_id: string }[]>`SELECT owner_user_id FROM customers WHERE id = ${customerId}`;
    assert.equal(rows[0].owner_user_id, s2);
  });
});

test("check 5d: reassigning only the customer (leaving its open quotation behind) fails (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const s1 = await insertUser(tx, { roleCode: "SELLER" });
    const s2 = await insertUser(tx, { roleCode: "SELLER" });
    const customerId = await insertCustomer(tx, { ownerUserId: s1 });
    await insertQuotation(tx, { customerId, ownerUserId: s1 });

    await expectDeferredSqlState(tx, "DTV01", async (sp) => {
      await sp`UPDATE customers SET owner_user_id = ${s2} WHERE id = ${customerId}`;
    });
  });
});

test("check 5e: role change away from SELLER fails while the user still owns customers (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const seller = await insertUser(tx, { roleCode: "SELLER" });
    await insertCustomer(tx, { ownerUserId: seller });
    const adminRole = await roleId(tx, "ADMIN");

    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await sp`UPDATE users SET role_id = ${adminRole} WHERE id = ${seller}`;
    });
  });
});

test("check 6: created_by_user_id survives reassignment and is immutable (DTI01)", async () => {
  await withRollback(sql, async (tx) => {
    const s1 = await insertUser(tx, { roleCode: "SELLER" });
    const s2 = await insertUser(tx, { roleCode: "SELLER" });
    const customerId = await insertCustomer(tx, { ownerUserId: s1, createdByUserId: s1 });

    await tx`UPDATE customers SET owner_user_id = ${s2} WHERE id = ${customerId}`;
    const rows = await tx<{ created_by_user_id: string; owner_user_id: string }[]>`
      SELECT created_by_user_id, owner_user_id FROM customers WHERE id = ${customerId}`;
    assert.equal(rows[0].created_by_user_id, s1);
    assert.equal(rows[0].owner_user_id, s2);

    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`UPDATE customers SET created_by_user_id = ${s2} WHERE id = ${customerId}`;
    });
  });
});
