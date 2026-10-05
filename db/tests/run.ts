// Entry point for `npm run test:db`.
//
// Drops + recreates a disposable `disetech_test` database, migrates it from
// empty, provisions the `disetech_test_runtime` NOLOGIN role from
// db/sql/runtime-grants.sql, runs every db/tests/*.test.ts file, then tears
// everything down again. Never logs the resolved connection string or a raw
// error that might carry one (CR-05) — see sanitizeErrorForLog.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  assertConnectedToTestDatabase,
  CHILD_ENV,
  resolveTestConnectionOptions,
  RUNTIME_ROLE,
  sanitizeErrorForLog,
  toDriverOptions,
  type ConnectionOptions,
} from "./helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// CR-01: every connection below is built from this validated options object —
// never a connection string — so no query parameter can ever override the
// database, user, or session options postgres.js would otherwise honor.
function makeClient(opts: ConnectionOptions): postgres.Sql {
  return postgres({
    ...toDriverOptions(opts),
    max: 1,
    onnotice: () => {},
  });
}

async function terminateAndDrop(adminOpts: ConnectionOptions, dbName: string): Promise<void> {
  const admin = makeClient(adminOpts);
  try {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  const testOpts = resolveTestConnectionOptions();
  const dbName = testOpts.database; // always the literal "disetech_test"
  const adminOpts: ConnectionOptions = { ...testOpts, database: "postgres" };

  await terminateAndDrop(adminOpts, dbName);
  {
    const admin = makeClient(adminOpts);
    try {
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }
  }

  const owner = makeClient(testOpts);
  let exitCode = 0;
  try {
    await assertConnectedToTestDatabase(owner); // checkpoint: before migrate

    await migrate(drizzle(owner), { migrationsFolder: path.join(repoRoot, "drizzle") });

    await owner.unsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN CREATE ROLE ${RUNTIME_ROLE} NOLOGIN; END IF; END $$;`,
    );
    // Idempotent; lets a non-superuser harness connection SET ROLE to it too.
    await owner.unsafe(`GRANT ${RUNTIME_ROLE} TO CURRENT_USER`);

    await assertConnectedToTestDatabase(owner); // checkpoint: before grants

    const grantsPath = path.join(repoRoot, "db", "sql", "runtime-grants.sql");
    if (!existsSync(grantsPath)) {
      throw new Error("db/sql/runtime-grants.sql does not exist yet (workstream B)");
    }
    const grantsSql = readFileSync(grantsPath, "utf8").replace(/\bdisetech_app\b/g, RUNTIME_ROLE);
    // The file may contain DO $$ ... $$ blocks and BEGIN/COMMIT — splitting on ';' would
    // break those. `unsafe()` sends it as one simple-query message, which Postgres runs as
    // multiple statements in one round trip as long as no parameters are bound (none are).
    await owner.unsafe(grantsSql);

    // CR-01: pass already-validated COMPONENTS to child test processes, never a connection
    // string — there is no query string here for a parameter to live in.
    process.env[CHILD_ENV.HOST] = testOpts.host;
    process.env[CHILD_ENV.PORT] = String(testOpts.port);
    if (testOpts.username) process.env[CHILD_ENV.USER] = testOpts.username;
    if (testOpts.password) process.env[CHILD_ENV.PASSWORD] = testOpts.password;

    await assertConnectedToTestDatabase(owner); // checkpoint: before running tests

    const files = readdirSync(here)
      .filter((f) => f.endsWith(".test.ts"))
      .sort()
      .map((f) => path.join(here, f));

    await new Promise<void>((resolve, reject) => {
      // forceExit: a leaked connection in one test file must never hang the whole
      // suite forever — a bug there should fail loudly, not stall CI indefinitely.
      const stream = run({ files, concurrency: false, timeout: 120_000, forceExit: true });
      stream.on("test:fail", () => {
        exitCode = 1;
      });
      stream.on("error", reject);
      stream.on("end", resolve);
      // @types/node@20's `compose()` overloads don't model the reporter-factory
      // pattern `spec` actually is (verified against the Node docs' own example
      // at runtime); cast to the closest overload just to satisfy tsc.
      stream.compose(spec as unknown as (source: AsyncIterable<unknown>) => AsyncIterable<unknown>).pipe(process.stdout);
    });
  } catch (err) {
    // CR-05: never print the raw error object — it (or a nested cause) could carry a
    // connection string. Code + redacted message only.
    console.error(sanitizeErrorForLog(err));
    exitCode = 1;
  } finally {
    try {
      await assertConnectedToTestDatabase(owner); // checkpoint: before cleanup
      await owner.unsafe(`DROP OWNED BY ${RUNTIME_ROLE}`);
    } catch {
      // best-effort — the DB is about to be dropped anyway.
    }
    await owner.end();

    await terminateAndDrop(adminOpts, dbName);
    const admin = makeClient(adminOpts);
    try {
      await admin.unsafe(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`);
    } finally {
      await admin.end();
    }
  }

  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(sanitizeErrorForLog(err));
  process.exitCode = 1;
});
