import { listSellers } from "@/lib/customers/service";
import { createCustomerAction } from "@/app/actions/business";
import { ActionForm } from "@/components/action-form";
import { CustomerFields } from "@/components/customer-fields";
import { requirePagePrincipal } from "@/lib/authorization";
import { redirect } from "next/navigation";

export default async function NewCustomerPage() {
  const principal = await requirePagePrincipal();
  const manageAll = principal.permissions.has("customers.manage_all");
  if (!manageAll && !principal.permissions.has("customers.manage_own")) redirect("/clientes");
  const sellers = manageAll ? await listSellers(principal) : [];
  return (
    <div className="stack">
      <h1>Nuevo cliente</h1>
      <section className="card">
        <ActionForm action={createCustomerAction} submitLabel="Crear cliente">
          {manageAll && <label>Vendedor responsable<select name="ownerUserId" required>{sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
          <CustomerFields />
          <fieldset className="stack"><legend>Contacto principal (opcional)</legend>
            <label>Nombre del contacto<input name="contactName" maxLength={200} /></label>
            <label>Teléfono del contacto<input name="contactPhone" type="tel" inputMode="tel" maxLength={20} /></label>
            <label>Correo del contacto<input name="contactEmail" type="email" /></label>
          </fieldset>
        </ActionForm>
      </section>
    </div>
  );
}
