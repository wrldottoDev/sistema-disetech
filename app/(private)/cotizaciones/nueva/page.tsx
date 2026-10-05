import { redirect } from "next/navigation";
import { createQuotationAction } from "@/app/actions/business";
import { ActionForm } from "@/components/action-form";
import { requirePagePrincipal } from "@/lib/authorization";
import { getCustomer, listContacts, listCustomers } from "@/lib/customers/service";
import { currentRate, dateInCR, todayCR } from "@/lib/quotations/service";
import Link from "next/link";

export default async function NewQuotationPage({ searchParams }: PageProps<"/cotizaciones/nueva">) {
  const principal = await requirePagePrincipal();
  if (!principal.permissions.has("quotations.manage_own")) redirect("/cotizaciones");
  const query = await searchParams;
  const customerId = typeof query.cliente === "string" ? query.cliente : undefined;
  const rate = await currentRate().catch(() => null);
  if (!customerId) {
    const customers = await listCustomers(principal, { status: "ACTIVE" });
    return (
      <div className="stack">
        <h1>Nueva cotización</h1>
        <p>Elige el cliente para esta cotización.</p>
        {customers.length === 0 ? <p className="notice">Primero crea un cliente. <Link href="/clientes/nuevo">Nuevo cliente</Link></p> : (
          <ul className="list">{customers.map((c) => <li key={c.id}><Link className="list-item" href={`/cotizaciones/nueva?cliente=${c.id}`}><strong>{c.fullName}</strong><span className="meta">{c.email}</span></Link></li>)}</ul>
        )}
      </div>
    );
  }
  const customer = await getCustomer(principal, customerId);
  const contacts = await listContacts(principal, customer.id);
  const validUntil = dateInCR(15);
  return (
    <div className="stack">
      <h1>Nueva cotización</h1>
      <p>Cliente: <strong>{customer.fullName}</strong></p>
      {!rate && <p className="error" role="alert">No hay tipo de cambio registrado. Pide al administrador que lo registre en Configuración.</p>}
      <section className="card">
        <ActionForm action={createQuotationAction} submitLabel="Crear borrador">
          <input type="hidden" name="customerId" value={customer.id} />
          <label>Concepto<input name="concept" required minLength={2} maxLength={300} placeholder="Ej. Venta de material eléctrico" /></label>
          <label>Moneda<select name="currency" defaultValue="CRC"><option value="CRC">Colones (CRC)</option><option value="USD">Dólares (USD)</option></select></label>
          <label>Válida hasta<input name="validUntil" type="date" min={todayCR()} defaultValue={validUntil} required /></label>
          {contacts.length > 0 && <label>Contacto<select name="contactId" defaultValue={contacts[0].id}>{contacts.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}</select></label>}
          <label>Notas y condiciones <span className="field-hint">aparecen en el PDF</span><textarea name="notes" maxLength={4000} /></label>
        </ActionForm>
      </section>
    </div>
  );
}
