import Link from "next/link";
import { requirePagePrincipal } from "@/lib/authorization";
import { listCustomers } from "@/lib/customers/service";

export default async function CustomersPage({ searchParams }: PageProps<"/clientes">) {
  const principal = await requirePagePrincipal();
  const query = await searchParams;
  const q = typeof query.q === "string" ? query.q : "";
  const status = typeof query.status === "string" ? query.status : "ACTIVE";
  const rows = await listCustomers(principal, { q, status });
  const showOwner = principal.role !== "SELLER";
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Clientes</h1>
        <Link className="button-link" href="/clientes/nuevo">Nuevo cliente</Link>
      </div>
      <form className="toolbar" method="get" role="search">
        <label>Buscar<input name="q" defaultValue={q} placeholder="Nombre, correo, teléfono o identificación" type="search" /></label>
        <label>Estado<select name="status" defaultValue={status}><option value="ACTIVE">Activos</option><option value="INACTIVE">Inactivos</option><option value="ALL">Todos</option></select></label>
        <button type="submit">Buscar</button>
      </form>
      {rows.length === 0 ? <p className="notice">No hay clientes que coincidan. Crea el primero con «Nuevo cliente».</p> : (
        <ul className="list" aria-label="Clientes">
          {rows.map((c) => (
            <li key={c.id}>
              <Link className="list-item" href={`/clientes/${c.id}`}>
                <strong>{c.fullName}</strong>
                <span className="meta"><span>{c.email}</span>{c.phone && <span>{c.phone}</span>}{showOwner && <span>Vendedor: {c.ownerName}</span>}{c.status === "INACTIVE" && <span className="badge">Inactivo</span>}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
