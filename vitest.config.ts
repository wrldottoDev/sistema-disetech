import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({ resolve: { alias: { "@": path.resolve(__dirname) } }, test: {
  environment: "node",
  include: ["tests/**/*.test.ts"],
  exclude: ["tests/integration/**", "node_modules/**"],
  env: {
    DATABASE_URL: "postgres://test:test@127.0.0.1:5432/disetech_test",
    BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-chars",
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    AUDIT_HMAC_SECRET: "test-only-audit-secret-at-least-32-chars",
    EMAIL_TRANSPORT: "memory",
  },
  coverage: { reporter: ["text", "html"] },
} });
