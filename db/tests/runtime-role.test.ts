// Runtime-role tests: everything the non-owner application role (disetech_test_runtime,
// provisioned by run.ts from db/sql/runtime-grants.sql) can and cannot do. The four
// owner-context-only writes (A4) must be unreachable directly; issuance and ordinary status
// transitions must work through the documented paths.
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import {
  asRuntime,
  createReadyToIssueQuotation,
  expectSqlStateIn,
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

test("runtime role cannot UPDATE quotation_folio_counters directly (42501, no grant)", async () => {
  await withRollback(sql, async (tx) => {
    await tx`INSERT INTO quotation_folio_counters (folio_year, last_number) VALUES (2999, 1)`;
    await asRuntime(tx);
    await expectSqlStateIn(tx, "42501", async (sp) => {
      await sp`UPDATE quotation_folio_counters SET last_number = 2 WHERE folio_year = 2999`;
    });
  });
});

test("runtime role cannot assign a folio directly (DTI01, owner-context only)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    await tx`INSERT INTO quotation_folio_counters (folio_year, last_number) VALUES (2998, 1) ON CONFLICT DO NOTHING`;
    await asRuntime(tx);
    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`UPDATE quotations SET status = 'ISSUED', folio_year = 2998, folio_number = 1 WHERE id = ${fixture.quotationId}`;
    });
  });
});

test("runtime role cannot flip a revision to ISSUED directly (DTI01, owner-context only)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    // Give the quotation a folio the owner-context way, so only the revision-side guard is
    // under test here.
    await issueRevision(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });
    // A second, independent DRAFT revision on the same (now-ISSUED-once) quotation, to
    // attack the "flip to ISSUED" path directly instead of through the function.
    const [rev2] = await tx<{ id: string; version: number }[]>`
      INSERT INTO quotation_revisions (
        quotation_id, customer_id, revision_number, currency, customer_name, customer_email,
        seller_user_id, seller_name, seller_email, seller_phone, created_by_user_id
      )
      SELECT quotation_id, customer_id, 2, currency, customer_name, customer_email,
             seller_user_id, seller_name, seller_email, seller_phone, created_by_user_id
      FROM quotation_revisions WHERE id = ${fixture.revisionId}
      RETURNING id, version`;

    await asRuntime(tx);
    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`UPDATE quotation_revisions
                 SET state = 'ISSUED', issued_at = now(), issued_by_user_id = ${fixture.sellerUserId},
                     subtotal = 0, tax_total = 0, total = 0
                 WHERE id = ${rev2.id}`;
    });
  });
});

test("runtime role cannot insert an ISSUED status_history row directly (DTI01, owner-context only)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    await issueRevision(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });

    await asRuntime(tx);
    await expectSqlStateIn(tx, "DTI01", async (sp) => {
      await sp`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
                 VALUES (${fixture.quotationId}, ${fixture.revisionId}, 'ISSUED', 'ISSUED', ${fixture.sellerUserId})`;
    });
  });
});

test("runtime role cannot CREATE FUNCTION in public (42501)", async () => {
  await withRollback(sql, async (tx) => {
    await asRuntime(tx);
    await expectSqlStateIn(tx, "42501", async (sp) => {
      await sp.unsafe(`CREATE FUNCTION pwn_${Date.now()}() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$`);
    });
  });
});

test("PUBLIC has no EXECUTE on issue_quotation_revision", async () => {
  await withRollback(sql, async (tx) => {
    const rows = await tx<{ has: boolean }[]>`
      SELECT has_function_privilege(
        'public',
        'public.issue_quotation_revision(uuid,uuid,integer,integer,uuid)',
        'EXECUTE'
      ) AS has`;
    assert.equal(rows[0].has, false);
  });
});

test("runtime role CAN build a draft and issue it end-to-end through issue_quotation_revision", async () => {
  await withRollback(sql, async (tx) => {
    await asRuntime(tx);
    const fixture = await createReadyToIssueQuotation(tx);
    const result = await issueRevision(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });
    assert.equal(result.alreadyIssued, false);
    assert.match(result.folio, /^COT-\d{4}-\d{3,}$/);
  });
});

test("runtime role CAN mark SENT/WON/CANCELLED directly, with a matching history row", async () => {
  await withRollback(sql, async (tx) => {
    async function issuedFixture() {
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

    const sentCase = await issuedFixture();
    const wonCase = await issuedFixture();
    const cancelledCase = await issuedFixture();

    await asRuntime(tx);

    await tx`UPDATE quotations SET status = 'SENT' WHERE id = ${sentCase.quotationId}`;
    await tx`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
              VALUES (${sentCase.quotationId}, ${sentCase.revisionId}, 'ISSUED', 'SENT', ${sentCase.sellerUserId})`;

    await tx`UPDATE quotations SET status = 'WON', sold_revision_id = ${wonCase.revisionId} WHERE id = ${wonCase.quotationId}`;
    await tx`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
              VALUES (${wonCase.quotationId}, ${wonCase.revisionId}, 'ISSUED', 'WON', ${wonCase.sellerUserId})`;

    await tx`UPDATE quotations SET status = 'CANCELLED' WHERE id = ${cancelledCase.quotationId}`;
    await tx`INSERT INTO quotation_status_history (quotation_id, revision_id, from_status, to_status, changed_by_user_id)
              VALUES (${cancelledCase.quotationId}, NULL, 'ISSUED', 'CANCELLED', ${cancelledCase.sellerUserId})`;

    const rows = await tx<{ id: string; status: string }[]>`
      SELECT id, status FROM quotations WHERE id IN (${sentCase.quotationId}, ${wonCase.quotationId}, ${cancelledCase.quotationId})`;
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    assert.equal(byId.get(sentCase.quotationId), "SENT");
    assert.equal(byId.get(wonCase.quotationId), "WON");
    assert.equal(byId.get(cancelledCase.quotationId), "CANCELLED");
  });
});
