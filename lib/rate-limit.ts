import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getServerEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";

export function rateLimitKey(scope: string, identity: string): string {
  const digest = createHmac("sha256", getServerEnv().AUDIT_HMAC_SECRET).update(identity.trim().toLowerCase()).digest("hex");
  return `${scope}:${digest}`;
}

export async function consumeRateLimit(scope: string, identity: string, windowSeconds: number, max: number): Promise<void> {
  const key = rateLimitKey(scope, identity);
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;
  const rows = await db.execute<{ count: number }>(sql`
    INSERT INTO rate_limits(id, key, count, last_request)
    VALUES(gen_random_uuid(), ${key}, 1, ${now})
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.last_request < ${cutoff} THEN 1 ELSE rate_limits.count + 1 END,
      last_request = CASE WHEN rate_limits.last_request < ${cutoff} THEN ${now} ELSE rate_limits.last_request END
    RETURNING count
  `);
  if ((rows[0]?.count ?? 1) > max) throw new AppError("RATE_LIMITED", "Demasiados intentos. Espera unos minutos e inténtalo nuevamente.");
}

