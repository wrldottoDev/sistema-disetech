// Check 14: issued revisions/items are immutable. Check 16: invalid state transitions.
// Check 17: composite FK on generated_documents. Plus: quotation_reviews.revision_version
// must match.
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import {
  claimRevision,
  createReadyToIssueQuotation,
  expectDeferredSqlState,
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

async function issueDefault(tx: postgres.TransactionSql) {
  const fixture = await createReadyToIssueQuotation(tx);
  await issueRevision(tx, {
    quotationId: fixture.quotationId,
    revisionId: fixture.revisionId,
    expectedQuotationVersion: fixture.quotationVersion,
    expectedRevisionVersion: fixture.revisionVersion,
    actorUserId: fixture.sellerUserId,
  });
  return fixture;
}

test("check 14: an ISSUED revision and its items are immutable (DTI01)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await issueDefault(tx);
    const [item] = await tx<{ id: string }[]>`
      SELECT id FROM quotation_items WHERE revision_id = ${fixture.revisionId} LIMIT 1`;

    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`UPDATE quotation_revisions SET customer_name = 'x' WHERE id = ${fixture.revisionId}`;
    });
    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`DELETE FROM quotation_revisions WHERE id = ${fixture.revisionId}`;
    });
    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await insertItem(sp, { quotationId: fixture.quotationId, revisionId: fixture.revisionId, lineNumber: 99 });
    });
    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`UPDATE quotation_items SET item_name = 'x' WHERE id = ${item.id}`;
    });
    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`DELETE FROM quotation_items WHERE id = ${item.id}`;
    });
  });
});

test("check 14b: an item cannot move to a different revision (DTI01)", async () => {
  await withRollback(sql, async (tx) => {
    const seller = await insertUser(tx, { roleCode: "SELLER" });
    const a = await createReadyToIssueQuotation(tx, { sellerUserId: seller });
    const b = await createReadyToIssueQuotation(tx, { sellerUserId: seller, itemCount: 0 });
    const [item] = await tx<{ id: string }[]>`
      SELECT id FROM quotation_items WHERE revision_id = ${a.revisionId} LIMIT 1`;

    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`UPDATE quotation_items SET revision_id = ${b.revisionId}, quotation_id = ${b.quotationId} WHERE id = ${item.id}`;
    });
  });
});

test("check 14c: TRUNCATE on protected tables is rejected (DTI01)", async () => {
  await withRollback(sql, async (tx) => {
    // Leaf tables only: a table with incoming FKs raises 0A000 ("referenced by a foreign
    // key constraint") before the trigger even runs, which would test Postgres's own FK
    // planner, not fn_prevent_mutation. All 19 tables carry the same BEFORE TRUNCATE
    // STATEMENT trigger (0001); these five have no incoming FKs, so TRUNCATE reaches it.
    for (const table of [
      "quotation_items",
      "audit_logs",
      "generated_documents",
      "quotation_status_history",
      "quotation_reviews",
    ] as const) {
      await expectSqlStateIn(tx, "DTI01", async (sp) => {
        await sp.unsafe(`TRUNCATE TABLE ${table}`);
      });
    }
  });
});

test("check 16a: a quotation cannot be inserted already ISSUED (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const seller = await insertUser(tx, { roleCode: "SELLER" });
    const customerId = await insertCustomer(tx, { ownerUserId: seller });
    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await sp`INSERT INTO quotations (customer_id, owner_user_id, status) VALUES (${customerId}, ${seller}, 'ISSUED')`;
    });
  });
});

test("check 16b: a quotation cannot transition back to DRAFT (DTQ03)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await issueDefault(tx);
    await expectSqlStateIn(tx, "DTQ03", async (sp) => {
      await sp`UPDATE quotations SET status = 'DRAFT' WHERE id = ${fixture.quotationId}`;
    });
  });
});

test("check 16c: WON without a sold_revision_id is rejected (23514)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await issueDefault(tx);
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`UPDATE quotations SET status = 'WON' WHERE id = ${fixture.quotationId}`;
    });
  });
});

