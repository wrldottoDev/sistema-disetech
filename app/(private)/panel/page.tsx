import Link from "next/link";
import { requirePagePrincipal } from "@/lib/authorization";
import { listQuotations } from "@/lib/quotations/service";
import { STATUS_LABEL, asCurrency, dateTime, money } from "@/lib/ui";

const PLURAL = { DRAFT: "Borradores", ISSUED: "Emitidas", SENT: "Enviadas", WON: "Ganadas" } as const;

export default async function PanelPage() {
  const principal = await requirePagePrincipal();
  if (principal.role === "ADMIN" && !principal.twoFactorEnabled) {
    return <section className="notice stack"><h1>Completa la protección de tu cuenta</h1><p>Debes configurar 2FA antes de acceder a las funciones administrativas.</p><Link className="button-link" href="/perfil">Configurar 2FA</Link></section>;
  }
  const canQuote = principal.permissions.has("quotations.manage_own") || principal.permissions.has("quotations.view_all");
  const rows = canQuote ? await listQuotations(principal, {}) : [];
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  const recent = rows.slice(0, 6);
  return (
    <div className="stack gap-lg">
      <h1>Inicio</h1>
      {principal.permissions.has("quotations.manage_own") && (
        <div className="toolbar"><Link className="button-link" href="/cotizaciones/nueva">Nueva cotización</Link><Link className="button-link secondary-link" href="/clientes/nuevo">Nuevo cliente</Link></div>
      )}
      {canQuote && (
        <section className="grid-2" aria-label="Resumen">
          {(["DRAFT", "ISSUED", "SENT", "WON"] as const).map((s) => <Link key={s} className="card stat" href={`/cotizaciones?status=${s}`}><strong>{count(s)}</strong><span>{PLURAL[s]}</span></Link>)}
        </section>
      )}
      {canQuote && (
        <section className="stack" aria-labelledby="recientes"><h2 id="recientes">Actividad reciente</h2>
          {recent.length === 0 ? <p className="notice">Todavía no hay cotizaciones.</p> : <ul className="list">{recent.map((r) => <li key={r.id}><Link className="list-item" href={`/cotizaciones/${r.id}`}><strong>{r.folio ?? "Borrador"} · {r.customerName}</strong><span className="meta"><span className={`badge s-${r.status}`}>{STATUS_LABEL[r.status]}</span><span>{dateTime(r.updatedAt)}</span></span><span className="amount">{money(r.total, asCurrency(r.currency))}</span></Link></li>)}</ul>}
        </section>
      )}
    </div>
  );
}
