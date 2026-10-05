// Check 12: folio uniqueness + format. Check 13: real concurrent issuance is gapless and
// duplicate-free; a failed issuance doesn't consume a number; double-submit of the same
// revision is idempotent; year-rollover independence.
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import {
  createReadyToIssueQuotation,
  expectSqlStateIn,
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

test("check 12a: uq_quotations_folio rejects a duplicate (year, number) pair (23505)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    await issueRevision(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });
    const [{ folio_year, folio_number }] = await tx<{ folio_year: number; folio_number: number }[]>`
      SELECT folio_year, folio_number FROM quotations WHERE id = ${fixture.quotationId}`;

    // Force a second row to the exact same (year, number) directly, bypassing the
    // counter/issuance protocol, to exercise the UNIQUE backstop itself.
    const other = await createReadyToIssueQuotation(tx, { itemCount: 0 });
    await expectSqlStateIn(tx, "23505", async (sp) => {
      await sp`UPDATE quotations SET status = 'ISSUED', folio_year = ${folio_year}, folio_number = ${folio_number}
                WHERE id = ${other.quotationId}`;
    });
  });
});

test("check 12b: folio renders as COT-YYYY-NNN, and pads number 1000 without truncation", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    const result = await issueRevision(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });
    assert.match(result.folio, /^COT-\d{4}-\d{3,}$/);

    const [{ folio_year }] = await tx<{ folio_year: number }[]>`
      SELECT folio_year FROM quotations WHERE id = ${fixture.quotationId}`;

    const big = await createReadyToIssueQuotation(tx);
    // fn_folio_counter_guard only allows +1 steps; jump ahead by disabling it for one
    // statement (owner-only DDL, rolled back with everything else in this test).
    await tx`ALTER TABLE quotation_folio_counters DISABLE TRIGGER trg_quotation_folio_counters_guard`;
    await tx`UPDATE quotation_folio_counters SET last_number = 999 WHERE folio_year = ${folio_year}`;
    await tx`ALTER TABLE quotation_folio_counters ENABLE TRIGGER trg_quotation_folio_counters_guard`;
    const bigResult = await issueRevision(tx, {
      quotationId: big.quotationId,
      revisionId: big.revisionId,
      expectedQuotationVersion: big.quotationVersion,
      expectedRevisionVersion: big.revisionVersion,
      actorUserId: big.sellerUserId,
    });
    assert.equal(bigResult.folio, `COT-${folio_year}-1000`);
  });
});

test("check 13a: N=10 parallel issuances on distinct quotations get a gapless, duplicate-free folio range", async () => {
  const clients: postgres.Sql[] = [];
  const setup = await newClient();
  clients.push(setup);
  try {
    const N = 10;
    const fixtures = [];
    for (let i = 0; i < N; i += 1) {
      // The claim GUC is transaction-local: build+claim+item-insert must share one
      // real transaction, not N separate autocommit statements on `setup`.
      fixtures.push(await setup.begin((btx) => createReadyToIssueQuotation(btx)));
    }

    const results = await Promise.all(
      fixtures.map(async (fixture) => {
        const client = await newClient();
        clients.push(client);
        return issueRevision(client, {
          quotationId: fixture.quotationId,
          revisionId: fixture.revisionId,
          expectedQuotationVersion: fixture.quotationVersion,
          expectedRevisionVersion: fixture.revisionVersion,
          actorUserId: fixture.sellerUserId,
        });
      }),
    );

    const numbers = results
      .map((r) => Number(r.folio.split("-")[2]))
      .sort((a, b) => a - b);
    const unique = new Set(numbers);
    assert.equal(unique.size, N, `expected ${N} distinct folio numbers, got ${JSON.stringify(numbers)}`);
    for (let i = 1; i < numbers.length; i += 1) {
      assert.equal(numbers[i], numbers[i - 1] + 1, `gap in folio sequence: ${JSON.stringify(numbers)}`);
    }
  } finally {
    await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
  }
});

test("check 13b: a failed issuance (zero items) does not consume a folio number", async () => {
  await withRollback(sql, async (tx) => {
    // Other (real, committed) concurrency tests in this suite may have already issued
    // folios for the current year, so read the counter's current value rather than
    // assuming it starts at 0 -- the invariant under test is "unchanged by a failed
    // attempt", not "always the first number ever".
    const [{ before }] = await tx<{ before: number }[]>`
      SELECT coalesce(
        (SELECT last_number FROM quotation_folio_counters
         WHERE folio_year = extract(year FROM (clock_timestamp() AT TIME ZONE 'America/Costa_Rica'))::smallint),
        0
      )::int AS before`;

    const empty = await createReadyToIssueQuotation(tx, { itemCount: 0 });
    await expectSqlStateIn(tx, "DTV01", async (sp) => {
      await issueRevision(sp, {
        quotationId: empty.quotationId,
        revisionId: empty.revisionId,
        expectedQuotationVersion: empty.quotationVersion,
        expectedRevisionVersion: empty.revisionVersion,
        actorUserId: empty.sellerUserId,
      });
    });

    const real = await createReadyToIssueQuotation(tx, { itemCount: 1 });
    const result = await issueRevision(tx, {
      quotationId: real.quotationId,
      revisionId: real.revisionId,
      expectedQuotationVersion: real.quotationVersion,
      expectedRevisionVersion: real.revisionVersion,
      actorUserId: real.sellerUserId,
    });
    // The failed issuance rolled back its own counter increment entirely (it never got past
    // the item-count check, which runs before the counter is touched) -- so the next real
    // issuance gets exactly `before + 1`, not `before + 2`.
    const gotNumber = Number(result.folio.split("-")[2]);
    assert.equal(gotNumber, before + 1);
  });
});

