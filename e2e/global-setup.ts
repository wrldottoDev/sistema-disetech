import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { e2eDatabaseUrl } from "./environment.ts";

export default async function globalSetup() {
  const target = new URL(e2eDatabaseUrl());
  const adminUrl = e2eDatabaseUrl("postgres");
  const admin = postgres(adminUrl, { max: 1 });
  const dbName = target.pathname.slice(1);
  await admin.unsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [dbName]);
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const owner = postgres(e2eDatabaseUrl(), { max: 1 });
  await migrate(drizzle(owner), { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  await owner.end();
}
