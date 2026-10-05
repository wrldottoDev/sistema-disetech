// Datos de demostración SOLO para bases locales de desarrollo (nunca producción):
//   DATABASE_URL=postgres://...@localhost/disetech_dev node scripts/seed-demo.ts
// Crea empresa, vendedor, gerente comercial, catálogo/proveedores aprobados, tipo de cambio, cuenta de pago y un cliente.
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

const url = process.env.DATABASE_URL?.replace(/^"|"$/g, "");
if (!url) throw new Error("DATABASE_URL no está definida");
const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Rechazado: el seed de demostración sólo corre contra una base local");

const PASSWORD = process.env.DEMO_PASSWORD ?? "Demo-Disetech-2026!";
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function user(email: string, name: string, role: string, companyId: string | null) {
  const [r] = await sql`SELECT id FROM roles WHERE code = ${role}`;
  const [u] = await sql`INSERT INTO users (full_name, email, phone, role_id, company_id, status, activated_at, email_verified)
    VALUES (${name}, ${email}, '60706262', ${r.id}, ${companyId}, 'ACTIVE', now(), true)
    ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`;
  await sql`INSERT INTO accounts (account_id, provider_id, user_id, password) VALUES (${u.id}, 'credential', ${u.id}, ${await hashPassword(PASSWORD)})
    ON CONFLICT (provider_id, account_id) DO UPDATE SET password = EXCLUDED.password`;
  return u.id as string;
}

const [company] = await sql`INSERT INTO companies (name, legal_id) VALUES ('Disetech S.A.', '3-101-000000') ON CONFLICT DO NOTHING RETURNING id`;
const companyId = company?.id ?? (await sql`SELECT id FROM companies WHERE lower(name) = 'disetech s.a.'`)[0].id;
const seller = await user("vendedor@demo.test", "Angel Vega", "SELLER", companyId);
await user("gerente@demo.test", "Gerente Comercial", "COMMERCIAL_MANAGER", null);
const [admin] = await sql`SELECT id FROM users WHERE two_factor_enabled LIMIT 1`;
const proposer = seller;
await sql`INSERT INTO exchange_rates (rate_date, source, buy_rate, sell_rate, created_by_user_id)
  SELECT (now() AT TIME ZONE 'America/Costa_Rica')::date, 'MANUAL', 455.0, 462.29, ${admin?.id ?? seller}
  WHERE NOT EXISTS (SELECT 1 FROM exchange_rates)`;
await sql`INSERT INTO payment_accounts (bank, account_number, currency) SELECT 'Banco Nacional', 'CR05015202001234567890', 'CRC' WHERE NOT EXISTS (SELECT 1 FROM payment_accounts)`;
const [reviewer] = await sql`SELECT id FROM users WHERE email = 'gerente@demo.test'`;
for (const [name, unit] of [["Ángulo UL interno blanco p/canaleta 100x45 DXN11011 Dexson", "UND"], ["Cable THHN #12 AWG", "m"], ["Breaker 2P 30A", "UND"]]) {
  await sql`INSERT INTO catalog_items (name, unit, status, proposed_by_user_id, reviewed_by_user_id, reviewed_at)
    SELECT ${name}, ${unit}, 'APPROVED', ${proposer}, ${reviewer.id}, now() WHERE NOT EXISTS (SELECT 1 FROM catalog_items WHERE name = ${name})`;
}
for (const name of ["Dexson", "Eléctrica Centroamericana"]) {
  await sql`INSERT INTO providers (legal_name, status, proposed_by_user_id, reviewed_by_user_id, reviewed_at)
    SELECT ${name}, 'APPROVED', ${proposer}, ${reviewer.id}, now() WHERE NOT EXISTS (SELECT 1 FROM providers WHERE legal_name = ${name})`;
}
const [customer] = await sql`INSERT INTO customers (full_name, email, phone, created_by_user_id, owner_user_id)
  SELECT 'ElectrosolucionesCR', 'compras@electrosoluciones.test', '6070-6262', ${seller}, ${seller} WHERE NOT EXISTS (SELECT 1 FROM customers WHERE full_name = 'ElectrosolucionesCR') RETURNING id`;
if (customer) await sql`INSERT INTO customer_contacts (customer_id, full_name, phone, is_primary) VALUES (${customer.id}, 'Contacto Compras', '6070-6262', true)`;
await sql.end();
console.log(`Listo. vendedor@demo.test / gerente@demo.test — contraseña: ${PASSWORD}`);
