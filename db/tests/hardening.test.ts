// Regression tests for the adversarial-review findings in
// .orchestration/review/interim-findings.md (F1-F13), covering fixes other workstreams are
// applying to 0001-0003 and db/sql/runtime-grants.sql. Written against the EXPECTED
// post-fix behavior; if a test here fails, either the fix isn't applied yet or it landed
// differently than expected (report file:line + this test, don't fix the migration).
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import {
  asRuntime,
  claimRevision,
  createReadyToIssueQuotation,
  expectSqlStateIn,
  insertCustomer,
  insertItem,
  insertQuotation,
  insertRevision,
  insertUser,
  issueRevision,
  newClient,
  withRollback,
} from "./helpers.ts";

let sql: postgres.Sql;
test.before(async () => {
  sql = await newClient();
});
test.after(async () => {
  await sql.end({ timeout: 5 });
});

async function approveCatalog(tx: postgres.TransactionSql, id: string, reviewer: string) {
  await tx`UPDATE catalog_items SET status = 'APPROVED', reviewed_by_user_id = ${reviewer}, reviewed_at = now() WHERE id = ${id}`;
}

// --- F1: fn_is_owner_context spoofing via a shadowed pg_class in a temp schema --------------

test("F1: runtime role cannot CREATE TEMP TABLE (closes the pg_class-shadowing spoof)", async () => {
  await withRollback(sql, async (tx) => {
    await asRuntime(tx);
    await expectSqlStateIn(tx, "42501", async (sp) => {
      await sp.unsafe(`CREATE TEMP TABLE pg_class (oid oid, relowner oid)`);
    });
  });
});

test("F1: fn_is_owner_context() reads pg_catalog.pg_class regardless of search_path (false for runtime)", async () => {
  await withRollback(sql, async (tx) => {
    await asRuntime(tx);
    await tx`SET LOCAL search_path = pg_temp, pg_catalog, public`;
    const rows = await tx<{ is_owner: boolean }[]>`SELECT public.fn_is_owner_context() AS is_owner`;
    assert.equal(rows[0].is_owner, false);
  });
});

// --- F2: terminal quotations must freeze their leftover DRAFT revision ----------------------

test("F2: a DRAFT revision of a terminal (CANCELLED) quotation can no longer be claimed or edited", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx, { itemCount: 0 });
    // Cancel straight from DRAFT (allowed: a draft can be cancelled without ever issuing).
    await tx`UPDATE quotations SET status = 'CANCELLED' WHERE id = ${fixture.quotationId}`;
    await tx`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
              VALUES (${fixture.quotationId}, NULL, 'DRAFT', 'CANCELLED', ${fixture.sellerUserId})`;

    await expectSqlStateIn(tx, "DTQ03", async (sp) => {
      await claimRevision(sp, fixture.revisionId, fixture.revisionVersion);
    });
    await expectSqlStateIn(tx, "DTQ03", async (sp) => {
      await sp`UPDATE quotation_revisions SET customer_name = 'x' WHERE id = ${fixture.revisionId}`;
    });
  });
});

test("F2: a new DRAFT revision cannot be inserted on a terminal quotation", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    await issueRevision(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });
    await tx`UPDATE quotations SET status = 'LOST' WHERE id = ${fixture.quotationId}`;
    await tx`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
              VALUES (${fixture.quotationId}, ${fixture.revisionId}, 'ISSUED', 'LOST', ${fixture.sellerUserId})`;

    await expectSqlStateIn(tx, "DTQ03", async (sp) => {
      await insertRevision(sp, {
        quotationId: fixture.quotationId,
        customerId: fixture.customerId,
        sellerUserId: fixture.sellerUserId,
        revisionNumber: 2,
      });
    });
  });
});

// --- F3: a merge target cannot be demoted from APPROVED while aliases point at it -----------

test("F3: demoting a merge target away from APPROVED while an alias points at it is rejected (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const proposer = await insertUser(tx, { roleCode: "SELLER" });
    const reviewer = await insertUser(tx, { roleCode: "COMMERCIAL_MANAGER" });
    const [a] = await tx<{ id: string }[]>`INSERT INTO catalog_items (name, proposed_by_user_id) VALUES ('A', ${proposer}) RETURNING id`;
    const [b] = await tx<{ id: string }[]>`INSERT INTO catalog_items (name, proposed_by_user_id) VALUES ('B', ${proposer}) RETURNING id`;
    await approveCatalog(tx, a.id, reviewer);
    await approveCatalog(tx, b.id, reviewer);
    await tx`UPDATE catalog_items SET status = 'MERGED', merged_into_id = ${b.id} WHERE id = ${a.id}`;

    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await sp`UPDATE catalog_items SET status = 'REJECTED', reviewed_by_user_id = ${reviewer}, reviewed_at = now() WHERE id = ${b.id}`;
    });
  });
});

