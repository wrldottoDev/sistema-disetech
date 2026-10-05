import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgres"),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  AUDIT_HMAC_SECRET: z.string().min(32),
  EMAIL_TRANSPORT: z.enum(["memory", "smtp"]).default("memory"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().email().default("info@disetechcr.com"),
  BOOTSTRAP_TOKEN: z.string().min(16).optional(),
  DOCUMENT_STORAGE_DIR: z.string().optional(),
  ENABLE_TEST_ENDPOINTS: z.enum(["true", "false"]).default("false"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Configuración de servidor inválida: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  if (parsed.data.EMAIL_TRANSPORT === "smtp") {
    if (!parsed.data.SMTP_HOST || !parsed.data.SMTP_PORT || !parsed.data.SMTP_USER || !parsed.data.SMTP_PASSWORD) {
      throw new Error("La configuración SMTP está incompleta");
    }
  }
  // `next build` evalúa los módulos sin la configuración real de producción: las exigencias aplican al arrancar el servidor.
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
    if (parsed.data.EMAIL_TRANSPORT !== "smtp") throw new Error("En producción EMAIL_TRANSPORT debe ser smtp");
    if (!parsed.data.BOOTSTRAP_TOKEN) throw new Error("En producción BOOTSTRAP_TOKEN es obligatorio");
    if (!parsed.data.BETTER_AUTH_URL.startsWith("https://")) throw new Error("En producción BETTER_AUTH_URL debe ser https");
  }
  const db = new URL(parsed.data.DATABASE_URL);
  if (process.env.NODE_ENV === "test" && !db.pathname.replace(/^\//, "").endsWith("_test")) {
    throw new Error("Los tests sólo pueden usar una base cuyo nombre termine en _test");
  }
  if (process.env.NODE_ENV === "production" && parsed.data.ENABLE_TEST_ENDPOINTS === "true") {
    throw new Error("Los endpoints de prueba no pueden habilitarse en producción");
  }
  cached = parsed.data;
  return cached;
}
