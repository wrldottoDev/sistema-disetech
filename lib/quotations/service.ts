import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  catalogItems,
  customerContacts,
  customers,
  paymentAccounts,
  providerCosts,
  providers,
  quotationItems,
  quotationReviews,
  quotationRevisions,
  quotationStatusHistory,
  quotations,
  systemSettings,
  users,
} from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import { type Principal, requirePermission } from "@/lib/rbac";
import { AppError } from "@/lib/errors";
import { type Currency, fromDb, marginPercentFromAmount, parseDecimal, toDb, unitPrice } from "@/lib/money";
import { ownedBy, quotationScope } from "@/lib/scope";
import { closeSchema, quotationHeaderSchema, quotationItemSchema, reviewSchema, uuidSchema, versionSchema } from "@/lib/validation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type QuotationRow = typeof quotations.$inferSelect;
export type RevisionRow = typeof quotationRevisions.$inferSelect;
export type ItemRow = typeof quotationItems.$inferSelect;

export const statusSchema = z.enum(["SENT", "WON", "LOST", "CANCELLED"]);
const auditIn = (tx: Tx, p: Principal, action: string, quotationId: string, metadata?: Record<string, string | number | boolean | null>) =>
  writeAudit({ actorUserId: p.userId, action, result: "SUCCESS", target: { type: "quotation", id: quotationId }, authSessionId: p.sessionId, metadata }, tx);
const notFound = () => new AppError("NOT_FOUND", "Cotización no encontrada.");

/** Fecha calendario de Costa Rica (YYYY-MM-DD), no la del servidor. */
export function todayCR(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica" }).format(now);
}

/** Fecha calendario de Costa Rica dentro de `days` días. */
export function dateInCR(days: number): string {
  return todayCR(new Date(Date.now() + days * 86_400_000));
}

// ---------------------------------------------------------------- lectura (siempre con alcance por rol)

/** Revisión "vigente" de una cotización para resúmenes: la vendida si existe, si no la última emitida, si no el borrador. */
const effectiveRevisionSql = sql`coalesce(${quotations.soldRevisionId}, (select r.id from quotation_revisions r where r.quotation_id = ${quotations.id} and r.state = 'ISSUED' order by r.revision_number desc limit 1), (select r.id from quotation_revisions r where r.quotation_id = ${quotations.id} order by r.revision_number desc limit 1))`;

