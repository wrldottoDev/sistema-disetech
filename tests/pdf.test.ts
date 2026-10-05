import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderQuotationPdf } from "../lib/pdf/quotation-pdf.ts";
import type { ClientDocument } from "../lib/quotations/client-document.ts";

function fixture(count = 1): ClientDocument {
  return {
    folio: "COT-2026-015", isDraft: false, date: "02/10/2026", validUntil: "17/10/2026",
    customerName: "ElectrosolucionesCR", contact: "6070-6262", cabys: "", sellerName: "Angel Vega",
    concept: "Venta de material eléctrico", currency: "CRC", exchangeRate: "462.2900",
    lines: Array.from({ length: count }, (_, index) => ({
      name: count === 1 ? "ANGULO UL INTERNO BLANCO P/CANALETA 100x45 DXN11011 DEXSON" : `Producto ${index + 1}`,
      quantity: "5.00", unitPrice: "18,337.58", subtotal: "18,337.58", taxPercent: "13.0%", total: "20,721.46",
    })),
    totals: { subtotal: "18,337.58", taxPercent: "13.0%", tax: "2,383.88", total: "20,721.46" },
    equivalence: { crc: "₡20,721.46", usd: "$44.82" }, notes: "", paymentAccounts: [],
    footerNote: "A nombre de Disetech. Enviar el comprobante de pago junto con la orden de compra.",
  };
}

function pageCount(buffer: Buffer): number {
  return (buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
}
function validPdf(buffer: Buffer) {
  expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  expect(buffer.length).toBeGreaterThan(10_000);
  expect(buffer.length).toBeLessThan(5_000_000);
  expect(buffer.toString("latin1")).toContain("/MediaBox [0 0 841.89 595.28]");
}
const gsExists = spawnSync("gs", ["--version"], { stdio: "ignore" }).status === 0;
function extract(buffer: Buffer): string {
  const directory = mkdtempSync(join(tmpdir(), "disetech-pdf-"));
  try {
    const source = join(directory, "quotation.pdf");
    const output = join(directory, "quotation.txt");
    writeFileSync(source, buffer);
    execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", `-sOutputFile=${output}`, source], { stdio: "pipe" });
    return readFileSync(output, "utf8");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("quotation PDF", () => {
  it.each([1, 5])("renders %i lines on landscape A4", async count => {
    const buffer = await renderQuotationPdf(fixture(count));
    validPdf(buffer);
    expect(pageCount(buffer)).toBeGreaterThanOrEqual(1);
    if (count === 1) expect(pageCount(buffer)).toBe(1);
  });

  it("paginates 120 long descriptions and remains deterministic", async () => {
    const doc = fixture(120);
    doc.lines.forEach((line, index) => {
      line.name = `Material eléctrico ${index + 1}: canaleta y accesorios para instalación`;
      line.description = "Descripción técnica detallada con dimensiones, compatibilidad, acabado y características del material. ".repeat(3) + `FIN-${index + 1}`;
    });
    const buffer = await renderQuotationPdf(doc);
    validPdf(buffer);
    expect(pageCount(buffer)).toBeGreaterThan(1);
    expect(buffer.equals(await renderQuotationPdf(doc))).toBe(true);
    if (gsExists) {
      const text = extract(buffer);
      expect(text).toContain("FIN-120");
      expect((text.match(/PRECIO UNITARIO VENTA/g) ?? []).length).toBeGreaterThan(1);
      expect(text).toContain(`Página ${pageCount(buffer)} de ${pageCount(buffer)}`);
    }
  }, 30_000);

  it("supports more than 200 lines", async () => {
    const buffer = await renderQuotationPdf(fixture(205));
    validPdf(buffer);
    expect(pageCount(buffer)).toBeGreaterThan(1);
  }, 30_000);

  it("renders drafts and empty optional fields", async () => {
    const doc = fixture();
    Object.assign(doc, { folio: null, isDraft: true, contact: "", cabys: "", notes: "", paymentAccounts: [] });
    const buffer = await renderQuotationPdf(doc);
    validPdf(buffer);
    if (gsExists) {
      const text = extract(buffer);
      expect(text).toContain("BORRADOR");
      expect(text).toContain("NOTAS Y CONDICIONES");
      expect(text).toContain("N° DE CUENTA / IBAN");
    }
  });

  it("renders special characters and huge amounts, extracting client fields when gs exists", async () => {
    const doc = fixture();
    doc.concept = 'Instalación áéíóúñÑ ü ¿ ¡ ₡ $ & < > "comillas"';
    doc.lines[0].description = 'Descripción: ¿cable de cobre? ¡Sí! ₡ $ & < > "dobles" y \'simples\'';
    doc.notes = "Condiciones de entrega: instalación y revisión. ".repeat(10);
    const huge = "999,999,999,999,999.99";
    Object.assign(doc.lines[0], { quantity: huge, unitPrice: huge, subtotal: huge, total: huge });
    doc.totals = { subtotal: huge, taxPercent: "13.0%", tax: "129,999,999,999,999.99", total: huge };
    doc.equivalence = { crc: `₡${huge}`, usd: `$${huge}` };
    doc.paymentAccounts = [{ bank: "Banco de Costa Rica", account: "CR05015202001026284066", currency: "CRC" }];
    // Runtime extras must not leak even if a caller circumvents the TS contract.
    Object.assign(doc, { cost: "COSTO", profit: "UTILIDAD", supplier: "PROVEEDOR" });
    Object.assign(doc.lines[0], { cost: "COSTO", supplier: "PROVEEDOR" });
    const buffer = await renderQuotationPdf(doc);
    validPdf(buffer);
    if (!gsExists) return;
    const text = extract(buffer);
    expect(text).toContain(doc.folio);
    expect(text.replace(/\s+/g, " ")).toContain(doc.concept);
    expect(text).toContain(doc.totals.total);
    expect(text).toContain(doc.equivalence.crc);
    expect(text).toContain(doc.lines[0].description);
    expect(text).toContain(doc.paymentAccounts[0].account);
    for (const forbidden of ["COSTO", "UTILIDAD", "PROVEEDOR"]) expect(text).not.toContain(forbidden);
  });

  it("continues a single oversized row and notes without dropping their endings", async () => {
    const doc = fixture();
    doc.lines[0].description = "Una descripción muy extensa que debe continuar en la próxima página. ".repeat(500) + "FIN-DESCRIPCION";
    doc.notes = "Una condición extensa que debe conservarse completa. ".repeat(500) + "FIN-NOTAS";
    const buffer = await renderQuotationPdf(doc);
    validPdf(buffer);
    expect(pageCount(buffer)).toBeGreaterThan(3);
    if (gsExists) {
      const text = extract(buffer);
      expect(text).toContain("FIN-DESCRIPCION");
      expect(text).toContain("FIN-NOTAS");
    }
  }, 30_000);
});
