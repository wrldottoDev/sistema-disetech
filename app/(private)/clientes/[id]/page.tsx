import Link from "next/link";
import { addContactAction, reassignCustomerAction, toggleCustomerAction, updateCustomerAction } from "@/app/actions/business";
import { ActionForm } from "@/components/action-form";
import { CustomerFields } from "@/components/customer-fields";
import { requirePagePrincipal } from "@/lib/authorization";
import { getCustomer, listContacts, listCustomerQuotations, listSellers } from "@/lib/customers/service";
import { STATUS_LABEL, dateTime } from "@/lib/ui";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";

export default async function CustomerPage({ params }: PageProps<"/clientes/[id]">) {
  const principal = await requirePagePrincipal();
  const { id } = await params;
  const customer = await getCustomer(principal, id).catch((error) => { if (error instanceof AppError && error.code === "NOT_FOUND") notFound(); throw error; });
  const [contacts, history] = await Promise.all([listContacts(principal, customer.id), listCustomerQuotations(principal, customer.id)]);
  const canManage = principal.permissions.has("customers.manage_all") || (principal.permissions.has("customers.manage_own") && customer.ownerUserId === principal.userId);
  const canQuote = principal.permissions.has("quotations.manage_own") && customer.ownerUserId === principal.userId && customer.status === "ACTIVE";
  const sellers = principal.permissions.has("customers.reassign") ? await listSellers(principal) : [];
  return (
    <div className="stack gap-lg">
      <div className="page-head">
        <h1>{customer.fullName}</h1>
        {canQuote && <Link className="button-link" href={`/cotizaciones/nueva?cliente=${customer.id}`}>Nueva cotización</Link>}
      </div>
      {customer.status === "INACTIVE" && <p className="notice">Este cliente está inactivo.</p>}
      <section className="card stack">
        <h2>Datos del cliente</h2>
        {canManage && customer.status === "ACTIVE" ? (
          <ActionForm action={updateCustomerAction} submitLabel="Guardar cambios">
            <input type="hidden" name="customerId" value={customer.id} /><input type="hidden" name="version" value={customer.version} />
            <CustomerFields customer={customer} />
          </ActionForm>
        ) : <dl className="doc-kv"><dt>Correo</dt><dd>{customer.email}</dd><dt>Teléfono</dt><dd>{customer.phone ?? "—"}</dd><dt>Identificación</dt><dd>{customer.identificationNumber ?? "—"}</dd></dl>}
      </section>
      <section className="card stack">
        <h2>Contactos</h2>
        {contacts.length === 0 ? <p>Sin contactos registrados.</p> : <ul className="plain-list">{contacts.map((c) => <li key={c.id}><span>{c.fullName}{c.isPrimary && <span className="badge"> Principal</span>}<br /><small>{[c.phone, c.email, c.department].filter(Boolean).join(" · ")}</small></span></li>)}</ul>}
        {canManage && customer.status === "ACTIVE" && (
          <ActionForm action={addContactAction} submitLabel="Agregar contacto" variant="secondary">
            <input type="hidden" name="customerId" value={customer.id} />
            <label>Nombre<input name="fullName" required maxLength={200} /></label>
            <label>Teléfono<input name="phone" type="tel" inputMode="tel" maxLength={20} /></label>
            <label>Correo<input name="email" type="email" /></label>
            <label>Departamento<input name="department" maxLength={120} /></label>
          </ActionForm>
        )}
      </section>
      <section className="card stack">
        <h2>Cotizaciones</h2>
        {history.length === 0 ? <p>Todavía no hay cotizaciones para este cliente.</p> : <ul className="list">{history.map((q) => <li key={q.id}><Link className="list-item" href={`/cotizaciones/${q.id}`}><strong>{q.folio ?? "Borrador sin folio"}</strong><span className="meta"><span className={`badge s-${q.status}`}>{STATUS_LABEL[q.status]}</span><span>{dateTime(q.updatedAt)}</span></span></Link></li>)}</ul>}
      </section>
      {sellers.length > 0 && (
        <section className="card stack">
          <h2>Reasignar vendedor</h2>
          <ActionForm action={reassignCustomerAction} submitLabel="Reasignar" variant="secondary" confirm="¿Reasignar este cliente a otro vendedor?">
            <input type="hidden" name="customerId" value={customer.id} />
            <label>Nuevo vendedor<select name="ownerUserId" defaultValue={customer.ownerUserId}>{sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          </ActionForm>
        </section>
      )}
      {canManage && (
        <ActionForm action={toggleCustomerAction} submitLabel={customer.status === "ACTIVE" ? "Desactivar cliente" : "Reactivar cliente"} variant={customer.status === "ACTIVE" ? "danger" : "secondary"} confirm={customer.status === "ACTIVE" ? "¿Desactivar este cliente?" : undefined}>
          <input type="hidden" name="customerId" value={customer.id} /><input type="hidden" name="version" value={customer.version} /><input type="hidden" name="active" value={customer.status === "ACTIVE" ? "false" : "true"} />
        </ActionForm>
      )}
    </div>
  );
}
