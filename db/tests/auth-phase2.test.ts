import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type postgres from "postgres";
import { expectSqlStateIn, newClient, roleId, uniqueEmail, withRollback } from "./helpers.ts";

let sql: postgres.Sql;
test.before(async () => { sql = await newClient(); });
test.after(async () => { await sql.end({ timeout: 5 }); });

test("auth tables and two-factor user field exist", async () => {
  const rows = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('sessions','accounts','verifications','passkeys','two_factors','rate_limits','activation_invitations','email_change_requests')`;
  assert.equal(rows.length, 8);
  const columns = await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='two_factor_enabled'`;
  assert.equal(columns.length, 1);
});

test("only one live activation invitation exists per user and hashes are required", async () => {
  await withRollback(sql, async (tx) => {
    const role = await roleId(tx, "COMMERCIAL_MANAGER");
    const [user] = await tx<{ id: string }[]>`INSERT INTO users(full_name,email,phone,role_id) VALUES ('Invited',${uniqueEmail()},'80000000',${role}) RETURNING id`;
    const hash = randomBytes(32).toString("hex");
    await tx`INSERT INTO activation_invitations(user_id,token_hash,expires_at) VALUES (${user.id},${hash},now()+interval '24 hours')`;
    await expectSqlStateIn(tx, "23505", (sp) => sp`INSERT INTO activation_invitations(user_id,token_hash,expires_at) VALUES (${user.id},${randomBytes(32).toString("hex")},now()+interval '24 hours')`);
  });
});

test("credential accounts cannot exist without a password", async () => {
  await withRollback(sql, async (tx) => {
    const role = await roleId(tx, "COMMERCIAL_MANAGER");
    const [user] = await tx<{ id: string }[]>`INSERT INTO users(full_name,email,phone,role_id) VALUES ('Credential',${uniqueEmail()},'80000000',${role}) RETURNING id`;
    await expectSqlStateIn(tx, "23514", (sp) => sp`INSERT INTO accounts(account_id,provider_id,user_id) VALUES (${user.id},'credential',${user.id})`);
  });
});

test("session revocation deletes auth sessions without deleting users", async () => {
  await withRollback(sql, async (tx) => {
    const role = await roleId(tx, "COMMERCIAL_MANAGER");
    const [user] = await tx<{ id: string }[]>`INSERT INTO users(full_name,email,phone,role_id,status,activated_at) VALUES ('Session',${uniqueEmail()},'80000000',${role},'ACTIVE',now()) RETURNING id`;
    const [session] = await tx<{ id: string }[]>`INSERT INTO sessions(token,user_id,expires_at) VALUES (${randomBytes(24).toString("hex")},${user.id},now()+interval '30 days') RETURNING id`;
    await tx`DELETE FROM sessions WHERE id=${session.id}`;
    const [stillThere] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE id=${user.id}`;
    assert.equal(stillThere.n, 1);
  });
});

test("database rejects deactivating or demoting the last active admin", async () => {
  await withRollback(sql, async (tx) => {
    const adminRole = await roleId(tx, "ADMIN");
    const sellerRole = await roleId(tx, "COMMERCIAL_MANAGER");
    const [admin] = await tx<{ id: string }[]>`INSERT INTO users(full_name,email,phone,role_id,status,activated_at) VALUES ('Only Admin',${uniqueEmail()},'80000000',${adminRole},'ACTIVE',now()) RETURNING id`;
    await expectSqlStateIn(tx, "DTA01", (sp) => sp`UPDATE users SET status='INACTIVE',deactivated_at=now() WHERE id=${admin.id}`);
    await expectSqlStateIn(tx, "DTA01", (sp) => sp`UPDATE users SET role_id=${sellerRole} WHERE id=${admin.id}`);
  });
});
