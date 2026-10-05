import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { getServerEnv } from "@/lib/env";

const forbidden = /pass(word)?|token|secret|totp|recovery|credential|cookie|authorization|jwt|bearer/i;

export type AuditEvent = {
  actorUserId?: string;
  attemptedIdentifier?: string;
  targetUserId?: string;
  target?: { type: string; id: string };
  action: string;
  result: "SUCCESS" | "FAILURE" | "DENIED";
  request?: Request;
  authSessionId?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

/** `executor` permite escribir la auditoría dentro de la misma transacción que la mutación de negocio. */
export async function writeAudit(event: AuditEvent, executor: Pick<typeof db, "insert"> = db): Promise<void> {
  if (event.metadata && Object.keys(event.metadata).some((key) => forbidden.test(key))) {
    throw new Error("Audit metadata contains a forbidden key");
  }
  const attemptedIdentifierHmac = event.attemptedIdentifier
    ? createHmac("sha256", getServerEnv().AUDIT_HMAC_SECRET).update(event.attemptedIdentifier.trim().toLowerCase()).digest("hex")
    : undefined;
  const candidateIp = event.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const forwarded = candidateIp && isIP(candidateIp) ? candidateIp : undefined;
  await executor.insert(auditLogs).values({
    actorType: event.actorUserId ? "USER" : event.attemptedIdentifier ? "ANONYMOUS" : "SYSTEM",
    actorUserId: event.actorUserId,
    attemptedIdentifierHmac,
    targetType: event.targetUserId ? "user" : event.target?.type,
    targetId: event.targetUserId ?? event.target?.id,
    targetUserId: event.targetUserId,
    action: event.action,
    result: event.result,
    ipAddress: forwarded,
    userAgent: event.request?.headers.get("user-agent")?.slice(0, 1000),
    authSessionId: event.authSessionId,
    metadata: event.metadata,
  });
}
