"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/app/actions/users";
import { createCompany, createPaymentAccount, recordRate, setCompanyActive, setMarginWarning, setPaymentAccountActive } from "@/lib/admin/service";
import { requirePrincipal } from "@/lib/authorization";
import { mergeCatalogItem, mergeProvider, proposeCatalogItem, proposeProvider, recordCost, reviewCatalogItem, reviewProvider } from "@/lib/catalog/service";
import { addContact, createCustomer, reassignCustomer, setCustomerActive, updateCustomer } from "@/lib/customers/service";
import { safeError } from "@/lib/errors";
import { sendQuotationEmail } from "@/lib/quotations/delivery";
import { addItem, closeQuotation, createQuotation, createRevision, discardDraftRevision, issueQuotation, removeItem, reviewQuotation, transitionQuotation, updateHeader, updateItem } from "@/lib/quotations/service";
import { setSellerCompany } from "@/lib/users/service";

const ok = (message: string): ActionState => ({ ok: true, message });
const fail = (error: unknown): ActionState => ({ ok: false, message: safeError(error) });
const fields = (form: FormData) => Object.fromEntries(form.entries());

/** Ejecuta una mutación y devuelve el mensaje; redirige (fuera de try/catch) cuando hay destino. */
async function run(form: FormData, paths: string[], work: (principal: Awaited<ReturnType<typeof requirePrincipal>>, data: Record<string, FormDataEntryValue>) => Promise<string | { redirectTo: string }>): Promise<ActionState> {
  let result: string | { redirectTo: string };
  try {
    result = await work(await requirePrincipal(), fields(form));
  } catch (error) {
    return fail(error);
  }
  for (const path of paths) revalidatePath(path);
  if (typeof result !== "string") redirect(result.redirectTo);
  return ok(result);
}

// ---------------------------------------------------------------- clientes
export async function createCustomerAction(_: ActionState, form: FormData) {
  return run(form, ["/clientes"], async (p, d) => ({ redirectTo: `/clientes/${(await createCustomer(p, d, d.ownerUserId)).id}` }));
}
export async function updateCustomerAction(_: ActionState, form: FormData) {
  return run(form, ["/clientes"], async (p, d) => (await updateCustomer(p, d.customerId, d.version, d), "Cliente actualizado."));
}
export async function toggleCustomerAction(_: ActionState, form: FormData) {
  return run(form, ["/clientes"], async (p, d) => (await setCustomerActive(p, d.customerId, d.version, d.active === "true"), d.active === "true" ? "Cliente reactivado." : "Cliente desactivado."));
}
export async function addContactAction(_: ActionState, form: FormData) {
  return run(form, ["/clientes"], async (p, d) => (await addContact(p, d.customerId, d), "Contacto agregado."));
}
export async function reassignCustomerAction(_: ActionState, form: FormData) {
  return run(form, ["/clientes"], async (p, d) => (await reassignCustomer(p, d.customerId, d.ownerUserId), "Cliente reasignado."));
}

// ---------------------------------------------------------------- cotizaciones
export async function createQuotationAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones", "/panel"], async (p, d) => ({ redirectTo: `/cotizaciones/${(await createQuotation(p, d.customerId, d)).id}` }));
}
export async function updateHeaderAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones"], async (p, d) => (await updateHeader(p, d.quotationId, d.revisionVersion, d, { refreshRate: d.refreshRate === "on", revisionId: d.revisionId }), "Datos generales guardados."));
}
export async function addItemAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones"], async (p, d) => (await addItem(p, d.quotationId, d.revisionVersion, d, d.revisionId), "Línea agregada."));
}
export async function updateItemAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones"], async (p, d) => (await updateItem(p, d.quotationId, d.revisionVersion, d.itemId, d, d.revisionId), "Línea actualizada."));
}
export async function removeItemAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones"], async (p, d) => (await removeItem(p, d.quotationId, d.revisionVersion, d.itemId, d.revisionId), "Línea eliminada."));
}
export async function issueQuotationAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones", "/panel"], async (p, d) => `Cotización emitida: ${(await issueQuotation(p, d.quotationId, { quotation: d.quotationVersion, revision: d.revisionVersion, revisionId: d.revisionId })).folio}.`);
}
export async function reviewQuotationAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones"], async (p, d) => (await reviewQuotation(p, d.quotationId, d), "Revisión registrada."));
}
export async function closeQuotationAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones", "/panel"], async (p, d) => (await closeQuotation(p, d.quotationId, d), "Estado actualizado."));
}
export async function markSentAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones", "/panel"], async (p, d) => (await transitionQuotation(p, d.quotationId, "SENT", "Marcada como enviada manualmente", d.quotationVersion), "Marcada como enviada."));
}
export async function reviseQuotationAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones"], async (p, d) => (await createRevision(p, d.quotationId, d.quotationVersion), "Nueva revisión creada en borrador."));
}
export async function discardRevisionAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones"], async (p, d) => (await discardDraftRevision(p, d.quotationId, d.revisionVersion, d.revisionId), "Revisión descartada."));
}
export async function sendQuotationAction(_: ActionState, form: FormData) {
  return run(form, ["/cotizaciones", "/panel"], async (p, d) => ((await sendQuotationEmail(p, d.quotationId, { to: d.to, message: d.message, revisionId: d.revisionId, quotationVersion: d.quotationVersion })), "Correo enviado con el PDF adjunto."));
}

