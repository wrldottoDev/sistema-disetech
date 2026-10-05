import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { customerContacts, customers, quotations, roles, users } from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import { type Principal, requirePermission } from "@/lib/rbac";
import { AppError } from "@/lib/errors";
import { customerScope, ownedBy, quotationScope } from "@/lib/scope";
import { contactSchema, customerSchema, uuidSchema, versionSchema } from "@/lib/validation";

export type CustomerRow = typeof customers.$inferSelect;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listCustomers(principal: Principal, filters: { q?: string; status?: string }) {
  const scope = customerScope(principal);
  const q = filters.q?.trim().slice(0, 100);
  const term = q ? `%${escapeLike(q)}%` : undefined;
  const status = filters.status === "INACTIVE" ? "INACTIVE" : filters.status === "ALL" ? undefined : "ACTIVE";
  return db
    .select({ id: customers.id, fullName: customers.fullName, email: customers.email, phone: customers.phone, status: customers.status, ownerName: users.name, ownerUserId: customers.ownerUserId })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.ownerUserId))
    .where(
      ownedBy(
        scope,
        customers.ownerUserId,
        status ? eq(customers.status, status) : undefined,
        term ? or(ilike(customers.fullName, term), ilike(customers.email, term), ilike(customers.phone, term), ilike(customers.identificationNumber, term)) : undefined,
      ),
    )
    .orderBy(customers.fullName)
    .limit(200);
}

/** Devuelve el cliente sólo si el principal puede verlo; si no, NOT_FOUND (no revela existencia). */
export async function getCustomer(principal: Principal, idInput: unknown): Promise<CustomerRow> {
  const id = uuidSchema.safeParse(idInput);
  if (!id.success) throw new AppError("NOT_FOUND", "Cliente no encontrado.");
  const scope = customerScope(principal);
  const [row] = await db.select().from(customers).where(ownedBy(scope, customers.ownerUserId, eq(customers.id, id.data))).limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Cliente no encontrado.");
  return row;
}

export async function listContacts(principal: Principal, customerId: string) {
  await getCustomer(principal, customerId);
  return db.select().from(customerContacts).where(and(eq(customerContacts.customerId, customerId), eq(customerContacts.isActive, true))).orderBy(desc(customerContacts.isPrimary), customerContacts.fullName);
}

export async function listCustomerQuotations(principal: Principal, customerId: string) {
  await getCustomer(principal, customerId);
  // El historial respeta el alcance de cotizaciones por separado: un cliente reasignado no expone lo del vendedor anterior.
  return db
    .select({ id: quotations.id, folio: quotations.folio, status: quotations.status, updatedAt: quotations.updatedAt })
    .from(quotations)
    .where(ownedBy(quotationScope(principal), quotations.ownerUserId, eq(quotations.customerId, customerId)))
    .orderBy(desc(quotations.updatedAt))
    .limit(100);
}

function customerValues(input: unknown) {
  const v = customerSchema.parse(input);
  return {
    fullName: v.fullName,
    email: v.email,
    identificationType: v.identificationType ?? null,
    identificationNumber: v.identificationNumber ?? null,
    phone: v.phone ?? null,
    economicActivityCabys: v.cabys ?? null,
    address: v.address ?? null,
    notes: v.notes ?? null,
  };
}

export async function createCustomer(principal: Principal, input: unknown, ownerInput?: unknown): Promise<{ id: string }> {
  const manageAll = principal.permissions.has("customers.manage_all");
  if (!manageAll) requirePermission(principal, "customers.manage_own");
  else requirePermission(principal, "customers.manage_all");
  // Un vendedor siempre es dueño de lo que crea; el dueño enviado por el cliente sólo cuenta para quien administra todo.
  const ownerUserId = manageAll ? uuidSchema.parse(ownerInput) : principal.userId;
  const values = customerValues(input);
  const primary = (input as { contactName?: unknown } | null)?.contactName ? contactSchema.parse({ fullName: (input as Record<string, unknown>).contactName, phone: (input as Record<string, unknown>).contactPhone, email: (input as Record<string, unknown>).contactEmail, department: undefined }) : null;
  const id = await db.transaction(async (tx) => {
    const [created] = await tx.insert(customers).values({ ...values, ownerUserId, createdByUserId: principal.userId }).returning({ id: customers.id });
    if (primary) await tx.insert(customerContacts).values({ customerId: created.id, fullName: primary.fullName, phone: primary.phone ?? null, email: primary.email ?? null, department: primary.department ?? null, isPrimary: true });
    await writeAudit({ actorUserId: principal.userId, action: "CUSTOMER.CREATE", result: "SUCCESS", target: { type: "customer", id: created.id }, authSessionId: principal.sessionId }, tx);
    return created.id;
  });
  return { id };
}

