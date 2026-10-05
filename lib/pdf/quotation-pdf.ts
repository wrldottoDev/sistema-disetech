import PDFDocument from "pdfkit";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientDocument } from "../quotations/client-document.ts";

// Literal asset paths also allow Next's file tracer to discover the local files.
const assets = {
  regular: [new URL("./assets/fonts/arimo-latin-400-normal.woff", import.meta.url), "lib/pdf/assets/fonts/arimo-latin-400-normal.woff"],
  bold: [new URL("./assets/fonts/arimo-latin-700-normal.woff", import.meta.url), "lib/pdf/assets/fonts/arimo-latin-700-normal.woff"],
  italic: [new URL("./assets/fonts/arimo-latin-400-italic.woff", import.meta.url), "lib/pdf/assets/fonts/arimo-latin-400-italic.woff"],
  colon: [new URL("./assets/fonts/arimo-latin-ext-400-normal.woff", import.meta.url), "lib/pdf/assets/fonts/arimo-latin-ext-400-normal.woff"],
  colonBold: [new URL("./assets/fonts/arimo-latin-ext-700-normal.woff", import.meta.url), "lib/pdf/assets/fonts/arimo-latin-ext-700-normal.woff"],
  logo: [new URL("./assets/logo.png", import.meta.url), "lib/pdf/assets/logo.png"],
} as const;

function asset(key: keyof typeof assets): Buffer {
  const [url, relative] = assets[key];
  const local = url.protocol === "file:" ? fileURLToPath(url) : "";
  return readFileSync(local && existsSync(local) ? local : join(/*turbopackIgnore: true*/ process.cwd(), relative));
}

type Font = "regular" | "bold" | "italic";
type TextLine = { text: string; font: Font; size: number; color: string; height: number };
type Cell = { width: number; lines: TextLine[]; align?: "left" | "right" | "center"; fill?: string };

const C = { navy: "#0B2545", blue: "#1F4E8C", green: "#D9EAD3", grid: "#B7B7B7", ink: "#111111", gray: "#777777", yellow: "#FFF2CC", pale: "#F7F8F9" };
const LEFT = 64;
const TOP = 65;
const WIDTH = 728;
const BOTTOM = 533;
const PAD = 1.5;
const GAP = 11;
const BAR = 11.5;
const ROW = 11.5;
const META_WIDTH = 469;
const COLUMNS = [280, 55, 134, 126, 66.5, 66.5];

function documentDate(value: string): Date {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match ? new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]))) : new Date(0);
}

