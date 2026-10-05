"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { auditLogs, passkeys, sessions } from "@/db/schema";
import { auth } from "@/lib/auth";
import { requirePermission, requirePrincipal, requireRecentAuthentication } from "@/lib/authorization";
import { safeError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { consumeRateLimit } from "@/lib/rate-limit";
import { passwordSchema, uuidSchema } from "@/lib/validation";
import type { ActionState } from "./users";

export async function reauthenticateAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const principal = await requirePrincipal();
    await consumeRateLimit("reauth", principal.userId, 60 * 15, 10);
    const password = passwordSchema.parse(form.get("password"));
    await auth.api.verifyPassword({ body: { password }, headers: await headers() });
    if (principal.role === "ADMIN") {
      const code = String(form.get("totp") ?? "");
      await auth.api.verifyTOTP({ body: { code, trustDevice: false }, headers: await headers() });
    }
    const authenticatedAt = new Date();
    // Better Auth's passkey registration middleware defines a fresh session from
    // createdAt. Refresh it only after password (+ TOTP for Admin) verification so
    // a 30-day session alone can never authorize a new credential.
    await db
      .update(sessions)
      .set({ createdAt: authenticatedAt, recentAuthAt: authenticatedAt })
      .where(eq(sessions.id, principal.sessionId));
    return { ok: true, message: "Identidad confirmada por 5 minutos." };
  } catch (error) { return { ok: false, message: safeError(error) }; }
}

export async function logoutAction(): Promise<void> {
  const principal = await requirePrincipal();
  await auth.api.signOut({ headers: await headers() });
  await writeAudit({ actorUserId: principal.userId, targetUserId: principal.userId, action: "AUTH.LOGOUT", result: "SUCCESS", authSessionId: principal.sessionId });
  redirect("/login");
}

export async function revokeSessionAction(form: FormData): Promise<void> {
  const principal = await requirePrincipal();
  requirePermission(principal, "users.manage");
  requireRecentAuthentication(principal);
  const sessionId = uuidSchema.parse(form.get("sessionId"));
  const [target] = await db.select({ userId: sessions.userId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!target) return;
  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: principal.userId, targetType: "user", targetId: target.userId, targetUserId: target.userId, action: "AUTH.SESSION_REVOKE", result: "SUCCESS", authSessionId: principal.sessionId });
  });
}

export async function revokeAllSessionsAction(form: FormData): Promise<void> {
  const principal = await requirePrincipal();
  requirePermission(principal, "users.manage");
  requireRecentAuthentication(principal);
  const userId = uuidSchema.parse(form.get("userId"));
  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: principal.userId, targetType: "user", targetId: userId, targetUserId: userId, action: "AUTH.SESSIONS_REVOKE_ALL", result: "SUCCESS", authSessionId: principal.sessionId });
  });
}

export async function revokePasskeyAction(form: FormData): Promise<void> {
  const principal = await requirePrincipal();
  requirePermission(principal, "users.manage");
  requireRecentAuthentication(principal);
  const passkeyId = uuidSchema.parse(form.get("passkeyId"));
  const [target] = await db.select({ userId: passkeys.userId }).from(passkeys).where(eq(passkeys.id, passkeyId)).limit(1);
  if (!target) return;
  await db.transaction(async (tx) => {
    await tx.delete(passkeys).where(eq(passkeys.id, passkeyId));
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: principal.userId, targetType: "user", targetId: target.userId, targetUserId: target.userId, action: "AUTH.PASSKEY_ADMIN_REVOKE", result: "SUCCESS", authSessionId: principal.sessionId });
  });
}