export async function listQuotations(principal: Principal, filters: { q?: string; status?: string }) {
  const scope = quotationScope(principal);
  const term = filters.q?.trim().slice(0, 100);
  const like = term ? `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
  const status = (["DRAFT", "ISSUED", "SENT", "WON", "LOST", "CANCELLED"] as const).find((s) => s === filters.status);
  return db
    .select({
      id: quotations.id,
      folio: quotations.folio,
      status: quotations.status,
      updatedAt: quotations.updatedAt,
      customerName: customers.fullName,
      ownerName: users.name,
      concept: sql<string | null>`(select r.concept from quotation_revisions r where r.id = ${effectiveRevisionSql})`,
      currency: sql<Currency>`(select r.currency from quotation_revisions r where r.id = ${effectiveRevisionSql})`,
      total: sql<string>`(select coalesce(sum(round(i.subtotal, 2) + round(i.tax_amount, 2)), 0)::text from quotation_items i where i.revision_id = ${effectiveRevisionSql})`,
    })
    .from(quotations)
    .innerJoin(customers, eq(customers.id, quotations.customerId))
    .innerJoin(users, eq(users.id, quotations.ownerUserId))
    .where(ownedBy(scope, quotations.ownerUserId, status ? eq(quotations.status, status) : undefined, like ? or(ilike(customers.fullName, like), ilike(quotations.folio, like)) : undefined))
    .orderBy(desc(quotations.updatedAt))
    .limit(200);
}

async function loadScoped(principal: Principal, idInput: unknown, runner: Pick<Tx, "select"> = db): Promise<QuotationRow> {
  const id = uuidSchema.safeParse(idInput);
  if (!id.success) throw notFound();
  const scope = quotationScope(principal);
  const [row] = await runner.select().from(quotations).where(ownedBy(scope, quotations.ownerUserId, eq(quotations.id, id.data))).limit(1);
  if (!row) throw notFound();
  return row;
}

/** Cotización que el principal puede modificar: sólo su dueño (vendedor con quotations.manage_own). */
async function loadOwned(principal: Principal, idInput: unknown, runner: Pick<Tx, "select"> = db): Promise<QuotationRow> {
  requirePermission(principal, "quotations.manage_own");
  const row = await loadScoped(principal, idInput, runner);
  if (row.ownerUserId !== principal.userId) throw notFound();
  return row;
}

async function latestRevision(runner: Pick<Tx, "select">, quotationId: string): Promise<RevisionRow> {
  const [rev] = await runner.select().from(quotationRevisions).where(eq(quotationRevisions.quotationId, quotationId)).orderBy(desc(quotationRevisions.revisionNumber)).limit(1);
  if (!rev) throw notFound();
  return rev;
}

export async function getQuotationDetail(principal: Principal, idInput: unknown, revisionNumber?: number) {
  const quotation = await loadScoped(principal, idInput);
  const revisions = await db.select({ id: quotationRevisions.id, revisionNumber: quotationRevisions.revisionNumber, state: quotationRevisions.state, issuedAt: quotationRevisions.issuedAt }).from(quotationRevisions).where(eq(quotationRevisions.quotationId, quotation.id)).orderBy(desc(quotationRevisions.revisionNumber));
  // Sin revisión explícita: una cotización ganada muestra la vendida; una perdida/cancelada, la última emitida; el resto, la más reciente.
  const closedDefault = quotation.soldRevisionId
    ? revisions.find((r) => r.id === quotation.soldRevisionId)?.revisionNumber
    : ["LOST", "CANCELLED"].includes(quotation.status)
      ? revisions.find((r) => r.state === "ISSUED")?.revisionNumber
      : undefined;
  const wanted = revisionNumber ?? closedDefault ?? revisions[0]?.revisionNumber;
  const [revision] = await db.select().from(quotationRevisions).where(and(eq(quotationRevisions.quotationId, quotation.id), eq(quotationRevisions.revisionNumber, wanted ?? -1))).limit(1);
  if (!revision) throw notFound();
  const items = await db.select().from(quotationItems).where(eq(quotationItems.revisionId, revision.id)).orderBy(quotationItems.lineNumber);
  const history = await db
    .select({ id: quotationStatusHistory.id, fromStatus: quotationStatusHistory.fromStatus, toStatus: quotationStatusHistory.toStatus, changedAt: quotationStatusHistory.changedAt, note: quotationStatusHistory.note, by: users.name })
    .from(quotationStatusHistory)
    .innerJoin(users, eq(users.id, quotationStatusHistory.changedByUserId))
    .where(eq(quotationStatusHistory.quotationId, quotation.id))
    .orderBy(desc(quotationStatusHistory.seq));
  const reviews = await db
    .select({ id: quotationReviews.id, outcome: quotationReviews.outcome, comment: quotationReviews.comment, reviewedAt: quotationReviews.reviewedAt, revisionVersion: quotationReviews.revisionVersion, revisionId: quotationReviews.revisionId, by: users.name })
    .from(quotationReviews)
    .innerJoin(users, eq(users.id, quotationReviews.reviewerUserId))
    .where(eq(quotationReviews.quotationId, quotation.id))
    .orderBy(desc(quotationReviews.reviewedAt));
  const [customer] = await db.select({ id: customers.id, fullName: customers.fullName }).from(customers).where(eq(customers.id, quotation.customerId)).limit(1);
  const [{ marginWarning }] = await db.select({ marginWarning: systemSettings.marginWarningPercent }).from(systemSettings).limit(1);
  const isOwner = quotation.ownerUserId === principal.userId && principal.permissions.has("quotations.manage_own");
  const isLatest = revision.id === revisions[0]?.id;
  const lowMargin = items.some((i) => fromDb(i.marginPercent) < fromDb(marginWarning));
  const latestReview = reviews.find((r) => r.revisionId === revision.id && r.revisionVersion === revision.version);
  return { quotation, revision, revisions, items, history, reviews, customer, isOwner, isLatest, marginWarning, lowMargin, approved: latestReview?.outcome === "APPROVED" };
}

export async function listContactsForQuotation(principal: Principal, quotationId: unknown) {
  const quotation = await loadScoped(principal, quotationId);
  return db.select({ id: customerContacts.id, fullName: customerContacts.fullName, phone: customerContacts.phone }).from(customerContacts).where(and(eq(customerContacts.customerId, quotation.customerId), eq(customerContacts.isActive, true)));
}

/** Catálogo/proveedores aprobados (proyecciones públicas) para el editor de líneas. */
export async function editorOptions(principal: Principal) {
  requirePermission(principal, "quotations.manage_own");
  const [items, provs, costs] = await Promise.all([
    db.select({ id: catalogItems.id, name: catalogItems.name, unit: catalogItems.unit }).from(catalogItems).where(eq(catalogItems.status, "APPROVED")).orderBy(catalogItems.name).limit(500),
    db.select({ id: providers.id, name: sql<string>`coalesce(${providers.commercialName}, ${providers.legalName})` }).from(providers).where(eq(providers.status, "APPROVED")).orderBy(providers.legalName).limit(500),
    db.select({ id: providerCosts.id, providerId: providerCosts.providerId, catalogItemId: providerCosts.catalogItemId, itemName: providerCosts.itemName, unitCost: providerCosts.unitCost, currency: providerCosts.currency, quotedOn: providerCosts.quotedOn }).from(providerCosts).where(eq(providerCosts.createdByUserId, principal.userId)).orderBy(desc(providerCosts.quotedOn), desc(providerCosts.createdAt)).limit(200),
  ]);
  return { items, providers: provs, costs };
}

// ---------------------------------------------------------------- escritura

async function effectiveRate(runner: Pick<Tx, "execute">) {
  const rows = await runner.execute<{ id: string; buy_rate: string; sell_rate: string; rate_date: string; source: "BCCR" | "MANUAL" }>(sql`
    SELECT e.id, e.buy_rate::text, e.sell_rate::text, e.rate_date::text, e.source
    FROM exchange_rates e
    WHERE e.rate_date <= ${todayCR()}::date
      AND NOT EXISTS (SELECT 1 FROM exchange_rates s WHERE s.supersedes_id = e.id)
    ORDER BY e.rate_date DESC, e.created_at DESC LIMIT 1`);
  const rate = rows[0];
  if (!rate) throw new AppError("CONFLICT", "No hay un tipo de cambio registrado. Pide al administrador que lo registre en Configuración.");
  return rate;
}

export async function currentRate() {
  return effectiveRate(db);
}

async function claim(tx: Tx, revision: RevisionRow, expectedVersion: number): Promise<void> {
  if (revision.version !== expectedVersion) throw new AppError("CONFLICT", "La cotización cambió mientras la editabas. Recarga la página e inténtalo de nuevo.");
  await tx.execute(sql`SELECT claim_quotation_revision(${revision.id}::uuid, ${expectedVersion}::int)`);
}

async function loadDraft(tx: Tx, principal: Principal, quotationId: unknown, expectedRevisionId?: unknown): Promise<{ quotation: QuotationRow; revision: RevisionRow }> {
  const quotation = await loadOwned(principal, quotationId, tx);
  const revision = await latestRevision(tx, quotation.id);
  // Toda mutación de un borrador identifica la revisión exacta que el usuario veía (la versión sola puede repetirse en un borrador de reemplazo).
  if (expectedRevisionId !== undefined && revision.id !== uuidSchema.safeParse(expectedRevisionId).data) throw new AppError("CONFLICT", "La cotización cambió mientras la editabas. Recarga la página e inténtalo de nuevo.");
  if (revision.state !== "DRAFT") throw new AppError("CONFLICT", "Esta cotización ya fue emitida. Crea una nueva revisión para modificarla.");
  return { quotation, revision };
}

export async function createQuotation(principal: Principal, customerIdInput: unknown, headerInput: unknown): Promise<{ id: string }> {
  requirePermission(principal, "quotations.manage_own");
  const customerId = uuidSchema.parse(customerIdInput);
  const header = quotationHeaderSchema.parse(headerInput);
  if (header.validUntil < todayCR()) throw new AppError("VALIDATION", "La vigencia no puede estar en el pasado.");
  const id = await db.transaction(async (tx) => {
    const [customer] = await tx.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.ownerUserId, principal.userId))).for("share").limit(1);
    if (!customer) throw new AppError("NOT_FOUND", "Cliente no encontrado.");
    if (customer.status !== "ACTIVE") throw new AppError("CONFLICT", "El cliente está inactivo.");
    const [seller] = await tx.select().from(users).where(eq(users.id, principal.userId)).limit(1);
    const contact = await resolveContact(tx, customerId, header.contactId);
    const fx = await effectiveRate(tx);
    const [created] = await tx.insert(quotations).values({ customerId, createdByUserId: principal.userId, ownerUserId: principal.userId }).returning({ id: quotations.id });
    await tx.insert(quotationRevisions).values({
      quotationId: created.id,
      customerId,
      revisionNumber: 1,
      currency: header.currency,
      exchangeRateId: fx.id,
      fxBuy: fx.buy_rate,
      fxSell: fx.sell_rate,
      fxRateDate: fx.rate_date,
      fxSource: fx.source,
      fxAppliedRate: fx.sell_rate,
      concept: header.concept,
      pricingMode: header.pricingMode ?? "BY_UNIT",
      validUntil: header.validUntil,
      notes: header.notes ?? null,
      customerCabys: header.cabys ?? customer.economicActivityCabys,
      ...customerSnapshot(customer, contact),
      sellerUserId: seller.id,
      sellerName: seller.name,
      sellerEmail: seller.email,
      sellerPhone: seller.phone,
      createdByUserId: principal.userId,
    });
    await auditIn(tx, principal, "QUOTATION.CREATE", created.id);
    return created.id;
  });
  return { id };
}

async function resolveContact(tx: Pick<Tx, "select">, customerId: string, contactId?: string) {
  const where = contactId
    ? and(eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId), eq(customerContacts.isActive, true))
    : and(eq(customerContacts.customerId, customerId), eq(customerContacts.isPrimary, true), eq(customerContacts.isActive, true));
  const [contact] = await tx.select().from(customerContacts).where(where).limit(1);
  if (contactId && !contact) throw new AppError("VALIDATION", "El contacto no pertenece a este cliente.");
  return contact ?? null;
}

function customerSnapshot(customer: typeof customers.$inferSelect, contact: typeof customerContacts.$inferSelect | null) {
  return {
    customerName: customer.fullName,
    customerIdentification: customer.identificationNumber,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    customerAddress: customer.address,
    customerContactName: contact?.fullName ?? null,
    customerContactPhone: contact?.phone ?? customer.phone,
    customerContactEmail: contact?.email ?? null,
    customerContactDepartment: contact?.department ?? null,
    customerContactExtension: contact?.extension ?? null,
  };
}

/** Recalcula el precio de todas las líneas (cambio de moneda o de tipo de cambio). Requiere revisión reclamada. */
async function repriceItems(tx: Tx, revision: { id: string }, currency: Currency, fxRate: bigint): Promise<void> {
  const items = await tx.select().from(quotationItems).where(eq(quotationItems.revisionId, revision.id));
  for (const item of items) {
    const price = unitPrice({ cost: fromDb(item.unitCost), costCurrency: item.costCurrency, marginPercent: fromDb(item.marginPercent), marginAmount: item.marginAmount === null ? null : fromDb(item.marginAmount), currency, fxRate });
    if (price <= 0n) throw new AppError("VALIDATION", `La línea ${item.lineNumber} quedaría con precio cero en esta moneda; ajusta su costo o utilidad primero.`);
    await tx.update(quotationItems).set({ unitPrice: toDb(price) }).where(eq(quotationItems.id, item.id));
  }
}

export async function updateHeader(principal: Principal, quotationId: unknown, revisionVersionInput: unknown, headerInput: unknown, opts: { refreshRate?: boolean; revisionId?: unknown } = {}): Promise<void> {
  const header = quotationHeaderSchema.parse(headerInput);
  const expected = versionSchema.parse(revisionVersionInput);
  if (header.validUntil < todayCR()) throw new AppError("VALIDATION", "La vigencia no puede estar en el pasado.");
  await db.transaction(async (tx) => {
    const { quotation, revision } = await loadDraft(tx, principal, quotationId, opts.revisionId);
    await claim(tx, revision, expected);
    const [customer] = await tx.select().from(customers).where(eq(customers.id, quotation.customerId)).limit(1);
    const contact = await resolveContact(tx, quotation.customerId, header.contactId);
    const fx = opts.refreshRate ? await effectiveRate(tx) : null;
    await tx
      .update(quotationRevisions)
      .set({
        currency: header.currency,
        concept: header.concept,
        ...(header.pricingMode ? { pricingMode: header.pricingMode } : {}),
        validUntil: header.validUntil,
        notes: header.notes ?? null,
        customerCabys: header.cabys ?? null,
        ...customerSnapshot(customer, contact),
        ...(fx ? { exchangeRateId: fx.id, fxBuy: fx.buy_rate, fxSell: fx.sell_rate, fxRateDate: fx.rate_date, fxSource: fx.source, fxAppliedRate: fx.sell_rate } : {}),
      })
      .where(eq(quotationRevisions.id, revision.id));
    const applied = fx ? fx.sell_rate : (revision.fxAppliedRate as string);
    if (header.currency !== revision.currency || fx) await repriceItems(tx, revision, header.currency, fromDb(applied));
    await auditIn(tx, principal, "QUOTATION.UPDATE", quotation.id);
  });
}

function parseItem(input: unknown, revision: RevisionRow) {
  const v = quotationItemSchema.parse(input);
  const quantity = parseDecimal(v.quantity, "La cantidad");
  if (quantity <= 0n || quantity % 10_000n !== 0n) throw new AppError("VALIDATION", "La cantidad debe ser mayor que cero y tener hasta 2 decimales.");
  const cost = parseDecimal(v.unitCost, "El costo");
  if (cost <= 0n) throw new AppError("VALIDATION", "El costo debe ser mayor que cero.");
  let margin: bigint;
  let marginAmount: bigint | null = null;
  if (v.marginMode === "AMOUNT") {
    marginAmount = parseDecimal(v.marginAmount ?? "", "El monto de utilidad");
    if (marginAmount <= 0n) throw new AppError("VALIDATION", "El monto de utilidad debe ser mayor que cero.");
    // El % derivado alimenta la alerta de utilidad baja y el rango permitido (hasta 100% del costo).
    margin = marginPercentFromAmount(cost, marginAmount);
    if (margin <= 0n) throw new AppError("VALIDATION", "El monto de utilidad es demasiado pequeño para el costo indicado.");
  } else {
    margin = parseDecimal(v.marginPercent ?? "", "La utilidad");
  }
  if (margin <= 0n || margin > 100n * 1_000_000n) throw new AppError("VALIDATION", "La utilidad debe ser mayor que 0 y no superar 100% del costo.");
  const price = unitPrice({ cost, costCurrency: v.costCurrency, marginPercent: margin, marginAmount, currency: revision.currency, fxRate: fromDb(revision.fxAppliedRate as string) });
  if (price <= 0n) throw new AppError("VALIDATION", "El precio calculado es cero; revisa costo y utilidad.");
  return { v, quantity, cost, margin, marginAmount, price };
}

async function itemRelations(tx: Tx, v: ReturnType<typeof parseItem>["v"]) {
  let name = v.itemName;
  let unit = v.unit ?? null;
  let description = v.itemDescription ?? null;
  if (v.catalogItemId) {
    const [item] = await tx.select().from(catalogItems).where(and(eq(catalogItems.id, v.catalogItemId), eq(catalogItems.status, "APPROVED"))).limit(1);
    if (!item) throw new AppError("VALIDATION", "El producto del catálogo no existe o no está aprobado.");
    name ??= item.name;
    unit ??= item.unit;
    description ??= item.description;
  }
  if (!name) throw new AppError("VALIDATION", "Indica la descripción del producto.");
  let provider: { id: string; name: string } | null = null;
  if (v.providerId) {
    const [p] = await tx.select().from(providers).where(and(eq(providers.id, v.providerId), eq(providers.status, "APPROVED"))).limit(1);
    if (!p) throw new AppError("VALIDATION", "El proveedor no existe o no está aprobado.");
    provider = { id: p.id, name: p.commercialName ?? p.legalName };
  }
  return { name, unit, description, provider };
}

export async function addItem(principal: Principal, quotationId: unknown, revisionVersionInput: unknown, input: unknown, revisionId?: unknown): Promise<void> {
  const expected = versionSchema.parse(revisionVersionInput);
  await db.transaction(async (tx) => {
    const { quotation, revision } = await loadDraft(tx, principal, quotationId, revisionId);
    await claim(tx, revision, expected);
    const { v, quantity, cost, margin, marginAmount, price } = parseItem(input, revision);
    const rel = await itemRelations(tx, v);
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${quotationItems.lineNumber}), 0) + 1` }).from(quotationItems).where(eq(quotationItems.revisionId, revision.id));
    await tx.insert(quotationItems).values({
      quotationId: revision.quotationId,
      revisionId: revision.id,
      lineNumber: next,
      catalogItemId: v.catalogItemId ?? null,
      providerId: rel.provider?.id ?? null,
      providerNameSnapshot: rel.provider?.name ?? null,
      itemName: rel.name,
      itemDescription: rel.description,
      unit: rel.unit,
      quantity: toDb(quantity),
      unitCost: toDb(cost),
      costCurrency: v.costCurrency,
      marginPercent: toDb(margin),
      marginMode: v.marginMode,
      marginAmount: marginAmount === null ? null : toDb(marginAmount),
      unitPrice: toDb(price),
    });
    if (v.saveCost && rel.provider) {
      await tx.insert(providerCosts).values({ providerId: rel.provider.id, catalogItemId: v.catalogItemId ?? null, itemName: rel.name, unitCost: toDb(cost), currency: v.costCurrency, quotedOn: todayCR(), createdByUserId: principal.userId });
    }
    await auditIn(tx, principal, "QUOTATION.ITEM_ADD", quotation.id);
  });
}

