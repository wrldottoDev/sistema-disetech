// Check 18: audit_logs actor/target coherence, forbidden metadata keys (nested), append-only,
// HMAC identifier bound to AUTH.LOGIN_FAILURE.
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

test("check 18a: a well-formed audit_logs row round-trips", async () => {
  await withRollback(sql, async (tx) => {
    const actor = await insertUser(tx, { roleCode: "ADMIN" });
    const [row] = await tx<{ id: string; action: string; result: string }[]>`
      INSERT INTO audit_logs (actor_type, actor_user_id, action, result)
      VALUES ('USER', ${actor}, 'AUTH.LOGIN_SUCCESS', 'SUCCESS')
      RETURNING id, action, result`;
    assert.equal(row.action, "AUTH.LOGIN_SUCCESS");
    assert.equal(row.result, "SUCCESS");
  });
});

test("check 18b: actor coherence CHECK (23514)", async () => {
  await withRollback(sql, async (tx) => {
    const actor = await insertUser(tx, { roleCode: "ADMIN" });
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO audit_logs (actor_type, actor_user_id, action, result)
                VALUES ('USER', NULL, 'AUTH.LOGIN_SUCCESS', 'SUCCESS')`;
    });
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO audit_logs (actor_type, actor_user_id, action, result)
                VALUES ('SYSTEM', ${actor}, 'AUTH.LOGIN_SUCCESS', 'SUCCESS')`;
    });
  });
});

test("check 18c: target coherence CHECKs (23514)", async () => {
  await withRollback(sql, async (tx) => {
    const target = await insertUser(tx, { roleCode: "ADMIN" });
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO audit_logs (actor_type, action, result, target_type, target_id, target_user_id)
                VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS', 'user', ${target}, NULL)`;
    });
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO audit_logs (actor_type, action, result, target_type, target_id)
                VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS', 'user', NULL)`;
    });
    await tx`INSERT INTO audit_logs (actor_type, action, result, target_type, target_id, target_user_id)
              VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS', 'user', ${target}, ${target})`;
  });
});

test("check 18d: forbidden metadata keys rejected, including nested in objects and arrays (23514)", async () => {
  await withRollback(sql, async (tx) => {
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO audit_logs (actor_type, action, result, metadata)
                VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS', '{"nested": {"password": "x"}}'::jsonb)`;
    });
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO audit_logs (actor_type, action, result, metadata)
                VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS', '{"items": [{"api_key": "x"}]}'::jsonb)`;
    });
    // A harmless key is fine.
    await tx`INSERT INTO audit_logs (actor_type, action, result, metadata)
              VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS', '{"reason": "cleanup"}'::jsonb)`;
  });
});

test("check 18e: attempted_identifier_hmac only valid for ANONYMOUS AUTH.LOGIN_FAILURE (23514)", async () => {
  await withRollback(sql, async (tx) => {
    const hmac = "a".repeat(64);
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO audit_logs (actor_type, action, result, attempted_identifier_hmac)
                VALUES ('ANONYMOUS', 'AUTH.LOGIN_SUCCESS', 'SUCCESS', ${hmac})`;
    });
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO audit_logs (actor_type, action, result, attempted_identifier_hmac)
                VALUES ('SYSTEM', 'AUTH.LOGIN_FAILURE', 'FAILURE', ${hmac})`;
    });
    await tx`INSERT INTO audit_logs (actor_type, action, result, attempted_identifier_hmac)
              VALUES ('ANONYMOUS', 'AUTH.LOGIN_FAILURE', 'FAILURE', ${hmac})`;
  });
});

test("check 18f: audit_logs is append-only (DTI01)", async () => {
  await withRollback(sql, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO audit_logs (actor_type, action, result) VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS') RETURNING id`;
    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`UPDATE audit_logs SET action = 'X' WHERE id = ${row.id}`;
    });
    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`DELETE FROM audit_logs WHERE id = ${row.id}`;
    });
    // TRUNCATE on audit_logs is covered by revisions.test.ts check 14c.
  });
});
