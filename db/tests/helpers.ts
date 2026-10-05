// Test harness helpers for the DB integrity/adversarial suite.
//
// Everything here talks to a disposable `disetech_test` database. Nothing in
// this file ever prints or logs a resolved connection string — error
// messages reference variable names, never values.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export const RUNTIME_ROLE = "disetech_test_runtime";

// ---------------------------------------------------------------------------
// URL resolution + safety guard
// ---------------------------------------------------------------------------

function readDatabaseUrlFromDotEnvLocal(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(here, "../../.env.local");
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, "utf8")
    .split("\n")
    .find((l) => l.startsWith("DATABASE_URL="));
  if (!line) return undefined;
  return line
    .slice("DATABASE_URL=".length)
    .trim()
    .replace(/^["']|["']$/g, "");
}

/**
 * CR-05: `new URL()` throws `ERR_INVALID_URL` with an enumerable `input`
 * property carrying the exact raw string — `console.error(err)` (or any
 * generic error logger) prints it in full, including embedded credentials.
 * Never let that exception escape: catch it and throw a fixed, sanitized
 * error with no `cause` and no interpolation of `raw`.
 */
function parseUrlSafely(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error("Refusing: the configured database URL could not be parsed (value withheld)");
  }
}

/**
 * CR-10: WHATWG URL keeps the brackets in `.hostname` for an IPv6 literal
 * (`[::1]`, not `::1`). postgres@3.4.9 always calls `.split(':')` on a string
 * host (to support "host1:port1,host2:port2" syntax) — handed the bracketed
 * form, that split lands on the colons INSIDE the address, not the ones
 * around it, and produces garbage (`"[::1]".split(':')[0]` is `"["`, not an
 * address at all). Strip the brackets before this value goes anywhere near
 * postgres.js or an equality check.
 */