// --- F4: claim + header UPDATE racing issuance must not deadlock ---------------------------

// F4 is covered deterministically in deterministic-races.test.ts (observed lock wait, exact outcome).

// --- F6: revision numbers must be sequential (max + 1) --------------------------------------

test("F6: a new revision must be numbered exactly max(revision_number) + 1 (DTV01 otherwise)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    await issueRevision(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });

    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await insertRevision(sp, {
        quotationId: fixture.quotationId,
        customerId: fixture.customerId,
        sellerUserId: fixture.sellerUserId,
        revisionNumber: 7,
      });
    });

    const rev2 = await insertRevision(tx, {
      quotationId: fixture.quotationId,
      customerId: fixture.customerId,
      sellerUserId: fixture.sellerUserId,
      revisionNumber: 2,
    });
    assert.ok(rev2.id);
  });
});

// --- F7: status_history to_status/from_status coherence -------------------------------------

test("F7: a status_history row with to_status = DRAFT is rejected (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx, { itemCount: 0 });
    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await sp`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
                VALUES (${fixture.quotationId}, NULL, NULL, 'DRAFT', ${fixture.sellerUserId})`;
    });
  });
});

test("F7: a status_history row whose from_status doesn't match the previous latest status is rejected (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    await issueRevision(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });
    await tx`UPDATE quotations SET status = 'SENT' WHERE id = ${fixture.quotationId}`;

    // Real previous latest to_status is ISSUED, not LOST.
    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await sp`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
                VALUES (${fixture.quotationId}, ${fixture.revisionId}, 'LOST', 'SENT', ${fixture.sellerUserId})`;
    });

    await tx`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
              VALUES (${fixture.quotationId}, ${fixture.revisionId}, 'ISSUED', 'SENT', ${fixture.sellerUserId})`;
  });
});

// --- F8: created_at immutability + owner/customer frozen once terminal ----------------------

test("F8: quotations.created_at is immutable (DTI01)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx, { itemCount: 0 });
    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`UPDATE quotations SET created_at = '2000-01-01' WHERE id = ${fixture.quotationId}`;
    });
  });
});

test("F8: owner_user_id cannot change once a quotation is terminal (DTQ03)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    await issueRevision(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });
    await tx`UPDATE quotations SET status = 'LOST' WHERE id = ${fixture.quotationId}`;
    await tx`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
              VALUES (${fixture.quotationId}, ${fixture.revisionId}, 'ISSUED', 'LOST', ${fixture.sellerUserId})`;

    const otherSeller = await insertUser(tx, { roleCode: "SELLER" });
    await expectSqlStateIn(tx, "DTQ03", async (sp) => {
      await sp`UPDATE quotations SET owner_user_id = ${otherSeller} WHERE id = ${fixture.quotationId}`;
    });
  });
});

// --- F9: issuance requires the revision's seller snapshot to match the current owner --------

