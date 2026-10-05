import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { customers, catalogItems, providers } from "./commercial";
import { exchangeRates, currencyCode, exchangeRateSource } from "./finance";

// A §0 enum policy
export const quotationRevisionState = pgEnum("quotation_revision_state", ["DRAFT", "ISSUED"]);
export const quotationReviewOutcome = pgEnum("quotation_review_outcome", [
  "APPROVED",
  "REJECTED",
  "CHANGES_REQUESTED",
]);

// A §1.10, CHECKs amended by A2 Q9 (folio_year range added). No version — the issuance
// transaction's ON CONFLICT row lock is the concurrency mechanism (custom migration).
export const quotationFolioCounters = pgTable(
  "quotation_folio_counters",
  {
    folioYear: smallint("folio_year").primaryKey(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (t) => [
    check("ck_quotation_folio_counters_non_negative", sql`${t.lastNumber} >= 0`),
    check("ck_quotation_folio_counters_year_range", sql`${t.folioYear} BETWEEN 2000 AND 9999`),
  ],
);

// Breaks the quotations <-> quotation_revisions mutual type-inference cycle: quotations
// carries a composite FK into quotation_revisions(quotation_id, id) declared below, while
// quotation_revisions carries a plain FK back into quotations(id). Wrapping the forward
// reference in an explicitly-typed accessor (IMPL-brief: "AnyPgColumn as needed") lets
// TS resolve both table types independently instead of requiring each other's inferred
// shape. Safe at runtime too: pgTable's extraConfig callback is stored, not invoked, until
// drizzle-kit later introspects the fully-evaluated module.
const quotationRevisionsQuotationIdRef = (): AnyPgColumn => quotationRevisions.quotationId;
const quotationRevisionsIdRef = (): AnyPgColumn => quotationRevisions.id;

// A §1.11, CHECKs replaced by A2 Q1 (CANCELLED-may-have-a-folio nuance, folio value range),
// indexes replaced by A2 Q1 (status+updated_at DESC for manager pipeline, drops plain status
// index). Transition matrix and folio-issuance protocol are app/trigger-enforced (A2 Q3/Q11,
// A3 DB-33/34/37) — not modeled here.
export const quotations = pgTable(
  "quotations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    status: text("status").notNull().default("DRAFT"),
    folioYear: smallint("folio_year"),
    folioNumber: integer("folio_number"),
    // A §1.11 — GREATEST(3, ...) guard is required: plain lpad(n::text, 3, '0') truncates
    // and collides once folio_number >= 1000.
    folio: text("folio").generatedAlwaysAs(sql`CASE
      WHEN folio_year IS NULL THEN NULL
      ELSE 'COT-' || folio_year::text || '-' ||
           lpad(folio_number::text, GREATEST(3, length(folio_number::text)), '0')
      END`),
    soldRevisionId: uuid("sold_revision_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    // version/updated_at DB-trigger-maintained (A2 G4, fn_touch_version) — no $onUpdate.
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("uq_quotations_folio").on(t.folioYear, t.folioNumber),
    index("ix_quotations_customer_id").on(t.customerId),
    index("ix_quotations_owner_status").on(t.ownerUserId, t.status),
    // A2 Q1 — replaces ix_quotations_status (manager pipeline, most-recently-updated first).
    index("ix_quotations_status_updated").on(t.status, t.updatedAt.desc()),
    foreignKey({
      name: "fk_quotations_customer_id",
      columns: [t.customerId],
      foreignColumns: [customers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_quotations_created_by_user_id",
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_quotations_owner_user_id",
      columns: [t.ownerUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    // Orchestrator ruling #9 — structurally impossible to point at another quotation's
    // revision; requires UNIQUE(quotation_id, id) on quotation_revisions (below).
    foreignKey({
      name: "fk_quotations_id_sold_revision_id",
      columns: [t.id, t.soldRevisionId],
      foreignColumns: [quotationRevisionsQuotationIdRef(), quotationRevisionsIdRef()],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    // A2 Q1 (amends A) — a draft can be cancelled without ever getting a folio.
    check(
      "ck_quotations_folio_coherence",
      sql`((${t.folioYear} IS NULL AND ${t.folioNumber} IS NULL) OR (${t.folioYear} IS NOT NULL AND ${t.folioNumber} IS NOT NULL))
        AND (${t.status} <> 'DRAFT' OR ${t.folioYear} IS NULL)
        AND (${t.status} NOT IN ('ISSUED','SENT','WON','LOST') OR ${t.folioYear} IS NOT NULL)`,
    ),
    check(
      "ck_quotations_folio_values",
      sql`${t.folioYear} IS NULL OR (${t.folioYear} BETWEEN 2000 AND 9999 AND ${t.folioNumber} > 0)`,
    ),
    check(
      "ck_quotations_sold_coherence",
      sql`(${t.status} = 'WON' AND ${t.soldRevisionId} IS NOT NULL) OR (${t.status} <> 'WON' AND ${t.soldRevisionId} IS NULL)`,
    ),
    // Orchestrator ruling #4 — EXPIRED dropped; text+CHECK (not pgEnum) since this is business
    // policy expected to keep changing (A §0).
    check(
      "ck_quotations_status_values",
      sql`${t.status} IN ('DRAFT','ISSUED','SENT','WON','LOST','CANCELLED')`,
    ),
  ],
);

// A §1.12, amended by A2 Q4 (issued_by_user_id, updated_at, fx_applied_rate, fx_source ->
// enum, seller/customer snapshot columns), A3 DB-06/17 (subtotal/tax_total/total become
// nullable unconstrained NUMERIC, NULL until issued) and A3 DB-37 (customer_id). Draft-edit
// claim protocol and issued-immutability are trigger-enforced (A3 DB-03/A4 DB-03) — not
// modeled here.
export const quotationRevisions = pgTable(
  "quotation_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quotationId: uuid("quotation_id").notNull(),
    // A3 DB-37 — the customer this snapshot was taken from; must equal quotations.customer_id
    // at DRAFT->ISSUED time (trigger-enforced).
    customerId: uuid("customer_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    state: quotationRevisionState("state").notNull().default("DRAFT"),
    currency: currencyCode("currency").notNull(),
    exchangeRateId: uuid("exchange_rate_id"),
    fxBuy: numeric("fx_buy", { precision: 14, scale: 6 }),
    fxSell: numeric("fx_sell", { precision: 14, scale: 6 }),
    // mode "string": a snapshot of exchange_rates.rate_date, a CR-calendar-day key (A §0).
    fxRateDate: date("fx_rate_date", { mode: "string" }),
    fxSource: exchangeRateSource("fx_source"), // A2 Q4 — text -> enum
    fxAppliedRate: numeric("fx_applied_rate", { precision: 14, scale: 6 }), // A2 Q4
    concept: text("concept"),
    // BY_UNIT: el cliente ve cada línea con su precio. PACKAGE: el cliente ve una sola línea con el total.
    pricingMode: text("pricing_mode").notNull().default("BY_UNIT"),
    validUntil: date("valid_until", { mode: "string" }),
    notes: text("notes"),
    // Cuentas de pago vigentes al emitir (congeladas con la revisión; el PDF/preview de una emitida no cambia).
    paymentSnapshot: jsonb("payment_snapshot"),
    customerCabys: text("customer_cabys"),
    customerName: text("customer_name").notNull(),
    customerIdentification: text("customer_identification"),
    customerEmail: text("customer_email").notNull(),
    customerPhone: text("customer_phone"), // A2 Q4
    customerAddress: text("customer_address"), // A2 Q4
    customerContactName: text("customer_contact_name"),
    customerContactPhone: text("customer_contact_phone"),
    customerContactEmail: text("customer_contact_email"), // A2 Q4
    customerContactDepartment: text("customer_contact_department"), // A2 Q4
    customerContactExtension: text("customer_contact_extension"), // A2 Q4
    sellerUserId: uuid("seller_user_id").notNull(),
    sellerName: text("seller_name").notNull(), // A2 Q4
    sellerEmail: text("seller_email").notNull(), // A2 Q4
    sellerPhone: text("seller_phone").notNull(), // A2 Q4
    createdByUserId: uuid("created_by_user_id").notNull(),
    issuedByUserId: uuid("issued_by_user_id"), // A2 Q4
    // A3 DB-06/17 — unconstrained NUMERIC, NULL while DRAFT, set only by
    // issue_quotation_revision() as SUM(items) at issuance (custom migration function).
    subtotal: numeric("subtotal"),
    taxTotal: numeric("tax_total"),
    total: numeric("total"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }) // A2 Q4
      .notNull()
      .defaultNow(),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    // Required target for every composite FK in this domain (orchestrator ruling #9).
    unique("uq_quotation_revisions_quotation_id_id").on(t.quotationId, t.id),
    unique("uq_quotation_revisions_number").on(t.quotationId, t.revisionNumber),
    // At most one draft per quotation, at any point in its life.
    uniqueIndex("uq_quotation_revisions_one_draft")
      .on(t.quotationId)
      .where(sql`${t.state} = 'DRAFT'`),
    // A2 Q4 — which quotations used a given rate. (ix_quotation_revisions_quotation_state
    // from A is dropped per A2 G7 — covered by uq_quotation_revisions_number and the
    // partial one-draft unique above.)
    index("ix_quotation_revisions_exchange_rate_id")
      .on(t.exchangeRateId)
      .where(sql`${t.exchangeRateId} IS NOT NULL`),
    foreignKey({
      name: "fk_quotation_revisions_quotation_id",
      columns: [t.quotationId],
      foreignColumns: [quotations.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_quotation_revisions_customer_id",
      columns: [t.customerId],
      foreignColumns: [customers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_quotation_revisions_seller_user_id",
      columns: [t.sellerUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_quotation_revisions_created_by_user_id",
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_quotation_revisions_issued_by_user_id",
      columns: [t.issuedByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_quotation_revisions_exchange_rate_id",
      columns: [t.exchangeRateId],
      foreignColumns: [exchangeRates.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("ck_quotation_revisions_number_positive", sql`${t.revisionNumber} > 0`),
    // A2 Q4 (amends A) — issued_by_user_id joins the coherence pair.
    check(
      "ck_quotation_revisions_issued_coherence",
      sql`(${t.state} = 'DRAFT' AND ${t.issuedAt} IS NULL AND ${t.issuedByUserId} IS NULL)
        OR (${t.state} = 'ISSUED' AND ${t.issuedAt} IS NOT NULL AND ${t.issuedByUserId} IS NOT NULL)`,
    ),
    // A2 Q4 — fx_buy/fx_sell/fx_rate_date/fx_source/exchange_rate_id all-or-nothing.
    check(
      "ck_quotation_revisions_fx_coherence",
      sql`(${t.fxBuy} IS NULL AND ${t.fxSell} IS NULL AND ${t.fxRateDate} IS NULL AND ${t.fxSource} IS NULL AND ${t.exchangeRateId} IS NULL)
        OR (${t.fxBuy} IS NOT NULL AND ${t.fxSell} IS NOT NULL AND ${t.fxRateDate} IS NOT NULL AND ${t.fxSource} IS NOT NULL AND ${t.exchangeRateId} IS NOT NULL)`,
    ),
    check(
      "ck_quotation_revisions_fx_applied_rate_requires_exchange_rate",
      sql`${t.fxAppliedRate} IS NULL OR ${t.exchangeRateId} IS NOT NULL`,
    ),
    check(
      "ck_quotation_revisions_fx_values_positive",
      sql`(${t.fxBuy} IS NULL OR (${t.fxBuy} > 0 AND ${t.fxBuy} <> 'NaN'))
        AND (${t.fxSell} IS NULL OR (${t.fxSell} > 0 AND ${t.fxSell} <> 'NaN'))
        AND (${t.fxAppliedRate} IS NULL OR (${t.fxAppliedRate} > 0 AND ${t.fxAppliedRate} <> 'NaN'))`,
    ),
    // A3 DB-06/17 — NULL while DRAFT, all three set together only at issuance.
    check(
      "ck_quotation_revisions_totals_coherence",
      sql`(${t.state} = 'DRAFT' AND ${t.subtotal} IS NULL AND ${t.taxTotal} IS NULL AND ${t.total} IS NULL)
        OR (${t.state} = 'ISSUED' AND ${t.subtotal} IS NOT NULL AND ${t.taxTotal} IS NOT NULL AND ${t.total} IS NOT NULL)`,
    ),
    // Unconstrained NUMERIC admits +-Infinity in PG14 (A3) — reject it explicitly; NULL
    // (still-DRAFT) rows pass every branch trivially.
    check(
      "ck_quotation_revisions_totals_non_negative_finite",
      sql`(${t.subtotal} IS NULL OR (${t.subtotal} >= 0 AND ${t.subtotal} NOT IN ('NaN','Infinity','-Infinity')))
        AND (${t.taxTotal} IS NULL OR (${t.taxTotal} >= 0 AND ${t.taxTotal} NOT IN ('NaN','Infinity','-Infinity')))
        AND (${t.total} IS NULL OR (${t.total} >= 0 AND ${t.total} NOT IN ('NaN','Infinity','-Infinity')))`,
    ),
    check("ck_quotation_revisions_pricing_mode", sql`${t.pricingMode} IN ('BY_UNIT','PACKAGE')`),
    check("ck_quotation_revisions_total_equals_sum", sql`${t.total} = ${t.subtotal} + ${t.taxTotal}`),
  ],
);

// A §1.13, amended by A2 G1 (catalog_item_id/provider_id -> RESTRICT, not SET NULL), A2 G3
// (precision), A2 Q5 (tax_percent pinned to 13, renamed from tax_rate), A2 Q6 (provider
// snapshot CHECK, indexes) and A3 DB-06/17 (subtotal/tax_amount/total become STORED
// generated columns of unconstrained NUMERIC — exact arithmetic, no implicit rounding).
export const quotationItems = pgTable(
  "quotation_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quotationId: uuid("quotation_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    catalogItemId: uuid("catalog_item_id"),
    providerId: uuid("provider_id"),
    itemName: text("item_name").notNull(),
    itemDescription: text("item_description"),
    unit: text("unit"),
    providerNameSnapshot: text("provider_name_snapshot"),
    quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 20, scale: 6 }).notNull(),
    costCurrency: currencyCode("cost_currency").notNull(),
    marginPercent: numeric("margin_percent", { precision: 9, scale: 6 }).notNull(),
    // PERCENT: el vendedor fijó el %. AMOUNT: fijó un monto por unidad (en la moneda del costo); margin_percent queda derivado.
    marginMode: text("margin_mode").notNull().default("PERCENT"),
    marginAmount: numeric("margin_amount", { precision: 20, scale: 6 }),
    unitPrice: numeric("unit_price", { precision: 20, scale: 6 }).notNull(),
    // A3 DB-06/17 — subtotal = quantity * unit_price, exact (no rounding) at these scales.
    subtotal: numeric("subtotal").notNull().generatedAlwaysAs(sql`quantity * unit_price`),
    // A2 Q5 — tax_percent (renamed from tax_rate), pinned to 13 by CHECK below (V1 IVA rule).
    taxPercent: numeric("tax_percent", { precision: 9, scale: 6 }).notNull().default("13"),
    // A3 DB-06/17 — dividing by 100 is an exact decimal-point shift at these scales.
    taxAmount: numeric("tax_amount")
      .notNull()
      .generatedAlwaysAs(sql`quantity * unit_price * tax_percent / 100`),
    total: numeric("total")
      .notNull()
      .generatedAlwaysAs(sql`quantity * unit_price + quantity * unit_price * tax_percent / 100`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("uq_quotation_items_revision_line").on(t.revisionId, t.lineNumber),
    index("ix_quotation_items_quotation_revision").on(t.quotationId, t.revisionId),
    // A2 Q6 — merge impact analysis.
    index("ix_quotation_items_catalog_item_id")
      .on(t.catalogItemId)
      .where(sql`${t.catalogItemId} IS NOT NULL`),
    index("ix_quotation_items_provider_id")
      .on(t.providerId)
      .where(sql`${t.providerId} IS NOT NULL`),
    foreignKey({
      name: "fk_quotation_items_quotation_id_revision_id",
      columns: [t.quotationId, t.revisionId],
      foreignColumns: [quotationRevisions.quotationId, quotationRevisions.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    // A2 G1 (amends A) — RESTRICT, not SET NULL; every FK in the schema is RESTRICT.
    foreignKey({
      name: "fk_quotation_items_catalog_item_id",
      columns: [t.catalogItemId],
      foreignColumns: [catalogItems.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_quotation_items_provider_id",
      columns: [t.providerId],
      foreignColumns: [providers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("ck_quotation_items_line_number_positive", sql`${t.lineNumber} > 0`),
    check("ck_quotation_items_quantity_positive", sql`${t.quantity} > 0 AND ${t.quantity} <> 'NaN'`),
    check("ck_quotation_items_unit_cost_non_negative", sql`${t.unitCost} >= 0 AND ${t.unitCost} <> 'NaN'`),
    check(
      "ck_quotation_items_margin_range",
      sql`${t.marginPercent} > 0 AND ${t.marginPercent} <= 100 AND ${t.marginPercent} <> 'NaN'`,
    ),
    check("ck_quotation_items_margin_mode", sql`(${t.marginMode} = 'PERCENT' AND ${t.marginAmount} IS NULL) OR (${t.marginMode} = 'AMOUNT' AND ${t.marginAmount} > 0)`),
    check("ck_quotation_items_unit_price_non_negative", sql`${t.unitPrice} >= 0 AND ${t.unitPrice} <> 'NaN'`),
    // A2 Q5 — V1 legal rule; a future rate change is a deliberate migration, historical rows
    // keep their snapshot. system_settings.default_vat_percent removed (Q5) — this is the
    // single source.
    check("ck_quotation_items_tax_percent_v1", sql`${t.taxPercent} = 13 AND ${t.taxPercent} <> 'NaN'`),
    check(
      "ck_quotation_items_provider_snapshot",
      sql`${t.providerId} IS NULL OR ${t.providerNameSnapshot} IS NOT NULL`,
    ),
  ],
);

// A §1.14, CHECKs amended by A2 (orchestrator ruling #4 — EXPIRED dropped), `seq` added by
// A3 DB-32 (deterministic "latest" ordering; deferred constraint triggers reread by id, not
// by insertion order). Append-only (trigger, custom migration).
export const quotationStatusHistory = pgTable(
  "quotation_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigint("seq", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    quotationId: uuid("quotation_id").notNull(),
    revisionId: uuid("revision_id"),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    changedByUserId: uuid("changed_by_user_id").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    note: text("note"),
  },
  (t) => [
    unique("uq_quotation_status_history_seq").on(t.seq),
    index("ix_quotation_status_history_quotation_changed").on(t.quotationId, t.changedAt),
    index("ix_quotation_status_history_to_changed").on(t.toStatus, t.changedAt),
    foreignKey({
      name: "fk_quotation_status_history_quotation_id",
      columns: [t.quotationId],
      foreignColumns: [quotations.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    // Nullable revision_id — header-level transitions like CANCELLED-before-issuance need
    // no revision.
    foreignKey({
      name: "fk_quotation_status_history_quotation_id_revision_id",
      columns: [t.quotationId, t.revisionId],
      foreignColumns: [quotationRevisions.quotationId, quotationRevisions.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_quotation_status_history_changed_by_user_id",
      columns: [t.changedByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "ck_quotation_status_history_to_values",
      sql`${t.toStatus} IN ('DRAFT','ISSUED','SENT','WON','LOST','CANCELLED')`,
    ),
    check(
      "ck_quotation_status_history_from_values",
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} IN ('DRAFT','ISSUED','SENT','WON','LOST','CANCELLED')`,
    ),
    check(
      "ck_quotation_status_history_revision_required",
      sql`${t.toStatus} NOT IN ('ISSUED','SENT','WON') OR ${t.revisionId} IS NOT NULL`,
    ),
  ],
);

// A §1.15, `revision_version` added by A2 Q7 (review binds to exact revision content — a
// later draft edit bumps quotation_revisions.version, so the review becomes visibly stale;
// the "must equal current version" rule is trigger-enforced on INSERT, not a static CHECK,
// since it reads another table). Append-only (trigger, custom migration). No FK/CHECK ties
// this to quotations.status — reviewable regardless of DRAFT/ISSUED.
export const quotationReviews = pgTable(
  "quotation_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quotationId: uuid("quotation_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    revisionVersion: integer("revision_version").notNull(),
    reviewerUserId: uuid("reviewer_user_id").notNull(),
    outcome: quotationReviewOutcome("outcome").notNull(),
    comment: text("comment"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_quotation_reviews_quotation_reviewed").on(t.quotationId, t.reviewedAt),
    index("ix_quotation_reviews_reviewer_reviewed").on(t.reviewerUserId, t.reviewedAt),
    foreignKey({
      name: "fk_quotation_reviews_quotation_id_revision_id",
      columns: [t.quotationId, t.revisionId],
      foreignColumns: [quotationRevisions.quotationId, quotationRevisions.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_quotation_reviews_reviewer_user_id",
      columns: [t.reviewerUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
  ],
);
