import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { quotationItems, quotations } from "@/db/schema";
import { createCustomer } from "@/lib/customers/service";
import { sendQuotationEmail } from "@/lib/quotations/delivery";
import { buildClientDocument } from "@/lib/quotations/document";
import { addItem, closeQuotation, listQuotations, createQuotation, createRevision, discardDraftRevision, getQuotationDetail, issueQuotation, reviewQuotation, transitionQuotation, updateHeader } from "@/lib/quotations/service";
import { getTestOutbox } from "@/lib/email";
import type { Principal } from "@/lib/rbac";
import { createUser, customerInput, ensureRate, headerInput, itemInput } from "./helpers";

let seller: Principal, manager: Principal, customerId: string;

beforeAll(async () => {
  [seller, manager] = await Promise.all([createUser("SELLER"), createUser("COMMERCIAL_MANAGER")]);
  await ensureRate();
  customerId = (await createCustomer(seller, customerInput())).id;
});

async function draft(extra: Record<string, unknown> = {}) {
  const { id } = await createQuotation(seller, customerId, headerInput(extra));
  return id;
}
const rev = async (id: string) => (await getQuotationDetail(seller, id)).revision;
const qv = async (id: string) => (await getQuotationDetail(seller, id)).quotation.version;
const closeBody = async (id: string, to: string) => ({ to, quotationVersion: await qv(id) });
const review = async (id: string, outcome: string, comment?: string) => {
  const r = await rev(id);
  return reviewQuotation(manager, id, { outcome, comment, revisionId: r.id, revisionVersion: r.version });
};
const send = async (id: string, to: string, message = "") => {
  const d = await getQuotationDetail(seller, id);
  return sendQuotationEmail(seller, id, { to, message, revisionId: d.revisions.find((x) => x.state === "ISSUED")?.id, quotationVersion: d.quotation.version });
};

describe("cálculos", () => {
  it("precio = costo + utilidad; IVA 13%; totales exactos", async () => {
    const id = await draft();
    await addItem(seller, id, (await rev(id)).version, itemInput({ quantity: "5", unitCost: "10000", marginPercent: "30" }));
    const d = await getQuotationDetail(seller, id);
    expect(d.items[0].unitPrice).toBe("13000.000000");
    const { document } = await buildClientDocument(seller, id);
    expect(document.lines[0]).toMatchObject({ quantity: "5.00", unitPrice: "13,000.00", subtotal: "65,000.00", taxPercent: "13.0%", total: "73,450.00" });
    expect(document.totals).toMatchObject({ subtotal: "65,000.00", tax: "8,450.00", total: "73,450.00" });
    expect(document.equivalence.usd).toBe("$158.88");
  });
  it("convierte costos en USD usando el tipo de cambio de venta", async () => {
    const id = await draft();
    await addItem(seller, id, (await rev(id)).version, itemInput({ quantity: "1", unitCost: "10", costCurrency: "USD", marginPercent: "20" }));
    expect((await getQuotationDetail(seller, id)).items[0].unitPrice).toBe("5547.480000");
  });
  it("cambiar la moneda recalcula los precios", async () => {
    const id = await draft();
    await addItem(seller, id, (await rev(id)).version, itemInput({ quantity: "1", unitCost: "462.29", marginPercent: "100", costCurrency: "CRC" }));
    await updateHeader(seller, id, (await rev(id)).version, headerInput({ currency: "USD" }));
    expect((await getQuotationDetail(seller, id)).items[0].unitPrice).toBe("2.000000");
  });
  it("utilidad por monto fijo: precio = costo + monto y sobrevive al cambio de moneda", async () => {
    const id = await draft();
    await addItem(seller, id, (await rev(id)).version, itemInput({ quantity: "2", unitCost: "10000", marginMode: "AMOUNT", marginAmount: "3500" }));
    const [item] = (await getQuotationDetail(seller, id)).items;
    expect(item).toMatchObject({ unitPrice: "13500.000000", marginMode: "AMOUNT", marginAmount: "3500.000000" });
    await updateHeader(seller, id, (await rev(id)).version, headerInput({ currency: "USD" }));
    expect((await getQuotationDetail(seller, id)).items[0].unitPrice).toBe("29.200000");
    await expect(addItem(seller, id, (await rev(id)).version, itemInput({ unitCost: "100", marginMode: "AMOUNT", marginAmount: "101" }))).rejects.toBeDefined();
  });
  it("paquete: el cliente ve una sola línea con el total y sin precios por producto", async () => {
    const id = await draft({ pricingMode: "PACKAGE" });
    await addItem(seller, id, (await rev(id)).version, itemInput({ itemName: "Cámara", quantity: "2", unitCost: "10000", marginPercent: "30" }));
    await addItem(seller, id, (await rev(id)).version, itemInput({ itemName: "DVR", quantity: "1", unitCost: "20000", marginPercent: "50" }));
    const { document } = await buildClientDocument(seller, id);
    expect(document.lines).toHaveLength(1);
    expect(document.lines[0]).toMatchObject({ unitPrice: "—", taxPercent: "13.0%", total: "63,280.00" });
    expect(document.lines[0].description).toMatch(/Cámara.*DVR/);
    expect(document.totals).toMatchObject({ subtotal: "56,000.00", tax: "7,280.00", total: "63,280.00" });
    expect(JSON.stringify(document)).not.toMatch(/13,000|30,000/);
  });
  it("el documento del cliente no contiene costo, utilidad ni proveedor", async () => {
    const id = await draft();
    await addItem(seller, id, (await rev(id)).version, itemInput({ unitCost: "7777", marginPercent: "41.5" }));
    const { document } = await buildClientDocument(seller, id);
    const text = JSON.stringify(document);
    expect(text).not.toMatch(/7777|7,777|41\.5|unitCost|margin|provider/i);
  });
});

