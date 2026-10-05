import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { requireAdminPage } from "@/lib/authorization";
import { dateTime } from "@/lib/ui";

export default async function AuditPage({ searchParams }: PageProps<"/admin/auditoria">) {
  await requireAdminPage("audit.view");
  const query = await searchParams;
  const action = typeof query.action === "string" ? query.action.slice(0, 60) : "";
  const result = ["SUCCESS", "FAILURE", "DENIED"].find((r) => r === query.result) as "SUCCESS" | "FAILURE" | "DENIED" | undefined;
  const events = await db
    .select({ id: auditLogs.id, occurredAt: auditLogs.occurredAt, action: auditLogs.action, result: auditLogs.result, actorType: auditLogs.actorType, actor: users.name, targetType: auditLogs.targetType, targetId: auditLogs.targetId, metadata: auditLogs.metadata })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(and(action ? ilike(auditLogs.action, `%${action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined, result ? eq(auditLogs.result, result) : undefined))
    .orderBy(desc(auditLogs.occurredAt))
    .limit(200);
  return (
    <div className="stack">
      <h1>Auditoría</h1>
      <form className="toolbar" method="get" role="search"><label>Acción<input name="action" defaultValue={action} placeholder="QUOTATION, AUTH, USERS…" /></label><label>Resultado<select name="result" defaultValue={result ?? ""}><option value="">Todos</option><option>SUCCESS</option><option>FAILURE</option><option>DENIED</option></select></label><button type="submit">Filtrar</button></form>
      <div className="table-wrap"><table><caption className="sr-only">Eventos de auditoría, más recientes primero</caption><thead><tr><th scope="col">Fecha</th><th scope="col">Acción</th><th scope="col">Resultado</th><th scope="col">Actor</th><th scope="col">Objetivo</th><th scope="col">Detalle</th></tr></thead>
        <tbody>{events.map((e) => <tr key={e.id}><td>{dateTime(e.occurredAt)}</td><td>{e.action}</td><td>{e.result}</td><td>{e.actor ?? e.actorType}</td><td>{e.targetType ? `${e.targetType} ${e.targetId?.slice(0, 8)}` : "—"}</td><td><code>{e.metadata ? JSON.stringify(e.metadata) : ""}</code></td></tr>)}</tbody></table></div>
    </div>
  );
}
