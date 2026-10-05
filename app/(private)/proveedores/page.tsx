import { mergeProviderAction, proposeProviderAction, reviewProviderAction } from "@/app/actions/business";
import { ActionForm } from "@/components/action-form";
import { requirePagePrincipal } from "@/lib/authorization";
import { listProviders } from "@/lib/catalog/service";

export default async function ProvidersPage({ searchParams }: PageProps<"/proveedores">) {
  const principal = await requirePagePrincipal();
  const query = await searchParams;
  const q = typeof query.q === "string" ? query.q : "";
  const rows = await listProviders(principal, q);
  const canReview = principal.permissions.has("providers.review");
  const canPropose = principal.permissions.has("providers.propose");
  return (
    <div className="stack gap-lg">
      <h1>Proveedores</h1>
      <form className="toolbar" method="get" role="search"><label>Buscar<input name="q" type="search" defaultValue={q} /></label><button type="submit">Buscar</button></form>
      {rows.length === 0 ? <p className="notice">No hay proveedores todavía.</p> : (
        <ul className="list" aria-label="Proveedores">
          {rows.map((r) => (
            <li key={r.id} className="list-item">
              <span className="page-head"><strong>{r.commercialName ?? r.legalName}</strong>{r.status === "PENDING_REVIEW" && <span className="badge s-DRAFT">Pendiente de revisión</span>}</span>
              <span className="meta">{r.commercialName && <span>{r.legalName}</span>}{r.contactName && <span>{r.contactName}</span>}{r.phone && <span>{r.phone}</span>}{r.email && <span>{r.email}</span>}</span>
              {canReview && r.status === "PENDING_REVIEW" && (
                <div className="toolbar">
                  <ActionForm action={reviewProviderAction} submitLabel="Aprobar" className="toolbar"><input type="hidden" name="providerId" value={r.id} /><input type="hidden" name="decision" value="APPROVED" /></ActionForm>
                  <ActionForm action={reviewProviderAction} submitLabel="Rechazar" variant="danger" className="toolbar" confirm="¿Rechazar este proveedor?"><input type="hidden" name="providerId" value={r.id} /><input type="hidden" name="decision" value="REJECTED" /></ActionForm>
                  <ActionForm action={mergeProviderAction} submitLabel="Fusionar" variant="secondary" className="toolbar">
                    <input type="hidden" name="providerId" value={r.id} />
                    <label><span className="sr-only">Fusionar con proveedor existente</span><select name="targetId" required defaultValue=""><option value="" disabled>Duplicado de…</option>{rows.filter((x) => x.status === "APPROVED").map((x) => <option key={x.id} value={x.id}>{x.commercialName ?? x.legalName}</option>)}</select></label>
                  </ActionForm>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canPropose && (
        <section className="card stack"><h2>Proponer proveedor</h2>
          <ActionForm action={proposeProviderAction} submitLabel="Enviar a revisión">
            <label>Nombre legal<input name="legalName" required minLength={2} maxLength={300} /></label>
            <label>Nombre comercial<input name="commercialName" maxLength={300} /></label>
            <div className="row">
              <label>Tipo de identificación<select name="identificationType" defaultValue=""><option value="">Sin identificación</option><option value="FISICA">Cédula física</option><option value="JURIDICA">Cédula jurídica</option><option value="DIMEX">DIMEX</option><option value="NITE">NITE</option><option value="PASAPORTE">Pasaporte</option></select></label>
              <label>Número<input name="identificationNumber" inputMode="numeric" maxLength={20} /></label>
            </div>
            <label>Contacto<input name="contactName" maxLength={200} /></label>
            <div className="row"><label>Teléfono<input name="phone" type="tel" inputMode="tel" maxLength={20} /></label><label>Correo<input name="email" type="email" /></label></div>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