test("F9: issuance is rejected if the revision's seller_user_id no longer matches the quotation's owner (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const s1 = await insertUser(tx, { roleCode: "SELLER" });
    const s2 = await insertUser(tx, { roleCode: "SELLER" });
    const customerId = await insertCustomer(tx, { ownerUserId: s1 });
    const quotation = await insertQuotation(tx, { customerId, ownerUserId: s1 });
    const revision = await insertRevision(tx, { quotationId: quotation.id, customerId, sellerUserId: s1 });
    const version = await claimRevision(tx, revision.id, revision.version);
    await insertItem(tx, { quotationId: quotation.id, revisionId: revision.id });

    // Reassign customer + quotation to s2 together (satisfies the deferred owner-match
    // check), but the revision's seller_user_id snapshot is still s1.
    await tx`UPDATE customers SET owner_user_id = ${s2} WHERE id = ${customerId}`;
    // The touch trigger bumps quotations.version on this UPDATE -- re-read it rather than
    // reusing the pre-reassignment value, or the version check (DTQ02) fires before F9's
    // seller-snapshot check ever gets a chance to.
    const [{ version: quotationVersion }] = await tx<{ version: number }[]>`
      UPDATE quotations SET owner_user_id = ${s2} WHERE id = ${quotation.id} RETURNING version`;
    // CR-06: proves the reassignment ITSELF is deferred-check-clean (a real bug there would
    // raise here, from a different guard, and would otherwise be indistinguishable from the
    // seller-snapshot rejection below). Then restore DEFERRED before calling issuance: with
    // constraints still IMMEDIATE, issuance's own header UPDATE would trip
    // trg_quotations_deferred_check (no matching ISSUED history yet) and raise its own
    // DTV01 -- the exact same SQLSTATE the seller guard would raise -- so a removed seller
    // guard could pass this test for the wrong reason (CR-06's whole point).
    await tx`SET CONSTRAINTS ALL IMMEDIATE`;
    await tx`SET CONSTRAINTS ALL DEFERRED`;

    // Not expectSqlStateIn: this needs the raise MESSAGE too (to prove it's the seller
    // guard specifically), so the savepoint failure is inspected here directly instead —
    // the error must propagate out of the savepoint callback itself, so postgres.js issues
    // ROLLBACK TO SAVEPOINT (not RELEASE SAVEPOINT, which would fail on an already-aborted
    // transaction if the rejection were swallowed inside the callback first).
    let caught: unknown;
    try {
      await tx.savepoint((sp) =>
        issueRevision(sp, {
          quotationId: quotation.id,
          revisionId: revision.id,
          expectedQuotationVersion: quotationVersion,
          expectedRevisionVersion: version,
          actorUserId: s2,
        }),
      );
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected issuance to be rejected");
    const code = (caught as { code?: string }).code;
    const message = caught instanceof Error ? caught.message : String(caught);
    assert.equal(code, "DTV01");
    assert.match(message, /seller_user_id/, `expected the seller-snapshot guard's own message, got: ${message}`);
  });
});

// --- F12: issuance requires an ACTIVE actor --------------------------------------------------

test("F12: issuance by a deactivated (INACTIVE) owner is rejected (DTQ04)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    // clock_timestamp(), not now(): now() returns the transaction's start time, which can be
    // *before* the seller's activated_at (a client-supplied timestamp set after the
    // transaction began) -- that would trip ck_users_status_coherence's deactivated_at >=
    // activated_at, unrelated to what this test is actually exercising.
    await tx`UPDATE users SET status = 'INACTIVE', deactivated_at = clock_timestamp() WHERE id = ${fixture.sellerUserId}`;

    await expectSqlStateIn(tx, "DTQ04", async (sp) => {
      await issueRevision(sp, {
        quotationId: fixture.quotationId,
        revisionId: fixture.revisionId,
        expectedQuotationVersion: fixture.quotationVersion,
        expectedRevisionVersion: fixture.revisionVersion,
        actorUserId: fixture.sellerUserId,
      });
    });
  });
});

// --- CR-02: NULL expected versions must not bypass the issuance CAS -------------------------

test("CR-02: issuance with both expected versions NULL is rejected (DTQ02), nothing changes", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);

    await expectSqlStateIn(tx, "DTQ02", async (sp) => {
      await sp`SELECT * FROM issue_quotation_revision(${fixture.quotationId}, ${fixture.revisionId}, NULL, NULL, ${fixture.sellerUserId})`;
    });

    const q = await tx<{ status: string; folio_year: number | null }[]>`
      SELECT status, folio_year FROM quotations WHERE id = ${fixture.quotationId}`;
    assert.equal(q[0].status, "DRAFT");
    assert.equal(q[0].folio_year, null);
    const r = await tx<{ state: string }[]>`SELECT state FROM quotation_revisions WHERE id = ${fixture.revisionId}`;
    assert.equal(r[0].state, "DRAFT");
    const h = await tx<{ count: string }[]>`SELECT count(*)::text FROM quotation_status_history WHERE quotation_id = ${fixture.quotationId}`;
    assert.equal(h[0].count, "0");
  });
});

test("CR-02: issuance with only the quotation's expected version NULL is rejected (DTQ02)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    await expectSqlStateIn(tx, "DTQ02", async (sp) => {
      await sp`SELECT * FROM issue_quotation_revision(${fixture.quotationId}, ${fixture.revisionId}, NULL, ${fixture.revisionVersion}, ${fixture.sellerUserId})`;
    });
  });
});

test("CR-02: issuance with only the revision's expected version NULL is rejected (DTQ02)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    await expectSqlStateIn(tx, "DTQ02", async (sp) => {
      await sp`SELECT * FROM issue_quotation_revision(${fixture.quotationId}, ${fixture.revisionId}, ${fixture.quotationVersion}, NULL, ${fixture.sellerUserId})`;
    });
  });
});

// --- CR-03: terminal quotations must reject item writes even under a still-valid claim ------

