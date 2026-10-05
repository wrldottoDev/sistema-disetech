import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { IT_DB, IT_RUNTIME_ROLE, itDatabaseUrl } from "./env";

export default async function setup() {
  const admin = postgres(itDatabaseUrl("postgres"), { max: 1 });
  await admin.unsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [IT_DB]);
  await admin.unsafe(`DROP DATABASE IF EXISTS "${IT_DB}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${IT_DB}"`);
  await admin.end();
  const owner = postgres(itDatabaseUrl(), { max: 1, onnotice: () => {} });
  await migrate(drizzle(owner), { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  // La app corre como un rol que NO es dueño del esquema, con exactamente los permisos de producción.
  await owner.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${IT_RUNTIME_ROLE}') THEN CREATE ROLE ${IT_RUNTIME_ROLE} NOLOGIN; END IF; END $$;`);
  await owner.unsafe(`GRANT ${IT_RUNTIME_ROLE} TO CURRENT_USER`);
  const grants = readFileSync(path.resolve(process.cwd(), "db/sql/runtime-grants.sql"), "utf8").replace(/\bdisetech_app\b/g, IT_RUNTIME_ROLE);
  await owner.unsafe(grants);
  await owner.end();
  return async () => {
    const cleanup = postgres(itDatabaseUrl("postgres"), { max: 1 });
    await cleanup.unsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [IT_DB]);
    await cleanup.unsafe(`DROP DATABASE IF EXISTS "${IT_DB}" WITH (FORCE)`);
    await cleanup.unsafe(`DROP ROLE IF EXISTS ${IT_RUNTIME_ROLE}`);
    await cleanup.end();
  };
}
