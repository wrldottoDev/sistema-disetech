import { mergeCatalogAction, proposeCatalogAction, reviewCatalogAction } from "@/app/actions/business";
import { ActionForm } from "@/components/action-form";
import { requirePagePrincipal } from "@/lib/authorization";
import { listCatalog } from "@/lib/catalog/service";

export default async function CatalogPage({ searchParams }: PageProps<"/catalogo">) {
  const principal = await requirePagePrincipal();
  const query = await searchParams;
  const q = typeof query.q === "string" ? query.q : "";
  const rows = await listCatalog(principal, q);
  const canReview = principal.permissions.has("catalog.review");
  const canPropose = principal.permissions.has("catalog.propose");
  return (
    <div className="stack gap-lg">
      <h1>Catálogo de productos</h1>
      <form className="toolbar" method="get" role="search"><label>Buscar<input name="q" type="search" defaultValue={q} placeholder="Nombre o CABYS" /></label><button type="submit">Buscar</button></form>
      {rows.length === 0 ? <p className="notice">No hay productos todavía.{canPropose ? " Propón el primero abajo." : ""}</p> : (
        <ul className="list" aria-label="Productos">
          {rows.map((r) => (
            <li key={r.id} className="list-item">
              <span className="page-head"><strong>{r.name}</strong>{r.status === "PENDING_REVIEW" && <span className="badge s-DRAFT">Pendiente de revisión</span>}</span>
              <span className="meta">{r.unit && <span>Unidad: {r.unit}</span>}{r.cabys && <span>CABYS {r.cabys}</span>}</span>
              {r.description && <small>{r.description}</small>}
              {canReview && r.status === "PENDING_REVIEW" && (
                <div className="toolbar">
                  <ActionForm action={reviewCatalogAction} submitLabel="Aprobar" className="toolbar"><input type="hidden" name="itemId" value={r.id} /><input type="hidden" name="decision" value="APPROVED" /></ActionForm>
                  <ActionForm action={reviewCatalogAction} submitLabel="Rechazar" variant="danger" className="toolbar" confirm="¿Rechazar este producto?"><input type="hidden" name="itemId" value={r.id} /><input type="hidden" name="decision" value="REJECTED" /></ActionForm>
                  <ActionForm action={mergeCatalogAction} submitLabel="Fusionar" variant="secondary" className="toolbar">
                    <input type="hidden" name="itemId" value={r.id} />
                    <label><span className="sr-only">Fusionar con producto existente</span><select name="targetId" required defaultValue=""><option value="" disabled>Duplicado de…</option>{rows.filter((x) => x.status === "APPROVED").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
                  </ActionForm>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canPropose && (
        <section className="card stack"><h2>Proponer producto</h2>
          <p className="field-hint">Un gerente lo aprobará antes de que aparezca para todos.</p>
          <ActionForm action={proposeCatalogAction} submitLabel="Enviar a revisión">
            <label>Nombre<input name="name" required minLength={2} maxLength={300} /></label>
            <label>Descripción<input name="description" maxLength={2000} /></label>
            <div className="row"><label>Unidad<input name="unit" maxLength={30} placeholder="UND, m, caja…" /></label><label>Código CABYS<input name="cabys" inputMode="numeric" maxLength={13} /></label></div>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
