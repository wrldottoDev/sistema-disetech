import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { companies, exchangeRates, paymentAccounts, systemSettings, users } from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import { type Principal, requirePermission } from "@/lib/rbac";
import { AppError } from "@/lib/errors";
import { parseDecimal, toDb } from "@/lib/money";
import { todayCR } from "@/lib/quotations/service";
import { currencySchema, dateSchema, optionalText, requiredText, uuidSchema, versionSchema } from "@/lib/validation";

const guard = (p: Principal) => requirePermission(p, "settings.manage");

export async function listCompanies(principal: Principal) {
  requirePermission(principal, "users.manage");
  return db.select({ id: companies.id, name: companies.name, legalId: companies.legalId, isActive: companies.isActive, version: companies.version, sellers: sql<number>`(select count(*)::int from users u where u.company_id = ${companies.id})` }).from(companies).orderBy(companies.name);
}

export async function createCompany(principal: Principal, input: unknown): Promise<void> {
  requirePermission(principal, "users.manage");
  const v = z.object({ name: requiredText(2, 200, "El nombre"), legalId: optionalText(30) }).parse(input);
  await db.transaction(async (tx) => {
    const [row] = await tx.insert(companies).values({ name: v.name, legalId: v.legalId ?? null }).returning({ id: companies.id });
    await writeAudit({ actorUserId: principal.userId, action: "COMPANY.CREATE", result: "SUCCESS", target: { type: "company", id: row.id }, authSessionId: principal.sessionId }, tx);
  });
}

export async function setCompanyActive(principal: Principal, idInput: unknown, versionInput: unknown, active: boolean): Promise<void> {
  requirePermission(principal, "users.manage");
  const id = uuidSchema.parse(idInput);
  const version = versionSchema.parse(versionInput);
  await db.transaction(async (tx) => {
    // Bloquea la empresa: serializa con las asignaciones de vendedores, que la toman FOR SHARE.
    const [company] = await tx.select({ version: companies.version }).from(companies).where(eq(companies.id, id)).for("update");
    if (!company || company.version !== version) throw new AppError("CONFLICT", "La empresa cambió; recarga antes de continuar.");
    if (!active) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(users).where(sql`${users.companyId} = ${id} AND ${users.status} <> 'INACTIVE'`);
      if (n > 0) throw new AppError("CONFLICT", "La empresa tiene usuarios activos o pendientes; reasígnalos primero.");
    }
    await tx.update(companies).set({ isActive: active }).where(eq(companies.id, id));
    await writeAudit({ actorUserId: principal.userId, action: active ? "COMPANY.ACTIVATE" : "COMPANY.DEACTIVATE", result: "SUCCESS", target: { type: "company", id }, authSessionId: principal.sessionId }, tx);
  });
}

export async function listPaymentAccounts(principal: Principal) {
  guard(principal);
  return db.select().from(paymentAccounts).orderBy(desc(paymentAccounts.isActive), paymentAccounts.bank);
}

export async function createPaymentAccount(principal: Principal, input: unknown): Promise<void> {
  guard(principal);
  const v = z.object({ bank: requiredText(2, 120, "El banco"), accountNumber: requiredText(5, 60, "La cuenta"), currency: currencySchema }).parse(input);
  await db.transaction(async (tx) => {
    const [row] = await tx.insert(paymentAccounts).values(v).returning({ id: paymentAccounts.id });
    await writeAudit({ actorUserId: principal.userId, action: "PAYMENT_ACCOUNT.CREATE", result: "SUCCESS", target: { type: "payment_account", id: row.id }, authSessionId: principal.sessionId }, tx);
  });
}

export async function setPaymentAccountActive(principal: Principal, idInput: unknown, active: boolean): Promise<void> {
  guard(principal);
  const id = uuidSchema.parse(idInput);
  await db.transaction(async (tx) => {
    const updated = await tx.update(paymentAccounts).set({ isActive: active, updatedAt: new Date() }).where(eq(paymentAccounts.id, id)).returning({ id: paymentAccounts.id });
    if (!updated.length) throw new AppError("NOT_FOUND", "Cuenta no encontrada.");
    await writeAudit({ actorUserId: principal.userId, action: active ? "PAYMENT_ACCOUNT.ACTIVATE" : "PAYMENT_ACCOUNT.DEACTIVATE", result: "SUCCESS", target: { type: "payment_account", id }, authSessionId: principal.sessionId }, tx);
  });
}

export async function listRates(principal: Principal) {
  guard(principal);
  return db.select().from(exchangeRates).orderBy(desc(exchangeRates.rateDate), desc(exchangeRates.createdAt)).limit(30);
}

/** Registra el tipo de cambio del día. Si ya existe uno para esa fecha, la nueva fila corrige (supersedes) a la vigente. */
export async function recordRate(principal: Principal, input: unknown): Promise<void> {
  guard(principal);
  const v = z.object({ rateDate: dateSchema, buy: z.string(), sell: z.string() }).parse(input);
  if (v.rateDate > todayCR()) throw new AppError("VALIDATION", "La fecha no puede ser futura.");
  const buy = parseDecimal(v.buy, "El tipo de cambio de compra");
  const sell = parseDecimal(v.sell, "El tipo de cambio de venta");
  if (buy <= 0n || sell < buy) throw new AppError("VALIDATION", "Compra y venta deben ser positivos y venta ≥ compra.");
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('disetech:exchange-rate'))`);
    const rows = await tx.execute<{ id: string }>(sql`SELECT e.id FROM exchange_rates e WHERE e.rate_date = ${v.rateDate}::date AND NOT EXISTS (SELECT 1 FROM exchange_rates s WHERE s.supersedes_id = e.id) LIMIT 1`);
    await tx.insert(exchangeRates).values({ rateDate: v.rateDate, source: "MANUAL", buyRate: toDb(buy), sellRate: toDb(sell), createdByUserId: principal.userId, supersedesId: rows[0]?.id ?? null });
    await writeAudit({ actorUserId: principal.userId, action: "FX.RECORD", result: "SUCCESS", authSessionId: principal.sessionId, metadata: { rateDate: v.rateDate } }, tx);
  });
}

export async function getMarginWarning(principal: Principal): Promise<{ value: string; version: number }> {
  guard(principal);
  const [row] = await db.select({ value: systemSettings.marginWarningPercent, version: systemSettings.version }).from(systemSettings).limit(1);
  return row;
}

export async function setMarginWarning(principal: Principal, valueInput: unknown, versionInput: unknown): Promise<void> {
  guard(principal);
  const value = parseDecimal(valueInput, "El porcentaje");
  if (value <= 0n || value > 100n * 1_000_000n) throw new AppError("VALIDATION", "El porcentaje debe estar entre 0 y 100.");
  const version = versionSchema.parse(versionInput);
  await db.transaction(async (tx) => {
    const updated = await tx.update(systemSettings).set({ marginWarningPercent: toDb(value), updatedByUserId: principal.userId }).where(sql`${systemSettings.version} = ${version}`).returning({ id: systemSettings.id });
    if (!updated.length) throw new AppError("CONFLICT", "La configuración cambió; recarga antes de continuar.");
    await writeAudit({ actorUserId: principal.userId, action: "SETTINGS.MARGIN_WARNING", result: "SUCCESS", authSessionId: principal.sessionId }, tx);
  });
}