test("CR-03: item insert/update/delete is rejected (DTQ03) after claim -> cancel, even though the claim and DRAFT state are still technically valid", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx, { itemCount: 1 });
    const [existingItem] = await tx<{ id: string }[]>`
      SELECT id FROM quotation_items WHERE revision_id = ${fixture.revisionId} LIMIT 1`;

    await tx`UPDATE quotations SET status = 'CANCELLED' WHERE id = ${fixture.quotationId}`;
    await tx`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
              VALUES (${fixture.quotationId}, NULL, 'DRAFT', 'CANCELLED', ${fixture.sellerUserId})`;

    // The claim is still valid and the revision is still DRAFT -- only the parent
    // quotation's terminal status should be what blocks these.
    await expectSqlStateIn(tx, "DTQ03", async (sp) => {
      await insertItem(sp, { quotationId: fixture.quotationId, revisionId: fixture.revisionId, lineNumber: 99 });
    });
    await expectSqlStateIn(tx, "DTQ03", async (sp) => {
      await sp`UPDATE quotation_items SET item_name = 'x' WHERE id = ${existingItem.id}`;
    });
    await expectSqlStateIn(tx, "DTQ03", async (sp) => {
      await sp`DELETE FROM quotation_items WHERE id = ${existingItem.id}`;
    });
  });
});

// --- CR-04: audit_logs target coherence must be NULL-safe -----------------------------------

test("CR-04: target_type/target_id both NULL with a target_user_id set is rejected (23514)", async () => {
  await withRollback(sql, async (tx) => {
    const target = await insertUser(tx, { roleCode: "ADMIN" });
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO audit_logs (actor_type, action, result, target_type, target_id, target_user_id)
                VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS', NULL, NULL, ${target})`;
    });
  });
});

// --- CR-09: forbidden-key tokenization is word-boundary-aware, not substring -----------------

test("CR-09: harmless near-matches (compass_heading, hashtag, passport_number) are allowed", async () => {
  await withRollback(sql, async (tx) => {
    for (const key of ["compass_heading", "hashtag", "passport_number"]) {
      await tx.unsafe(
        `INSERT INTO audit_logs (actor_type, action, result, metadata) VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS', jsonb_build_object($1::text, 'x'))`,
        [key],
      );
    }
  });
});

test("CR-09: forbidden keys (incl. camelCase and multi-word) are rejected (23514)", async () => {
  await withRollback(sql, async (tx) => {
    for (const key of ["password", "userPassword", "password_hash", "accessToken", "api_key", "apiKey", "backupCodes"]) {
      await expectSqlStateIn(tx, "23514", async (sp) => {
        await sp.unsafe(
          `INSERT INTO audit_logs (actor_type, action, result, metadata) VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS', jsonb_build_object($1::text, 'x'))`,
          [key],
        );
      });
    }
  });
});

test("CR-09: acronym-prefixed secret keys are rejected even when nested in objects/arrays (23514)", async () => {
  await withRollback(sql, async (tx) => {
    for (const key of ["JWTToken", "TOTPSecret", "APISecret"]) {
      for (const shape of ["flat", "object", "array"] as const) {
        const metadata = JSON.stringify(
          shape === "flat" ? { [key]: "x" } : shape === "object" ? { a: { b: { [key]: "x" } } } : { a: [1, { [key]: "x" }] },
        );
        const [{ hit }] = await tx.unsafe<{ hit: boolean }[]>(`SELECT public.fn_jsonb_has_forbidden_keys($1::text::jsonb) AS hit`, [
          metadata,
        ]);
        assert.equal(hit, true, `${key} (${shape}) not detected`);
        await expectSqlStateIn(tx, "23514", async (sp) => {
          try {
            await sp.unsafe(
              `INSERT INTO audit_logs (actor_type, action, result, metadata) VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS', $1::text::jsonb)`,
              [metadata],
            );
          } catch (e) {
            assert.equal((e as { constraint_name?: string }).constraint_name, "ck_audit_logs_metadata_no_secrets");
            throw e;
          }
        });
      }
    }
    // Harmless acronym/near-match keys stay allowed.
    for (const key of ["HTTPStatus", "userID", "compass_heading", "hashtag", "passport_number"]) {
      await tx.unsafe(
        `INSERT INTO audit_logs (actor_type, action, result, metadata) VALUES ('SYSTEM', 'USERS.DEACTIVATE', 'SUCCESS', $1::text::jsonb)`,
        [JSON.stringify({ nested: [{ [key]: "x" }] })],
      );
    }
  });
});
