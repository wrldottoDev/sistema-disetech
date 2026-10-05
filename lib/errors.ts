import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly code: "UNAUTHENTICATED" | "FORBIDDEN" | "VALIDATION" | "CONFLICT" | "NOT_FOUND" | "RATE_LIMITED",
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

type PgInfo = { code?: string; constraint_name?: string; table_name?: string };

/** Recorre la cadena `cause` (Drizzle envuelve el error de postgres-js) buscando un SQLSTATE. */
function pgInfo(error: unknown): PgInfo | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const candidate = current as PgInfo & { cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) return candidate;
    current = candidate.cause;
  }
  return undefined;
}

const DB_MESSAGES: Record<string, [AppError["code"], string]> = {
  DTQ02: ["CONFLICT", "La cotización cambió mientras la editabas. Recarga la página e inténtalo de nuevo."],
  DTQ03: ["CONFLICT", "La cotización ya está cerrada o no admite este cambio."],
  DTQ04: ["FORBIDDEN", "No tienes acceso a esta cotización."],
  DTI01: ["CONFLICT", "Este registro ya no se puede modificar."],
  "23505": ["CONFLICT", "Ya existe un registro con esos datos."],
  "23514": ["VALIDATION", "Alguno de los datos no cumple las reglas del sistema."],
  "23503": ["VALIDATION", "Alguno de los registros relacionados no existe."],
  "40001": ["CONFLICT", "Otra operación se cruzó con la tuya. Inténtalo de nuevo."],
  "40P01": ["CONFLICT", "Otra operación se cruzó con la tuya. Inténtalo de nuevo."],
};

export function safeError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof ZodError) return error.issues[0]?.message ?? "Datos inválidos.";
  const pg = pgInfo(error);
  if (pg?.code && DB_MESSAGES[pg.code]) return DB_MESSAGES[pg.code][1];
  console.error("Unexpected application error", pg ? `pg:${pg.code}:${pg.constraint_name ?? pg.table_name ?? ""}` : error instanceof Error ? error.message.slice(0, 200) : "unknown");
  return "No pudimos completar la operación. Inténtalo de nuevo.";
}
