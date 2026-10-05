import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function sourceDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  const file = path.resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) throw new Error("E2E requires a local TEST_DATABASE_URL or DATABASE_URL");
  const line = readFileSync(file, "utf8").split("\n").find((item) => item.startsWith("DATABASE_URL="));
  if (!line) throw new Error("E2E database configuration is missing");
  return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}

export function e2eDatabaseUrl(database = "disetech_e2e_test"): string {
  const url = new URL(sourceDatabaseUrl());
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("E2E only accepts a local PostgreSQL host");
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

export const e2eServerEnv = {
  DATABASE_URL: e2eDatabaseUrl(),
  BETTER_AUTH_SECRET: "e2e-only-better-auth-secret-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3107",
  AUDIT_HMAC_SECRET: "e2e-only-audit-hmac-secret-at-least-32-characters",
  EMAIL_TRANSPORT: "memory",
  ENABLE_TEST_ENDPOINTS: "true",
  DISABLE_WEBPACK_CACHE: "true",
};
