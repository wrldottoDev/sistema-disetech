// Alcance de datos por rol. Todo acceso a clientes/cotizaciones pasa por aquí: el servidor decide qué
// filas ve un usuario a partir de la sesión, nunca de ids o filtros enviados por el cliente.
import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { AppError } from "@/lib/errors";
import type { Principal } from "@/lib/rbac";

export type Scope = { all: true } | { all: false; ownerUserId: string };

export function scopeFor(principal: Principal, viewAll: string, viewOwn: string): Scope {
  if (principal.role === "ADMIN" && !principal.twoFactorEnabled) throw new AppError("FORBIDDEN", "Configura el segundo factor para habilitar funciones administrativas.");
  if (principal.permissions.has(viewAll)) return { all: true };
  if (principal.permissions.has(viewOwn)) return { all: false, ownerUserId: principal.userId };
  throw new AppError("FORBIDDEN", "No tienes permiso para ver este contenido.");
}

export const customerScope = (p: Principal) => scopeFor(p, "customers.view_all", "customers.view_own");
export const quotationScope = (p: Principal) => scopeFor(p, "quotations.view_all", "quotations.manage_own");

export function ownedBy(scope: Scope, ownerColumn: PgColumn, ...conditions: (SQL | undefined)[]): SQL | undefined {
  return and(scope.all ? undefined : eq(ownerColumn, scope.ownerUserId), ...conditions);
}
