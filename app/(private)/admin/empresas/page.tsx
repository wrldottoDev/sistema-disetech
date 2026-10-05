import { createCompanyAction, toggleCompanyAction } from "@/app/actions/business";
import { ActionForm } from "@/components/action-form";
import { requireAdminPage } from "@/lib/authorization";
import { listCompanies } from "@/lib/admin/service";

export default async function CompaniesPage() {
  const principal = await requireAdminPage("users.manage");
  const rows = await listCompanies(principal);
  return (
    <div className="stack gap-lg">
      <h1>Empresas</h1>
      <section className="card stack"><h2>Nueva empresa</h2>
        <ActionForm action={createCompanyAction} submitLabel="Crear empresa"><label>Nombre<input name="name" required minLength={2} maxLength={200} /></label><label>Cédula jurídica <span className="field-hint">opcional</span><input name="legalId" maxLength={30} /></label></ActionForm>
      </section>
      <ul className="list" aria-label="Empresas">
        {rows.map((c) => (
          <li key={c.id} className="list-item">
            <span className="page-head"><strong>{c.name}</strong>{!c.isActive && <span className="badge">Inactiva</span>}</span>
            <span className="meta"><span>{c.sellers} usuario(s)</span>{c.legalId && <span>{c.legalId}</span>}</span>
            <ActionForm action={toggleCompanyAction} submitLabel={c.isActive ? "Desactivar" : "Reactivar"} variant="secondary" className="toolbar"><input type="hidden" name="companyId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="active" value={c.isActive ? "false" : "true"} /></ActionForm>
          </li>
        ))}
      </ul>
    </div>
  );
}
