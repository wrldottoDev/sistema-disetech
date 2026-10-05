// CR-07(d): deterministic regression tests for the required item-write/issuance and merge
// races, using coordinated separate connections with manual BEGIN/COMMIT and pg_locks
// polling to prove the intended interleaving actually happened (a bare Promise.all of two
// independent calls can resolve in either order and never actually exercise the race).
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import {
  backendPid,
  claimRevision,
  createReadyToIssueQuotation,
  expectSqlState,
  insertCustomer,
  insertItem,
  insertUser,
  issueRevision,
  newClient,
  waitUntilBlocked,
} from "./helpers.ts";

let watcher: postgres.Sql;
test.before(async () => {
  watcher = await newClient();
});
test.after(async () => {
  await watcher.end({ timeout: 5 });
});

test("race 1: an open claim+item-write blocks a concurrent issuance, which then fails DTQ02 once the claim commits", async () => {
  const setup = await newClient();
  const connA = await newClient();
  const connB = await newClient();
  try {
    const fixture = await setup.begin((btx) => createReadyToIssueQuotation(btx, { itemCount: 0 }));

    await connA.unsafe("BEGIN");
    await claimRevision(connA, fixture.revisionId, fixture.revisionVersion);
    await insertItem(connA, { quotationId: fixture.quotationId, revisionId: fixture.revisionId });
    // connA now holds the revision row lock open (claim's UPDATE), uncommitted.

    const pidB = await backendPid(connB);
    const issuancePromise = issueRevision(connB, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      // Stale on purpose: the real version after connA's claim is revisionVersion + 1, which
      // is exactly what connB should see once unblocked.
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });

    await waitUntilBlocked(watcher, pidB);
    await connA.unsafe("COMMIT");

    await expectSqlState(issuancePromise, "DTQ02");
  } finally {
    await Promise.all([setup.end({ timeout: 5 }), connA.end({ timeout: 5 }), connB.end({ timeout: 5 })]);
  }
});

test("race 2 (reverse): issuance holds its locks open, a concurrent claim blocks, then fails once issuance commits", async () => {
  const setup = await newClient();
  const connA = await newClient();
  const connB = await newClient();
  try {
    const fixture = await setup.begin((btx) => createReadyToIssueQuotation(btx));

    await connA.unsafe("BEGIN");
    await connA.unsafe(
      "SELECT * FROM issue_quotation_revision($1, $2, $3, $4, $5)",
      [fixture.quotationId, fixture.revisionId, fixture.quotationVersion, fixture.revisionVersion, fixture.sellerUserId],
    );
    // connA has done all of issuance's writes but not committed -- its quotation/revision
    // locks are still held.

    const pidB = await backendPid(connB);
    const claimPromise = claimRevision(connB, fixture.revisionId, fixture.revisionVersion);

    await waitUntilBlocked(watcher, pidB);
    await connA.unsafe("COMMIT");

    // The revision is ISSUED once connB unblocks, so its claim is now stale/not-DRAFT. Any
    // of these three is an acceptable rejection per CR-07(d); DTQ02 is what the current
    // claim_quotation_revision actually raises for "found the row but state <> DRAFT".
    await expectSqlState(claimPromise, ["DTQ02", "DTQ03", "DTI01"]);
  } finally {
    await Promise.all([setup.end({ timeout: 5 }), connA.end({ timeout: 5 }), connB.end({ timeout: 5 })]);
  }
});

for (const table of ["catalog_items", "providers"] as const) {
  test(`merge race (${table}): A→B holds its locks, concurrent B→A blocks, then is rejected DTV01 once A→B commits`, async () => {
    const setup = await newClient();
    const connA = await newClient();
    const connB = await newClient();
    try {
      const reviewer = await setup.begin((btx) => insertUser(btx, { roleCode: "COMMERCIAL_MANAGER" }));
      const proposer = await setup.begin((btx) => insertUser(btx, { roleCode: "SELLER" }));
      const nameCol = table === "catalog_items" ? "name" : "legal_name";
      const [a, b] = await setup.begin(async (btx) => {
        const ids: string[] = [];
        for (const label of ["RaceA", "RaceB"]) {
          const [r] = await btx.unsafe<{ id: string }[]>(
            `INSERT INTO ${table} (${nameCol}, proposed_by_user_id) VALUES ($1, $2) RETURNING id`,
            [label, proposer],
          );
          ids.push(r.id);
        }
        await btx.unsafe(
          `UPDATE ${table} SET status = 'APPROVED', reviewed_by_user_id = $1, reviewed_at = now() WHERE id = ANY($2::uuid[])`,
          [reviewer, ids],
        );
        return ids;
      });

      await connA.unsafe("BEGIN");
      // A→B: locks row A and takes FOR SHARE on target B inside fn_check_merge.
      await connA.unsafe(`UPDATE ${table} SET status = 'MERGED', merged_into_id = $1 WHERE id = $2`, [b, a]);

      await connB.unsafe("BEGIN");
      const pidB = await backendPid(connB);
      // B→A must wait: updating row B conflicts with A's FOR SHARE lock on B.
      const pB = connB.unsafe(`UPDATE ${table} SET status = 'MERGED', merged_into_id = $1 WHERE id = $2`, [a, b]);
      pB.catch(() => {}); // observed below
      await waitUntilBlocked(watcher, pidB);

      await connA.unsafe("COMMIT");
      await expectSqlState(pB, "DTV01"); // B's trigger now sees A as MERGED: no cycle, no chain
      await connB.unsafe("ROLLBACK");

      const rows = await setup.unsafe<{ id: string; status: string; merged_into_id: string | null }[]>(
        `SELECT id, status, merged_into_id FROM ${table} WHERE id = ANY($1::uuid[])`,
        [[a, b]],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      assert.equal(byId.get(a)?.status, "MERGED");
      assert.equal(byId.get(a)?.merged_into_id, b);
      assert.equal(byId.get(b)?.status, "APPROVED");
      assert.equal(byId.get(b)?.merged_into_id, null);
    } finally {
      await Promise.all([setup.end({ timeout: 5 }), connA.end({ timeout: 5 }), connB.end({ timeout: 5 })]);
    }
  });
}

test("F4 (deterministic): claim + header customer change holds the quotation lock; issuance blocks, then gets 40001 — never 40P01", async () => {
  const setup = await newClient();
  const connA = await newClient();
  const connB = await newClient();
  try {
    const fixture = await setup.begin((btx) => createReadyToIssueQuotation(btx));
    const otherCustomerId = await setup.begin((btx) => insertCustomer(btx, { ownerUserId: fixture.sellerUserId }));

    await connA.unsafe("BEGIN");
    await claimRevision(connA, fixture.revisionId, fixture.revisionVersion); // locks quotation, then revision
    await connA.unsafe("UPDATE quotations SET customer_id = $1 WHERE id = $2", [otherCustomerId, fixture.quotationId]);

    const pidB = await backendPid(connB);
    const pB = issueRevision(connB, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });
    pB.catch(() => {});
    await waitUntilBlocked(watcher, pidB); // blocked on the quotation row held by connA

    await connA.unsafe("COMMIT");
    await expectSqlState(pB, "40001"); // customer_id changed while acquiring locks → retryable

    const [q] = await setup<{ status: string; customer_id: string }[]>`
      SELECT status, customer_id FROM quotations WHERE id = ${fixture.quotationId}`;
    assert.equal(q.status, "DRAFT");
    assert.equal(q.customer_id, otherCustomerId);
  } finally {
    await Promise.all([setup.end({ timeout: 5 }), connA.end({ timeout: 5 }), connB.end({ timeout: 5 })]);
  }
});