export async function updateItem(principal: Principal, quotationId: unknown, revisionVersionInput: unknown, itemIdInput: unknown, input: unknown, revisionId?: unknown): Promise<void> {
  const expected = versionSchema.parse(revisionVersionInput);
  const itemId = uuidSchema.parse(itemIdInput);
  await db.transaction(async (tx) => {
    const { quotation, revision } = await loadDraft(tx, principal, quotationId, revisionId);
    await claim(tx, revision, expected);
    const { v, quantity, cost, margin, marginAmount, price } = parseItem(input, revision);
    const rel = await itemRelations(tx, v);
    const updated = await tx
      .update(quotationItems)
      .set({
        catalogItemId: v.catalogItemId ?? null,
        providerId: rel.provider?.id ?? null,
        providerNameSnapshot: rel.provider?.name ?? null,
        itemName: rel.name,
        itemDescription: rel.description,
        unit: rel.unit,
        quantity: toDb(quantity),
        unitCost: toDb(cost),
        costCurrency: v.costCurrency,
        marginPercent: toDb(margin),
        marginMode: v.marginMode,
        marginAmount: marginAmount === null ? null : toDb(marginAmount),
        unitPrice: toDb(price),
      })
      .where(and(eq(quotationItems.id, itemId), eq(quotationItems.revisionId, revision.id)))
      .returning({ id: quotationItems.id });
    if (!updated.length) throw new AppError("NOT_FOUND", "Línea no encontrada.");
    if (v.saveCost && rel.provider) {
      await tx.insert(providerCosts).values({ providerId: rel.provider.id, catalogItemId: v.catalogItemId ?? null, itemName: rel.name, unitCost: toDb(cost), currency: v.costCurrency, quotedOn: todayCR(), createdByUserId: principal.userId });
    }
    await auditIn(tx, principal, "QUOTATION.ITEM_UPDATE", quotation.id);
  });
}

