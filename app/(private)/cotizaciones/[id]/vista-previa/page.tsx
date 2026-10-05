import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePrincipal } from "@/lib/authorization";
import { AppError } from "@/lib/errors";
import { buildClientDocument } from "@/lib/quotations/document";

export default async function PreviewPage({ params, searchParams }: PageProps<"/cotizaciones/[id]/vista-previa">) {
  const principal = await requirePagePrincipal();
  const { id } = await params;
  const query = await searchParams;
  const rev = typeof query.rev === "string" ? Number.parseInt(query.rev, 10) : undefined;
  const { document: d, quotation, revision } = await buildClientDocument(principal, id, Number.isInteger(rev) ? rev : undefined).catch((error) => { if (error instanceof AppError && error.code === "NOT_FOUND") notFound(); throw error; });
  const rows: [string, string][] = [["N° DE FOLIO", d.folio ?? "BORRADOR"], ["FECHA", d.date], ["CLIENTE", d.customerName], ["CONTACTO", d.contact], ["CÓDIGO CABYS", d.cabys], ["VENDEDOR", d.sellerName], ["CONCEPTO", d.concept], ["MONEDA", d.currency], ["TIPO DE CAMBIO USADO", d.exchangeRate], ["VÁLIDA HASTA", d.validUntil]];
  return (
    <div className="stack">
      <div className="page-head no-print">
        <h1>Vista previa</h1>
        <div className="toolbar"><Link className="button-link secondary-link" href={`/cotizaciones/${quotation.id}`}>Volver</Link><a className="button-link" href={`/api/cotizaciones/${quotation.id}/pdf?rev=${revision.revisionNumber}`}>{d.isDraft ? "PDF borrador" : "Descargar PDF"}</a></div>
      </div>
      {d.isDraft && <p className="warn no-print">Borrador: así se verá el documento, pero todavía no tiene folio y no se puede enviar.</p>}
      <article className="preview-sheet stack" aria-label="Vista previa de la cotización">
        <div className="doc-title">COTIZACIÓN / FACTURA PROFORMA</div>
        <dl className="doc-kv">{rows.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}:</dt><dd>{v}</dd></div>)}</dl>
        <div className="doc-bar">DETALLE DE LA COTIZACIÓN</div>
        <div className="table-wrap">
          <table className="doc-table">
            <thead><tr><th scope="col">PRODUCTO</th><th scope="col" className="num">CANTIDAD</th><th scope="col" className="num">PRECIO UNITARIO VENTA</th><th scope="col" className="num">SUBTOTAL</th><th scope="col" className="num">IMPUESTO %</th><th scope="col" className="num">TOTAL</th></tr></thead>
            <tbody>{d.lines.map((l, i) => <tr key={i}><td>{l.name}{l.description && <><br /><small>{l.description}</small></>}</td><td className="num">{l.quantity}</td><td className="num">{l.unitPrice}</td><td className="num">{l.subtotal}</td><td className="num">{l.taxPercent}</td><td className="num">{l.total}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="totals"><div><span>SUBTOTAL:</span><span>{d.totals.subtotal}</span></div><div><span>IMPUESTO ({d.totals.taxPercent}):</span><span>{d.totals.tax}</span></div><div className="grand"><span>TOTAL:</span><span>{d.totals.total}</span></div></div>
        <div className="doc-bar">EQUIVALENCIA SEGÚN EL TIPO DE CAMBIO DE ESA COTIZACIÓN</div>
        <dl className="doc-kv"><dt>TOTAL EN COLONES (₡):</dt><dd><strong>{d.equivalence.crc}</strong></dd><dt>TOTAL EN DÓLARES (US$):</dt><dd><strong>{d.equivalence.usd}</strong></dd></dl>
        <div className="doc-bar">NOTAS Y CONDICIONES</div>
        <p style={{ minHeight: "4rem", border: "1px solid #c7ccd3", padding: ".5rem", whiteSpace: "pre-wrap", margin: 0 }}>{d.notes}</p>
        <div className="doc-bar">DATOS PARA PAGO O DEPÓSITO</div>
        <div className="table-wrap"><table className="doc-table"><thead><tr><th scope="col">BANCO</th><th scope="col">N° DE CUENTA / IBAN</th><th scope="col">MONEDA</th></tr></thead><tbody>{d.paymentAccounts.length === 0 ? <tr><td colSpan={3}>&nbsp;</td></tr> : d.paymentAccounts.map((a, i) => <tr key={i}><td>{a.bank}</td><td>{a.account}</td><td>{a.currency}</td></tr>)}</tbody></table></div>
        <p><em>{d.footerNote}</em></p>
      </article>
    </div>
  );
}
