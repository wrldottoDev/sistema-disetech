import path from "node:path";
import { defineConfig } from "vitest/config";
import { itRuntimeUrl } from "./tests/integration/env";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      DATABASE_URL: itRuntimeUrl(),
      BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-chars",
      BETTER_AUTH_URL: "http://127.0.0.1:3000",
      AUDIT_HMAC_SECRET: "test-only-audit-secret-at-least-32-chars",
      EMAIL_TRANSPORT: "memory",
      DOCUMENT_STORAGE_DIR: path.resolve(__dirname, "storage-test"),
      ENABLE_TEST_ENDPOINTS: "true",
      NODE_ENV: "test",
    },
  },
});