export async function removeItem(principal: Principal, quotationId: unknown, revisionVersionInput: unknown, itemIdInput: unknown, revisionId?: unknown): Promise<void> {
  const expected = versionSchema.parse(revisionVersionInput);
  const itemId = uuidSchema.parse(itemIdInput);
  await db.transaction(async (tx) => {
    const { quotation, revision } = await loadDraft(tx, principal, quotationId, revisionId);
    await claim(tx, revision, expected);
    const removed = await tx.delete(quotationItems).where(and(eq(quotationItems.id, itemId), eq(quotationItems.revisionId, revision.id))).returning({ id: quotationItems.id });
    if (!removed.length) throw new AppError("NOT_FOUND", "Línea no encontrada.");
    await auditIn(tx, principal, "QUOTATION.ITEM_REMOVE", quotation.id);
  });
}

export async function reviewQuotation(principal: Principal, quotationId: unknown, input: unknown): Promise<void> {
  requirePermission(principal, "quotations.review");
  const v = reviewSchema.parse(input);
  const quotation = await loadScoped(principal, quotationId);
  if (v.outcome !== "APPROVED" && !v.comment) throw new AppError("VALIDATION", "Explica el motivo en el comentario.");
  await db.transaction(async (tx) => {
    // La revisión sólo vale para exactamente la versión que el gerente vio.
    const [revision] = await tx.select().from(quotationRevisions).where(eq(quotationRevisions.id, v.revisionId)).for("update");
    if (!revision || revision.quotationId !== quotation.id) throw notFound();
    const latest = await latestRevision(tx, quotation.id);
    if (latest.id !== revision.id || revision.version !== v.revisionVersion) throw new AppError("CONFLICT", "La cotización cambió desde que la abriste. Recarga la página y revísala de nuevo.");
    const [current] = await tx.select({ status: quotations.status }).from(quotations).where(eq(quotations.id, quotation.id)).for("share");
    if (["WON", "LOST", "CANCELLED"].includes(current.status)) throw new AppError("CONFLICT", "La cotización ya está cerrada.");
    await tx.insert(quotationReviews).values({ quotationId: quotation.id, revisionId: revision.id, revisionVersion: revision.version, reviewerUserId: principal.userId, outcome: v.outcome, comment: v.comment ?? null });
    await auditIn(tx, principal, `QUOTATION.REVIEW_${v.outcome}`, quotation.id);
  });
}