test("check 16d: a quotation cannot change after a terminal status (DTQ03)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await issueDefault(tx);
    await tx`UPDATE quotations SET status = 'WON', sold_revision_id = ${fixture.revisionId} WHERE id = ${fixture.quotationId}`;
    await tx`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
              VALUES (${fixture.quotationId}, ${fixture.revisionId}, 'ISSUED', 'WON', ${fixture.sellerUserId})`;
    await expectSqlStateIn(tx, "DTQ03", async (sp) => {
      await sp`UPDATE quotations SET status = 'LOST' WHERE id = ${fixture.quotationId}`;
    });
    const rows = await tx<{ status: string }[]>`SELECT status FROM quotations WHERE id = ${fixture.quotationId}`;
    assert.equal(rows[0].status, "WON");
  });
});

test("check 16e: status without a matching history row fails at commit (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await issueDefault(tx);
    await expectDeferredSqlState(tx, "DTV01", async (sp) => {
      await sp`UPDATE quotations SET status = 'SENT' WHERE id = ${fixture.quotationId}`;
    });
  });
});

test("check 17a: generated_documents composite FK rejects a mismatched (quotation, revision) pair (23503)", async () => {
  await withRollback(sql, async (tx) => {
    const seller = await insertUser(tx, { roleCode: "SELLER" });
    const q1 = await issueDefault(tx);
    // q2's revision must also be ISSUED, or fn_generated_documents_guard's own "must
    // reference an ISSUED revision" check (DTV01) fires first and masks the FK violation
    // under test here.
    const q2fixture = await createReadyToIssueQuotation(tx, { sellerUserId: seller });
    await issueRevision(tx, {
      quotationId: q2fixture.quotationId,
      revisionId: q2fixture.revisionId,
      expectedQuotationVersion: q2fixture.quotationVersion,
      expectedRevisionVersion: q2fixture.revisionVersion,
      actorUserId: q2fixture.sellerUserId,
    });
    const q2 = q2fixture;
    const uploader = q1.sellerUserId;

    await expectSqlStateIn(tx, "23503", async (sp) => {
      await sp`INSERT INTO generated_documents (
                 quotation_id, revision_id, storage_provider, storage_key, file_name, byte_size, sha256, created_by_user_id
               ) VALUES (
                 ${q1.quotationId}, ${q2.revisionId}, 'LOCAL_FS', 'docs/x.pdf', 'x.pdf', 100, ${"a".repeat(64)}, ${uploader}
               )`;
    });
  });
});

test("check 17b: a document for the correct (quotation, revision) pair succeeds; a DRAFT revision is rejected (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const q1 = await issueDefault(tx);
    await tx`INSERT INTO generated_documents (
               quotation_id, revision_id, storage_provider, storage_key, file_name, byte_size, sha256, created_by_user_id
             ) VALUES (
               ${q1.quotationId}, ${q1.revisionId}, 'LOCAL_FS', 'docs/ok.pdf', 'ok.pdf', 100, ${"b".repeat(64)}, ${q1.sellerUserId}
             )`;

    const draft = await createReadyToIssueQuotation(tx, { sellerUserId: q1.sellerUserId, itemCount: 0 });
    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await sp`INSERT INTO generated_documents (
                 quotation_id, revision_id, storage_provider, storage_key, file_name, byte_size, sha256, created_by_user_id
               ) VALUES (
                 ${draft.quotationId}, ${draft.revisionId}, 'LOCAL_FS', 'docs/draft.pdf', 'draft.pdf', 100, ${"c".repeat(64)}, ${q1.sellerUserId}
               )`;
    });
  });
});

test("plus: quotation_reviews.revision_version must equal the revision's current version (DTV01)", async () => {
  await withRollback(sql, async (tx) => {
    const seller = await insertUser(tx, { roleCode: "SELLER" });
    const reviewer = await insertUser(tx, { roleCode: "COMMERCIAL_MANAGER" });
    const customerId = await insertCustomer(tx, { ownerUserId: seller });
    const quotation = await insertQuotation(tx, { customerId, ownerUserId: seller });
    const revision = await insertRevision(tx, { quotationId: quotation.id, customerId, sellerUserId: seller });
    const claimed = await claimRevision(tx, revision.id, revision.version);

    await tx`INSERT INTO quotation_reviews (quotation_id, revision_id, revision_version, reviewer_user_id, outcome)
              VALUES (${quotation.id}, ${revision.id}, ${claimed}, ${reviewer}, 'APPROVED')`;

    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await sp`INSERT INTO quotation_reviews (quotation_id, revision_id, revision_version, reviewer_user_id, outcome)
                VALUES (${quotation.id}, ${revision.id}, ${claimed - 1}, ${reviewer}, 'APPROVED')`;
    });
  });
});
