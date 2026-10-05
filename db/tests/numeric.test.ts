// Checks 9-11: monetary/percent/fx columns are exact-precision NUMERIC, NaN rejected,
// margin/tax_percent range CHECKs.
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import {
  createReadyToIssueQuotation,
  expectSqlStateIn,
  insertItem,
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

const EXPECTED_NUMERIC_COLUMNS: Record<string, { precision: number | null; scale: number | null }> = {
  "quotation_items.quantity": { precision: 18, scale: 6 },
  "quotation_items.unit_cost": { precision: 20, scale: 6 },
  "quotation_items.margin_percent": { precision: 9, scale: 6 },
  "quotation_items.unit_price": { precision: 20, scale: 6 },
  "quotation_items.subtotal": { precision: null, scale: null },
  "quotation_items.tax_percent": { precision: 9, scale: 6 },
  "quotation_items.tax_amount": { precision: null, scale: null },
  "quotation_items.total": { precision: null, scale: null },
  "quotation_revisions.fx_buy": { precision: 14, scale: 6 },
  "quotation_revisions.fx_sell": { precision: 14, scale: 6 },
  "quotation_revisions.fx_applied_rate": { precision: 14, scale: 6 },
  "quotation_revisions.subtotal": { precision: null, scale: null },
  "quotation_revisions.tax_total": { precision: null, scale: null },
  "quotation_revisions.total": { precision: null, scale: null },
  "exchange_rates.buy_rate": { precision: 14, scale: 6 },
  "exchange_rates.sell_rate": { precision: 14, scale: 6 },
  "system_settings.margin_warning_percent": { precision: 9, scale: 6 },
  "provider_costs.unit_cost": { precision: 20, scale: 6 },
};

test("check 9: exact set of monetary/percent/fx columns, all numeric with expected precision/scale", async () => {
  await withRollback(sql, async (tx) => {
    const rows = await tx<
      { table_name: string; column_name: string; numeric_precision: number | null; numeric_scale: number | null }[]
    >`
      SELECT table_name, column_name, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'numeric'`;

    const actual: Record<string, { precision: number | null; scale: number | null }> = {};
    for (const r of rows) {
      actual[`${r.table_name}.${r.column_name}`] = { precision: r.numeric_precision, scale: r.numeric_scale };
    }
    assert.deepEqual(actual, EXPECTED_NUMERIC_COLUMNS);
  });
});

test("check 9b: NaN rejected on a numeric business column (23514)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx, { itemCount: 0 });
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO quotation_items (quotation_id, revision_id, line_number, item_name,
                 quantity, unit_cost, cost_currency, margin_percent, unit_price)
               VALUES (${fixture.quotationId}, ${fixture.revisionId}, 1, 'Item', 1, 'NaN', 'CRC', 20, 120)`;
    });
  });
});

test("check 10: margin_percent 100 ok, 100.000001 rejected (23514)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx, { itemCount: 0 });
    await tx`INSERT INTO quotation_items (quotation_id, revision_id, line_number, item_name,
               quantity, unit_cost, cost_currency, margin_percent, unit_price)
             VALUES (${fixture.quotationId}, ${fixture.revisionId}, 1, 'Item', 1, 100, 'CRC', 100, 120)`;

    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO quotation_items (quotation_id, revision_id, line_number, item_name,
                 quantity, unit_cost, cost_currency, margin_percent, unit_price)
               VALUES (${fixture.quotationId}, ${fixture.revisionId}, 2, 'Item2', 1, 100, 'CRC', 100.000001, 120)`;
    });
  });
});

test("check 11a: margin_percent 0 rejected (23514)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx, { itemCount: 0 });
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO quotation_items (quotation_id, revision_id, line_number, item_name,
                 quantity, unit_cost, cost_currency, margin_percent, unit_price)
               VALUES (${fixture.quotationId}, ${fixture.revisionId}, 1, 'Item', 1, 100, 'CRC', 0, 120)`;
    });
  });
});

// NUMERIC multiplication/division in Postgres tracks scale exactly (e.g. scale(a)*scale(b)
// for a product), so a generated column often comes back with trailing zeros the hand-typed
// expected literal doesn't have ("3703.703673000000" vs "3703.703673") -- strip them so the
// comparison is on VALUE, which is what these tests are actually asserting, not on Postgres's
// internal scale bookkeeping.
function normalizeDecimal(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

// CR-07(c): independently assert the generated-column arithmetic itself with a known,
// hand-computed value, not just "it's some numeric" -- incorrect generated tax arithmetic
// (e.g. a wrong divisor, wrong rounding) could stay internally self-consistent (total ==
// subtotal+tax) and pass every other check while still being wrong.
test("check 9c: generated subtotal/tax_amount/total match hand-computed values exactly", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx, { itemCount: 0 });
    const itemId = await insertItem(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      quantity: "3",
      unitCost: "1000",
      unitPrice: "1234.567891",
      marginPercent: "20",
    });
    const rows = await tx<{ subtotal: string; tax_amount: string; total: string }[]>`
      SELECT subtotal, tax_amount, total FROM quotation_items WHERE id = ${itemId}`;
    // 3 * 1234.567891 = 3703.703673; * 13% = 481.48147749; sum = 4185.18515049.
    assert.equal(normalizeDecimal(rows[0].subtotal), "3703.703673");
    assert.equal(normalizeDecimal(rows[0].tax_amount), "481.48147749");
    assert.equal(normalizeDecimal(rows[0].total), "4185.18515049");
  });
});

test("check 9d: an issued revision's frozen totals equal the independently hand-computed sum of its items", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx, { itemCount: 0 });
    // Two items with distinct, exactly-representable-at-scale values.
    await insertItem(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      lineNumber: 1,
      quantity: "3",
      unitCost: "1000",
      unitPrice: "1234.567891",
      marginPercent: "20",
    });
    await insertItem(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      lineNumber: 2,
      quantity: "2.5",
      unitCost: "50",
      unitPrice: "60",
      marginPercent: "20",
    });
    // subtotal: 3703.703673 + 150 = 3853.703673
    // tax:      481.48147749 + 19.5 = 500.98147749
    // total:    4185.18515049 + 169.5 = 4354.68515049
    await issueRevision(tx, {
      quotationId: fixture.quotationId,
      revisionId: fixture.revisionId,
      expectedQuotationVersion: fixture.quotationVersion,
      expectedRevisionVersion: fixture.revisionVersion,
      actorUserId: fixture.sellerUserId,
    });

    const rows = await tx<{ subtotal: string; tax_total: string; total: string }[]>`
      SELECT subtotal, tax_total, total FROM quotation_revisions WHERE id = ${fixture.revisionId}`;
    assert.equal(normalizeDecimal(rows[0].subtotal), "3853.703673");
    assert.equal(normalizeDecimal(rows[0].tax_total), "500.98147749");
    assert.equal(normalizeDecimal(rows[0].total), "4354.68515049");
  });
});

test("check 11b: tax_percent other than 13 rejected (23514)", async () => {
  await withRollback(sql, async (tx) => {
    const fixture = await createReadyToIssueQuotation(tx, { itemCount: 0 });
    await expectSqlStateIn(tx, "23514", async (sp) => {
      await sp`INSERT INTO quotation_items (quotation_id, revision_id, line_number, item_name,
                 quantity, unit_cost, cost_currency, margin_percent, unit_price, tax_percent)
               VALUES (${fixture.quotationId}, ${fixture.revisionId}, 1, 'Item', 1, 100, 'CRC', 20, 120, 12)`;
    });
  });
});
