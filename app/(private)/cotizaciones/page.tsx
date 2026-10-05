import Link from "next/link";
import { requirePagePrincipal } from "@/lib/authorization";
import { listQuotations } from "@/lib/quotations/service";
import { STATUS_LABEL, asCurrency, dateTime, money } from "@/lib/ui";

export default async function QuotationsPage({ searchParams }: PageProps<"/cotizaciones">) {
  const principal = await requirePagePrincipal();
  const query = await searchParams;
  const q = typeof query.q === "string" ? query.q : "";
  const status = typeof query.status === "string" ? query.status : "";
  const rows = await listQuotations(principal, { q, status });
  const canCreate = principal.permissions.has("quotations.manage_own");
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Cotizaciones</h1>
        {canCreate && <Link className="button-link" href="/cotizaciones/nueva">Nueva cotización</Link>}
      </div>
      <form className="toolbar" method="get" role="search">
        <label>Buscar<input name="q" type="search" defaultValue={q} placeholder="Folio o cliente" /></label>
        <label>Estado<select name="status" defaultValue={status}><option value="">Todos</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <button type="submit">Filtrar</button>
      </form>
      {rows.length === 0 ? <p className="notice">No hay cotizaciones con estos filtros.</p> : (
        <ul className="list" aria-label="Cotizaciones">
          {rows.map((r) => (
            <li key={r.id}>
              <Link className="list-item" href={`/cotizaciones/${r.id}`}>
                <span className="page-head"><strong>{r.folio ?? "Borrador"} · {r.customerName}</strong><span className={`badge s-${r.status}`}>{STATUS_LABEL[r.status]}</span></span>
                <span className="meta"><span>{r.concept ?? "Sin concepto"}</span>{principal.role !== "SELLER" && <span>Vendedor: {r.ownerName}</span>}<span>{dateTime(r.updatedAt)}</span></span>
                <span className="amount">{money(r.total, asCurrency(r.currency))} <small>(IVA incluido)</small></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