/** Node/server-only renderer. Prints an explicit allowlist of ClientDocument fields. */
export async function renderQuotationPdf(doc: ClientDocument): Promise<Buffer> {
  const date = documentDate(doc.date);
  const pdf = new PDFDocument({
    size: "A4", layout: "landscape", margin: 0, bufferPages: true, compress: true,
    info: { Title: doc.folio ?? "BORRADOR", Creator: "Disetech", Producer: "Disetech", CreationDate: date, ModDate: date },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  try {
    for (const name of ["regular", "bold", "italic", "colon", "colonBold"] as const) pdf.registerFont(name, asset(name));
    const logo = asset("logo");
    let y = TOP;

    // Only the colon sign uses the extended subset, including in bold runs.
    function runs(value: string, font: Font): { text: string; font: string }[] {
      return value.split(/(₡)/u).filter(Boolean).map(text => ({ text, font: text === "₡" ? (font === "bold" ? "colonBold" : "colon") : font }));
    }
    function textWidth(value: string, font: Font, size: number): number {
      return runs(value, font).reduce((sum, run) => sum + pdf.font(run.font).fontSize(size).widthOfString(run.text), 0);
    }
    function textLines(value: string, width: number, font: Font = "regular", size = 7, color = C.ink): TextLine[] {
      const output: TextLine[] = [];
      function emit(text: string) {
        // The exact same measured lines are used for both pagination and drawing.
        const height = pdf.font(font).fontSize(size).heightOfString(text || "M", { width: width + 0.1, lineGap: 0 });
        output.push({ text, font, size, color, height });
      }
      for (const paragraph of value.replace(/\r\n?/g, "\n").split("\n")) {
        let line = "";
        for (const word of paragraph.match(/\S+/gu) ?? []) {
          const candidate = line ? `${line} ${word}` : word;
          if (textWidth(candidate, font, size) <= width) { line = candidate; continue; }
          if (line) { emit(line); line = ""; }
          // A single long token (SKU/IBAN/etc.) must wrap too, without losing chars.
          for (const char of word) {
            if (line && textWidth(line + char, font, size) > width) { emit(line); line = ""; }
            line += char;
          }
        }
        emit(line);
      }
      return output;
    }
    const linesHeight = (lines: TextLine[]) => lines.reduce((sum, line) => sum + line.height, 0);
    function fitted(value: string, width: number, font: Font = "regular", size = 7): TextLine[] {
      const measured = textWidth(value, font, size);
      const fit = measured > width ? Math.max(4, size * width / measured) : size;
      return textLines(value, width, font, fit);
    }
    function drawText(lines: TextLine[], x: number, at: number, width: number, align: Cell["align"] = "left") {
      for (const line of lines) {
        const measured = textWidth(line.text, line.font, line.size);
        let offset = align === "right" ? width - measured : align === "center" ? (width - measured) / 2 : 0;
        for (const run of runs(line.text, line.font)) {
          pdf.font(run.font).fontSize(line.size).fillColor(line.color).text(run.text, x + offset, at, { lineBreak: false });
          offset += pdf.widthOfString(run.text);
        }
        at += line.height;
      }
    }
    function rectangle(x: number, at: number, width: number, height: number, fill?: string) {
      pdf.lineWidth(0.5).strokeColor(C.grid).rect(x, at, width, height);
      if (fill) pdf.fillAndStroke(fill, C.grid); else pdf.stroke();
    }
    function newPage() { pdf.addPage(); y = TOP; }
    function ensure(height: number) { if (y + height > BOTTOM) newPage(); }
    function bar(title: string, width = WIDTH) {
      pdf.rect(LEFT, y, width, BAR).fill(C.blue);
      drawText(textLines(title, width - 2 * PAD, "bold", 7.5, "#FFFFFF"), LEFT + PAD, y + 1.2, width - 2 * PAD);
      y += BAR;
    }
    function row(cells: Cell[], minimum = ROW, center = false) {
      const height = Math.max(minimum, ...cells.map(cell => linesHeight(cell.lines) + 2 * PAD));
      let x = LEFT;
      for (const cell of cells) {
        rectangle(x, y, cell.width, height, cell.fill);
        drawText(cell.lines, x + PAD, y + (center ? (height - linesHeight(cell.lines)) / 2 : PAD), cell.width - 2 * PAD, cell.align);
        x += cell.width;
      }
      y += height;
    }
    // Normal rows are indivisible. If one row exceeds an entire page, its text
    // continues inside bordered cells on subsequent pages, with headers repeated.
    function pagedRow(cells: Cell[], repeat: () => void, minimum = ROW, headerHeight = 0) {
      const fullHeight = Math.max(minimum, ...cells.map(cell => linesHeight(cell.lines) + 2 * PAD));
      const firstHeight = Math.max(minimum, ...cells.map(cell => (cell.lines[0]?.height ?? 0) + 2 * PAD));
      if (y + firstHeight > BOTTOM || (y + fullHeight > BOTTOM && fullHeight <= BOTTOM - TOP - headerHeight)) { newPage(); repeat(); }
      const remaining = cells.map(cell => ({ ...cell, lines: [...cell.lines] }));
      do {
        const available = BOTTOM - y - 2 * PAD;
        const part = remaining.map(cell => {
          let used = 0;
          let count = 0;
          for (const line of cell.lines) {
            if (used + line.height > available) break;
            used += line.height;
            count++;
          }
          return { ...cell, lines: cell.lines.splice(0, count) };
        });
        row(part, minimum);
        if (remaining.some(cell => cell.lines.length)) { newPage(); repeat(); } else break;
      } while (true);
    }

    pdf.rect(LEFT, y, WIDTH, 23).fill(C.navy);
    drawText(textLines("COTIZACIÓN / FACTURA PROFORMA", WIDTH, "bold", 11.5, "#FFFFFF"), LEFT, y + 5, WIDTH, "center");
    y += 34;
    const headerTop = y;
    // Draw on the first page before unusually long metadata can paginate.
    // The reference stretches the artwork slightly to fill this rectangle.
    pdf.image(logo, LEFT + META_WIDTH + 28, headerTop + 27, { width: 208, height: 40 });
    const fields = [
      ["N° DE FOLIO:", doc.folio ?? "BORRADOR"], ["FECHA:", doc.date], ["CLIENTE:", doc.customerName],
      ["CONTACTO:", doc.contact], ["CÓDIGO CABYS:", doc.cabys], ["VENDEDOR:", doc.sellerName],
      ["CONCEPTO:", doc.concept], ["MONEDA:", doc.currency], ["TIPO DE CAMBIO USADO:", doc.exchangeRate], ["VÁLIDA HASTA:", doc.validUntil],
    ];
    fields.forEach(([label, value], index) => {
      pagedRow([
        { width: 280, lines: textLines(label, 276, "bold"), fill: C.pale },
        { width: 55, lines: [], fill: C.pale },
        { width: 134, lines: textLines(value, 130, index === 0 ? "bold" : "regular"), fill: index === 0 ? C.yellow : C.pale },
      ], () => {});
    });
    y += GAP;

    function detailHeader() {
      bar("DETALLE DE LA COTIZACIÓN");
      row(["PRODUCTO", "CANTIDAD", "PRECIO UNITARIO VENTA", "SUBTOTAL", "IMPUESTO %", "TOTAL"].map((label, index) => ({
        width: COLUMNS[index], lines: textLines(label, COLUMNS[index] - 4, "bold"), fill: C.green,
      })), 20, true);
    }
    ensure(BAR + 20 + ROW);
    detailHeader();
    for (const line of doc.lines) {
      const product = textLines(line.name, COLUMNS[0] - 4);
      if (line.description) product.push(...textLines(line.description, COLUMNS[0] - 4, "regular", 6.3, C.gray));
      const numbers = [line.quantity, line.unitPrice, line.subtotal, line.taxPercent, line.total];
      pagedRow([{ width: COLUMNS[0], lines: product }, ...numbers.map((value, index) => ({
        width: COLUMNS[index + 1], lines: fitted(value, COLUMNS[index + 1] - 4), align: "right" as const,
      }))], detailHeader, ROW, BAR + 20);
    }
    y += GAP;

    // Totals stay together and expand horizontally only for exceptionally wide amounts.
    const totalValues = [doc.totals.subtotal, doc.totals.tax, doc.totals.total];
    const valueWidth = Math.max(66.5, ...totalValues.map(value => textWidth(value, "bold", 8) + 4));
    const totalsWidth = Math.min(WIDTH, 66.5 + valueWidth);
    const totalCells = totalValues.map((value, index) => ({
      label: textLines(["SUBTOTAL:", "IMPUESTO:", "TOTAL:"][index], 62.5, "bold", index === 2 ? 8 : 7),
      value: fitted(value, totalsWidth - 70.5, index === 2 ? "bold" : "regular", index === 2 ? 8 : 7),
    }));
    ensure(totalCells.reduce((sum, cell) => sum + Math.max(ROW, linesHeight(cell.label) + 2 * PAD, linesHeight(cell.value) + 2 * PAD), 0));
    totalCells.forEach((cell, index) => {
      const height = Math.max(ROW, linesHeight(cell.label) + 2 * PAD, linesHeight(cell.value) + 2 * PAD);
      const x = LEFT + WIDTH - totalsWidth;
      rectangle(x, y, 66.5, height, index === 2 ? C.green : undefined);
      rectangle(x + 66.5, y, totalsWidth - 66.5, height, index === 2 ? C.green : undefined);
      drawText(cell.label, x + PAD, y + PAD, 62.5, "right");
      drawText(cell.value, x + 68.5, y + PAD, totalsWidth - 70.5, "right");
      y += height;
    });
    y += GAP;

    const equivalents = [["TOTAL EN COLONES (₡):", doc.equivalence.crc], ["TOTAL EN DÓLARES (US$):", doc.equivalence.usd]];
    const equivalentCells = equivalents.map(([label, value]) => [
      { width: 280, lines: textLines(label, 276, "bold") }, { width: 55, lines: [], fill: C.pale },
      { width: 134, lines: fitted(value, 130, "bold"), align: "right" as const, fill: C.pale },
    ]);
    ensure(BAR + equivalentCells.reduce((sum, cells) => sum + Math.max(ROW, ...cells.map(cell => linesHeight(cell.lines) + 2 * PAD)), 0));
    bar("EQUIVALENCIA SEGÚN EL TIPO DE CAMBIO DE ESA COTIZACIÓN", META_WIDTH);
    equivalentCells.forEach(cells => row(cells));
    y += GAP;

    const notes = textLines(doc.notes, WIDTH - 8);
    const notesHeight = Math.max(46, linesHeight(notes) + 8);
    ensure(Math.min(BAR + notesHeight, BOTTOM - TOP));
    bar("NOTAS Y CONDICIONES");
    if (notesHeight <= BOTTOM - y) {
      rectangle(LEFT, y, WIDTH, notesHeight);
      drawText(notes, LEFT + 4, y + 4, WIDTH - 8);
      y += notesHeight;
    } else {
      pagedRow([{ width: WIDTH, lines: notes }], () => bar("NOTAS Y CONDICIONES"), ROW, BAR);
    }
    y += GAP;

    const paymentWidths = [280, 189, WIDTH - 469];
    const accounts = doc.paymentAccounts.map(account => [account.bank, account.account, account.currency]);
    while (accounts.length < 6) accounts.push(["", "", ""]);
    const payments = accounts.map(values => values.map((value, index) => ({ width: paymentWidths[index], lines: textLines(value, paymentWidths[index] - 4) })));
    function paymentHeader() {
      bar("DATOS PARA PAGO O DEPÓSITO");
      row(["BANCO", "N° DE CUENTA / IBAN", "MONEDA"].map((label, index) => ({ width: paymentWidths[index], lines: textLines(label, paymentWidths[index] - 4, "bold"), fill: C.green })));
    }
    const paymentHeight = BAR + ROW + payments.reduce((sum, cells) => sum + Math.max(ROW, ...cells.map(cell => linesHeight(cell.lines) + 2 * PAD)), 0);
    ensure(Math.min(paymentHeight, BOTTOM - TOP));
    paymentHeader();
    payments.forEach(cells => pagedRow(cells, paymentHeader, ROW, BAR + ROW));

    // The footer follows the payment block, with a rule and measured italic text.
    y += GAP;
    const footer = textLines(doc.footerNote, WIDTH - 4, "italic", 7, C.gray);
    const footerHeight = linesHeight(footer) + 5;
    if (y + footerHeight > pdf.page.height - 30) newPage();
    pdf.moveTo(LEFT, y).lineTo(LEFT + WIDTH, y).lineWidth(0.5).strokeColor(C.grid).stroke();
    y += 3;
    for (const line of footer) {
      if (y + line.height > pdf.page.height - 30) newPage();
      drawText([line], LEFT + PAD, y, WIDTH - 4);
      y += line.height;
    }

    const pages = pdf.bufferedPageRange();
    for (let index = pages.start; index < pages.start + pages.count; index++) {
      pdf.switchToPage(index);
      if (doc.isDraft) {
        pdf.save().fillOpacity(0.07).rotate(-28, { origin: [pdf.page.width / 2, pdf.page.height / 2] });
        drawText(textLines("BORRADOR", 600, "bold", 66, C.navy), (pdf.page.width - 600) / 2, pdf.page.height / 2 - 38, 600, "center");
        pdf.restore();
      }
      if (pages.count > 1) drawText(textLines(`Página ${index - pages.start + 1} de ${pages.count}`, WIDTH, "regular", 6, C.gray), LEFT, pdf.page.height - 23, WIDTH, "right");
    }
    pdf.end();
  } catch (error) {
    pdf.destroy();
    throw error;
  }
  return result;
}
