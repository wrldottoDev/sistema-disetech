// Checks 1-3: users/roles integrity.
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import { expectSqlStateIn, insertUser, newClient, roleId, uniqueEmail, withRollback } from "./helpers.ts";

let sql: postgres.Sql;
test.before(async () => {
  sql = await newClient();
});
test.after(async () => {
  await sql.end({ timeout: 5 });
});

test("check 1a: exact duplicate email rejected (23505)", async () => {
  await withRollback(sql, async (tx) => {
    const email = uniqueEmail();
    await insertUser(tx, { email });
    await expectSqlStateIn(tx, "23505", async (sp) => {
      await insertUser(sp, { email });
    });
  });
});

test("check 1b: non-normalized email rejected by CHECK (23514), normalized row round-trips", async () => {
  await withRollback(sql, async (tx) => {
    const raw = `  A.${uniqueEmail().slice(0, 10)}@EXAMPLE.TEST  `;
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await insertUser(sp, { email: raw });
    });

    const normalized = uniqueEmail().toLowerCase();
    const id = await insertUser(tx, { email: normalized });
    const rows = await tx<{ email: string }[]>`SELECT email FROM users WHERE id = ${id}`;
    assert.equal(rows[0].email, normalized);
  });
});

test("check 1c: case/whitespace-variant duplicate rejected (23505 or 23514)", async () => {
  await withRollback(sql, async (tx) => {
    const email = uniqueEmail();
    await insertUser(tx, { email });
    await expectSqlStateIn(tx, ["23505", "23514"], async (sp) => {
      await insertUser(sp, { email: `  ${email.toUpperCase()}  ` });
    });
  });
});

test("check 2: user without role rejected (23502)", async () => {
  await withRollback(sql, async (tx) => {
    await expectSqlStateIn(tx, "23502", async (sp) => {
      await sp`INSERT INTO users (full_name, email, phone, role_id) VALUES ('No Role', ${uniqueEmail()}, '80000000', NULL)`;
    });
  });
});

test("check 3a: unknown role_id FK rejected (23503)", async () => {
  await withRollback(sql, async (tx) => {
    await expectSqlStateIn(tx, "23503", async (sp) => {
      await sp`INSERT INTO users (full_name, email, phone, role_id) VALUES ('Ghost Role', ${uniqueEmail()}, '80000000', gen_random_uuid())`;
    });
  });
});

test("check 3b: invalid role enum value impossible (22P02)", async () => {
  await withRollback(sql, async (tx) => {
    await expectSqlStateIn(tx, "22P02", async (sp) => {
      await sp`INSERT INTO roles (code, name) VALUES ('NOT_A_REAL_ROLE', 'x')`;
    });
  });
});

test("fixture sanity: all four seeded roles resolve", async () => {
  await withRollback(sql, async (tx) => {
    for (const code of ["ADMIN", "SELLER", "COMMERCIAL_MANAGER", "ADMINISTRATIVE_MANAGER"] as const) {
      const id = await roleId(tx, code);
      assert.ok(id);
    }
  });
});