function normalizeHost(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function assertSafeHost(host: string): void {
  if (!isLocalHost(host)) {
    throw new Error("Refusing: test DB host must be localhost/127.0.0.1/::1");
  }
}

export interface ConnectionOptions {
  host: string;
  port: number;
  username: string | undefined;
  password: string | undefined;
  database: string;
}

/** Same shape as ConnectionOptions, but `database` is pinned to the literal at the type level too. */
export interface TestConnectionOptions extends ConnectionOptions {
  database: "disetech_test";
}

/**
 * The one guard that must never be weakened: the host must be local. This is
 * intentionally the ONLY rejection this function performs — the ordinary,
 * documented, expected input is DATABASE_URL pointing at `disetech_dev` (a
 * developer's regular working database), which must be redirected, not
 * refused. Safety here comes from `database` always being the hardcoded
 * literal below, unconditionally, regardless of whatever pathname or query
 * string the source URL actually has — never from rejecting URLs that
 * "don't look like a test config".
 *
 * CR-01: postgres.js accepts a connection STRING and, per its own startup
 * logic, lets query parameters (`?database=...`, `?options=...`, etc.)
 * override fields the pathname already set — a URL of
 * `.../disetech_test?database=disetech_dev` connects to disetech_dev even
 * though the pathname said disetech_test. There is no query-param allowlist
 * that closes this: the fix is to never build a connection string at all.
 * This function reads only `hostname`, `port`, `username` and `password` off
 * the parsed URL — `url.pathname`, `url.search` and `url.searchParams` are
 * never touched, so neither the URL's own path nor any query parameter can
 * reach the returned object, structurally, regardless of what they contain.
 *
 * Pure (no env reads, no I/O) so it can be unit-tested with synthetic inputs.
 */
export function parseTestConnection(raw: string): TestConnectionOptions {
  const url = parseUrlSafely(raw);
  const host = normalizeHost(url.hostname);
  assertSafeHost(host);
  return {
    host,
    port: url.port ? Number(url.port) : 5432,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database: "disetech_test",
  };
}

/** Env vars run.ts sets for child test-file processes — see resolveTestConnectionOptions. */
export const CHILD_ENV = {
  HOST: "DISETECH_TEST_DB_HOST",
  PORT: "DISETECH_TEST_DB_PORT",
  USER: "DISETECH_TEST_DB_USER",
  PASSWORD: "DISETECH_TEST_DB_PASSWORD",
} as const;

/**
 * Resolves validated connection options for the disposable test database.
 *
 * Highest precedence: DISETECH_TEST_DB_HOST/_PORT/_USER/_PASSWORD, set by
 * run.ts for child test-file processes — already-validated components, never
 * a connection string, so passing state from parent to child can't
 * reintroduce CR-01 (there is no query string here for a parameter to live
 * in). Otherwise: TEST_DATABASE_URL env, DATABASE_URL env, or the
 * `DATABASE_URL=` line of .env.local, parsed and stripped down by
 * parseTestConnection.
 */
export function resolveTestConnectionOptions(): TestConnectionOptions {
  const rawHost = process.env[CHILD_ENV.HOST];
  if (rawHost) {
    const host = normalizeHost(rawHost);
    assertSafeHost(host);
    return {
      host,
      port: Number(process.env[CHILD_ENV.PORT] ?? "5432"),
      username: process.env[CHILD_ENV.USER] || undefined,
      password: process.env[CHILD_ENV.PASSWORD] || undefined,
      database: "disetech_test",
    };
  }

  const raw = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? readDatabaseUrlFromDotEnvLocal();
  if (!raw) {
    throw new Error("Set TEST_DATABASE_URL or DATABASE_URL, or add DATABASE_URL= to .env.local");
  }
  return parseTestConnection(raw);
}

/**
 * CR-01: verify the live connection actually landed on disetech_test, not
 * merely that we asked it to. Call this right after opening any connection
 * that will migrate, grant, run tests, or clean up — before doing any of
 * those things.
 */
export async function assertConnectedToTestDatabase(client: postgres.Sql): Promise<void> {
  const rows = await client<{ current_database: string }[]>`SELECT current_database() AS current_database`;
  const actual = rows[0]?.current_database;
  if (actual !== "disetech_test") {
    throw new Error("Refusing: live connection is not on disetech_test (value withheld)");
  }
}

/**
 * CR-10: postgres.js's `host`/`port` options, when given as plain strings/
 * numbers, get run through comma/colon-splitting logic meant for its
 * multi-host connection-string syntax — which mangles a bare IPv6 literal.
 * Passing both as single-element ARRAYS (`Array.isArray(host)` check in
 * postgres.js) bypasses that splitting entirely and is accepted uniformly for
 * ordinary hostnames too (verified against the installed postgres@3.4.9).
 */
export function toDriverOptions(opts: ConnectionOptions) {
  // Options typings declare scalars; the installed runtime accepts arrays (see above).
  return {
    host: [opts.host] as unknown as string,
    port: [opts.port] as unknown as number,
    username: opts.username,
    password: opts.password,
    database: opts.database,
  };
}

/** A fresh, dedicated, verified connection (own backend pid) to the test database. */
export async function newClient(): Promise<postgres.Sql> {
  const opts = resolveTestConnectionOptions();
  const client = postgres({ ...toDriverOptions(opts), max: 1, onnotice: () => {} });
  await assertConnectedToTestDatabase(client);
  return client;
}

/**
 * CR-05: for callers (run.ts) that must log something on failure without
 * ever risking a raw connection string or credential reaching stdout/stderr.
 * Prints the SQLSTATE/error code plus a message with any `scheme://user@`
 * segment redacted; never the object itself, never `.stack`, never `.input`.
 */
export function sanitizeErrorForLog(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const redacted = rawMessage.replace(/:\/\/[^@]*@/g, "://<redacted>@");
  return code ? `[${code}] ${redacted}` : redacted;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function sqlStateOf(err: unknown): string | undefined {
  return (err as { code?: string } | undefined)?.code;
}

/** Asserts a plain (non-transactional) promise rejects with one of `code`. */
export async function expectSqlState(promise: Promise<unknown>, code: string | string[]): Promise<void> {
  const codes = Array.isArray(code) ? code : [code];
  try {
    await promise;
  } catch (err) {
    const got = sqlStateOf(err);
    assert.ok(got !== undefined && codes.includes(got), `expected SQLSTATE ${codes.join("/")}, got ${got ?? String(err)}`);
    return;
  }
  assert.fail(`expected SQLSTATE ${codes.join("/")} but the operation succeeded`);
}

/**
 * Runs `fn` inside a SAVEPOINT of the enclosing transaction and asserts it
 * fails with one of `code`. A failure only rolls back to the savepoint, so
 * the outer (rolled-back-at-the-end) transaction stays usable for further
 * assertions. Use this for every "expect an error" check inside a test.
 */
export async function expectSqlStateIn(
  tx: postgres.TransactionSql,
  code: string | string[],
  fn: (sp: postgres.TransactionSql) => Promise<unknown>,
): Promise<void> {
  const codes = Array.isArray(code) ? code : [code];
  try {
    await tx.savepoint((sp) => fn(sp));
  } catch (err) {
    const got = sqlStateOf(err);
    assert.ok(got !== undefined && codes.includes(got), `expected SQLSTATE ${codes.join("/")}, got ${got ?? String(err)}`);
    return;
  }
  assert.fail(`expected SQLSTATE ${codes.join("/")} but the operation succeeded`);
}

/**
 * Forces deferred constraint triggers to run now, inside a savepoint, so a
 * deferred failure can be asserted without waiting for COMMIT (A3 DB-24).
 * `fn` should perform the write(s) whose deferred check is under test.
 */
export async function expectDeferredSqlState(
  tx: postgres.TransactionSql,
  code: string | string[],
  fn: (sp: postgres.TransactionSql) => Promise<unknown>,
): Promise<void> {
  await expectSqlStateIn(tx, code, async (sp) => {
    await fn(sp);
    await sp`SET CONSTRAINTS ALL IMMEDIATE`;
  });
}

class RollbackSignal extends Error {}

/**
 * Runs `fn` in a transaction that is always rolled back (test isolation).
 *
 * CR-07(a): before rolling back, forces every deferred constraint trigger to
 * run now (`SET CONSTRAINTS ALL IMMEDIATE`) rather than never — a rollback
 * with nothing forced never runs them at all, so a "positive" test could pass
 * even though the same work would fail at a real COMMIT. Any failure surfaces
 * as a genuine test failure, not swallowed by the rollback. Tests that expect
 * a deferred failure use `expectDeferredSqlState` in a savepoint first, which
 * already resolves it before this point is ever reached.
 */
export async function withRollback<T>(
  sql: postgres.Sql,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await sql
    .begin(async (tx) => {
      result = await fn(tx);
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      throw new RollbackSignal();
    })
    .catch((e: unknown) => {
      if (!(e instanceof RollbackSignal)) throw e;
    });
  return result as T;
}

/** `SET LOCAL ROLE disetech_test_runtime` for the remainder of this transaction. */
export async function asRuntime(tx: postgres.TransactionSql): Promise<void> {
  await tx.unsafe(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
}

/** Back to the owning role (superuser/table owner) within the same transaction. */
export async function asOwner(tx: postgres.TransactionSql): Promise<void> {
  await tx.unsafe("RESET ROLE");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export type SqlLike = postgres.Sql | postgres.TransactionSql;

export type RoleCode = "ADMIN" | "SELLER" | "COMMERCIAL_MANAGER" | "ADMINISTRATIVE_MANAGER";
export type UserStatus = "PENDING_ACTIVATION" | "ACTIVE" | "INACTIVE";

let counter = 0;
/** Cheap, collision-free-enough suffix (no crypto import needed for test data). */
export function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}.${uniqueSuffix()}@example.test`;
}

export async function roleId(db: SqlLike, code: RoleCode): Promise<string> {
  const rows = await db<{ id: string }[]>`SELECT id FROM roles WHERE code = ${code}`;
  if (rows.length === 0) throw new Error(`fixture: role ${code} not seeded`);
  return rows[0].id;
}

export interface UserOverrides {
  roleCode?: RoleCode;
  status?: UserStatus;
  email?: string;
  name?: string;
  phone?: string;
}

export async function insertUser(db: SqlLike, overrides: UserOverrides = {}): Promise<string> {
  const code = overrides.roleCode ?? "SELLER";
  const rId = await roleId(db, code);
  const status = overrides.status ?? "ACTIVE";
  const activatedAt = status === "ACTIVE" || status === "INACTIVE" ? new Date() : null;
  const deactivatedAt = status === "INACTIVE" ? new Date() : null;
  let companyId: string | null = null;
  if (code === "SELLER") {
    const company = await db<{ id: string }[]>`INSERT INTO companies (name) VALUES (${`Empresa ${randomUUID()}`}) RETURNING id`;
    companyId = company[0].id;
  }
  const rows = await db<{ id: string }[]>`
    INSERT INTO users (full_name, email, phone, role_id, company_id, status, activated_at, deactivated_at)
    VALUES (
      ${overrides.name ?? "Test User"},
      ${overrides.email ?? uniqueEmail()},
      ${overrides.phone ?? "80000000"},
      ${rId},
      ${companyId},
      ${status},
      ${activatedAt},
      ${deactivatedAt}
    )
    RETURNING id`;
  return rows[0].id;
}

export interface CustomerOverrides {
  ownerUserId: string;
  createdByUserId?: string;
  email?: string;
  fullName?: string;
}

export async function insertCustomer(db: SqlLike, o: CustomerOverrides): Promise<string> {
  const rows = await db<{ id: string }[]>`
    INSERT INTO customers (full_name, email, created_by_user_id, owner_user_id)
    VALUES (
      ${o.fullName ?? "Test Customer"},
      ${o.email ?? uniqueEmail("cust")},
      ${o.createdByUserId ?? o.ownerUserId},
      ${o.ownerUserId}
    )
    RETURNING id`;
  return rows[0].id;
}

export interface QuotationRow {
  id: string;
  version: number;
}

export interface QuotationOverrides {
  customerId: string;
  ownerUserId: string;
  createdByUserId?: string;
}

export async function insertQuotation(db: SqlLike, o: QuotationOverrides): Promise<QuotationRow> {
  const rows = await db<QuotationRow[]>`
    INSERT INTO quotations (customer_id, owner_user_id, created_by_user_id)
    VALUES (${o.customerId}, ${o.ownerUserId}, ${o.createdByUserId ?? o.ownerUserId})
    RETURNING id, version`;
  return rows[0];
}

export interface RevisionRow {
  id: string;
  version: number;
}

export interface RevisionOverrides {
  quotationId: string;
  customerId: string;
  sellerUserId: string;
  createdByUserId?: string;
  revisionNumber?: number;
  currency?: "CRC" | "USD";
  customerName?: string;
  customerEmail?: string;
  sellerName?: string;
  sellerEmail?: string;
  sellerPhone?: string;
}

export async function insertRevision(db: SqlLike, o: RevisionOverrides): Promise<RevisionRow> {
  const rows = await db<RevisionRow[]>`
    INSERT INTO quotation_revisions (
      quotation_id, customer_id, revision_number, currency,
      customer_name, customer_email,
      seller_user_id, seller_name, seller_email, seller_phone,
      created_by_user_id
    )
    VALUES (
      ${o.quotationId}, ${o.customerId}, ${o.revisionNumber ?? 1}, ${o.currency ?? "CRC"},
      ${o.customerName ?? "Cust Name"}, ${o.customerEmail ?? "cust@example.test"},
      ${o.sellerUserId}, ${o.sellerName ?? "Seller Name"}, ${o.sellerEmail ?? "seller@example.test"}, ${o.sellerPhone ?? "80000000"},
      ${o.createdByUserId ?? o.sellerUserId}
    )
    RETURNING id, version`;
  return rows[0];
}

/** Runs the DB-24/DB-03 claim protocol: returns the post-claim version. */
export async function claimRevision(db: SqlLike, revisionId: string, expectedVersion: number): Promise<number> {
  const rows = await db<{ claim_quotation_revision: number }[]>`
    SELECT claim_quotation_revision(${revisionId}, ${expectedVersion})`;
  return rows[0].claim_quotation_revision;
}

export interface ItemOverrides {
  quotationId: string;
  revisionId: string;
  lineNumber?: number;
  itemName?: string;
  quantity?: string;
  unitCost?: string;
  costCurrency?: "CRC" | "USD";
  marginPercent?: string;
  unitPrice?: string;
  taxPercent?: string;
  catalogItemId?: string | null;
  providerId?: string | null;
  providerNameSnapshot?: string | null;
}

export async function insertItem(db: SqlLike, o: ItemOverrides): Promise<string> {
  const rows = await db<{ id: string }[]>`
    INSERT INTO quotation_items (
      quotation_id, revision_id, line_number, item_name,
      quantity, unit_cost, cost_currency, margin_percent, unit_price, tax_percent,
      catalog_item_id, provider_id, provider_name_snapshot
    )
    VALUES (
      ${o.quotationId}, ${o.revisionId}, ${o.lineNumber ?? 1}, ${o.itemName ?? "Item"},
      ${o.quantity ?? "1"}, ${o.unitCost ?? "100"}, ${o.costCurrency ?? "CRC"},
      ${o.marginPercent ?? "20"}, ${o.unitPrice ?? "120"}, ${o.taxPercent ?? "13"},
      ${o.catalogItemId ?? null}, ${o.providerId ?? null}, ${o.providerNameSnapshot ?? null}
    )
    RETURNING id`;
  return rows[0].id;
}

export interface IssueParams {
  quotationId: string;
  revisionId: string;
  expectedQuotationVersion: number;
  expectedRevisionVersion: number;
  actorUserId: string;
}

export interface IssueResult {
  folio: string;
  revisionNumber: number;
  alreadyIssued: boolean;
}

export async function issueRevision(db: SqlLike, p: IssueParams): Promise<IssueResult> {
  const rows = await db<{ folio: string; revision_number: number; already_issued: boolean }[]>`
    SELECT * FROM issue_quotation_revision(
      ${p.quotationId}, ${p.revisionId}, ${p.expectedQuotationVersion}, ${p.expectedRevisionVersion}, ${p.actorUserId}
    )`;
  const r = rows[0];
  return { folio: r.folio, revisionNumber: r.revision_number, alreadyIssued: r.already_issued };
}

export interface ReadyQuotation {
  sellerUserId: string;
  customerId: string;
  quotationId: string;
  quotationVersion: number;
  revisionId: string;
  revisionVersion: number;
}

/** Composed fixture: SELLER + customer + DRAFT quotation/revision + N claimed items. */
export async function createReadyToIssueQuotation(
  db: SqlLike,
  opts: { sellerUserId?: string; itemCount?: number } = {},
): Promise<ReadyQuotation> {
  const sellerUserId = opts.sellerUserId ?? (await insertUser(db, { roleCode: "SELLER" }));
  const customerId = await insertCustomer(db, { ownerUserId: sellerUserId });
  const quotation = await insertQuotation(db, { customerId, ownerUserId: sellerUserId });
  const revision = await insertRevision(db, { quotationId: quotation.id, customerId, sellerUserId });
  const revisionVersion = await claimRevision(db, revision.id, revision.version);
  const itemCount = opts.itemCount ?? 1;
  for (let i = 1; i <= itemCount; i += 1) {
    await insertItem(db, { quotationId: quotation.id, revisionId: revision.id, lineNumber: i });
  }
  return {
    sellerUserId,
    customerId,
    quotationId: quotation.id,
    quotationVersion: quotation.version,
    revisionId: revision.id,
    revisionVersion,
  };
}

// ---------------------------------------------------------------------------
// Deterministic-race helpers (CR-07d) — manual BEGIN/COMMIT + pg_locks polling
// ---------------------------------------------------------------------------

/** This connection's own backend pid, for another connection to watch via pg_stat_activity. */
export async function backendPid(client: postgres.Sql): Promise<number> {
  const rows = await client<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return rows[0].pid;
}

/**
 * Polls (from a separate, unblocked connection) until the given backend pid is actually
 * waiting on a lock, or throws after `timeoutMs`. Used to prove a race's second actor is
 * genuinely blocked before the first actor releases its lock — without this, "concurrent"
 * promises can resolve in either order and the race is not actually exercised.
 */
export async function waitUntilBlocked(watcher: postgres.Sql, pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await watcher<{ wait_event_type: string | null }[]>`
      SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
    if (rows[0]?.wait_event_type === "Lock") return;
    if (Date.now() >= deadline) {
      throw new Error(`backend ${pid} never reached wait_event_type = 'Lock' within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
