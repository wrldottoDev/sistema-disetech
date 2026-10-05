import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";

// A §0 — shared enum, customers + providers.
export const identificationType = pgEnum("identification_type", [
  "FISICA",
  "JURIDICA",
  "DIMEX",
  "NITE",
  "PASAPORTE",
]);

export const customerStatus = pgEnum("customer_status", ["ACTIVE", "INACTIVE"]);

export const catalogReviewStatus = pgEnum("catalog_review_status", [
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
  "MERGED",
]);

// A §1.5, amended by A2 C1 (explicit-branch status coherence, no half-populated rows) and
// orchestrator ruling #6 (no UNIQUE on identification anywhere — cross-seller leak via a
// constraint-violation error; plain index only, for manager dedup).
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    email: text("email").notNull(),
    identificationType: identificationType("identification_type"),
    identificationNumber: text("identification_number"),
    phone: text("phone"),
    economicActivityCabys: text("economic_activity_cabys"),
    address: text("address"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    status: customerStatus("status").notNull().default("ACTIVE"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true, mode: "date" }),
    deactivatedByUserId: uuid("deactivated_by_user_id"),
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
    index("ix_customers_owner_status").on(t.ownerUserId, t.status),
    index("ix_customers_email_normalized").on(sql`lower(btrim(${t.email}))`),
    // Orchestrator ruling #6 (A §1.5): non-unique, global — managers dedup, no isolation leak.
    index("ix_customers_identification")
      .on(t.identificationType, t.identificationNumber)
      .where(sql`${t.identificationNumber} IS NOT NULL`),
    foreignKey({
      name: "fk_customers_created_by_user_id",
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_customers_owner_user_id",
      columns: [t.ownerUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_customers_deactivated_by_user_id",
      columns: [t.deactivatedByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "ck_customers_identification_both_or_neither",
      sql`(${t.identificationType} IS NULL) = (${t.identificationNumber} IS NULL)`,
    ),
    check(
      "ck_customers_identification_format",
      sql`(${t.identificationType} IS DISTINCT FROM 'FISICA'    OR ${t.identificationNumber} ~ '^[0-9]{9}$')
        AND (${t.identificationType} IS DISTINCT FROM 'JURIDICA'  OR ${t.identificationNumber} ~ '^[0-9]{10}$')
        AND (${t.identificationType} IS DISTINCT FROM 'DIMEX'     OR ${t.identificationNumber} ~ '^[0-9]{11,12}$')
        AND (${t.identificationType} IS DISTINCT FROM 'NITE'      OR ${t.identificationNumber} ~ '^[0-9]{9,10}$')
        AND (${t.identificationType} IS DISTINCT FROM 'PASAPORTE' OR length(${t.identificationNumber}) BETWEEN 3 AND 20)`,
    ),
    check("ck_customers_email_normalized", sql`${t.email} = lower(btrim(${t.email}))`),
    check(
      "ck_customers_cabys_format",
      sql`${t.economicActivityCabys} IS NULL OR ${t.economicActivityCabys} ~ '^[0-9]{13}$'`,
    ),
    // A2 C1 — explicit branches (replaces A's `(status = 'ACTIVE') = (a IS NULL AND b IS NULL)`
    // shortcut, which admitted half-populated rows).
    check(
      "ck_customers_status_coherence",
      sql`(${t.status} = 'ACTIVE' AND ${t.deactivatedAt} IS NULL AND ${t.deactivatedByUserId} IS NULL)
        OR (${t.status} = 'INACTIVE' AND ${t.deactivatedAt} IS NOT NULL AND ${t.deactivatedByUserId} IS NOT NULL)`,
    ),
  ],
);

// A §1.6, version ADDED by A2 G4. FK is RESTRICT (A §0 override of C's original CASCADE).
export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").notNull(),
    fullName: text("full_name").notNull(),
    department: text("department"),
    email: text("email"),
    phone: text("phone"),
    extension: text("extension"),
    isPrimary: boolean("is_primary").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_customer_contacts_customer_id").on(t.customerId),
    uniqueIndex("uq_customer_contacts_primary")
      .on(t.customerId)
      .where(sql`${t.isPrimary}`),
    foreignKey({
      name: "fk_customer_contacts_customer_id",
      columns: [t.customerId],
      foreignColumns: [customers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
  ],
);

// A §1.7, version ADDED by A2 G4. Small admin-controlled vocabulary — global unique is safe.
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_categories_name_normalized").on(sql`lower(btrim(${t.name}))`),
  ],
);

