import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// A §0 — pgEnum: fixed, mechanical, essentially-frozen vocabularies.
export const roleCode = pgEnum("role_code", [
  "ADMIN",
  "SELLER",
  "COMMERCIAL_MANAGER",
  "ADMINISTRATIVE_MANAGER",
]);

export const userStatus = pgEnum("user_status", [
  "PENDING_ACTIVATION",
  "ACTIVE",
  "INACTIVE",
]);

// A §1.1 — fixed 4-role RBAC vocabulary. Seed-only (migration 0003), 4 rows ever.
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: roleCode("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("uq_roles_code").on(t.code)],
);

// A §1.2 — RBAC permission catalog, `domain.action` codes. App-extensible: text + CHECK.
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("uq_permissions_code").on(t.code),
    check(
      "ck_permissions_code_format",
      sql`${t.code} ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*[.][a-z][a-z0-9]*(_[a-z0-9]+)*$'`,
    ),
  ],
);

// A §1.3 — RBAC grant join table. Composite PK prevents duplicate grants by construction.
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id").notNull(),
    permissionId: uuid("permission_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "pk_role_permissions", columns: [t.roleId, t.permissionId] }),
    // role_id already leads the composite PK; permission_id needs its own index (A §1.3).
    index("ix_role_permissions_permission_id").on(t.permissionId),
    foreignKey({
      name: "fk_role_permissions_role_id",
      columns: [t.roleId],
      foreignColumns: [roles.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_role_permissions_permission_id",
      columns: [t.permissionId],
      foreignColumns: [permissions.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
  ],
);

// Empresa a la que pertenece un vendedor (cada vendedor pertenece a una sola empresa).
export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    legalId: text("legal_id"),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_companies_name_normalized").on(sql`lower(btrim(${t.name}))`),
    check("ck_companies_name_nonblank", sql`length(btrim(${t.name})) > 0`),
  ],
);

// A §1.4 — Better Auth `user` model (Better Auth maps by TS key: id, name, email,
// emailVerified, image, createdAt, updatedAt). Persistent Better Auth models are
// defined below and introduced by migration 0005.
// version/updated_at are DB-trigger-maintained (A2 G4, fn_touch_version) — no $onUpdate.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("full_name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    phone: varchar("phone", { length: 20 }).notNull(),
    roleId: uuid("role_id").notNull(),
    companyId: uuid("company_id"),
    status: userStatus("status").notNull().default("PENDING_ACTIVATION"),
    activatedAt: timestamp("activated_at", { withTimezone: true, mode: "date" }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    unique("uq_users_email").on(t.email),
    index("ix_users_role_id").on(t.roleId),
    index("ix_users_company_id").on(t.companyId).where(sql`${t.companyId} IS NOT NULL`),
    foreignKey({ name: "fk_users_company_id", columns: [t.companyId], foreignColumns: [companies.id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    // Admin's activation queue (A §1.4).
    index("ix_users_status_pending")
      .on(t.status)
      .where(sql`${t.status} = 'PENDING_ACTIVATION'`),
    foreignKey({
      name: "fk_users_role_id",
      columns: [t.roleId],
      foreignColumns: [roles.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("ck_users_email_normalized", sql`${t.email} = lower(btrim(${t.email}))`),
    // A2 U1 (amends A): INACTIVE no longer requires activated_at (a user can be
    // deactivated before ever being activated).
    check(
      "ck_users_status_coherence",
      sql`(${t.status} = 'PENDING_ACTIVATION' AND ${t.activatedAt} IS NULL AND ${t.deactivatedAt} IS NULL)
        OR (${t.status} = 'ACTIVE' AND ${t.activatedAt} IS NOT NULL AND ${t.deactivatedAt} IS NULL)
        OR (${t.status} = 'INACTIVE' AND ${t.deactivatedAt} IS NOT NULL
            AND (${t.activatedAt} IS NULL OR ${t.deactivatedAt} >= ${t.activatedAt}))`,
    ),
  ],
);

// Better Auth 1.7 persistent models. PostgreSQL remains the session source of
// truth; cookie caching is deliberately disabled in the auth configuration.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull(),
    userId: uuid("user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    authMethod: text("auth_method").notNull().default("password"),
    recentAuthAt: timestamp("recent_auth_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_sessions_token").on(t.token),
    index("ix_sessions_user_id").on(t.userId),
    index("ix_sessions_expires_at").on(t.expiresAt),
    foreignKey({ name: "fk_sessions_user_id", columns: [t.userId], foreignColumns: [users.id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("ck_sessions_auth_method", sql`${t.authMethod} IN ('password', 'passkey')`),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: "date" }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: "date" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_accounts_provider_account").on(t.providerId, t.accountId),
    index("ix_accounts_user_id").on(t.userId),
    foreignKey({ name: "fk_accounts_user_id", columns: [t.userId], foreignColumns: [users.id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("ck_accounts_credential_password", sql`${t.providerId} <> 'credential' OR ${t.password} IS NOT NULL`),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("ix_verifications_identifier").on(t.identifier), index("ix_verifications_expires_at").on(t.expiresAt)],
);

export const passkeys = pgTable(
  "passkeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: uuid("user_id").notNull(),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
  },
  (t) => [
    unique("uq_passkeys_credential_id").on(t.credentialID),
    index("ix_passkeys_user_id").on(t.userId),
    foreignKey({ name: "fk_passkeys_user_id", columns: [t.userId], foreignColumns: [users.id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
  ],
);

export const twoFactors = pgTable(
  "two_factors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    unique("uq_two_factors_user_id").on(t.userId),
    index("ix_two_factors_secret").on(t.secret),
    foreignKey({ name: "fk_two_factors_user_id", columns: [t.userId], foreignColumns: [users.id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("ck_two_factors_failed_count", sql`${t.failedVerificationCount} >= 0`),
  ],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (t) => [unique("uq_rate_limits_key").on(t.key), check("ck_rate_limits_count", sql`${t.count} >= 0`)],
);

export const activationInvitations = pgTable(
  "activation_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_activation_invitations_token_hash").on(t.tokenHash),
    index("ix_activation_invitations_user_id").on(t.userId),
    index("ix_activation_invitations_expires_at").on(t.expiresAt),
    uniqueIndex("uq_activation_invitations_live_user").on(t.userId).where(sql`${t.usedAt} IS NULL`),
    foreignKey({ name: "fk_activation_invitations_user_id", columns: [t.userId], foreignColumns: [users.id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({ name: "fk_activation_invitations_created_by", columns: [t.createdByUserId], foreignColumns: [users.id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("ck_activation_token_hash", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const emailChangeRequests = pgTable(
  "email_change_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    newEmail: text("new_email").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_email_change_token_hash").on(t.tokenHash),
    uniqueIndex("uq_email_change_live_user").on(t.userId).where(sql`${t.usedAt} IS NULL`),
    index("ix_email_change_expires_at").on(t.expiresAt),
    foreignKey({ name: "fk_email_change_user", columns: [t.userId], foreignColumns: [users.id] }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({ name: "fk_email_change_actor", columns: [t.requestedByUserId], foreignColumns: [users.id] }).onDelete("restrict").onUpdate("restrict"),
    check("ck_email_change_email_normalized", sql`${t.newEmail} = lower(btrim(${t.newEmail}))`),
    check("ck_email_change_token_hash", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
