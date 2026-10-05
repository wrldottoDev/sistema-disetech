import { AppError } from "@/lib/errors";

export type RoleCode = "ADMIN" | "SELLER" | "COMMERCIAL_MANAGER" | "ADMINISTRATIVE_MANAGER";
export type Principal = {
  userId: string;
  sessionId: string;
  role: RoleCode;
  permissions: ReadonlySet<string>;
  twoFactorEnabled: boolean;
  recentAuthAt: Date | null;
};

export function requirePermission(principal: Principal, permission: string): void {
  if (!principal.permissions.has(permission)) throw new AppError("FORBIDDEN", "No tienes permiso para realizar esta acción.");
  if (principal.role === "ADMIN" && !principal.twoFactorEnabled) throw new AppError("FORBIDDEN", "Configura el segundo factor para habilitar funciones administrativas.");
}
export function requireRecentAuthentication(principal: Principal, maxAgeSeconds = 300): void {
  if (!principal.recentAuthAt || Date.now() - principal.recentAuthAt.getTime() > maxAgeSeconds * 1000) throw new AppError("FORBIDDEN", "Vuelve a confirmar tu identidad para continuar.");
}
export function canAccessOwnedResource(principal: Pick<Principal, "role" | "userId">, ownerUserId: string): boolean { return principal.role !== "SELLER" || principal.userId === ownerUserId; }
export function requireOwnedResource(principal: Pick<Principal, "role" | "userId">, ownerUserId: string): void { if (!canAccessOwnedResource(principal, ownerUserId)) throw new AppError("FORBIDDEN", "No tienes acceso a este recurso."); }

