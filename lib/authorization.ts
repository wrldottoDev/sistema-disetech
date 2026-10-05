import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { permissions, rolePermissions, roles, users } from "@/db/schema";
import { auth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import type { Principal } from "@/lib/rbac";
export { canAccessOwnedResource, requireOwnedResource, requirePermission, requireRecentAuthentication } from "@/lib/rbac";

export type { Principal, RoleCode } from "@/lib/rbac";

export async function getPrincipal(): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const rows = await db
    .select({
      userId: users.id,
      status: users.status,
      role: roles.code,
      permission: permissions.code,
      twoFactorEnabled: users.twoFactorEnabled,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(users.id, session.user.id), eq(users.status, "ACTIVE")));
  if (!rows.length) return null;
  return {
    userId: rows[0].userId,
    sessionId: session.session.id,
    role: rows[0].role,
    permissions: new Set(rows.flatMap((row) => (row.permission ? [row.permission] : []))),
    twoFactorEnabled: rows[0].twoFactorEnabled,
    recentAuthAt: session.session.recentAuthAt ?? null,
  };
}

export async function requirePrincipal(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) throw new AppError("UNAUTHENTICATED", "Debes iniciar sesión.");
  return principal;
}

export async function requirePagePrincipal(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) redirect("/login");
  return principal;
}

export async function requireAdminPage(permission: string): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) redirect("/login");
  if (!principal.permissions.has(permission) || principal.role !== "ADMIN" || !principal.twoFactorEnabled) redirect("/panel");
  return principal;
}
