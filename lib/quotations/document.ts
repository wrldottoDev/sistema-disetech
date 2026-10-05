import { eq } from "drizzle-orm";
import { db } from "@/db";
import { paymentAccounts } from "@/db/schema";
import type { Principal } from "@/lib/rbac";
import { type Currency, convert, formatMoney, fromDb, lineAmounts, round } from "@/lib/money";
import type { ClientDocument } from "@/lib/quotations/client-document";
import { getQuotationDetail, todayCR } from "@/lib/quotations/service";

export const FOOTER_NOTE = "A nombre de Disetech. Enviar el comprobante de pago junto con la orden de compra.";

const dmy = (iso: string) => iso.split("-").reverse().join("/");

/** Convierte datos internos en el documento del cliente. Aquí se descartan costo, utilidad y proveedor. */
export async function buildClientDocument(principal: Principal, quotationId: unknown, revisionNumber?: number) {
  const detail = await getQuotationDetail(principal, quotationId, revisionNumber);
  const { quotation, revision, items } = detail;
  // Una revisión emitida usa las cuentas congeladas al emitir; el borrador muestra las vigentes.
  // Una emitida SIN instantánea (anterior a esta función) no muestra cuentas vigentes: sería cambiar un documento histórico.
  const frozen = revision.state === "ISSUED" ? ((revision.paymentSnapshot as { bank: string; account: string; currency: string }[] | null) ?? []) : null;
  const accounts = frozen ?? (await db.select({ bank: paymentAccounts.bank, account: paymentAccounts.accountNumber, currency: paymentAccounts.currency }).from(paymentAccounts).where(eq(paymentAccounts.isActive, true)).orderBy(paymentAccounts.bank));
  const taxRate = 13n * 1_000_000n;
  let subtotal = 0n;
  let tax = 0n;
  const itemLines = items.map((item) => {
    const amounts = lineAmounts(fromDb(item.quantity), fromDb(item.unitPrice), fromDb(item.taxPercent));
    // El documento impreso suma los importes ya redondeados de cada línea para que cuadre a simple vista.
    const lineSubtotal = round(amounts.subtotal);
    const lineTax = round(amounts.tax);
    subtotal += lineSubtotal;
    tax += lineTax;
    return {
      name: item.itemName,
      description: item.itemDescription ?? undefined,
      unit: item.unit ?? undefined,
      quantity: formatMoney(fromDb(item.quantity)),
      unitPrice: formatMoney(fromDb(item.unitPrice)),
      subtotal: formatMoney(lineSubtotal),
      taxPercent: `${(Number(item.taxPercent)).toFixed(1)}%`,
      total: formatMoney(lineSubtotal + lineTax),
    };
  });
  const total = subtotal + tax;
  // Paquete: el cliente ve una sola línea con el total; los productos se listan sin precios.
  const lines = revision.pricingMode === "PACKAGE"
    ? [{
        name: `Paquete: ${revision.concept ?? ""}`.trim(),
        description: items.map((i) => `${formatMoney(fromDb(i.quantity))} ${i.unit ?? ""} ${i.itemName}`.replace(/\s+/g, " ")).join("; "),
        quantity: "1.00",
        unitPrice: "—",
        subtotal: "—",
        taxPercent: `${Number(items[0]?.taxPercent ?? 13).toFixed(1)}%`,
        total: formatMoney(total),
      }]
    : itemLines;
  const currency = revision.currency as Currency;
  const rate = fromDb((revision.fxAppliedRate ?? "1") as string);
  const issueDate = revision.issuedAt ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica" }).format(revision.issuedAt) : todayCR();
  const document: ClientDocument = {
    folio: quotation.folio,
    isDraft: revision.state === "DRAFT",
    date: dmy(issueDate),
    validUntil: revision.validUntil ? dmy(revision.validUntil) : "",
    customerName: revision.customerName,
    contact: revision.customerContactPhone ?? revision.customerContactName ?? "",
    cabys: revision.customerCabys ?? "",
    sellerName: revision.sellerName,
    concept: revision.concept ?? "",
    currency,
    exchangeRate: Number(revision.fxAppliedRate ?? 0).toFixed(4),
    lines,
    totals: { subtotal: formatMoney(subtotal), taxPercent: `${Number(taxRate / 1_000_000n).toFixed(1)}%`, tax: formatMoney(tax), total: formatMoney(total) },
    equivalence: { crc: `₡${formatMoney(convert(total, currency, "CRC", rate))}`, usd: `$${formatMoney(convert(total, currency, "USD", rate))}` },
    notes: revision.notes ?? "",
    paymentAccounts: accounts.map((a) => ({ bank: a.bank, account: a.account, currency: a.currency })),
    footerNote: FOOTER_NOTE,
  };
  return { document, quotation, revision };
}
