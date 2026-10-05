import postgres from "postgres";
import { e2eDatabaseUrl } from "./environment.ts";
export default async function globalTeardown() {
  const target = new URL(e2eDatabaseUrl());
  const dbName = target.pathname.slice(1);
  const admin = postgres(e2eDatabaseUrl("postgres"), { max: 1 });
  await admin.unsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [dbName]);
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
}
