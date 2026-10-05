// Check 15: no destructive cascades -- every FK is RESTRICT (confdeltype = 'r').
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

test("check 15: zero FKs use CASCADE/SET NULL/SET DEFAULT; every FK is RESTRICT", async () => {
  await withRollback(sql, async (tx) => {
    const nonRestrict = await tx<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype
      FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND confdeltype <> 'r'`;
    assert.equal(nonRestrict.length, 0, JSON.stringify(nonRestrict));

    const total = await tx<{ count: string }[]>`
      SELECT count(*)::text FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`;
    // Sanity: there really are FKs to check, so a broken query can't silently pass.
    assert.ok(Number(total[0].count) > 20, `expected many FKs, got ${total[0].count}`);
  });
});
