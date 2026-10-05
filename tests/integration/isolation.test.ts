import { beforeAll, describe, expect, it } from "vitest";
import { addContact, createCustomer, listCustomerQuotations, getCustomer, listCustomers, reassignCustomer, setCustomerActive, updateCustomer } from "@/lib/customers/service";
import { addItem, closeQuotation, createQuotation, createRevision, getQuotationDetail, issueQuotation, listQuotations, removeItem, reviewQuotation, updateHeader, updateItem } from "@/lib/quotations/service";
import { listCatalog, listCosts, listProviders, recordCost } from "@/lib/catalog/service";
import { createCompany, recordRate } from "@/lib/admin/service";
import { getQuotationPdf } from "@/lib/quotations/delivery";
import type { Principal } from "@/lib/rbac";
import { createUser, customerInput, ensureRate, headerInput, itemInput } from "./helpers";

let a: Principal, b: Principal, manager: Principal, admin: Principal;
let customerA: string, quotationA: string;

beforeAll(async () => {
  [a, b, manager, admin] = await Promise.all([createUser("SELLER"), createUser("SELLER"), createUser("COMMERCIAL_MANAGER"), createUser("ADMIN")]);
  await ensureRate();
  customerA = (await createCustomer(a, customerInput("Cliente de A"))).id;
  quotationA = (await createQuotation(a, customerA, headerInput())).id;
  const detail = await getQuotationDetail(a, quotationA);
  await addItem(a, quotationA, detail.revision.version, itemInput());
});

const notFound = { code: "NOT_FOUND" };

describe("aislamiento entre vendedores (servidor)", () => {
  it("B no ve ni lista los clientes de A", async () => {
    await expect(getCustomer(b, customerA)).rejects.toMatchObject(notFound);
    const mine = await listCustomers(b, { status: "ALL" });
    expect(mine.find((c) => c.id === customerA)).toBeUndefined();
    expect((await listCustomers(a, { status: "ALL" })).some((c) => c.id === customerA)).toBe(true);
  });
  it("B no puede editar, desactivar, agregar contactos ni reasignar clientes de A", async () => {
    await expect(updateCustomer(b, customerA, 1, customerInput())).rejects.toMatchObject(notFound);
    await expect(setCustomerActive(b, customerA, 1, false)).rejects.toMatchObject(notFound);
    await expect(addContact(b, customerA, { fullName: "Intruso" })).rejects.toMatchObject(notFound);
    await expect(reassignCustomer(b, customerA, b.userId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("B no puede cotizar a un cliente de A", async () => {
    await expect(createQuotation(b, customerA, headerInput())).rejects.toMatchObject(notFound);
  });
  it("B no ve, edita, emite, cierra, revisa ni descarga cotizaciones de A", async () => {
    expect((await listQuotations(b, {})).some((q) => q.id === quotationA)).toBe(false);
    await expect(getQuotationDetail(b, quotationA)).rejects.toMatchObject(notFound);
    await expect(updateHeader(b, quotationA, 1, headerInput())).rejects.toMatchObject(notFound);
    await expect(addItem(b, quotationA, 1, itemInput())).rejects.toMatchObject(notFound);
    await expect(updateItem(b, quotationA, 1, "00000000-0000-4000-8000-000000000001", itemInput())).rejects.toMatchObject(notFound);
    await expect(removeItem(b, quotationA, 1, "00000000-0000-4000-8000-000000000001")).rejects.toMatchObject(notFound);
    await expect(issueQuotation(b, quotationA, { quotation: 1, revision: 1 })).rejects.toMatchObject(notFound);
    await expect(closeQuotation(b, quotationA, { to: "CANCELLED", quotationVersion: 1 })).rejects.toMatchObject(notFound);
    await expect(createRevision(b, quotationA, 1)).rejects.toMatchObject(notFound);
    await expect(reviewQuotation(b, quotationA, { outcome: "APPROVED", revisionId: "00000000-0000-4000-8000-000000000001", revisionVersion: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getQuotationPdf(b, quotationA)).rejects.toMatchObject(notFound);
  });
  it("IDs inválidos o inexistentes no revelan nada", async () => {
    await expect(getCustomer(a, "no-es-uuid")).rejects.toMatchObject(notFound);
    await expect(getQuotationDetail(a, "00000000-0000-4000-8000-0000000000aa")).rejects.toMatchObject(notFound);
  });
  it("los costos internos son privados por vendedor", async () => {
    expect(await listCosts(b)).toHaveLength(0);
    await expect(recordCost(b, { providerId: "00000000-0000-4000-8000-000000000001", itemName: "x", unitCost: "1", currency: "CRC" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("permisos por rol", () => {
  it("el gerente ve todo pero no modifica", async () => {
    expect((await listQuotations(manager, {})).some((q) => q.id === quotationA)).toBe(true);
    expect((await getQuotationDetail(manager, quotationA)).isOwner).toBe(false);
    await expect(addItem(manager, quotationA, 1, itemInput())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createQuotation(manager, customerA, headerInput())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateCustomer(manager, customerA, 1, customerInput())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("el vendedor no administra configuración ni empresas", async () => {
    await expect(recordRate(a, { rateDate: "2026-01-01", buy: "500", sell: "510" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createCompany(a, { name: "X" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createCompany(manager, { name: "X" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("el administrador sin 2FA no obtiene acceso administrativo", async () => {
    const weakAdmin = { ...admin, twoFactorEnabled: false };
    await expect(listCustomers(weakAdmin, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createCompany(weakAdmin, { name: "Y" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("un cliente reasignado no expone cotizaciones del vendedor anterior", async () => {
    const c = (await createCustomer(a, customerInput())).id;
    const q = (await createQuotation(a, c, headerInput())).id;
    await closeQuotation(a, q, { to: "CANCELLED", quotationVersion: (await getQuotationDetail(a, q)).quotation.version });
    await reassignCustomer(admin, c, b.userId);
    expect(await listCustomerQuotations(b, c)).toHaveLength(0);
    expect(await listCustomerQuotations(admin, c)).toHaveLength(1);
  });
  it("catálogo y proveedores: el administrador sin 2FA no ve colas de revisión", async () => {
    const weakAdmin = { ...admin, twoFactorEnabled: false };
    await expect(listCatalog(weakAdmin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listProviders(weakAdmin)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("el administrador ve todo y puede reasignar clientes sin cotizaciones abiertas", async () => {
    expect((await listCustomers(admin, {status: "ALL"})).some((c) => c.id === customerA)).toBe(true);
    const spare = (await createCustomer(a, customerInput())).id;
    await reassignCustomer(admin, spare, b.userId);
    expect((await getCustomer(b, spare)).ownerUserId).toBe(b.userId);
    await expect(getCustomer(a, spare)).rejects.toMatchObject(notFound);
    await expect(reassignCustomer(admin, customerA, b.userId)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("un vendedor no puede asignarse un dueño distinto al crear clientes (mass assignment)", async () => {
    const created = await createCustomer(a, { ...customerInput(), ownerUserId: b.userId, createdByUserId: b.userId }, b.userId);
    expect((await getCustomer(a, created.id)).ownerUserId).toBe(a.userId);
  });
});