describe("validaciones del servidor", () => {
  it.each([
    ["cantidad cero", { quantity: "0" }], ["cantidad negativa", { quantity: "-1" }], ["cantidad con 3 decimales", { quantity: "1.005" }], ["cantidad texto", { quantity: "abc" }],
    ["costo cero", { unitCost: "0" }], ["costo negativo", { unitCost: "-5" }], ["utilidad cero", { marginPercent: "0" }], ["utilidad > 100", { marginPercent: "100.01" }], ["utilidad negativa", { marginPercent: "-1" }],
    ["notación científica", { unitCost: "1e3" }], ["sin descripción", { itemName: "" }], ["proveedor inexistente", { providerId: "00000000-0000-4000-8000-000000000009" }], ["catálogo inexistente", { catalogItemId: "00000000-0000-4000-8000-000000000009" }],
  ])("rechaza %s", async (_label, bad) => {
    const id = await draft();
    await expect(addItem(seller, id, (await rev(id)).version, itemInput(bad))).rejects.toBeDefined();
    expect((await getQuotationDetail(seller, id)).items).toHaveLength(0);
  });
  it("rechaza encabezados inválidos", async () => {
    await expect(createQuotation(seller, customerId, headerInput({ currency: "EUR" }))).rejects.toBeDefined();
    await expect(createQuotation(seller, customerId, headerInput({ validUntil: "2020-01-01" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createQuotation(seller, customerId, headerInput({ validUntil: "2026-02-31" }))).rejects.toBeDefined();
    await expect(createQuotation(seller, customerId, headerInput({ concept: " " }))).rejects.toBeDefined();
    await expect(createQuotation(seller, "00000000-0000-4000-8000-0000000000bb", headerInput())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("detecta ediciones con versión obsoleta", async () => {
    const id = await draft();
    const stale = (await rev(id)).version;
    await addItem(seller, id, stale, itemInput());
    await expect(addItem(seller, id, stale, itemInput())).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("no se puede emitir sin líneas", async () => {
    const id = await draft();
    const d = await getQuotationDetail(seller, id);
    await expect(issueQuotation(seller, id, { quotation: d.quotation.version, revision: d.revision.version })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

async function issued() {
  const id = await draft();
  await addItem(seller, id, (await rev(id)).version, itemInput());
  const d = await getQuotationDetail(seller, id);
  const result = await issueQuotation(seller, id, { quotation: d.quotation.version, revision: d.revision.version });
  return { id, ...result };
}

describe("emisión, folio y workflow", () => {
  it("asigna folio COT-AAAA-NNN y congela la revisión", async () => {
    const { id, folio, alreadyIssued } = await issued();
    expect(folio).toMatch(/^COT-\d{4}-\d{3,}$/);
    expect(alreadyIssued).toBe(false);
    const d = await getQuotationDetail(seller, id);
    expect(d.quotation.status).toBe("ISSUED");
    expect(d.revision.total).not.toBeNull();
    await expect(addItem(seller, id, d.revision.version, itemInput())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(updateHeader(seller, id, d.revision.version, headerInput())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(db.update(quotationItems).set({ quantity: "99" }).where(eq(quotationItems.quotationId, id))).rejects.toBeDefined();
  });
  it("emisiones concurrentes nunca duplican folio", async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, async () => {
      const id = await draft();
      await addItem(seller, id, (await rev(id)).version, itemInput());
      return id;
    }));
    const results = await Promise.all(ids.map(async (id) => {
      const d = await getQuotationDetail(seller, id);
      return issueQuotation(seller, id, { quotation: d.quotation.version, revision: d.revision.version });
    }));
    const folios = results.map((r) => r.folio);
    expect(new Set(folios).size).toBe(folios.length);
  });
  it("emitir dos veces la misma cotización es idempotente en BD", async () => {
    const { id, folio } = await issued();
    const rows = await db.execute<{ folio: string; already_issued: boolean }>(sql`SELECT * FROM issue_quotation_revision(${id}::uuid, (SELECT id FROM quotation_revisions WHERE quotation_id = ${id}::uuid LIMIT 1), 1, 1, ${seller.userId}::uuid)`);
    expect(rows[0]).toMatchObject({ folio, already_issued: true });
  });
  it("transiciones válidas e inválidas", async () => {
    const { id } = await issued();
    await expect(transitionQuotation(seller, id, "ISSUED", undefined, await qv(id))).rejects.toBeDefined();
    await transitionQuotation(seller, id, "SENT", "prueba", await qv(id));
    await expect(transitionQuotation(seller, id, "SENT", undefined, await qv(id))).rejects.toMatchObject({ code: "CONFLICT" });
    await closeQuotation(seller, id, await closeBody(id, "WON"));
    const d = await getQuotationDetail(seller, id);
    expect(d.quotation.status).toBe("WON");
    expect(d.quotation.soldRevisionId).toBe(d.revision.id);
    await expect(closeQuotation(seller, id, await closeBody(id, "LOST"))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createRevision(seller, id, await qv(id))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(db.update(quotations).set({ status: "ISSUED" }).where(eq(quotations.id, id))).rejects.toBeDefined();
  });
  it("un borrador puede cancelarse sin folio", async () => {
    const id = await draft();
    await closeQuotation(seller, id, await closeBody(id, "CANCELLED"));
    const d = await getQuotationDetail(seller, id);
    expect(d.quotation.status).toBe("CANCELLED");
    expect(d.quotation.folio).toBeNull();
  });
  it("crea una nueva revisión copiando líneas y reemite con el mismo folio", async () => {
    const { id, folio } = await issued();
    await createRevision(seller, id, await qv(id));
    await expect(createRevision(seller, id, await qv(id))).rejects.toMatchObject({ code: "CONFLICT" });
    const d = await getQuotationDetail(seller, id);
    expect(d.revision.revisionNumber).toBe(2);
    expect(d.items).toHaveLength(1);
    const again = await issueQuotation(seller, id, { quotation: d.quotation.version, revision: d.revision.version });
    expect(again.folio).toBe(folio);
    expect((await getQuotationDetail(seller, id)).revisions).toHaveLength(2);
  });
  it("utilidad baja exige aprobación gerencial de la versión exacta", async () => {
    const id = await draft();
    await addItem(seller, id, (await rev(id)).version, itemInput({ marginPercent: "10" }));
    let d = await getQuotationDetail(seller, id);
    await expect(issueQuotation(seller, id, { quotation: d.quotation.version, revision: d.revision.version })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(review(id, "REJECTED")).rejects.toMatchObject({ code: "VALIDATION" });
    await review(id, "APPROVED");
    d = await getQuotationDetail(seller, id);
    expect(d.approved).toBe(true);
    await addItem(seller, id, d.revision.version, itemInput({ marginPercent: "10" }));
    d = await getQuotationDetail(seller, id);
    expect(d.approved).toBe(false);
    await expect(issueQuotation(seller, id, { quotation: d.quotation.version, revision: d.revision.version })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await review(id, "APPROVED");
    await expect(issueQuotation(seller, id, { quotation: d.quotation.version, revision: d.revision.version })).resolves.toBeDefined();
  });
});

describe("correo", () => {
  it("envía el PDF adjunto y marca ENVIADA sólo si el envío funcionó", async () => {
    const { id, folio } = await issued();
    await expect(send(id, "no-es-correo")).rejects.toBeDefined();
    expect((await getQuotationDetail(seller, id)).quotation.status).toBe("ISSUED");
    const result = await send(id, "cliente@example.test", "Gracias");
    expect(result.statusUpdated).toBe(true);
    expect((await getQuotationDetail(seller, id)).quotation.status).toBe("SENT");
    const mail = getTestOutbox().at(-1);
    expect(mail?.subject).toContain(folio);
    expect(mail?.attachments?.[0].content.subarray(0, 4).toString()).toBe("%PDF");
    expect(mail?.text).not.toMatch(/costo|utilidad|proveedor/i);
  });
  it("no permite enviar un borrador", async () => {
    const id = await draft();
    await expect(sendQuotationEmail(seller, id, { to: "cliente@example.test", message: "", revisionId: (await rev(id)).id, quotationVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("regresiones de la auditoría (concurrencia y formularios viejos)", () => {
  it("una revisión gerencial de una versión vieja se rechaza", async () => {
    const id = await draft();
    await addItem(seller, id, (await rev(id)).version, itemInput({ marginPercent: "10" }));
    const old = await rev(id);
    await addItem(seller, id, old.version, itemInput({ marginPercent: "10" }));
    await expect(reviewQuotation(manager, id, { outcome: "APPROVED", revisionId: old.id, revisionVersion: old.version })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("cerrar o enviar con una versión vieja de la cotización falla y no cambia nada", async () => {
    const { id } = await issued();
    const stale = await qv(id);
    await transitionQuotation(seller, id, "SENT", "x", stale);
    await expect(closeQuotation(seller, id, { to: "WON", quotationVersion: stale })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getQuotationDetail(seller, id)).quotation.status).toBe("SENT");
    const d = await getQuotationDetail(seller, id);
    await expect(sendQuotationEmail(seller, id, { to: "c@example.test", message: "", revisionId: d.revision.id, quotationVersion: stale })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("emitir con una versión de revisión vieja falla", async () => {
    const id = await draft();
    await addItem(seller, id, (await rev(id)).version, itemInput());
    const before = await getQuotationDetail(seller, id);
    await addItem(seller, id, before.revision.version, itemInput());
    await expect(issueQuotation(seller, id, { quotation: before.quotation.version, revision: before.revision.version })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("cambiar de moneda no puede dejar líneas con precio cero", async () => {
    const id = await draft();
    await addItem(seller, id, (await rev(id)).version, itemInput({ quantity: "1", unitCost: "0.004", marginPercent: "25" }));
    await expect(updateHeader(seller, id, (await rev(id)).version, headerInput({ currency: "USD" }))).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await getQuotationDetail(seller, id)).revision.currency).toBe("CRC");
  });
  it("las cuentas de pago se congelan al emitir", async () => {
    await db.execute(sql`INSERT INTO payment_accounts (bank, account_number, currency) VALUES ('Banco Prueba', 'CR0000000000000001', 'CRC')`);
    const { id } = await issued();
    await db.execute(sql`UPDATE payment_accounts SET is_active = false`);
    const { document } = await buildClientDocument(seller, id);
    expect(document.paymentAccounts.map((a) => a.bank)).toContain("Banco Prueba");
  });
  it("una revisión en borrador se descarta y la cotización sigue abierta", async () => {
    const { id } = await issued();
    await createRevision(seller, id, await qv(id));
    const draftRev = await rev(id);
    await discardDraftRevision(seller, id, draftRev.version);
    const d = await getQuotationDetail(seller, id);
    expect(d.revisions).toHaveLength(1);
    expect(d.quotation.status).toBe("ISSUED");
    await expect(discardDraftRevision(seller, id, d.revision.version)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("un formulario de un borrador descartado no puede modificar el borrador de reemplazo", async () => {
    const { id } = await issued();
    await createRevision(seller, id, await qv(id));
    const first = await rev(id);
    await discardDraftRevision(seller, id, first.version, first.id);
    await createRevision(seller, id, await qv(id));
    const second = await rev(id);
    expect(second.id).not.toBe(first.id);
    await expect(addItem(seller, id, second.version, itemInput(), first.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(discardDraftRevision(seller, id, second.version, first.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(updateHeader(seller, id, second.version, headerInput(), { revisionId: first.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("una cotización ganada muestra la revisión vendida aunque exista un borrador posterior", async () => {
    const { id } = await issued();
    await createRevision(seller, id, await qv(id));
    const draftRev = await rev(id);
    await addItem(seller, id, draftRev.version, itemInput({ unitCost: "99999" }), draftRev.id);
    await closeQuotation(seller, id, await closeBody(id, "WON"));
    const d = await getQuotationDetail(seller, id);
    expect(d.revision.state).toBe("ISSUED");
    expect(d.revision.id).toBe(d.quotation.soldRevisionId);
    const row = (await listQuotations(seller, {})).find((q) => q.id === id);
    expect(Number(row?.total)).toBeLessThan(100000);
  });
});