export async function issueQuotation(principal: Principal, quotationId: unknown, versions: { quotation: unknown; revision: unknown; revisionId?: unknown }): Promise<{ folio: string; alreadyIssued: boolean }> {
  const quotationVersion = versionSchema.parse(versions.quotation);
  const revisionVersion = versionSchema.parse(versions.revision);
  return db.transaction(async (tx) => {
    const { quotation, revision } = await loadDraft(tx, principal, quotationId, versions.revisionId);
    if (quotation.version !== quotationVersion) throw new AppError("CONFLICT", "La cotización cambió mientras la editabas. Recarga la página e inténtalo de nuevo.");
    const [customer] = await tx.select({ status: customers.status }).from(customers).where(eq(customers.id, quotation.customerId)).for("share");
    if (customer.status !== "ACTIVE") throw new AppError("CONFLICT", "El cliente está inactivo.");
    // Bloquea la revisión: desde aquí nadie puede editar líneas ni cambiar su versión hasta el commit.
    await claim(tx, revision, revisionVersion);
    const items = await tx.select().from(quotationItems).where(eq(quotationItems.revisionId, revision.id));
    if (!items.length) throw new AppError("VALIDATION", "Agrega al menos una línea antes de emitir.");
    if (items.some((i) => fromDb(i.unitPrice) <= 0n)) throw new AppError("VALIDATION", "Hay líneas con precio cero; corrígelas antes de emitir.");
    if (!revision.concept || !revision.validUntil) throw new AppError("VALIDATION", "Completa concepto y vigencia antes de emitir.");
    if (revision.validUntil < todayCR()) throw new AppError("VALIDATION", "La vigencia ya venció; actualízala antes de emitir.");
    const [{ marginWarning }] = await tx.select({ marginWarning: systemSettings.marginWarningPercent }).from(systemSettings).limit(1);
    if (items.some((i) => fromDb(i.marginPercent) < fromDb(marginWarning))) {
      const [review] = await tx.select().from(quotationReviews).where(and(eq(quotationReviews.revisionId, revision.id), eq(quotationReviews.revisionVersion, revisionVersion))).orderBy(desc(quotationReviews.reviewedAt)).limit(1);
      if (review?.outcome !== "APPROVED") throw new AppError("FORBIDDEN", `Hay líneas con utilidad menor a ${Number(marginWarning)}%: un gerente debe aprobar la cotización antes de emitirla.`);
    }
    // Las cuentas de pago vigentes quedan congeladas con la revisión emitida.
    const accounts = await tx.select({ bank: paymentAccounts.bank, account: paymentAccounts.accountNumber, currency: paymentAccounts.currency }).from(paymentAccounts).where(eq(paymentAccounts.isActive, true)).orderBy(paymentAccounts.bank);
    await tx.update(quotationRevisions).set({ paymentSnapshot: accounts }).where(eq(quotationRevisions.id, revision.id));
    const [fresh] = await tx.select({ version: quotationRevisions.version }).from(quotationRevisions).where(eq(quotationRevisions.id, revision.id));
    const rows = await tx.execute<{ folio: string; already_issued: boolean }>(sql`SELECT folio, already_issued FROM issue_quotation_revision(${quotation.id}::uuid, ${revision.id}::uuid, ${quotationVersion}::int, ${fresh.version}::int, ${principal.userId}::uuid)`);
    await auditIn(tx, principal, "QUOTATION.ISSUE", quotation.id, { folio: rows[0].folio });
    return { folio: rows[0].folio, alreadyIssued: rows[0].already_issued };
  });
}

