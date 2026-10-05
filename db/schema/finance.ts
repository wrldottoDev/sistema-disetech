import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
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
import { catalogItems, providers } from "./commercial";

// A §0 enum policy
export const currencyCode = pgEnum("currency_code", ["CRC", "USD"]);
export const exchangeRateSource = pgEnum("exchange_rate_source", ["BCCR", "MANUAL"]);

// A §1.16, amended by A2 I3 (chain replaces plain UNIQUE(rate_date, source)) and
// A3 DB-36 / A4 DB-38 (supersedes_id correction chain, acyclic by construction —
// fn_exchange_rates_guard enforcing the predecessor lock/date match is a custom
// migration trigger, not modeled here).
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    baseCurrency: text("base_currency").notNull().default("USD"),
    quoteCurrency: text("quote_currency").notNull().default("CRC"),
    // mode "string" (not "date"): A §0 flags rate_date as a CR-calendar-day key, not
    // an instant — a JS Date roundtrip risks a UTC/local off-by-one, a plain
    // "YYYY-MM-DD" string does not.
    rateDate: date("rate_date", { mode: "string" }).notNull(),
    source: exchangeRateSource("source").notNull(),
    // G3: FX columns are NUMERIC(14,6)
    buyRate: numeric("buy_rate", { precision: 14, scale: 6 }).notNull(),
    sellRate: numeric("sell_rate", { precision: 14, scale: 6 }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    // A3 DB-36: correction chain — the row this one supersedes (same rate_date).
    supersedesId: uuid("supersedes_id"),
  },
  (t) => [
    foreignKey({
      name: "fk_exchange_rates_created_by_user_id",
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    // A3 DB-36: composite self-FK target, requires UNIQUE(id, rate_date) below.
    foreignKey({
      name: "fk_exchange_rates_supersedes_id_rate_date",
      columns: [t.supersedesId, t.rateDate],
      foreignColumns: [t.id, t.rateDate],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("ck_exchange_rates_pair_v1", sql`${t.baseCurrency} = 'USD' AND ${t.quoteCurrency} = 'CRC'`),
    check("ck_exchange_rates_positive", sql`${t.buyRate} > 0 AND ${t.sellRate} > 0`),
    check("ck_exchange_rates_sell_gte_buy", sql`${t.sellRate} >= ${t.buyRate}`),
    check(
      "ck_exchange_rates_manual_creator",
      sql`(${t.source} = 'MANUAL' AND ${t.createdByUserId} IS NOT NULL) OR (${t.source} = 'BCCR' AND ${t.createdByUserId} IS NULL)`,
    ),
    check("ck_exchange_rates_rates_not_nan", sql`${t.buyRate} <> 'NaN' AND ${t.sellRate} <> 'NaN'`),
    // A3 DB-36: only a manual correction may supersede another row.
    check("ck_exchange_rates_supersedes_manual", sql`${t.supersedesId} IS NULL OR ${t.source} = 'MANUAL'`),
    // A4 DB-38: acyclic by construction.
    check("ck_exchange_rates_supersedes_not_self", sql`${t.supersedesId} IS NULL OR ${t.supersedesId} <> ${t.id}`),
    unique("uq_exchange_rates_id_rate_date").on(t.id, t.rateDate),
    // A3 DB-36: each row superseded at most once (no forks).
    unique("uq_exchange_rates_supersedes_id").on(t.supersedesId),
    // A3 DB-36: exactly one root per date (drops A2's partial BCCR-only unique).
    uniqueIndex("uq_exchange_rates_root_per_date").on(t.rateDate).where(sql`${t.supersedesId} IS NULL`),
    index("ix_exchange_rates_created_by").on(t.createdByUserId).where(sql`${t.createdByUserId} IS NOT NULL`),
    // A2 I3: rate lookup ordering for "effective rate on/before date X".
    index("ix_exchange_rates_date_created").on(t.rateDate.desc(), t.createdAt.desc()),
  ],
);

// Cuentas bancarias que se imprimen en "DATOS PARA PAGO O DEPÓSITO" del PDF. Administradas por Admin.
export const paymentAccounts = pgTable(
  "payment_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bank: text("bank").notNull(),
    accountNumber: text("account_number").notNull(),
    currency: currencyCode("currency").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    check("ck_payment_accounts_nonblank", sql`length(btrim(${t.bank})) > 0 AND length(btrim(${t.accountNumber})) > 0`),
  ],
);

// Historial INTERNO de costos cotizados por proveedores. Cada fila pertenece a quien la registró
// (los vendedores sólo leen las suyas). Append-only: una corrección es una fila nueva.
export const providerCosts = pgTable(
  "provider_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id").notNull(),
    catalogItemId: uuid("catalog_item_id"),
    itemName: text("item_name").notNull(),
    unitCost: numeric("unit_cost", { precision: 20, scale: 6 }).notNull(),
    currency: currencyCode("currency").notNull(),
    quotedOn: date("quoted_on", { mode: "string" }).notNull(),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("ix_provider_costs_owner_item").on(t.createdByUserId, t.catalogItemId, t.quotedOn.desc()),
    index("ix_provider_costs_provider").on(t.providerId),
    foreignKey({ name: "fk_provider_costs_provider_id", columns: [t.providerId], foreignColumns: [providers.id] }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({ name: "fk_provider_costs_catalog_item_id", columns: [t.catalogItemId], foreignColumns: [catalogItems.id] }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({ name: "fk_provider_costs_created_by", columns: [t.createdByUserId], foreignColumns: [users.id] }).onDelete("restrict").onUpdate("restrict"),
    check("ck_provider_costs_unit_cost", sql`${t.unitCost} >= 0 AND ${t.unitCost} <> 'NaN'`),
    check("ck_provider_costs_item_name", sql`length(btrim(${t.itemName})) > 0`),
  ],
);