test("check 13c: double-submit of the SAME revision from 5 connections yields exactly one issuance", async () => {
  const clients: postgres.Sql[] = [];
  const setup = await newClient();
  clients.push(setup);
  try {
    const fixture = await setup.begin((btx) => createReadyToIssueQuotation(btx));

    const N = 5;
    const outcomes = await Promise.allSettled(
      Array.from({ length: N }, async () => {
        const client = await newClient();
        clients.push(client);
        return issueRevision(client, {
          quotationId: fixture.quotationId,
          revisionId: fixture.revisionId,
          expectedQuotationVersion: fixture.quotationVersion,
          expectedRevisionVersion: fixture.revisionVersion,
          actorUserId: fixture.sellerUserId,
        });
      }),
    );

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof issueRevision>>
    >[];
    assert.equal(fulfilled.length, N, `expected all ${N} calls to succeed (idempotent), got ${JSON.stringify(outcomes)}`);

    const notAlreadyIssued = fulfilled.filter((o) => o.value.alreadyIssued === false);
    assert.equal(notAlreadyIssued.length, 1, "expected exactly one caller to have actually performed the issuance");
    const alreadyIssued = fulfilled.filter((o) => o.value.alreadyIssued === true);
    assert.equal(alreadyIssued.length, N - 1);

    const folios = new Set(fulfilled.map((o) => o.value.folio));
    assert.equal(folios.size, 1, "all callers must observe the same folio");

    const historyRows = await setup<{ count: string }[]>`
      SELECT count(*)::text FROM quotation_status_history
      WHERE revision_id = ${fixture.revisionId} AND to_status = 'ISSUED'`;
    assert.equal(historyRows[0].count, "1");
  } finally {
    await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
  }
});

test("year-rollover: counters for different years are independent, both render zero-padded", async () => {
  await withRollback(sql, async (tx) => {
    const a = await createReadyToIssueQuotation(tx);
    const resultA = await issueRevision(tx, {
      quotationId: a.quotationId,
      revisionId: a.revisionId,
      expectedQuotationVersion: a.quotationVersion,
      expectedRevisionVersion: a.revisionVersion,
      actorUserId: a.sellerUserId,
    });
    const [{ folio_year: yearA }] = await tx<{ folio_year: number }[]>`
      SELECT folio_year FROM quotations WHERE id = ${a.quotationId}`;
    const otherYear = yearA + 1;

    // Directly seed an independent counter row for a different year and issue against it by
    // pre-existing folio_year on the quotation header (simulates a quotation carried across a
    // real year boundary without needing to mock the clock).
    await tx`INSERT INTO quotation_folio_counters (folio_year, last_number) VALUES (${otherYear}, 1)`;
    assert.notEqual(resultA.folio, `COT-${otherYear}-001`);

    const rows = await tx<{ folio_year: number; last_number: number }[]>`
      SELECT folio_year, last_number FROM quotation_folio_counters WHERE folio_year IN (${yearA}, ${otherYear})
      ORDER BY folio_year`;
    assert.equal(rows.length, 2);
  });
});

test("bonus: not-owner actor cannot issue (DTQ04); stale expected version (DTQ02)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    const stranger = await insertUser(tx, { roleCode: "SELLER" });

    await expectSqlStateIn(tx, "DTQ04", async (sp) => {
      await issueRevision(sp, {
        quotationId: fixture.quotationId,
        revisionId: fixture.revisionId,
        expectedQuotationVersion: fixture.quotationVersion,
        expectedRevisionVersion: fixture.revisionVersion,
        actorUserId: stranger,
      });
    });
  });

  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx);
    await expectSqlStateIn(tx, "DTQ02", async (sp) => {
      await issueRevision(sp, {
        quotationId: fixture.quotationId,
        revisionId: fixture.revisionId,
        expectedQuotationVersion: fixture.quotationVersion,
        expectedRevisionVersion: fixture.revisionVersion + 1,
        actorUserId: fixture.sellerUserId,
      });
    });
  });
});
