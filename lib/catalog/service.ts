import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/db";
import { catalogItems, providerCosts, providers } from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import { type Principal, requirePermission } from "@/lib/rbac";
import { AppError } from "@/lib/errors";
import { parseDecimal, toDb } from "@/lib/money";
import { todayCR } from "@/lib/quotations/service";
import { currencySchema, identificationTypeSchema, optionalText, phoneSchema, requiredText, uuidSchema, emailSchema } from "@/lib/validation";
import { z } from "zod";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const itemSchema = z.object({ name: requiredText(2, 300, "El nombre"), description: optionalText(2000), unit: optionalText(30), cabys: z.preprocess(blank, z.string().trim().regex(/^[0-9]{13}$/, "El código CABYS debe tener 13 dígitos.").optional()) });
const providerSchema = z
  .object({
    legalName: requiredText(2, 300, "El nombre legal"),
    commercialName: optionalText(300),
    identificationType: z.preprocess(blank, identificationTypeSchema.optional()),
    identificationNumber: z.preprocess(blank, z.string().trim().max(20).optional()),
    phone: z.preprocess(blank, phoneSchema.optional()),
    email: z.preprocess(blank, emailSchema.optional()),
    contactName: optionalText(200),
  })
  .refine((v) => !!v.identificationType === !!v.identificationNumber, { message: "Indica tipo y número de identificación, o ninguno.", path: ["identificationNumber"] });