/** Cotización propia cargada con bloqueo `FOR NO KEY UPDATE`: nadie puede emitir, cerrar o crear revisiones hasta el commit. */
export async function lockOwnedQuotation(tx: Tx, principal: Principal, quotationId: unknown): Promise<QuotationRow> {
  const owned = await loadOwned(principal, quotationId, tx);
  const [locked] = await tx.select().from(quotations).where(eq(quotations.id, owned.id)).for("no key update");
  return locked;
}

/** Última revisión emitida (la que el cliente recibe), aunque exista un borrador posterior. */
export async function latestIssuedRevision(runner: Pick<Tx, "select">, quotationId: string): Promise<RevisionRow | undefined> {
  const [row] = await runner.select().from(quotationRevisions).where(and(eq(quotationRevisions.quotationId, quotationId), eq(quotationRevisions.state, "ISSUED"))).orderBy(desc(quotationRevisions.revisionNumber)).limit(1);
  return row;
}

/** Transiciones de estado posteriores a la emisión. La matriz vive aquí; la BD impide retroceder y mutar estados finales. */
const TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ["CANCELLED"],
  ISSUED: ["SENT", "WON", "LOST", "CANCELLED"],
  SENT: ["WON", "LOST", "CANCELLED"],
};

/** Núcleo de la transición: el llamador aporta la transacción y la cotización ya cargada (y bloqueada si hace falta). */
export async function transitionInTx(tx: Tx, principal: Principal, quotation: QuotationRow, to: z.infer<typeof statusSchema>, note: string | undefined, expectedVersion: number): Promise<void> {
  if (quotation.version !== expectedVersion) throw new AppError("CONFLICT", "La cotización cambió; recarga antes de continuar.");
  if (!TRANSITIONS[quotation.status]?.includes(to)) throw new AppError("CONFLICT", `No se puede pasar de ${quotation.status} a ${to}.`);
  const issued = await latestIssuedRevision(tx, quotation.id);
  if (to !== "CANCELLED" && !issued) throw new AppError("CONFLICT", "La cotización no tiene una revisión emitida.");
  const updated = await tx
    .update(quotations)
    .set({ status: to, ...(to === "WON" ? { soldRevisionId: issued!.id } : {}) })
    .where(and(eq(quotations.id, quotation.id), eq(quotations.version, quotation.version), eq(quotations.status, quotation.status)))
    .returning({ id: quotations.id });
  if (!updated.length) throw new AppError("CONFLICT", "La cotización cambió; recarga antes de continuar.");
  await tx.insert(quotationStatusHistory).values({ quotationId: quotation.id, revisionId: issued?.id ?? null, fromStatus: quotation.status, toStatus: to, changedByUserId: principal.userId, note });
  await auditIn(tx, principal, `QUOTATION.${to}`, quotation.id);
}

