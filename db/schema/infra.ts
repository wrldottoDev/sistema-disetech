import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { quotationRevisions } from "./quotations";

// A §0 enum policy
export const auditActorType = pgEnum("audit_actor_type", ["USER", "SYSTEM", "ANONYMOUS"]);
export const auditResult = pgEnum("audit_result", ["SUCCESS", "FAILURE", "DENIED"]);
export const generatedDocumentKind = pgEnum("generated_document_kind", ["QUOTATION_PDF"]);

// A §1.17, amended by A2 I2 (auth_session_id, actor/target coherence rewritten as
// explicit branches) and A3 DB-13 / A4 DB-13 (attempted_identifier -> hmac, bound to
// AUTH.LOGIN_FAILURE). Append-only: mutation blocked by fn_prevent_mutation (custom
// migration), not modeled here. The metadata secret-scan CHECK
// (fn_jsonb_has_forbidden_keys) is added in a later custom SQL migration because it
// needs a function; not declared here.
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    actorType: auditActorType("actor_type").notNull(),
    actorUserId: uuid("actor_user_id"),
    // A3 DB-13: HMAC-SHA256 hex of the normalized identifier, never the raw value.
    attemptedIdentifierHmac: text("attempted_identifier_hmac"),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    targetUserId: uuid("target_user_id"),
    action: text("action").notNull(),
    result: auditResult("result").notNull(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    requestId: uuid("request_id"),
    // A2 I2: renamed from session_id; Better Auth session id, never a real FK
    // (sessions are ephemeral, audit retention is indefinite).
    authSessionId: uuid("auth_session_id"),
    metadata: jsonb("metadata"),
  },
  (t) => [
    foreignKey({
      name: "fk_audit_logs_actor_user_id",
      columns: [t.actorUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_audit_logs_target_user_id",
      columns: [t.targetUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    // A2 I2: explicit-branch coherence (G5).
    check(
      "ck_audit_logs_actor_coherence",
      sql`(${t.actorType} = 'USER' AND ${t.actorUserId} IS NOT NULL) OR (${t.actorType} <> 'USER' AND ${t.actorUserId} IS NULL)`,
    ),
    check("ck_audit_logs_target_both_or_neither", sql`(${t.targetType} IS NULL) = (${t.targetId} IS NULL)`),
    // CR-04: NULL-safe branches (IS NOT DISTINCT FROM, never bare `=` against a
    // nullable column) wrapped in `IS TRUE` so the expression is never
    // UNKNOWN/NULL-admitted by the CHECK when target_type/target_id are NULL.
    check(
      "ck_audit_logs_target_user_coherence",
      sql`((${t.targetType} IS NOT DISTINCT FROM 'user' AND ${t.targetUserId} IS NOT NULL AND ${t.targetUserId} = ${t.targetId}) OR (${t.targetType} IS DISTINCT FROM 'user' AND ${t.targetUserId} IS NULL)) IS TRUE`,
    ),
    check("ck_audit_logs_target_type_format", sql`${t.targetType} IS NULL OR ${t.targetType} ~ '^[a-z][a-z_]*$'`),
    // I2: canonical action format, written with [.] per G6/IMPL-brief.
    check("ck_audit_logs_action_format", sql`${t.action} ~ '^[A-Z][A-Z0-9_]*([.][A-Z][A-Z0-9_]*)*$'`),
    // A3 DB-13, amended by A4 DB-13 (action binding to AUTH.LOGIN_FAILURE).
    check(
      "ck_audit_logs_attempted_identifier_hmac",
      sql`${t.attemptedIdentifierHmac} IS NULL OR (${t.attemptedIdentifierHmac} ~ '^[0-9a-f]{64}$' AND ${t.actorType} = 'ANONYMOUS' AND ${t.result} = 'FAILURE' AND ${t.action} = 'AUTH.LOGIN_FAILURE')`,
    ),
    check("ck_audit_logs_metadata_object", sql`${t.metadata} IS NULL OR jsonb_typeof(${t.metadata}) = 'object'`),
    check("ck_audit_logs_metadata_size", sql`${t.metadata} IS NULL OR pg_column_size(${t.metadata}) <= 8192`),
    index("ix_audit_logs_occurred_at").on(t.occurredAt.desc()),
    index("ix_audit_logs_actor_user_id").on(t.actorUserId).where(sql`${t.actorUserId} IS NOT NULL`),
    index("ix_audit_logs_target").on(t.targetType, t.targetId).where(sql`${t.targetType} IS NOT NULL`),
    index("ix_audit_logs_target_user_id").on(t.targetUserId).where(sql`${t.targetUserId} IS NOT NULL`),
  ],
);

// A2 I1 full spec. Immutable (G2 + Q10's fn_generated_documents_guard, custom migration).
export const generatedDocuments = pgTable(
  "generated_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quotationId: uuid("quotation_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    kind: generatedDocumentKind("kind").notNull().default("QUOTATION_PDF"),
    storageProvider: text("storage_provider").notNull(),
    storageBucket: text("storage_bucket"),
    storageKey: text("storage_key").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull().default("application/pdf"),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Requires UNIQUE(quotation_id, id) on quotation_revisions (owned by D).
    foreignKey({
      name: "fk_generated_documents_quotation_id_revision_id",
      columns: [t.quotationId, t.revisionId],
      foreignColumns: [quotationRevisions.quotationId, quotationRevisions.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_generated_documents_created_by_user_id",
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("ck_generated_documents_storage_provider", sql`${t.storageProvider} IN ('R2', 'LOCAL_FS')`),
    check("ck_generated_documents_byte_size_positive", sql`${t.byteSize} > 0`),
    check("ck_generated_documents_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "ck_generated_documents_mime_type_pdf",
      sql`${t.kind} <> 'QUOTATION_PDF' OR ${t.mimeType} = 'application/pdf'`,
    ),
    check(
      "ck_generated_documents_storage_key_format",
      sql`length(${t.storageKey}) BETWEEN 1 AND 1024 AND ${t.storageKey} !~ '^/'`,
    ),
    check("ck_generated_documents_file_name_length", sql`length(${t.fileName}) BETWEEN 1 AND 255`),
    uniqueIndex("uq_generated_documents_storage").on(
      t.storageProvider,
      sql`coalesce(${t.storageBucket}, '')`,
      t.storageKey,
    ),
    unique("uq_generated_documents_sha_revision").on(t.revisionId, t.kind, t.sha256),
    index("ix_generated_documents_quotation_revision").on(t.quotationId, t.revisionId),
  ],
);

// A §1.18, amended by A2 I4 (default_vat_percent dropped — margin_warning_percent only;
// range tightened to (0,100]). Singleton pattern: id boolean PK default true + CHECK.
export const systemSettings = pgTable(
  "system_settings",
  {
    id: boolean("id").primaryKey().default(true),
    marginWarningPercent: numeric("margin_warning_percent", { precision: 9, scale: 6 })
      .notNull()
      .default("25"),
    updatedByUserId: uuid("updated_by_user_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "fk_system_settings_updated_by_user_id",
      columns: [t.updatedByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    // id = true rejects a false row outright; the PK forbids a second true row.
    check("ck_system_settings_singleton", sql`${t.id}`),
    check(
      "ck_system_settings_margin_range",
      sql`${t.marginWarningPercent} > 0 AND ${t.marginWarningPercent} <= 100 AND ${t.marginWarningPercent} <> 'NaN'`,
    ),
  ],
);
