# DISETECH — capa de base de datos

PostgreSQL es la fuente de verdad. Drizzle define tablas/constraints (`db/schema/*.ts`);
las reglas que Drizzle no expresa (triggers, funciones, vistas, seeds) viven en migraciones
SQL versionadas (`drizzle/0001..0004`). Nunca `drizzle-kit push`.

## Comandos

| comando | uso |
|---|---|
| `npm run db:generate` | genera migración tras cambiar `db/schema` (revisar el SQL a mano) |
| `npm run db:check` | consistencia del historial de migraciones |
| `npm run db:migrate` | aplica migraciones a `DATABASE_URL` (exportar la variable; drizzle-kit no lee `.env.local`) |
| `npm run test:db` | crea `disetech_test` desde cero en localhost, migra, ejecuta tests de integridad y la elimina |

`test:db` solo acepta host `localhost`/`127.0.0.1`/`::1` y nombre de DB terminado en `_test`.

## Archivos

- `db/schema/auth.ts` roles, permisos, empresas, usuarios (modelo `user` de Better Auth; `users.company_id` es obligatorio para SELLER, verificado por trigger), sesiones, passkeys, 2FA.
- `db/schema/commercial.ts` clientes, contactos, categorías, catálogo, proveedores.
- `db/schema/finance.ts` tipos de cambio, cuentas de pago (se imprimen en el PDF) e historial interno append-only de costos de proveedores (`provider_costs`, visible sólo para quien lo registró y gerencia).
- `db/schema/quotations.ts` cotizaciones, revisiones, items, folios, historial, revisiones gerenciales.
- `db/schema/infra.ts` auditoría, documentos generados, configuración.
- `db/sql/runtime-grants.sql` permisos del rol de runtime (`disetech_app`) — se ejecuta en despliegue, no es migración.

## Decisiones no obvias

1. **Better Auth**: `users` es el modelo `user` de Better Auth; `sessions`, `accounts`, `verifications`, `passkeys`, `two_factors` y `rate_limits` existen desde la migración 0005 (ids uuid, `disableSignUp: true`). `roleId`, `status`, `phone`, `activatedAt`, `deactivatedAt`, `version` son `additionalFields` con `input: false`. Desactivar un usuario revoca sus sesiones.
2. **Emails** se guardan normalizados (`lower(btrim())`, CHECK) y son únicos. El email de clientes no es único (buzones compartidos).
3. **Nada se borra**: todas las FK son `RESTRICT`; triggers bloquean DELETE en tablas de negocio y TRUNCATE en todas. Se desactiva/cancela. Solo se borran revisiones DRAFT (N>1), sus items y grants de roles.
4. **Concurrencia optimista**: `version` e `updated_at` los incrementa un trigger en cada UPDATE. La app hace `UPDATE ... WHERE id = $1 AND version = $2`; 0 filas = conflicto (nunca reintentar en silencio).
5. **Edición de borradores**: toda escritura de items exige `claim_quotation_revision(revision_id, version_esperada)` en la misma transacción (bloquea la revisión y valida versión).
6. **Emisión**: solo vía `issue_quotation_revision(...)` (SECURITY DEFINER). Asigna folio `COT-YYYY-NNN` con contador por año transaccional (sin huecos entre emisiones confirmadas, nunca reutiliza), año según `America/Costa_Rica` en el instante de emisión, congela totales y registra historial. Reintentar sobre una revisión ya emitida devuelve el mismo folio (`already_issued = true`).
7. **Inmutabilidad**: revisiones emitidas, sus items, historial de estados, revisiones gerenciales, auditoría, tipos de cambio y documentos son inmutables (triggers). Los items guardan snapshot de nombre/descripción/proveedor; la revisión guarda snapshot de cliente, vendedor y tipo de cambio.
8. **Montos**: entradas `NUMERIC` con escala 6; subtotal/IVA/total de items son columnas generadas exactas (sin redondeo). La política de redondeo y la fórmula precio=f(costo, margen, tipo de cambio) pertenecen a la fase financiera; la app debe cuantizar `unit_price` a ≤ 6 decimales. IVA fijado a 13% por CHECK (cambiarlo es una migración deliberada).
9. **Propiedad**: clientes por `customers.owner_user_id`; cotizaciones por `quotations.owner_user_id`. El dueño debe ser SELLER activo. Cotizaciones abiertas (DRAFT/ISSUED/SENT) deben tener el mismo dueño que su cliente (verificado al commit); reasignar = actualizar cliente y sus cotizaciones abiertas en una transacción. `created_by_user_id` es inmutable.
10. **Catálogo/proveedores globales**: los vendedores leen solo las vistas `catalog_items_public` / `providers_public` (APPROVED, sin proponente ni notas) más sus propias propuestas. Costos y proveedor usado viven solo en `quotation_items`.
11. **Tipo de cambio**: filas inmutables; correcciones manuales forman una cadena (`supersedes_id`) por fecha; la vigente es la no reemplazada. Cada revisión referencia la fila exacta y copia compra/venta/fecha/fuente y la tasa aplicada.
12. **Auditoría**: append-only. Nunca contraseñas, tokens, secretos TOTP ni credenciales WebAuthn (CHECK rechaza claves sospechosas en `metadata`, control primario = allowlist en la app). Identificador de login fallido solo como HMAC.
13. **Enums**: los `pgEnum` son vocabularios congelados. Para agregar valores se convierte la columna a `text` + CHECK (no usar `ALTER TYPE ... ADD VALUE`: el migrador corre todo en una transacción).
14. **Roles de BD**: migraciones como dueño del esquema; la app en producción con rol no dueño (`db/sql/runtime-grants.sql`). Si la app se conecta como dueño o superusuario, las garantías de exclusividad de emisión dependen de la app.