/** `expectedVersion` es la versión de la cotización que el usuario tenía en pantalla: evita cerrar o enviar sobre datos que ya cambiaron. */
export async function transitionQuotation(principal: Principal, quotationId: unknown, toInput: string, noteInput: string | undefined, expectedVersionInput: unknown): Promise<void> {
  const to = statusSchema.parse(toInput);
  const note = noteInput?.trim() || undefined;
  const expectedVersion = versionSchema.parse(expectedVersionInput);
  await db.transaction(async (tx) => {
    const quotation = await loadOwned(principal, quotationId, tx);
    await transitionInTx(tx, principal, quotation, to, note, expectedVersion);
  });
}

export async function closeQuotation(principal: Principal, quotationId: unknown, input: unknown): Promise<void> {
  const v = closeSchema.parse(input);
  await transitionQuotation(principal, quotationId, v.to, v.note, v.quotationVersion);
}

/** Crea la siguiente revisión (borrador) copiando líneas y re-tomando instantáneas actuales de cliente/vendedor. */
export async function createRevision(principal: Principal, quotationId: unknown, expectedVersionInput: unknown): Promise<void> {
  const expectedVersion = versionSchema.parse(expectedVersionInput);
  await db.transaction(async (tx) => {
    const quotation = await loadOwned(principal, quotationId, tx);
    if (quotation.version !== expectedVersion) throw new AppError("CONFLICT", "La cotización cambió; recarga antes de continuar.");
    if (!["ISSUED", "SENT"].includes(quotation.status)) throw new AppError("CONFLICT", "Sólo se puede revisar una cotización emitida o enviada.");
    // Compare-and-swap real sobre la cotización (avanza su versión).
    const bumped = await tx.update(quotations).set({ updatedAt: new Date() }).where(and(eq(quotations.id, quotation.id), eq(quotations.version, expectedVersion))).returning({ id: quotations.id });
    if (!bumped.length) throw new AppError("CONFLICT", "La cotización cambió; recarga antes de continuar.");
    const previous = await latestRevision(tx, quotation.id);
    if (previous.state !== "ISSUED") throw new AppError("CONFLICT", "Ya existe una revisión en borrador.");
    const [customer] = await tx.select().from(customers).where(eq(customers.id, quotation.customerId)).for("share");
    if (customer.status !== "ACTIVE") throw new AppError("CONFLICT", "El cliente está inactivo.");
    const [seller] = await tx.select().from(users).where(eq(users.id, principal.userId)).limit(1);
    const contact = await resolveContact(tx, quotation.customerId);
    const fx = await effectiveRate(tx);
    const [created] = await tx
      .insert(quotationRevisions)
      .values({
        quotationId: quotation.id,
        customerId: quotation.customerId,
        revisionNumber: previous.revisionNumber + 1,
        currency: previous.currency,
        exchangeRateId: fx.id,
        fxBuy: fx.buy_rate,
        fxSell: fx.sell_rate,
        fxRateDate: fx.rate_date,
        fxSource: fx.source,
        fxAppliedRate: fx.sell_rate,
        concept: previous.concept,
        pricingMode: previous.pricingMode,
        validUntil: previous.validUntil && previous.validUntil >= todayCR() ? previous.validUntil : null,
        notes: previous.notes,
        customerCabys: previous.customerCabys,
        ...customerSnapshot(customer, contact),
        sellerUserId: seller.id,
        sellerName: seller.name,
        sellerEmail: seller.email,
        sellerPhone: seller.phone,
        createdByUserId: principal.userId,
      })
      .returning();
    await tx.execute(sql`SELECT claim_quotation_revision(${created.id}::uuid, ${created.version}::int)`);
    const items = await tx.select().from(quotationItems).where(eq(quotationItems.revisionId, previous.id)).orderBy(quotationItems.lineNumber);
    for (const item of items) {
      const price = unitPrice({ cost: fromDb(item.unitCost), costCurrency: item.costCurrency, marginPercent: fromDb(item.marginPercent), marginAmount: item.marginAmount === null ? null : fromDb(item.marginAmount), currency: created.currency, fxRate: fromDb(fx.sell_rate) });
      if (price <= 0n) throw new AppError("VALIDATION", `La línea ${item.lineNumber} quedaría con precio cero con el tipo de cambio vigente.`);
      await tx.insert(quotationItems).values({
        quotationId: quotation.id,
        revisionId: created.id,
        lineNumber: item.lineNumber,
        catalogItemId: item.catalogItemId,
        providerId: item.providerId,
        providerNameSnapshot: item.providerNameSnapshot,
        itemName: item.itemName,
        itemDescription: item.itemDescription,
        unit: item.unit,
        quantity: item.quantity,
        unitCost: item.unitCost,
        costCurrency: item.costCurrency,
        marginPercent: item.marginPercent,
        marginMode: item.marginMode,
        marginAmount: item.marginAmount,
        unitPrice: toDb(price),
      });
    }
    await auditIn(tx, principal, "QUOTATION.REVISE", quotation.id);
  });
}