// A §1.8, amended by A2 C2 (proposed_by_user_id, unit) and A3 DB-28 (merged_into index).
// Zero commercial-context columns by construction (invariant 9) — no customer/quotation/
// cost/margin/seller reference exists here for any query to accidentally select.
export const catalogItems = pgTable(
  "catalog_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    categoryId: uuid("category_id"),
    cabysCode: text("cabys_code"),
    unit: text("unit"), // A2 C2 — generic unit of measure.
    status: catalogReviewStatus("status").notNull().default("PENDING_REVIEW"),
    mergedIntoId: uuid("merged_into_id"),
    proposedByUserId: uuid("proposed_by_user_id").notNull(), // A2 C2
    reviewedByUserId: uuid("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_catalog_items_name_normalized").on(sql`lower(btrim(${t.name}))`),
    index("ix_catalog_items_status").on(t.status),
    index("ix_catalog_items_category_id").on(t.categoryId),
    // A2 C2 — seller's own pending proposals.
    index("ix_catalog_items_proposed_by").on(t.proposedByUserId, t.status),
    // A3 DB-28 — incoming-alias checks / "what was merged into X".
    index("ix_catalog_items_merged_into")
      .on(t.mergedIntoId)
      .where(sql`${t.mergedIntoId} IS NOT NULL`),
    foreignKey({
      name: "fk_catalog_items_category_id",
      columns: [t.categoryId],
      foreignColumns: [categories.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_catalog_items_merged_into_id",
      columns: [t.mergedIntoId],
      foreignColumns: [t.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_catalog_items_proposed_by_user_id",
      columns: [t.proposedByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_catalog_items_reviewed_by_user_id",
      columns: [t.reviewedByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "ck_catalog_items_no_self_merge",
      sql`${t.mergedIntoId} IS NULL OR ${t.mergedIntoId} <> ${t.id}`,
    ),
    // A2 C1 — explicit branches.
    check(
      "ck_catalog_items_merge_coherence",
      sql`(${t.status} = 'MERGED' AND ${t.mergedIntoId} IS NOT NULL)
        OR (${t.status} <> 'MERGED' AND ${t.mergedIntoId} IS NULL)`,
    ),
    check(
      "ck_catalog_items_review_coherence",
      sql`(${t.status} = 'PENDING_REVIEW' AND ${t.reviewedByUserId} IS NULL AND ${t.reviewedAt} IS NULL)
        OR (${t.status} <> 'PENDING_REVIEW' AND ${t.reviewedByUserId} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)`,
    ),
    check(
      "ck_catalog_items_cabys_format",
      sql`${t.cabysCode} IS NULL OR ${t.cabysCode} ~ '^[0-9]{13}$'`,
    ),
  ],
);

// A §1.9, amended by A2 C2 (proposed_by_user_id), A3 DB-35 (unique only among APPROVED,
// plus a separate non-unique dedup index) and A3 DB-28 (merged_into index). Providers have
// no seller-isolation boundary, so a real identification unique is safe here (unlike
// customers).
export const providers = pgTable(
  "providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legalName: text("legal_name").notNull(),
    commercialName: text("commercial_name"),
    identificationType: identificationType("identification_type"),
    identificationNumber: text("identification_number"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    contactName: text("contact_name"),
    notes: text("notes"),
    status: catalogReviewStatus("status").notNull().default("PENDING_REVIEW"),
    mergedIntoId: uuid("merged_into_id"),
    proposedByUserId: uuid("proposed_by_user_id").notNull(), // A2 C2
    reviewedByUserId: uuid("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_providers_legal_name_normalized").on(sql`lower(btrim(${t.legalName}))`),
    index("ix_providers_status").on(t.status),
    // A2 C2 — seller's own pending proposals.
    index("ix_providers_proposed_by").on(t.proposedByUserId, t.status),
    // A3 DB-35 — non-unique dedup search across all statuses (unique index below is
    // restricted to APPROVED only).
    index("ix_providers_identification")
      .on(t.identificationType, t.identificationNumber)
      .where(sql`${t.identificationNumber} IS NOT NULL`),
    // A3 DB-28 — incoming-alias checks / "what was merged into X".
    index("ix_providers_merged_into")
      .on(t.mergedIntoId)
      .where(sql`${t.mergedIntoId} IS NOT NULL`),
    // A3 DB-35 (supersedes C3/A §1.9 `status <> 'MERGED'`): unique only among APPROVED rows
    // — duplicate PENDING/REJECTED proposals are allowed; approving a duplicate fails and
    // the reviewer merges instead.
    uniqueIndex("uq_providers_identification")
      .on(t.identificationType, t.identificationNumber)
      .where(
        sql`${t.identificationNumber} IS NOT NULL AND ${t.status} = 'APPROVED'`,
      ),
    foreignKey({
      name: "fk_providers_merged_into_id",
      columns: [t.mergedIntoId],
      foreignColumns: [t.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_providers_proposed_by_user_id",
      columns: [t.proposedByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_providers_reviewed_by_user_id",
      columns: [t.reviewedByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "ck_providers_no_self_merge",
      sql`${t.mergedIntoId} IS NULL OR ${t.mergedIntoId} <> ${t.id}`,
    ),
    check(
      "ck_providers_merge_coherence",
      sql`(${t.status} = 'MERGED' AND ${t.mergedIntoId} IS NOT NULL)
        OR (${t.status} <> 'MERGED' AND ${t.mergedIntoId} IS NULL)`,
    ),
    check(
      "ck_providers_review_coherence",
      sql`(${t.status} = 'PENDING_REVIEW' AND ${t.reviewedByUserId} IS NULL AND ${t.reviewedAt} IS NULL)
        OR (${t.status} <> 'PENDING_REVIEW' AND ${t.reviewedByUserId} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)`,
    ),
    check(
      "ck_providers_identification_both_or_neither",
      sql`(${t.identificationType} IS NULL) = (${t.identificationNumber} IS NULL)`,
    ),
    check(
      "ck_providers_identification_format",
      sql`(${t.identificationType} IS DISTINCT FROM 'FISICA'    OR ${t.identificationNumber} ~ '^[0-9]{9}$')
        AND (${t.identificationType} IS DISTINCT FROM 'JURIDICA'  OR ${t.identificationNumber} ~ '^[0-9]{10}$')
        AND (${t.identificationType} IS DISTINCT FROM 'DIMEX'     OR ${t.identificationNumber} ~ '^[0-9]{11,12}$')
        AND (${t.identificationType} IS DISTINCT FROM 'NITE'      OR ${t.identificationNumber} ~ '^[0-9]{9,10}$')
        AND (${t.identificationType} IS DISTINCT FROM 'PASAPORTE' OR length(${t.identificationNumber}) BETWEEN 3 AND 20)`,
    ),
  ],
);
