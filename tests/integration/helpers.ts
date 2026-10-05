import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { permissions, rolePermissions, roles, users } from "@/db/schema";
import type { Principal, RoleCode } from "@/lib/rbac";

let counter = 0;
const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

export async function createCompanyRow(name = unique("Empresa")): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`INSERT INTO companies (name) VALUES (${name}) RETURNING id`);
  return rows[0].id;
}

export async function createUser(role: RoleCode, name = unique(role)): Promise<Principal> {
  const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, role));
  const companyId = role === "SELLER" ? await createCompanyRow() : null;
  const [u] = await db
    .insert(users)
    .values({ name, email: `${unique("u")}@example.test`, phone: "80000000", roleId: r.id, status: "ACTIVE", activatedAt: new Date(), companyId, twoFactorEnabled: role === "ADMIN" })
    .returning({ id: users.id });
  return principalFor(u.id);
}

export async function principalFor(userId: string): Promise<Principal> {
  const rows = await db
    .select({ role: roles.code, permission: permissions.code, twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(users.id, userId));
  return {
    userId,
    sessionId: "00000000-0000-4000-8000-000000000000",
    role: rows[0].role,
    permissions: new Set(rows.flatMap((r) => (r.permission ? [r.permission] : []))),
    twoFactorEnabled: rows[0].twoFactorEnabled,
    recentAuthAt: new Date(),
  };
}

export async function ensureRate(sell = "462.290000", buy = "455.000000"): Promise<void> {
  const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM exchange_rates`);
  if (rows[0].n > 0) return;
  const admin = await createUser("ADMIN");
  await db.execute(sql`INSERT INTO exchange_rates (rate_date, source, buy_rate, sell_rate, created_by_user_id) VALUES ((now() AT TIME ZONE 'America/Costa_Rica')::date, 'MANUAL', ${buy}, ${sell}, ${admin.userId})`);
}

export const futureDate = (days = 15) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica" }).format(new Date(Date.now() + days * 86_400_000));

export const customerInput = (name = unique("Cliente")) => ({ fullName: name, email: `${unique("c")}@example.test`, contactName: "Contacto Uno", contactPhone: "60706262" });
export const headerInput = (extra: Record<string, unknown> = {}) => ({ concept: "Venta de material eléctrico", currency: "CRC", validUntil: futureDate(), ...extra });
export const itemInput = (extra: Record<string, unknown> = {}) => ({ itemName: "Ángulo UL interno blanco", quantity: "5", unitCost: "10000", costCurrency: "CRC", marginPercent: "30", ...extra });