const escape = (q: string) => `%${q.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---- catálogo: todos ven lo aprobado y lo propio pendiente; los revisores ven toda la cola.
// El filtro de visibilidad va en SQL (antes del LIMIT); un administrador sin 2FA no ve nada.
function assertReady(principal: Principal): void {
  if (principal.role === "ADMIN" && !principal.twoFactorEnabled) throw new AppError("FORBIDDEN", "Configura el segundo factor para habilitar funciones administrativas.");
}

export async function listCatalog(principal: Principal, q?: string) {
  assertReady(principal);
  const canReview = principal.permissions.has("catalog.review");
  const like = q?.trim() ? escape(q) : undefined;
  const visible: SQL | undefined = canReview ? or(eq(catalogItems.status, "APPROVED"), eq(catalogItems.status, "PENDING_REVIEW")) : or(eq(catalogItems.status, "APPROVED"), and(eq(catalogItems.status, "PENDING_REVIEW"), eq(catalogItems.proposedByUserId, principal.userId)));
  return db
    .select({ id: catalogItems.id, name: catalogItems.name, description: catalogItems.description, unit: catalogItems.unit, cabys: catalogItems.cabysCode, status: catalogItems.status, proposedBy: catalogItems.proposedByUserId, version: catalogItems.version })
    .from(catalogItems)
    .where(and(visible, like ? or(ilike(catalogItems.name, like), ilike(catalogItems.cabysCode, like)) : undefined))
    .orderBy(desc(eq(catalogItems.status, "PENDING_REVIEW")), catalogItems.name)
    .limit(300);
}

export async function proposeCatalogItem(principal: Principal, input: unknown): Promise<void> {
  requirePermission(principal, "catalog.propose");
  const v = itemSchema.parse(input);
  await db.transaction(async (tx) => {
    const [row] = await tx.insert(catalogItems).values({ name: v.name, description: v.description ?? null, unit: v.unit ?? null, cabysCode: v.cabys ?? null, proposedByUserId: principal.userId }).returning({ id: catalogItems.id });
    await writeAudit({ actorUserId: principal.userId, action: "CATALOG.PROPOSE", result: "SUCCESS", target: { type: "catalog_item", id: row.id }, authSessionId: principal.sessionId }, tx);
  });
}

export async function reviewCatalogItem(principal: Principal, idInput: unknown, decision: unknown): Promise<void> {
  requirePermission(principal, "catalog.review");
  const id = uuidSchema.parse(idInput);
  const status = z.enum(["APPROVED", "REJECTED"]).parse(decision);
  await db.transaction(async (tx) => {
    const updated = await tx.update(catalogItems).set({ status, reviewedByUserId: principal.userId, reviewedAt: new Date() }).where(and(eq(catalogItems.id, id), eq(catalogItems.status, "PENDING_REVIEW"))).returning({ id: catalogItems.id });
    if (!updated.length) throw new AppError("CONFLICT", "El producto ya fue revisado o no existe.");
    await writeAudit({ actorUserId: principal.userId, action: `CATALOG.${status}`, result: "SUCCESS", target: { type: "catalog_item", id }, authSessionId: principal.sessionId }, tx);
  });
}

// ---- proveedores
export async function listProviders(principal: Principal, q?: string) {
  assertReady(principal);
  const canReview = principal.permissions.has("providers.review");
  const like = q?.trim() ? escape(q) : undefined;
  const visible: SQL | undefined = canReview ? or(eq(providers.status, "APPROVED"), eq(providers.status, "PENDING_REVIEW")) : or(eq(providers.status, "APPROVED"), and(eq(providers.status, "PENDING_REVIEW"), eq(providers.proposedByUserId, principal.userId)));
  return db
    .select({ id: providers.id, legalName: providers.legalName, commercialName: providers.commercialName, phone: providers.phone, email: providers.email, contactName: providers.contactName, status: providers.status, proposedBy: providers.proposedByUserId })
    .from(providers)
    .where(and(visible, like ? or(ilike(providers.legalName, like), ilike(providers.commercialName, like)) : undefined))
    .orderBy(desc(eq(providers.status, "PENDING_REVIEW")), providers.legalName)
    .limit(300);
}

export async function proposeProvider(principal: Principal, input: unknown): Promise<void> {
  requirePermission(principal, "providers.propose");
  const v = providerSchema.parse(input);
  await db.transaction(async (tx) => {
    const [row] = await tx.insert(providers).values({ legalName: v.legalName, commercialName: v.commercialName ?? null, identificationType: v.identificationType ?? null, identificationNumber: v.identificationNumber ?? null, phone: v.phone ?? null, email: v.email ?? null, contactName: v.contactName ?? null, proposedByUserId: principal.userId }).returning({ id: providers.id });
    await writeAudit({ actorUserId: principal.userId, action: "PROVIDER.PROPOSE", result: "SUCCESS", target: { type: "provider", id: row.id }, authSessionId: principal.sessionId }, tx);
  });
}

export async function reviewProvider(principal: Principal, idInput: unknown, decision: unknown): Promise<void> {
  requirePermission(principal, "providers.review");
  const id = uuidSchema.parse(idInput);
  const status = z.enum(["APPROVED", "REJECTED"]).parse(decision);
  await db.transaction(async (tx) => {
    const updated = await tx.update(providers).set({ status, reviewedByUserId: principal.userId, reviewedAt: new Date() }).where(and(eq(providers.id, id), eq(providers.status, "PENDING_REVIEW"))).returning({ id: providers.id });
    if (!updated.length) throw new AppError("CONFLICT", "El proveedor ya fue revisado o no existe.");
    await writeAudit({ actorUserId: principal.userId, action: `PROVIDER.${status}`, result: "SUCCESS", target: { type: "provider", id }, authSessionId: principal.sessionId }, tx);
  });
}

// ---- costos internos (historial por vendedor; revisores con quotations.view_all ven todos)
const costSchema = z.object({ providerId: uuidSchema, catalogItemId: z.preprocess(blank, uuidSchema.optional()), itemName: optionalText(300), unitCost: z.string().trim().min(1, "El costo es obligatorio."), currency: currencySchema, notes: optionalText(500) });

export async function listCosts(principal: Principal) {
  requirePermission(principal, principal.permissions.has("quotations.view_all") ? "quotations.view_all" : "quotations.manage_own");
  const all = principal.permissions.has("quotations.view_all");
  return db
    .select({ id: providerCosts.id, itemName: providerCosts.itemName, unitCost: providerCosts.unitCost, currency: providerCosts.currency, quotedOn: providerCosts.quotedOn, notes: providerCosts.notes, provider: providers.legalName })
    .from(providerCosts)
    .innerJoin(providers, eq(providers.id, providerCosts.providerId))
    .where(all ? undefined : eq(providerCosts.createdByUserId, principal.userId))
    .orderBy(desc(providerCosts.quotedOn), desc(providerCosts.createdAt))
    .limit(300);
}

export async function recordCost(principal: Principal, input: unknown): Promise<void> {
  requirePermission(principal, "quotations.manage_own");
  const v = costSchema.parse(input);
  const cost = parseDecimal(v.unitCost, "El costo");
  if (cost <= 0n) throw new AppError("VALIDATION", "El costo debe ser mayor que cero.");
  const [provider] = await db.select({ id: providers.id }).from(providers).where(and(eq(providers.id, v.providerId), eq(providers.status, "APPROVED"))).limit(1);
  if (!provider) throw new AppError("VALIDATION", "El proveedor no existe o no está aprobado.");
  let name = v.itemName;
  if (v.catalogItemId) {
    const [item] = await db.select({ name: catalogItems.name }).from(catalogItems).where(and(eq(catalogItems.id, v.catalogItemId), eq(catalogItems.status, "APPROVED"))).limit(1);
    if (!item) throw new AppError("VALIDATION", "El producto del catálogo no existe o no está aprobado.");
    name ??= item.name;
  }
  if (!name) throw new AppError("VALIDATION", "Indica el producto.");
  await db.transaction(async (tx) => {
    await tx.insert(providerCosts).values({ providerId: provider.id, catalogItemId: v.catalogItemId ?? null, itemName: name, unitCost: toDb(cost), currency: v.currency, quotedOn: todayCR(), notes: v.notes ?? null, createdByUserId: principal.userId });
    await writeAudit({ actorUserId: principal.userId, action: "COST.RECORD", result: "SUCCESS", authSessionId: principal.sessionId }, tx);
  });
}

/** Fusiona una propuesta pendiente en un producto/proveedor ya aprobado (duplicados). */
export async function mergeCatalogItem(principal: Principal, idInput: unknown, targetInput: unknown): Promise<void> {
  requirePermission(principal, "catalog.review");
  const id = uuidSchema.parse(idInput);
  const target = uuidSchema.parse(targetInput);
  if (id === target) throw new AppError("VALIDATION", "Elige un producto distinto.");
  await db.transaction(async (tx) => {
    const [dest] = await tx.select({ id: catalogItems.id }).from(catalogItems).where(and(eq(catalogItems.id, target), eq(catalogItems.status, "APPROVED"))).for("share");
    if (!dest) throw new AppError("VALIDATION", "El producto destino debe estar aprobado.");
    const updated = await tx.update(catalogItems).set({ status: "MERGED", mergedIntoId: target, reviewedByUserId: principal.userId, reviewedAt: new Date() }).where(and(eq(catalogItems.id, id), eq(catalogItems.status, "PENDING_REVIEW"))).returning({ id: catalogItems.id });
    if (!updated.length) throw new AppError("CONFLICT", "El producto ya fue revisado o no existe.");
    await writeAudit({ actorUserId: principal.userId, action: "CATALOG.MERGED", result: "SUCCESS", target: { type: "catalog_item", id }, authSessionId: principal.sessionId }, tx);
  });
}

export async function mergeProvider(principal: Principal, idInput: unknown, targetInput: unknown): Promise<void> {
  requirePermission(principal, "providers.review");
  const id = uuidSchema.parse(idInput);
  const target = uuidSchema.parse(targetInput);
  if (id === target) throw new AppError("VALIDATION", "Elige un proveedor distinto.");
  await db.transaction(async (tx) => {
    const [dest] = await tx.select({ id: providers.id }).from(providers).where(and(eq(providers.id, target), eq(providers.status, "APPROVED"))).for("share");
    if (!dest) throw new AppError("VALIDATION", "El proveedor destino debe estar aprobado.");
    const updated = await tx.update(providers).set({ status: "MERGED", mergedIntoId: target, reviewedByUserId: principal.userId, reviewedAt: new Date() }).where(and(eq(providers.id, id), eq(providers.status, "PENDING_REVIEW"))).returning({ id: providers.id });
    if (!updated.length) throw new AppError("CONFLICT", "El proveedor ya fue revisado o no existe.");
    await writeAudit({ actorUserId: principal.userId, action: "PROVIDER.MERGED", result: "SUCCESS", target: { type: "provider", id }, authSessionId: principal.sessionId }, tx);
  });
}
