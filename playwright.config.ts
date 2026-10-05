import { defineConfig, devices } from "@playwright/test";
import { e2eServerEnv } from "./e2e/environment";
export default defineConfig({
  testDir: "./e2e",
  globalTeardown: "./e2e/global-teardown.ts",
  workers: 1,
  timeout: 600_000,
  // El servidor de desarrollo (webpack) compila cada ruta la primera vez que se visita.
  expect: { timeout: 60_000 },
  use: { baseURL: "http://localhost:3107", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", testMatch: /critical\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chrome", testMatch: /mobile\.spec\.ts/, use: { ...devices["Pixel 7"] } },
    { name: "mobile-webkit", testMatch: /mobile\.spec\.ts/, use: { ...devices["iPhone 14"] } },
  ],
  webServer: { command: "node e2e/prepare.ts && npm run dev -- --webpack --port 3107", url: "http://localhost:3107/login", reuseExistingServer: false, timeout: 1_800_000, env: e2eServerEnv },
});