export async function updateCustomer(principal: Principal, idInput: unknown, versionInput: unknown, input: unknown): Promise<void> {
  const customer = await getCustomer(principal, idInput);
  requirePermission(principal, principal.permissions.has("customers.manage_all") ? "customers.manage_all" : "customers.manage_own");
  if (customer.status !== "ACTIVE") throw new AppError("CONFLICT", "Reactiva al cliente antes de editarlo.");
  const version = versionSchema.parse(versionInput);
  const values = customerValues(input);
  await db.transaction(async (tx) => {
    const updated = await tx.update(customers).set(values).where(and(eq(customers.id, customer.id), eq(customers.version, version))).returning({ id: customers.id });
    if (!updated.length) throw new AppError("CONFLICT", "El cliente cambió; recarga antes de continuar.");
    await writeAudit({ actorUserId: principal.userId, action: "CUSTOMER.UPDATE", result: "SUCCESS", target: { type: "customer", id: customer.id }, authSessionId: principal.sessionId }, tx);
  });
}

export async function setCustomerActive(principal: Principal, idInput: unknown, versionInput: unknown, active: boolean): Promise<void> {
  const customer = await getCustomer(principal, idInput);
  requirePermission(principal, principal.permissions.has("customers.manage_all") ? "customers.manage_all" : "customers.manage_own");
  const version = versionSchema.parse(versionInput);
  await db.transaction(async (tx) => {
    // Bloquea al cliente: serializa con la creación de cotizaciones, que lo toma FOR SHARE.
    await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, customer.id)).for("update");
    if (!active) {
      const open = await tx.select({ id: quotations.id }).from(quotations).where(and(eq(quotations.customerId, customer.id), inArray(quotations.status, ["DRAFT", "ISSUED", "SENT"]))).limit(1);
      if (open.length) throw new AppError("CONFLICT", "El cliente tiene cotizaciones abiertas; ciérralas o cancélalas primero.");
    }
    const result = await tx
      .update(customers)
      .set(active ? { status: "ACTIVE", deactivatedAt: null, deactivatedByUserId: null } : { status: "INACTIVE", deactivatedAt: new Date(), deactivatedByUserId: principal.userId })
      .where(and(eq(customers.id, customer.id), eq(customers.version, version)))
      .returning({ id: customers.id });
    if (!result.length) throw new AppError("CONFLICT", "El cliente cambió; recarga antes de continuar.");
    await writeAudit({ actorUserId: principal.userId, action: active ? "CUSTOMER.REACTIVATE" : "CUSTOMER.DEACTIVATE", result: "SUCCESS", target: { type: "customer", id: customer.id }, authSessionId: principal.sessionId }, tx);
  });
}

export async function addContact(principal: Principal, customerIdInput: unknown, input: unknown): Promise<void> {
  requirePermission(principal, principal.permissions.has("customers.manage_all") ? "customers.manage_all" : "customers.manage_own");
  const scope = customerScope(principal);
  const customerId = uuidSchema.safeParse(customerIdInput);
  if (!customerId.success) throw new AppError("NOT_FOUND", "Cliente no encontrado.");
  const v = contactSchema.parse(input);
  await db.transaction(async (tx) => {
    // Se vuelve a comprobar propiedad y estado bajo bloqueo: una reasignación concurrente no puede cruzarse.
    const [customer] = await tx.select().from(customers).where(ownedBy(scope, customers.ownerUserId, eq(customers.id, customerId.data))).for("update").limit(1);
    if (!customer) throw new AppError("NOT_FOUND", "Cliente no encontrado.");
    if (customer.status !== "ACTIVE") throw new AppError("CONFLICT", "Reactiva al cliente antes de editarlo.");
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(customerContacts).where(and(eq(customerContacts.customerId, customer.id), eq(customerContacts.isActive, true)));
    await tx.insert(customerContacts).values({ customerId: customer.id, fullName: v.fullName, phone: v.phone ?? null, email: v.email ?? null, department: v.department ?? null, isPrimary: count === 0 });
    await writeAudit({ actorUserId: principal.userId, action: "CUSTOMER.CONTACT_ADD", result: "SUCCESS", target: { type: "customer", id: customer.id }, authSessionId: principal.sessionId }, tx);
  });
}

export async function reassignCustomer(principal: Principal, idInput: unknown, newOwnerInput: unknown): Promise<void> {
  requirePermission(principal, "customers.reassign");
  const id = uuidSchema.parse(idInput);
  const newOwner = uuidSchema.parse(newOwnerInput);
  await db.transaction(async (tx) => {
    const open = await tx.select({ id: quotations.id }).from(quotations).where(and(eq(quotations.customerId, id), inArray(quotations.status, ["DRAFT", "ISSUED", "SENT"]))).limit(1);
    if (open.length) throw new AppError("CONFLICT", "Hay cotizaciones abiertas; ciérralas o cancélalas antes de reasignar el cliente.");
    const moved = await tx.update(customers).set({ ownerUserId: newOwner }).where(eq(customers.id, id)).returning({ id: customers.id });
    if (!moved.length) throw new AppError("NOT_FOUND", "Cliente no encontrado.");
    await writeAudit({ actorUserId: principal.userId, action: "CUSTOMER.REASSIGN", result: "SUCCESS", target: { type: "customer", id }, authSessionId: principal.sessionId, metadata: { newOwner } }, tx);
  });
}

export async function listSellers(principal: Principal) {
  requirePermission(principal, principal.permissions.has("customers.reassign") ? "customers.reassign" : "customers.manage_all");
  return db.select({ id: users.id, name: users.name }).from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(and(eq(roles.code, "SELLER"), eq(users.status, "ACTIVE"))).orderBy(users.name);
}
