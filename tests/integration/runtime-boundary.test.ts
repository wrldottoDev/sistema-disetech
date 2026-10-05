import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { IT_RUNTIME_ROLE } from "./env";
import { createUser } from "./helpers";

describe("la app corre como rol de runtime (no dueño)", () => {
  it("current_user es el rol restringido", async () => {
    const rows = await db.execute<{ u: string }>(sql`SELECT current_user AS u`);
    expect(rows[0].u).toBe(IT_RUNTIME_ROLE);
  });
  it("no puede escribir folios ni contadores ni borrar", async () => {
    await createUser("SELLER");
    await expect(db.execute(sql`UPDATE quotation_folio_counters SET last_number = 0`)).rejects.toBeDefined();
    await expect(db.execute(sql`DELETE FROM customers`)).rejects.toBeDefined();
    await expect(db.execute(sql`TRUNCATE audit_logs`)).rejects.toBeDefined();
    await expect(db.execute(sql`UPDATE provider_costs SET unit_cost = 0`)).rejects.toBeDefined();
    await expect(db.execute(sql`CREATE TABLE evil (id int)`)).rejects.toBeDefined();
  });
  it("un vendedor sin empresa es rechazado por la BD", async () => {
    await expect(db.execute(sql`INSERT INTO users (full_name, email, phone, role_id) SELECT 'X', 'sin-empresa@example.test', '80000000', id FROM roles WHERE code = 'SELLER'`)).rejects.toBeDefined();
  });
});
