import Link from "next/link";
import { notFound } from "next/navigation";
import { addItemAction, closeQuotationAction, discardRevisionAction, issueQuotationAction, markSentAction, removeItemAction, reviewQuotationAction, reviseQuotationAction, sendQuotationAction, updateHeaderAction, updateItemAction } from "@/app/actions/business";
import { ActionForm } from "@/components/action-form";
import { LineEditor } from "@/components/line-editor";
import { requirePagePrincipal } from "@/lib/authorization";
import { AppError } from "@/lib/errors";
import { formatMoney, fromDb, lineAmounts, round } from "@/lib/money";
import { editorOptions, getQuotationDetail, listContactsForQuotation, todayCR } from "@/lib/quotations/service";
import { STATUS_LABEL, asCurrency, dateTime, dmy, symbol } from "@/lib/ui";

export default async function QuotationPage({ params, searchParams }: PageProps<"/cotizaciones/[id]">) {
  const principal = await requirePagePrincipal();
  const { id } = await params;
  const query = await searchParams;
  const revParam = typeof query.rev === "string" ? Number.parseInt(query.rev, 10) : undefined;
  const detail = await getQuotationDetail(principal, id, Number.isInteger(revParam) ? revParam : undefined).catch((error) => { if (error instanceof AppError && error.code === "NOT_FOUND") notFound(); throw error; });
  const { quotation, revision, revisions, items, history, reviews, customer, isOwner, isLatest, marginWarning, lowMargin, approved } = detail;
  const currency = asCurrency(revision.currency);
  const sym = symbol(currency);
  const editable = isOwner && isLatest && revision.state === "DRAFT" && !["WON", "LOST", "CANCELLED"].includes(quotation.status);
  const canReview = principal.permissions.has("quotations.review") && isLatest;
  const options = editable ? await editorOptions(principal) : null;
  const contacts = editable ? await listContactsForQuotation(principal, quotation.id) : [];
  let subtotal = 0n;
  let tax = 0n;
  for (const item of items) {
    const a = lineAmounts(fromDb(item.quantity), fromDb(item.unitPrice), fromDb(item.taxPercent));
    subtotal += round(a.subtotal);
    tax += round(a.tax);
  }
  const fmt = (v: bigint) => `${sym}${formatMoney(v)}`;
  const open = ["ISSUED", "SENT"].includes(quotation.status);
  const issuedRevision = revisions.find((r) => r.state === "ISSUED");
  const latestIsIssued = revisions[0]?.state === "ISSUED";
  const rateText = revision.fxAppliedRate ? Number(revision.fxAppliedRate).toFixed(4) : "—";

  return (
    <div className="stack gap-lg">
      <div className="page-head">
        <div>
          <h1>{quotation.folio ?? "Borrador"}{revision.revisionNumber > 1 && <small> · rev. {revision.revisionNumber}</small>}</h1>
          <p><Link href={`/clientes/${customer.id}`}>{customer.fullName}</Link> · <span className={`badge s-${quotation.status}`}>{STATUS_LABEL[quotation.status]}</span></p>
        </div>
        <div className="toolbar">
          <Link className="button-link secondary-link" href={`/cotizaciones/${quotation.id}/vista-previa${revision.revisionNumber !== revisions[0]?.revisionNumber ? `?rev=${revision.revisionNumber}` : ""}`}>Vista previa</Link>
          <a className="button-link" href={`/api/cotizaciones/${quotation.id}/pdf?rev=${revision.revisionNumber}`}>{revision.state === "DRAFT" ? "PDF borrador" : "Descargar PDF"}</a>
        </div>
      </div>

      {revisions.length > 1 && (
        <nav aria-label="Revisiones" className="toolbar">
          {revisions.map((r) => <Link key={r.id} className={`badge${r.revisionNumber === revision.revisionNumber ? " s-ISSUED" : ""}`} href={`/cotizaciones/${quotation.id}?rev=${r.revisionNumber}`} aria-current={r.revisionNumber === revision.revisionNumber ? "page" : undefined}>Rev. {r.revisionNumber} · {r.state === "DRAFT" ? "borrador" : "emitida"}</Link>)}
        </nav>
      )}

      <section className="card stack" aria-labelledby="general">
        <h2 id="general">Datos generales</h2>
        {editable ? (
          <ActionForm action={updateHeaderAction} submitLabel="Guardar datos generales" variant="secondary">
            <input type="hidden" name="quotationId" value={quotation.id} /><input type="hidden" name="revisionId" value={revision.id} /><input type="hidden" name="revisionVersion" value={revision.version} />
            <label>Concepto<input name="concept" defaultValue={revision.concept ?? ""} required maxLength={300} /></label>
            <div className="row">
              <label>Moneda<select name="currency" defaultValue={revision.currency}><option value="CRC">Colones (CRC)</option><option value="USD">Dólares (USD)</option></select></label>
              <label>Válida hasta<input name="validUntil" type="date" min={todayCR()} defaultValue={revision.validUntil ?? ""} required /></label>
            </div>
            <label>Tipo de cotización<select name="pricingMode" defaultValue={revision.pricingMode}><option value="BY_UNIT">Por unidad (precios desglosados)</option><option value="PACKAGE">Por paquete (el cliente ve solo el total)</option></select></label>
            {contacts.length > 0 && <label>Contacto<select name="contactId" defaultValue={contacts.find((c) => c.fullName === revision.customerContactName)?.id ?? contacts[0].id}>{contacts.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}</select></label>}
            <label>Código CABYS <span className="field-hint">opcional</span><input name="cabys" defaultValue={revision.customerCabys ?? ""} inputMode="numeric" maxLength={13} /></label>
            <label>Notas y condiciones <span className="field-hint">aparecen en el PDF</span><textarea name="notes" defaultValue={revision.notes ?? ""} maxLength={4000} /></label>
            <label className="check"><input type="checkbox" name="refreshRate" /> Actualizar al tipo de cambio vigente (actual {rateText})</label>
          </ActionForm>
        ) : (
          <dl className="doc-kv">
            <dt>Concepto</dt><dd>{revision.concept ?? "—"}</dd><dt>Vendedor</dt><dd>{revision.sellerName}</dd><dt>Contacto</dt><dd>{revision.customerContactName ?? "—"} {revision.customerContactPhone ?? ""}</dd>
            <dt>Tipo</dt><dd>{revision.pricingMode === "PACKAGE" ? "Por paquete (solo total)" : "Por unidad"}</dd><dt>Moneda</dt><dd>{revision.currency}</dd><dt>Tipo de cambio usado</dt><dd>{rateText}</dd><dt>Válida hasta</dt><dd>{dmy(revision.validUntil)}</dd><dt>Notas</dt><dd>{revision.notes ?? "—"}</dd>
          </dl>
        )}
        {editable && <p className="field-hint">Tipo de cambio usado: <strong>{rateText}</strong>. Cambiar la moneda recalcula los precios.</p>}
      </section>

      <section className="stack" aria-labelledby="lineas">
        <h2 id="lineas">Líneas ({items.length})</h2>
        {items.length === 0 && <p className="notice">Todavía no hay líneas. {editable ? "Agrega la primera abajo." : ""}</p>}
        {items.map((item) => {
          const a = lineAmounts(fromDb(item.quantity), fromDb(item.unitPrice), fromDb(item.taxPercent));
          return (
            <article key={item.id} className="line-card">
              <strong>{item.lineNumber}. {item.itemName}</strong>
              {item.itemDescription && <small>{item.itemDescription}</small>}
              <span>{formatMoney(fromDb(item.quantity))} {item.unit ?? ""} × {fmt(fromDb(item.unitPrice))} = {fmt(round(a.subtotal))} + IVA {fmt(round(a.tax))} → <strong>{fmt(round(a.subtotal) + round(a.tax))}</strong></span>
              <div className="internal">Interno: proveedor {item.providerNameSnapshot ?? "—"} · costo {item.costCurrency === "USD" ? "$" : "₡"}{formatMoney(fromDb(item.unitCost))} · utilidad {item.marginMode === "AMOUNT" ? `${item.costCurrency === "USD" ? "$" : "₡"}${formatMoney(fromDb(item.marginAmount ?? "0"))} por unidad (${Number(item.marginPercent).toFixed(2)}%)` : `${Number(item.marginPercent)}%`}{fromDb(item.marginPercent) < fromDb(marginWarning) ? " ⚠" : ""}</div>
              {editable && options && (
                <details>
                  <summary>Editar o eliminar</summary>
                  <div className="stack">
                    <LineEditor action={updateItemAction} quotationId={quotation.id} revisionId={revision.id} revisionVersion={revision.version} currency={currency} fxRate={revision.fxAppliedRate ?? "1"} warningPercent={marginWarning} catalog={options.items} providers={options.providers} costs={options.costs.map((c) => ({ ...c, currency: asCurrency(c.currency) }))} submitLabel="Guardar línea" defaults={{ id: item.id, itemName: item.itemName, itemDescription: item.itemDescription, unit: item.unit, catalogItemId: item.catalogItemId, providerId: item.providerId, quantity: item.quantity, unitCost: item.unitCost, costCurrency: asCurrency(item.costCurrency), marginPercent: item.marginPercent, marginMode: item.marginMode === "AMOUNT" ? "AMOUNT" : "PERCENT", marginAmount: item.marginAmount }} />
                    <ActionForm action={removeItemAction} submitLabel="Eliminar línea" variant="danger" confirm="¿Eliminar esta línea?">
                      <input type="hidden" name="quotationId" value={quotation.id} /><input type="hidden" name="revisionId" value={revision.id} /><input type="hidden" name="revisionVersion" value={revision.version} /><input type="hidden" name="itemId" value={item.id} />
                    </ActionForm>
                  </div>
                </details>
              )}
            </article>
          );
        })}
        {editable && options && (
          <section className="card stack" aria-labelledby="nueva-linea">
            <h3 id="nueva-linea">Agregar línea</h3>
            <LineEditor action={addItemAction} quotationId={quotation.id} revisionId={revision.id} revisionVersion={revision.version} currency={currency} fxRate={revision.fxAppliedRate ?? "1"} warningPercent={marginWarning} catalog={options.items} providers={options.providers} costs={options.costs.map((c) => ({ ...c, currency: asCurrency(c.currency) }))} submitLabel="Agregar línea" />
          </section>
        )}
        <div className="totals" aria-label="Totales">
          <div><span>Subtotal</span><span>{fmt(subtotal)}</span></div>
          <div><span>IVA 13%</span><span>{fmt(tax)}</span></div>
          <div className="grand"><span>Total</span><span>{fmt(subtotal + tax)}</span></div>
        </div>
      </section>

      {editable && (
        <section className="card stack" aria-labelledby="emitir">
          <h2 id="emitir">Emitir cotización</h2>
          <p>Al emitir se asigna el folio y la revisión queda congelada. Revisa la vista previa antes.</p>
          {lowMargin && !approved && <p className="warn">Hay líneas con utilidad menor a {Number(marginWarning)}%. Un gerente debe aprobar esta versión para poder emitirla.</p>}
          <ActionForm action={issueQuotationAction} submitLabel="Emitir y asignar folio" confirm="¿Emitir la cotización? Ya no podrá editarse.">
            <input type="hidden" name="quotationId" value={quotation.id} /><input type="hidden" name="revisionId" value={revision.id} /><input type="hidden" name="quotationVersion" value={quotation.version} /><input type="hidden" name="revisionVersion" value={revision.version} />
          </ActionForm>
        </section>
      )}

      {isOwner && open && (
        <section className="card stack" aria-labelledby="seguimiento">
          <h2 id="seguimiento">Envío y seguimiento</h2>
          {issuedRevision && latestIsIssued && isLatest && revision.state === "ISSUED" ? (
            <>
              <ActionForm action={sendQuotationAction} submitLabel={quotation.status === "SENT" ? "Reenviar por correo" : "Enviar por correo"}>
                <input type="hidden" name="quotationId" value={quotation.id} /><input type="hidden" name="revisionId" value={issuedRevision.id} /><input type="hidden" name="quotationVersion" value={quotation.version} />
                <label>Enviar a<input name="to" type="email" defaultValue={revision.customerContactEmail ?? revision.customerEmail} required /></label>
                <label>Mensaje <span className="field-hint">opcional</span><textarea name="message" maxLength={1500} /></label>
              </ActionForm>
              {quotation.status === "ISSUED" && <ActionForm action={markSentAction} submitLabel="Marcar como enviada (ya la envié por otro medio)" variant="secondary"><input type="hidden" name="quotationId" value={quotation.id} /><input type="hidden" name="quotationVersion" value={quotation.version} /></ActionForm>}
              <ActionForm action={reviseQuotationAction} submitLabel="Crear nueva revisión" variant="secondary" confirm="Se creará un borrador nuevo copiando las líneas. ¿Continuar?"><input type="hidden" name="quotationId" value={quotation.id} /><input type="hidden" name="quotationVersion" value={quotation.version} /></ActionForm>
            </>
          ) : <p className="field-hint">Hay una revisión en borrador. Emítela o descártala para enviar o crear otra; mientras tanto puedes cerrar la cotización.</p>}
          <ActionForm action={closeQuotationAction} submitLabel="Cerrar cotización" variant="secondary" confirm="Esta acción no se puede deshacer. ¿Continuar?">
            <input type="hidden" name="quotationId" value={quotation.id} /><input type="hidden" name="quotationVersion" value={quotation.version} />
            <label>Resultado<select name="to"><option value="WON">Ganada</option><option value="LOST">Perdida</option><option value="CANCELLED">Cancelada</option></select></label>
            <label>Nota <span className="field-hint">opcional</span><input name="note" maxLength={500} /></label>
          </ActionForm>
        </section>
      )}
      {editable && isOwner && quotation.status === "DRAFT" && (
        <ActionForm action={closeQuotationAction} submitLabel="Cancelar borrador" variant="danger" confirm="¿Cancelar este borrador?">
          <input type="hidden" name="quotationId" value={quotation.id} /><input type="hidden" name="quotationVersion" value={quotation.version} /><input type="hidden" name="to" value="CANCELLED" />
        </ActionForm>
      )}
      {editable && isOwner && revision.revisionNumber > 1 && (
        <ActionForm action={discardRevisionAction} submitLabel="Descartar esta revisión en borrador" variant="danger" confirm="¿Descartar el borrador? Se conserva la última revisión emitida.">
          <input type="hidden" name="quotationId" value={quotation.id} /><input type="hidden" name="revisionId" value={revision.id} /><input type="hidden" name="revisionVersion" value={revision.version} />
        </ActionForm>
      )}

      {canReview && (
        <section className="card stack" aria-labelledby="revision">
          <h2 id="revision">Revisión gerencial</h2>
          <ActionForm action={reviewQuotationAction} submitLabel="Registrar revisión">
            <input type="hidden" name="quotationId" value={quotation.id} /><input type="hidden" name="revisionId" value={revision.id} /><input type="hidden" name="revisionVersion" value={revision.version} />
            <label>Resultado<select name="outcome"><option value="APPROVED">Aprobar</option><option value="CHANGES_REQUESTED">Solicitar cambios</option><option value="REJECTED">Rechazar</option></select></label>
            <label>Comentario <span className="field-hint">obligatorio si no aprueba</span><textarea name="comment" maxLength={1000} /></label>
          </ActionForm>
        </section>
      )}

      <section className="card stack" aria-labelledby="historial">
        <h2 id="historial">Historial</h2>
        {reviews.length === 0 && history.length === 0 ? <p>Sin movimientos todavía.</p> : (
          <ul className="plain-list">
            {history.map((h) => <li key={h.id}><span>{STATUS_LABEL[h.fromStatus ?? "DRAFT"]} → <strong>{STATUS_LABEL[h.toStatus]}</strong>{h.note && ` · ${h.note}`}<br /><small>{h.by} · {dateTime(h.changedAt)}</small></span></li>)}
            {reviews.map((r) => <li key={r.id}><span>Revisión: <strong>{r.outcome === "APPROVED" ? "Aprobada" : r.outcome === "REJECTED" ? "Rechazada" : "Cambios solicitados"}</strong>{r.revisionVersion !== revision.version && r.revisionId === revision.id && " (versión anterior)"}{r.comment && ` · ${r.comment}`}<br /><small>{r.by} · {dateTime(r.reviewedAt)}</small></span></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
