// CR-01/CR-05 regression tests for the connection-safety guard itself. These are pure unit
// tests: they call parseTestConnection() with synthetic strings and never open a socket, per
// the audit's explicit instruction ("adversarial unit tests for the guard ... that do not
// connect anywhere").
import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { parseTestConnection, sanitizeErrorForLog, toDriverOptions } from "./helpers.ts";

test("CR-01: a ?database= query param cannot override the connection's database", () => {
  const opts = parseTestConnection("postgres://user:pw@localhost:5432/disetech_test?database=disetech_dev");
  assert.equal(opts.database, "disetech_test");
  assert.equal(opts.host, "localhost");
  // Structural guarantee, not just a value check: the returned object has no field a query
  // parameter could have reached in the first place.
  assert.deepEqual(Object.keys(opts).sort(), ["database", "host", "password", "port", "username"]);
});

test("CR-01: other dangerous query params (options=, user=, sslmode=) are silently dropped, not honored", () => {
  const opts = parseTestConnection(
    "postgres://user:pw@localhost/disetech_test?options=-c%20search_path%3Dpg_catalog&user=someone_else&sslmode=disable",
  );
  assert.equal(opts.database, "disetech_test");
  assert.equal(opts.username, "user"); // from the URL's own userinfo, not the query param
});

test("CR-01: a non-local host is rejected", () => {
  assert.throws(() => parseTestConnection("postgres://user@evil.example.com/disetech_test"), /localhost/);
});

test("CR-01: a pathname not ending in _test (e.g. the developer's own disetech_dev) is still forced to disetech_test, never used as-is", () => {
  // This is the documented, expected input: DATABASE_URL normally points at disetech_dev.
  // Safety comes from unconditional forcing, not from rejecting a URL that "looks wrong" --
  // rejecting here would break the ordinary .env.local workflow for no security benefit,
  // since the database is never derived from the pathname regardless of what it says.
  const opts = parseTestConnection("postgres://user@localhost/disetech_dev");
  assert.equal(opts.database, "disetech_test");
});

test("CR-01: an IPv6 loopback host is accepted", () => {
  const opts = parseTestConnection("postgres://user@[::1]:5432/disetech_test");
  assert.equal(opts.host, "::1"); // brackets stripped from WHATWG .hostname
  assert.equal(opts.database, "disetech_test");
  // CR-10: assert the destination the driver would actually use (postgres() is lazy: no connection).
  const sql = postgres({ ...toDriverOptions(opts), max: 1 });
  assert.deepEqual(sql.options.host, ["::1"]);
  assert.deepEqual(sql.options.port, [5432]);
  assert.equal(sql.options.database, "disetech_test");
  void sql.end();
});

test("CR-05: a malformed URL throws a fixed, sanitized error that never echoes the raw input", () => {
  const credentialSentinel = "s3cr3t-CR05-SENTINEL";
  const raw = `postgres://admin:${credentialSentinel}@localhost:not-a-port/disetech_test`;
  try {
    parseTestConnection(raw);
    assert.fail("expected parseTestConnection to throw on a malformed URL");
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.ok(!("input" in err), "the thrown error must not carry the original ERR_INVALID_URL's `input` property");
    assert.ok(!("cause" in err) || (err as { cause?: unknown }).cause === undefined, "must not chain the raw error as `cause`");
    const fullDump = JSON.stringify(err, Object.getOwnPropertyNames(err));
    assert.ok(!fullDump.includes(credentialSentinel), `sentinel leaked into the thrown error: ${fullDump}`);
    assert.ok(!err.message.includes(credentialSentinel), `sentinel leaked into the error message: ${err.message}`);
  }
});

test("CR-05: sanitizeErrorForLog redacts scheme://user@ segments and keeps the error code", () => {
  const err = Object.assign(new Error("connect ECONNREFUSED postgres://admin:hunter2@10.0.0.5:5432/prod"), {
    code: "ECONNREFUSED",
  });
  const printed = sanitizeErrorForLog(err);
  assert.ok(printed.includes("ECONNREFUSED"));
  assert.ok(!printed.includes("hunter2"), `credential leaked: ${printed}`);
  assert.ok(printed.includes("://<redacted>@"), `expected a redaction marker: ${printed}`);
});