/** Descarta una revisión en borrador (N>1) de una cotización abierta; la última emitida vuelve a ser la vigente. */
export async function discardDraftRevision(principal: Principal, quotationId: unknown, revisionVersionInput: unknown, revisionId?: unknown): Promise<void> {
  const expected = versionSchema.parse(revisionVersionInput);
  await db.transaction(async (tx) => {
    const { quotation, revision } = await loadDraft(tx, principal, quotationId, revisionId);
    if (revision.revisionNumber <= 1) throw new AppError("CONFLICT", "El primer borrador no se descarta; cancela la cotización.");
    const [review] = await tx.select({ id: quotationReviews.id }).from(quotationReviews).where(eq(quotationReviews.revisionId, revision.id)).limit(1);
    if (review) throw new AppError("CONFLICT", "Esta revisión ya tiene revisiones gerenciales y no puede descartarse.");
    await claim(tx, revision, expected);
    await tx.delete(quotationItems).where(eq(quotationItems.revisionId, revision.id));
    await tx.delete(quotationRevisions).where(eq(quotationRevisions.id, revision.id));
    // Avanza el token de concurrencia de la cotización: ningún formulario anterior sobrevive al reemplazo del borrador.
    await tx.update(quotations).set({ updatedAt: new Date() }).where(eq(quotations.id, quotation.id));
    await auditIn(tx, principal, "QUOTATION.DISCARD_REVISION", quotation.id);
  });
}
