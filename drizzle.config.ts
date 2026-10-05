import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` only reads the schema; DATABASE_URL is needed for
// `drizzle-kit migrate`. Never use `drizzle-kit push`: every change goes through
// a versioned migration in ./drizzle.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
