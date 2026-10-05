import { redirect } from "next/navigation";
import { recordCostAction } from "@/app/actions/business";
import { ActionForm } from "@/components/action-form";
import { requirePagePrincipal } from "@/lib/authorization";
import { listCosts } from "@/lib/catalog/service";
import { editorOptions } from "@/lib/quotations/service";
import { dmy, money, asCurrency } from "@/lib/ui";

export default async function CostsPage() {
  const principal = await requirePagePrincipal();
  if (!principal.permissions.has("quotations.manage_own") && !principal.permissions.has("quotations.view_all")) redirect("/panel");
  const rows = await listCosts(principal);
  const options = principal.permissions.has("quotations.manage_own") ? await editorOptions(principal) : null;
  return (
    <div className="stack gap-lg">
      <h1>Costos de proveedores</h1>
      <p className="notice">Información interna: nunca aparece en el PDF ni en el correo al cliente.</p>
      {options && (
        <section className="card stack"><h2>Registrar costo</h2>
          <ActionForm action={recordCostAction} submitLabel="Guardar costo">
            <label>Proveedor<select name="providerId" required><option value="">— Elegir —</option>{options.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>Producto del catálogo <span className="field-hint">opcional</span><select name="catalogItemId"><option value="">— Producto libre —</option>{options.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
            <label>Descripción <span className="field-hint">si no eliges producto del catálogo</span><input name="itemName" maxLength={300} /></label>
            <div className="row"><label>Costo unitario<input name="unitCost" inputMode="decimal" required /></label><label>Moneda<select name="currency"><option value="CRC">CRC</option><option value="USD">USD</option></select></label></div>
            <label>Observaciones<input name="notes" maxLength={500} /></label>
          </ActionForm>
        </section>
      )}
      {rows.length === 0 ? <p className="notice">Todavía no hay costos registrados. También se guardan al agregar líneas a una cotización.</p> : (
        <ul className="list" aria-label="Historial de costos">{rows.map((r) => <li key={r.id} className="list-item"><strong>{r.itemName}</strong><span className="meta"><span>{r.provider}</span><span>{dmy(r.quotedOn)}</span>{r.notes && <span>{r.notes}</span>}</span><span className="amount">{money(r.unitCost, asCurrency(r.currency))}</span></li>)}</ul>
      )}
    </div>
  );
}