// ---------------------------------------------------------------- catálogo, proveedores, costos
export async function proposeCatalogAction(_: ActionState, form: FormData) {
  return run(form, ["/catalogo"], async (p, d) => (await proposeCatalogItem(p, d), "Producto enviado a revisión."));
}
export async function reviewCatalogAction(_: ActionState, form: FormData) {
  return run(form, ["/catalogo"], async (p, d) => (await reviewCatalogItem(p, d.itemId, d.decision), "Producto revisado."));
}
export async function mergeCatalogAction(_: ActionState, form: FormData) {
  return run(form, ["/catalogo"], async (p, d) => (await mergeCatalogItem(p, d.itemId, d.targetId), "Producto fusionado."));
}
export async function mergeProviderAction(_: ActionState, form: FormData) {
  return run(form, ["/proveedores"], async (p, d) => (await mergeProvider(p, d.providerId, d.targetId), "Proveedor fusionado."));
}
export async function proposeProviderAction(_: ActionState, form: FormData) {
  return run(form, ["/proveedores"], async (p, d) => (await proposeProvider(p, d), "Proveedor enviado a revisión."));
}
export async function reviewProviderAction(_: ActionState, form: FormData) {
  return run(form, ["/proveedores"], async (p, d) => (await reviewProvider(p, d.providerId, d.decision), "Proveedor revisado."));
}
export async function recordCostAction(_: ActionState, form: FormData) {
  return run(form, ["/costos"], async (p, d) => (await recordCost(p, d), "Costo registrado."));
}

// ---------------------------------------------------------------- administración
export async function createCompanyAction(_: ActionState, form: FormData) {
  return run(form, ["/admin/empresas"], async (p, d) => (await createCompany(p, d), "Empresa creada."));
}
export async function toggleCompanyAction(_: ActionState, form: FormData) {
  return run(form, ["/admin/empresas"], async (p, d) => (await setCompanyActive(p, d.companyId, d.version, d.active === "true"), "Empresa actualizada."));
}
export async function setSellerCompanyAction(_: ActionState, form: FormData) {
  return run(form, ["/admin/usuarios"], async (p, d) => (await setSellerCompany(p, d.userId, d.companyId), "Empresa asignada."));
}
export async function createPaymentAccountAction(_: ActionState, form: FormData) {
  return run(form, ["/admin/configuracion"], async (p, d) => (await createPaymentAccount(p, d), "Cuenta agregada."));
}
export async function togglePaymentAccountAction(_: ActionState, form: FormData) {
  return run(form, ["/admin/configuracion"], async (p, d) => (await setPaymentAccountActive(p, d.accountId, d.active === "true"), "Cuenta actualizada."));
}
export async function recordRateAction(_: ActionState, form: FormData) {
  return run(form, ["/admin/configuracion", "/cotizaciones"], async (p, d) => (await recordRate(p, d), "Tipo de cambio registrado."));
}
export async function setMarginWarningAction(_: ActionState, form: FormData) {
  return run(form, ["/admin/configuracion"], async (p, d) => (await setMarginWarning(p, d.value, d.version), "Umbral actualizado."));
}
