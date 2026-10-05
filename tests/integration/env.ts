import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const IT_DB = "disetech_it_test";

function source(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const file = path.resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) throw new Error("Las pruebas de integración requieren TEST_DATABASE_URL o DATABASE_URL local");
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("Falta DATABASE_URL en .env.local");
  return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}

/** URL de una base desechable local; nunca la base de desarrollo ni producción. */
export function itDatabaseUrl(database: string = IT_DB): string {
  const url = new URL(source());
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error("Sólo se permite PostgreSQL local para pruebas de integración");
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

export const IT_RUNTIME_ROLE = "disetech_it_runtime";

/** Conexión de la app en las pruebas: mismo servidor, pero actuando como el rol de runtime sin privilegios de dueño. */
export function itRuntimeUrl(): string {
  const url = new URL(itDatabaseUrl());
  url.searchParams.set("options", `-c role=${IT_RUNTIME_ROLE}`);
  return url.toString();
}
