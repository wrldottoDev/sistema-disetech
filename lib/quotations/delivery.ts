import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { generatedDocuments } from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import { type Principal, requirePermission } from "@/lib/rbac";
import { sendEmail } from "@/lib/email";
import { AppError } from "@/lib/errors";
import { renderQuotationPdf } from "@/lib/pdf/quotation-pdf";
import { buildClientDocument } from "@/lib/quotations/document";
import { latestIssuedRevision, lockOwnedQuotation, transitionInTx } from "@/lib/quotations/service";
import { emailSchema, optionalText, uuidSchema, versionSchema } from "@/lib/validation";

const storageRoot = () => path.resolve(/*turbopackIgnore: true*/ process.env.DOCUMENT_STORAGE_DIR ?? "storage");
const storagePath = (key: string) => path.join(/*turbopackIgnore: true*/ storageRoot(), key);

/**
 * PDF de la revisión. Las emitidas se generan una vez, se guardan (inmutables, con sha256) y se sirven de disco;
 * los borradores se renderizan al vuelo con marca de agua y nunca se guardan.
 */
export async function getQuotationPdf(principal: Principal, quotationId: unknown, revisionNumber?: number): Promise<{ bytes: Buffer; fileName: string }> {
  const { document, quotation, revision } = await buildClientDocument(principal, quotationId, revisionNumber);
  if (revision.state === "DRAFT") return { bytes: await renderQuotationPdf(document), fileName: "borrador.pdf" };
  const fileName = `${quotation.folio}${revision.revisionNumber > 1 ? `-rev${revision.revisionNumber}` : ""}.pdf`;
  const intact = async (doc: typeof generatedDocuments.$inferSelect) => {
    try {
      const bytes = await readFile(storagePath(doc.storageKey));
      return createHash("sha256").update(bytes).digest("hex") === doc.sha256 ? bytes : null;
    } catch {
      return null;
    }
  };
  const lookup = () => db.select().from(generatedDocuments).where(and(eq(generatedDocuments.revisionId, revision.id), eq(generatedDocuments.kind, "QUOTATION_PDF"))).orderBy(desc(generatedDocuments.createdAt));
  for (const doc of await lookup()) {
    const bytes = await intact(doc);
    if (bytes) return { bytes, fileName };
  }
  // Generación serializada por revisión: dos descargas simultáneas no compiten por el mismo registro.
  const bytes = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`pdf:${revision.id}`}))`);
    const stored = await tx.select().from(generatedDocuments).where(and(eq(generatedDocuments.revisionId, revision.id), eq(generatedDocuments.kind, "QUOTATION_PDF"))).orderBy(desc(generatedDocuments.createdAt));
    for (const doc of stored) {
      const ok = await intact(doc);
      if (ok) return ok;
    }
    const rendered = await renderQuotationPdf(document);
    const sha256 = createHash("sha256").update(rendered).digest("hex");
    // El renderer es determinista: si ya existe el registro con ese hash sólo se restaura su archivo.
    const same = stored.find((d) => d.sha256 === sha256);
    const storageKey = same?.storageKey ?? `quotations/${quotation.id}/${revision.id}-${randomUUID()}.pdf`;
    await mkdir(path.dirname(storagePath(storageKey)), { recursive: true });
    await writeFile(storagePath(storageKey), rendered);
    if (!same) {
      await tx.insert(generatedDocuments).values({ quotationId: quotation.id, revisionId: revision.id, storageProvider: "LOCAL_FS", storageKey, fileName, byteSize: rendered.length, sha256, createdByUserId: principal.userId });
    }
    return rendered;
  });
  return { bytes, fileName };
}

export async function sendQuotationEmail(principal: Principal, quotationId: unknown, input: { to: unknown; message: unknown; revisionId: unknown; quotationVersion: unknown }): Promise<{ statusUpdated: boolean }> {
  requirePermission(principal, "quotations.manage_own");
  const to = emailSchema.parse(input.to);
  const message = optionalText(1500).parse(input.message);
  const revisionId = uuidSchema.parse(input.revisionId);
  const quotationVersion = versionSchema.parse(input.quotationVersion);
  // La cotización queda bloqueada mientras se genera el PDF y se envía el correo: nada puede emitirla de nuevo ni cerrarla a mitad del envío.
  return db.transaction(async (tx) => {
    const quotation = await lockOwnedQuotation(tx, principal, quotationId);
    if (!["ISSUED", "SENT"].includes(quotation.status)) throw new AppError("CONFLICT", "Emite la cotización antes de enviarla.");
    const issued = await latestIssuedRevision(tx, quotation.id);
    // Se envía exactamente la revisión que el vendedor tenía en pantalla, y sólo si sigue siendo la vigente.
    if (!issued || issued.id !== revisionId || quotation.version !== quotationVersion) throw new AppError("CONFLICT", "La cotización cambió; recarga la página antes de enviarla.");
    const { document, revision } = await buildClientDocument(principal, quotation.id, issued.revisionNumber);
    const pdf = await getQuotationPdf(principal, quotation.id, issued.revisionNumber);
    const target = { type: "quotation", id: quotation.id };
    try {
      await sendEmail({
        to,
        subject: `Cotización ${document.folio} – Disetech`,
        text: [
          "Estimado cliente,",
          "",
          `Adjuntamos la cotización ${document.folio} correspondiente a: ${document.concept}.`,
          `Es válida hasta el ${document.validUntil}.`,
          ...(message ? ["", message] : []),
          "",
          "Quedamos atentos a sus comentarios.",
          "",
          `${revision.sellerName}`,
          `${revision.sellerPhone} · ${revision.sellerEmail}`,
          "Disetech",
        ].join("\n"),
        attachments: [{ filename: pdf.fileName, content: pdf.bytes, contentType: "application/pdf" }],
      });
    } catch (error) {
      console.error("Quotation email failed", error instanceof Error ? error.message.slice(0, 200) : "unknown");
      await writeAudit({ actorUserId: principal.userId, action: "QUOTATION.EMAIL_SEND", result: "FAILURE", target, authSessionId: principal.sessionId, metadata: { folio: document.folio } }).catch(() => undefined);
      throw new AppError("CONFLICT", "No se pudo enviar el correo. La cotización NO fue marcada como enviada; inténtalo de nuevo o descarga el PDF.");
    }
    // El correo ya salió: un fallo al auditar no debe presentarse como fallo de envío.
    await writeAudit({ actorUserId: principal.userId, action: "QUOTATION.EMAIL_SEND", result: "SUCCESS", target, authSessionId: principal.sessionId, metadata: { folio: document.folio } }).catch((error) => console.error("Audit failed after email", error instanceof Error ? error.message.slice(0, 120) : "unknown"));
    if (quotation.status === "SENT") return { statusUpdated: false };
    try {
      await transitionInTx(tx, principal, quotation, "SENT", `Enviada por correo a ${to}`, quotationVersion);
      return { statusUpdated: true };
    } catch (error) {
      console.error("Quotation sent but status not updated", error instanceof Error ? error.message.slice(0, 200) : "unknown");
      throw new AppError("CONFLICT", "El correo se envió, pero no se pudo actualizar el estado a ENVIADA. Márcala como enviada manualmente.");
    }
  });
}
