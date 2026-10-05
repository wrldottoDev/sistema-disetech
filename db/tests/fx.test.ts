// Plus: exchange_rates correction chain (A3 DB-36 / A4 DB-38 / A5 DB-40) -- acyclic by
// construction, one root per date, at most one successor per row.
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import { expectSqlStateIn, insertUser, newClient, withRollback } from "./helpers.ts";

let sql: postgres.Sql;
test.before(async () => {
  sql = await newClient();
});
test.after(async () => {
  await sql.end({ timeout: 5 });
});

async function insertRoot(tx: postgres.TransactionSql, rateDate: string) {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO exchange_rates (rate_date, source, buy_rate, sell_rate)
    VALUES (${rateDate}, 'BCCR', 500, 510)
    RETURNING id`;
  return row.id;
}

async function insertCorrection(tx: postgres.TransactionSql, rateDate: string, supersedesId: string, creator: string) {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO exchange_rates (rate_date, source, buy_rate, sell_rate, created_by_user_id, supersedes_id)
    VALUES (${rateDate}, 'MANUAL', 501, 511, ${creator}, ${supersedesId})
    RETURNING id`;
  return row.id;
}

test("fx chain: two successive manual corrections on the same date succeed", async () => {
  await withRollback(sql, async (tx) => {
    const admin = await insertUser(tx, { roleCode: "ADMIN" });
    const date = "2026-05-01";
    const root = await insertRoot(tx, date);
    const c1 = await insertCorrection(tx, date, root, admin);
    const c2 = await insertCorrection(tx, date, c1, admin);

    const effective = await tx<{ id: string }[]>`
      SELECT r.id FROM exchange_rates r
      WHERE r.rate_date = ${date} AND NOT EXISTS (SELECT 1 FROM exchange_rates s WHERE s.supersedes_id = r.id)`;
    assert.equal(effective.length, 1);
    assert.equal(effective[0].id, c2);
  });
});

test("fx chain: a fork (two rows supersede the same row) is rejected (23505)", async () => {
  await withRollback(sql, async (tx) => {
    const admin = await insertUser(tx, { roleCode: "ADMIN" });
    const date = "2026-05-02";
    const root = await insertRoot(tx, date);
    await insertCorrection(tx, date, root, admin);

    await expectSqlStateIn(tx, "23505", async (sp) => {
      await insertCorrection(sp, date, root, admin);
    });
  });
});

test("fx chain: self-reference is rejected", async () => {
  await withRollback(sql, async (tx) => {
    const admin = await insertUser(tx, { roleCode: "ADMIN" });
    // ck_exchange_rates_supersedes_not_self (23514) is the structural backstop, but
    // fn_exchange_rates_guard (BEFORE INSERT) runs first and looks up supersedes_id by a
    // plain SELECT: the row being inserted doesn't exist yet at that point, so a
    // self-reference reads as "predecessor not found" -> DTV01, before the CHECK is ever
    // reached. Triggers running before constraints is correct Postgres behavior; the
    // invariant under test is just "rejected".
    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await sp`
        WITH r AS (SELECT gen_random_uuid() AS id)
        INSERT INTO exchange_rates (id, rate_date, source, buy_rate, sell_rate, created_by_user_id, supersedes_id)
        SELECT id, '2026-05-03', 'MANUAL', 500, 510, ${admin}, id FROM r`;
    });
  });
});

test("fx chain: a second root for the same date is rejected (23505)", async () => {
  await withRollback(sql, async (tx) => {
    const date = "2026-05-04";
    await insertRoot(tx, date);
    await expectSqlStateIn(tx, "23505", async (sp) => {
      await insertRoot(sp, date);
    });
  });
});

test("fx chain: a correction for a different date than its predecessor is rejected", async () => {
  await withRollback(sql, async (tx) => {
    const admin = await insertUser(tx, { roleCode: "ADMIN" });
    const root = await insertRoot(tx, "2026-05-05");
    // The composite FK (supersedes_id, rate_date) -> (id, rate_date) is the structural
    // backstop (23503), but fn_exchange_rates_guard's own predecessor-date check (BEFORE
    // INSERT) raises DTV01 first -- same "trigger before constraint" ordering as above.
    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await insertCorrection(sp, "2026-05-06", root, admin);
    });
  });
});
